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
  const token = req.headers["x-auth-token"] as string | undefined;
  return token === internalSecret;
}

export function registerAdapterRoutes(router: RestRouter, internalSecret: string): void {
  // GET /api/internal/siclaw/agent/:agentId — agent basic info
  router.get("/api/internal/siclaw/agent/:agentId", async (req, res, params) => {
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
      status: agent.status,
      model_provider: agent.model_provider,
      model_id: agent.model_id,
      system_prompt: agent.system_prompt,
      icon: agent.icon,
      color: agent.color,
    });
  });

  // GET /api/internal/siclaw/agent/:agentId/resources — bound resources
  router.get("/api/internal/siclaw/agent/:agentId/resources", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const agentId = params.agentId;

    const [[clusters], [hosts], [skills], [mcpServers], [agentRows]] = await Promise.all([
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
      db.query(
        "SELECT is_production FROM agents WHERE id = ?",
        [agentId],
      ),
    ]) as any;

    const isProduction = agentRows.length > 0 ? !!agentRows[0].is_production : true; // default to prod for safety

    sendJson(res, 200, {
      clusters,
      hosts,
      skill_ids: skills.map((r: { skill_id: string }) => r.skill_id),
      mcp_server_ids: mcpServers.map((r: { mcp_server_id: string }) => r.mcp_server_id),
      is_production: isProduction,
    });
  });

  // POST /api/internal/siclaw/check-access
  router.post("/api/internal/siclaw/check-access", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const body = await parseBody<{ user_id?: string; action?: string }>(req);

    // "review" action requires can_review_skills flag or admin role
    if (body.action === "review" && body.user_id) {
      const db = getDb();
      const [rows] = await db.query(
        "SELECT role, can_review_skills FROM siclaw_users WHERE id = ?",
        [body.user_id],
      ) as any;
      if (rows.length === 0) {
        sendJson(res, 200, { allowed: false, grant_all: false, agent_group_ids: [] });
        return;
      }
      const user = rows[0];
      const allowed = user.role === "admin" || !!user.can_review_skills;
      sendJson(res, 200, { allowed, grant_all: allowed, agent_group_ids: [] });
      return;
    }

    // All other actions: allow (existing behavior)
    sendJson(res, 200, { allowed: true, grant_all: true, agent_group_ids: [] });
  });

  // POST /api/internal/siclaw/credential-request
  router.post("/api/internal/siclaw/credential-request", async (req, res) => {
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

  // POST /api/internal/siclaw/credential-list
  router.post("/api/internal/siclaw/credential-list", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const body = await parseBody<{ kind?: string }>(req);
    const agentId = req.headers["x-cert-agent-id"] as string | undefined;
    if (!agentId) { sendJson(res, 400, { error: "X-Cert-Agent-Id header required" }); return; }

    const db = getDb();

    if (body.kind === "host" || body.kind === "hosts") {
      const [rows] = await db.query(
        `SELECT h.name, h.ip, h.port, h.username, h.auth_type, h.is_production, h.description
         FROM agent_hosts ah JOIN hosts h ON ah.host_id = h.id WHERE ah.agent_id = ?`,
        [agentId],
      ) as any;
      sendJson(res, 200, {
        hosts: rows.map((r: any) => ({
          name: r.name, ip: r.ip, port: r.port, username: r.username,
          auth_type: r.auth_type, is_production: !!r.is_production,
          ...(r.description ? { description: r.description } : {}),
        })),
      });
      return;
    }

    // Default: clusters
    const [rows] = await db.query(
      `SELECT c.name, c.api_server, c.is_production, c.kubeconfig, c.description, c.debug_image
       FROM agent_clusters ac JOIN clusters c ON ac.cluster_id = c.id WHERE ac.agent_id = ?`,
      [agentId],
    ) as any;
    sendJson(res, 200, {
      clusters: rows.map((r: any) => ({
        name: r.name, is_production: !!r.is_production,
        ...(r.api_server ? { api_server: r.api_server } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.debug_image ? { debug_image: r.debug_image } : {}),
      })),
    });
  });

  // POST /api/internal/siclaw/resource-manifest
  router.post("/api/internal/siclaw/resource-manifest", async (req, res) => {
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

  // POST /api/internal/siclaw/host-search
  router.post("/api/internal/siclaw/host-search", async (req, res) => {
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

  // GET /api/internal/siclaw/agent/:agentId/settings — provider + models for agentbox
  router.get("/api/internal/siclaw/agent/:agentId/settings", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const [agentRows] = await db.query(
      "SELECT model_provider, model_id FROM agents WHERE id = ?",
      [params.agentId],
    ) as any;

    if (agentRows.length === 0 || !agentRows[0].model_provider) {
      sendJson(res, 200, { providers: {} });
      return;
    }

    const agent = agentRows[0] as { model_provider: string; model_id: string };

    const [providerRows] = await db.query(
      "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
      [agent.model_provider],
    ) as any;

    if (providerRows.length === 0) {
      sendJson(res, 200, { providers: {} });
      return;
    }

    const p = providerRows[0];
    const [modelRows] = await db.query(
      `SELECT model_id, name, reasoning, context_window, max_tokens
       FROM model_entries WHERE provider_id = ? ORDER BY sort_order, created_at`,
      [p.id],
    ) as any;

    sendJson(res, 200, {
      providers: {
        [p.name]: {
          baseUrl: p.base_url,
          apiKey: p.api_key || "",
          api: p.api_type,
          models: (modelRows as any[]).map((m: any) => ({
            id: m.model_id,
            name: m.name || m.model_id,
            reasoning: !!m.reasoning,
            contextWindow: m.context_window,
            maxTokens: m.max_tokens,
          })),
        },
      },
      default: { provider: agent.model_provider, modelId: agent.model_id },
    });
  });

  // GET /api/internal/siclaw/skill/:skillId/agents — agents bound to a skill
  //   ?dev_only=1  → only return agents with is_production=0
  router.get("/api/internal/siclaw/skill/:skillId/agents", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const qIdx = (req.url ?? "").indexOf("?");
    const qs = qIdx >= 0 ? new URLSearchParams((req.url ?? "").slice(qIdx + 1)) : null;
    const devOnly = qs?.get("dev_only") === "1";

    const sql = devOnly
      ? `SELECT ask.agent_id FROM agent_skills ask
         JOIN agents a ON ask.agent_id = a.id
         WHERE ask.skill_id = ? AND a.is_production = 0`
      : "SELECT agent_id FROM agent_skills WHERE skill_id = ?";

    const [rows] = await db.query(sql, [params.skillId]) as any;

    sendJson(res, 200, {
      agent_ids: rows.map((r: { agent_id: string }) => r.agent_id),
    });
  });

  // GET /api/internal/siclaw/mcp/:mcpId/agents — agents bound to an MCP server
  router.get("/api/internal/siclaw/mcp/:mcpId/agents", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT agent_id FROM agent_mcp_servers WHERE mcp_server_id = ?",
      [params.mcpId],
    ) as any;
    sendJson(res, 200, { agent_ids: rows.map((r: { agent_id: string }) => r.agent_id) });
  });

  // GET /api/internal/siclaw/cluster/:clusterId/agents — agents bound to a cluster
  router.get("/api/internal/siclaw/cluster/:clusterId/agents", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT agent_id FROM agent_clusters WHERE cluster_id = ?",
      [params.clusterId],
    ) as any;
    sendJson(res, 200, { agent_ids: rows.map((r: { agent_id: string }) => r.agent_id) });
  });

  // GET /api/internal/siclaw/host/:hostId/agents — agents bound to a host
  router.get("/api/internal/siclaw/host/:hostId/agents", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT agent_id FROM agent_hosts WHERE host_id = ?",
      [params.hostId],
    ) as any;
    sendJson(res, 200, { agent_ids: rows.map((r: { agent_id: string }) => r.agent_id) });
  });

  // GET /api/internal/siclaw/channels — list active channels for Runtime to boot
  router.get("/api/internal/siclaw/channels", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM channels WHERE status = 'active' ORDER BY created_at",
    ) as any;
    sendJson(res, 200, { data: rows });
  });
}
