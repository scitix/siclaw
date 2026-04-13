/**
 * Adapter API — implements the same endpoints that Upstream provides
 * so the Siclaw Runtime can fetch agent config, credentials, and resources.
 *
 * Auth: X-Auth-Token header (shared secret).
 */

import http from "node:http";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  type RestRouter,
} from "../gateway/rest-router.js";

function requireInternalAuth(req: http.IncomingMessage, internalSecret: string): boolean {
  const token = req.headers["x-internal-token"] as string | undefined;
  return token === internalSecret;
}

export function registerAdapterRoutes(router: RestRouter, internalSecret: string): void {
  // GET /api/internal/siclaw/adapter/agent/:agentId — agent basic info
  router.get("/api/internal/siclaw/adapter/agent/:agentId", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [params.agentId]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    const agent = rows[0];
    sendJson(res, 200, {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      group_name: agent.group_name,
      status: agent.status,
      model_provider: agent.model_provider,
      model_id: agent.model_id,
      system_prompt: agent.system_prompt,
      brain_type: agent.brain_type,
      icon: agent.icon,
      color: agent.color,
    });
  });

  // GET /api/internal/siclaw/adapter/agent/:agentId/resources — bound resources
  router.get("/api/internal/siclaw/adapter/agent/:agentId/resources", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const agentId = params.agentId;

    const [[clusters], [hosts], [skills], [mcpServers]] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.api_server FROM agent_clusters ac
         JOIN clusters c ON ac.cluster_id = c.id WHERE ac.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT h.id, h.name, h.ip, h.port, h.username, h.auth_type FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id WHERE ah.agent_id = ?`,
        [agentId],
      ),
      db.query(
        "SELECT skill_id FROM agent_skills WHERE agent_id = ?",
        [agentId],
      ),
      db.query(
        "SELECT mcp_server_id FROM agent_mcp_servers WHERE agent_id = ?",
        [agentId],
      ),
    ]) as any;

    sendJson(res, 200, {
      clusters,
      hosts,
      skill_ids: skills.map((r: { skill_id: string }) => r.skill_id),
      mcp_server_ids: mcpServers.map((r: { mcp_server_id: string }) => r.mcp_server_id),
    });
  });

  // POST /api/internal/siclaw/adapter/check-access — always allow
  router.post("/api/internal/siclaw/adapter/check-access", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    sendJson(res, 200, { allowed: true, grant_all: true, agent_group_ids: [] });
  });

  // POST /api/internal/siclaw/adapter/credential-request
  router.post("/api/internal/siclaw/adapter/credential-request", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const body = await parseBody<{
      source?: string;
      source_id?: string;
      purpose?: string;
    }>(req);

    if (!body.source || !body.source_id) {
      sendJson(res, 400, { error: "source and source_id are required" });
      return;
    }

    const agentId = req.headers["x-cert-agent-id"] as string | undefined;
    const db = getDb();

    if (body.source === "cluster") {
      // Check agent binding if agent header present
      if (agentId) {
        const [binding] = await db.query(
          "SELECT 1 FROM agent_clusters WHERE agent_id = ? AND cluster_id = ?",
          [agentId, body.source_id],
        ) as any;
        if (binding.length === 0) {
          sendJson(res, 403, { error: "Agent not bound to this cluster" });
          return;
        }
      }

      const [rows] = await db.query(
        "SELECT name, kubeconfig FROM clusters WHERE id = ?",
        [body.source_id],
      ) as any;
      if (rows.length === 0) {
        sendJson(res, 404, { error: "Cluster not found" });
        return;
      }

      const cluster = rows[0];
      sendJson(res, 200, {
        credential: {
          name: cluster.name,
          type: "kubeconfig",
          files: [{ name: "cluster.kubeconfig", content: cluster.kubeconfig }],
          ttl_seconds: 300,
        },
      });
      return;
    }

    if (body.source === "host") {
      // Check agent binding if agent header present
      if (agentId) {
        const [binding] = await db.query(
          "SELECT 1 FROM agent_hosts WHERE agent_id = ? AND host_id = ?",
          [agentId, body.source_id],
        ) as any;
        if (binding.length === 0) {
          sendJson(res, 403, { error: "Agent not bound to this host" });
          return;
        }
      }

      const [rows] = await db.query(
        "SELECT name, ip, port, username, auth_type, password, private_key FROM hosts WHERE id = ?",
        [body.source_id],
      ) as any;
      if (rows.length === 0) {
        sendJson(res, 404, { error: "Host not found" });
        return;
      }

      const host = rows[0];
      const files: { name: string; content: string; mode?: number }[] = [];

      if (host.auth_type === "key" && host.private_key) {
        files.push({ name: "host.key", content: host.private_key, mode: 0o600 });
      } else if (host.password) {
        files.push({ name: "host.password", content: host.password });
      }

      sendJson(res, 200, {
        credential: {
          name: host.name,
          type: "ssh",
          host: host.ip,
          port: host.port,
          username: host.username,
          auth_type: host.auth_type,
          files,
          ttl_seconds: 300,
        },
      });
      return;
    }

    sendJson(res, 400, { error: `Unknown source type: ${body.source}` });
  });

  // POST /api/internal/siclaw/adapter/resource-manifest
  router.post("/api/internal/siclaw/adapter/resource-manifest", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const body = await parseBody<{ agent_id?: string }>(req);
    const db = getDb();
    const agentId = body.agent_id ?? (req.headers["x-cert-agent-id"] as string | undefined);

    if (!agentId) {
      sendJson(res, 400, { error: "agent_id required" });
      return;
    }

    const [[clusters], [hosts]] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.api_server, 'cluster' AS type FROM agent_clusters ac
         JOIN clusters c ON ac.cluster_id = c.id WHERE ac.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT h.id, h.name, h.ip, h.port, h.username, h.auth_type, 'host' AS type FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id WHERE ah.agent_id = ?`,
        [agentId],
      ),
    ]) as any;

    sendJson(res, 200, {
      resources: [...clusters, ...hosts],
    });
  });

  // POST /api/internal/siclaw/adapter/host-search
  router.post("/api/internal/siclaw/adapter/host-search", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const body = await parseBody<{ query?: string; agent_id?: string }>(req);
    const db = getDb();
    const agentId = body.agent_id ?? (req.headers["x-cert-agent-id"] as string | undefined);

    let sql: string;
    const params: unknown[] = [];

    if (agentId) {
      sql = `SELECT h.id, h.name, h.ip, h.port, h.username, h.auth_type, h.description
             FROM agent_hosts ah
             JOIN hosts h ON ah.host_id = h.id
             WHERE ah.agent_id = ?`;
      params.push(agentId);

      if (body.query) {
        sql += " AND (h.name LIKE ? OR h.ip LIKE ? OR h.description LIKE ?)";
        params.push(`%${body.query}%`, `%${body.query}%`, `%${body.query}%`);
      }
    } else {
      sql = "SELECT id, name, ip, port, username, auth_type, description FROM hosts";
      if (body.query) {
        sql += " WHERE name LIKE ? OR ip LIKE ? OR description LIKE ?";
        params.push(`%${body.query}%`, `%${body.query}%`, `%${body.query}%`);
      }
    }

    const [rows] = await db.query(sql, params) as any;
    sendJson(res, 200, { hosts: rows });
  });
}
