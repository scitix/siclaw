/**
 * Adapter API — implements the same endpoints that Upstream provides
 * so the Siclaw Runtime can fetch agent config, credentials, and resources.
 *
 * Auth: X-Auth-Token header (shared secret).
 */

import crypto from "node:crypto";
import http from "node:http";
import { getDb } from "../gateway/db.js";
import { buildUpsert, safeParseJson, toSqlTimestamp } from "../gateway/dialect-helpers.js";
import { createTaskNotification } from "./notification-api.js";
import {
  sendJson,
  parseBody,
  type RestRouter,
} from "../gateway/rest-router.js";

function requireInternalAuth(req: http.IncomingMessage, internalSecret: string): boolean {
  const token = req.headers["x-auth-token"] as string | undefined;
  return token === internalSecret;
}

function jsonParam(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
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
         JOIN clusters c ON ac.cluster_id = c.id
         JOIN agents a ON ac.agent_id = a.id
         WHERE ac.agent_id = ? AND a.is_production = c.is_production`,
        [agentId],
      ),
      db.query(
        `SELECT h.id, h.name, h.ip, h.port, h.username, h.auth_type FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id
         JOIN agents a ON ah.agent_id = a.id
         WHERE ah.agent_id = ? AND a.is_production = h.is_production`,
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
      // source_id is the cluster's NAME (that is what CredentialService passes
      // and what cluster_list returns to the agent). Look up by name first,
      // then use the resolved id for the binding check.
      const [rows] = await db.query(
        "SELECT id, name, kubeconfig FROM clusters WHERE name = ?",
        [body.source_id],
      ) as any;
      if (rows.length === 0) {
        sendJson(res, 404, { error: "Cluster not found" });
        return;
      }
      const cluster = rows[0];

      // Check agent binding if agent header present. Also require matching
      // is_production so a prod agent can't acquire a test cluster (or vice
      // versa) via a stale cross-env binding.
      if (agentId) {
        const [binding] = await db.query(
          `SELECT 1 FROM agent_clusters ac
           JOIN agents a ON ac.agent_id = a.id
           JOIN clusters c ON ac.cluster_id = c.id
           WHERE ac.agent_id = ? AND ac.cluster_id = ?
             AND a.is_production = c.is_production`,
          [agentId, cluster.id],
        ) as any;
        if (binding.length === 0) {
          sendJson(res, 403, { error: "Agent not bound to this cluster" });
          return;
        }
      }

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
      // source_id is the host's NAME — see cluster branch above for rationale.
      const [rows] = await db.query(
        "SELECT id, name, ip, port, username, auth_type, password, private_key, is_production, description FROM hosts WHERE name = ?",
        [body.source_id],
      ) as any;
      if (rows.length === 0) {
        sendJson(res, 404, { error: "Host not found" });
        return;
      }

      // Check agent binding if agent header present. Also require matching
      // is_production so cross-env access via stale bindings is blocked.
      if (agentId) {
        const [binding] = await db.query(
          `SELECT 1 FROM agent_hosts ah
           JOIN agents a ON ah.agent_id = a.id
           JOIN hosts h ON ah.host_id = h.id
           WHERE ah.agent_id = ? AND ah.host_id = ?
             AND a.is_production = h.is_production`,
          [agentId, rows[0].id],
        ) as any;
        if (binding.length === 0) {
          sendJson(res, 403, { error: "Agent not bound to this host" });
          return;
        }
      }

      const host = rows[0];
      const files: { name: string; content: string; mode?: number }[] = [];

      if (host.auth_type === "key") {
        if (!host.private_key) {
          sendJson(res, 400, { error: `Host "${host.name}" has auth_type="key" but private_key is empty` });
          return;
        }
        files.push({ name: "host.key", content: host.private_key, mode: 0o600 });
      } else if (host.auth_type === "password") {
        if (!host.password) {
          sendJson(res, 400, { error: `Host "${host.name}" has auth_type="password" but password is empty` });
          return;
        }
        files.push({ name: "host.password", content: host.password });
      } else {
        sendJson(res, 400, { error: `Host "${host.name}" has unknown auth_type=${JSON.stringify(host.auth_type)}` });
        return;
      }

      sendJson(res, 200, {
        credential: {
          name: host.name,
          type: "ssh",
          files,
          metadata: {
            ip: host.ip,
            port: host.port,
            username: host.username,
            auth_type: host.auth_type,
            is_production: !!host.is_production,
            ...(host.description ? { description: host.description } : {}),
          },
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
         FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id
         JOIN agents a ON ah.agent_id = a.id
         WHERE ah.agent_id = ? AND a.is_production = h.is_production`,
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

    // Default: clusters. is_production must match between agent and cluster —
    // a prod agent never sees test clusters and vice versa, even if a stale
    // agent_clusters row exists from before an is_production flip.
    const [rows] = await db.query(
      `SELECT c.name, c.api_server, c.is_production, c.kubeconfig, c.description, c.debug_image
       FROM agent_clusters ac
       JOIN clusters c ON ac.cluster_id = c.id
       JOIN agents a ON ac.agent_id = a.id
       WHERE ac.agent_id = ? AND a.is_production = c.is_production`,
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
         JOIN clusters c ON ac.cluster_id = c.id
         JOIN agents a ON ac.agent_id = a.id
         WHERE ac.agent_id = ? AND a.is_production = c.is_production`,
        [agentId],
      ),
      db.query(
        `SELECT h.id, h.name, h.ip, h.port, h.username, h.auth_type, 'host' AS type FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id
         JOIN agents a ON ah.agent_id = a.id
         WHERE ah.agent_id = ? AND a.is_production = h.is_production`,
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
             JOIN agents a ON ah.agent_id = a.id
             WHERE ah.agent_id = ? AND a.is_production = h.is_production`;
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
      "SELECT * FROM channels WHERE status = 'active' ORDER BY created_at, id",
    ) as any;
    for (const row of rows as any[]) {
      if (row.config !== undefined) row.config = safeParseJson(row.config, null);
    }
    sendJson(res, 200, { data: rows });
  });

  // ================================================================
  // Chat persistence — called by Runtime's sse-consumer during execution
  // ================================================================

  // POST /api/internal/siclaw/chat/ensure-session
  router.post("/api/internal/siclaw/chat/ensure-session", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{
      session_id: string; agent_id: string; user_id: string;
      title?: string; preview?: string; origin?: string;
      parent_session_id?: string | null; parent_agent_id?: string | null;
      delegation_id?: string | null; target_agent_id?: string | null;
    }>(req);
    const db = getDb();
    // last_active_at omitted: relies on schema DEFAULT CURRENT_TIMESTAMP for
    // new rows, and the updateColumns expression for conflicts. Passing a
    // JS ISO string ("2026-04-22T...Z") would be rejected by MySQL TIMESTAMP.
    const upsert = buildUpsert(
      db,
      "chat_sessions",
      ["id", "agent_id", "user_id", "title", "preview", "message_count", "origin", "parent_session_id", "parent_agent_id", "delegation_id", "target_agent_id"],
      [body.session_id, body.agent_id, body.user_id,
       body.title || "New Session", body.preview || null, 0, body.origin || null,
       body.parent_session_id ?? null, body.parent_agent_id ?? null,
       body.delegation_id ?? null, body.target_agent_id ?? null],
      ["id"],
      [{ col: "last_active_at", expr: "CURRENT_TIMESTAMP" }],
    );
    await db.query(upsert.sql, upsert.params);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/internal/siclaw/chat/append-message
  router.post("/api/internal/siclaw/chat/append-message", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{
      session_id: string; role: string; content: string;
      tool_name?: string; tool_input?: string; metadata?: any;
      outcome?: string; duration_ms?: number;
      from_agent_id?: string | null; parent_session_id?: string | null;
      delegation_id?: string | null; target_agent_id?: string | null;
    }>(req);
    const id = crypto.randomUUID();
    const db = getDb();
    await db.query(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_name, tool_input, metadata, outcome, duration_ms, from_agent_id, parent_session_id, delegation_id, target_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, body.session_id, body.role, body.content,
       body.tool_name || null, body.tool_input || null,
       jsonParam(body.metadata),
       body.outcome || null, body.duration_ms ?? null,
       body.from_agent_id ?? null, body.parent_session_id ?? null,
       body.delegation_id ?? null, body.target_agent_id ?? null],
    );
    // Bump session message_count
    await db.query(
      `UPDATE chat_sessions SET message_count = message_count + 1, last_active_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [body.session_id],
    );
    sendJson(res, 200, { id });
  });

  // ================================================================
  // Task run persistence — called by Runtime's task-coordinator
  // ================================================================

  // POST /api/internal/siclaw/task-run
  router.post("/api/internal/siclaw/task-run", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{
      id: string; task_id: string; status: string;
      result_text?: string; error?: string; duration_ms?: number; session_id?: string;
    }>(req);
    const db = getDb();
    await db.query(
      `INSERT INTO agent_task_runs (id, task_id, status, result_text, error, duration_ms, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [body.id, body.task_id, body.status,
       body.result_text || null, body.error || null,
       body.duration_ms ?? null, body.session_id || null],
    );
    // Update task last_run_at + last_result
    await db.query(
      `UPDATE agent_tasks SET last_run_at = CURRENT_TIMESTAMP, last_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [body.status, body.task_id],
    );
    sendJson(res, 200, { ok: true });
  });

  // GET /api/internal/siclaw/tasks/active — list active tasks for scheduling
  router.get("/api/internal/siclaw/tasks/active", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status, created_by, last_run_at, last_result
       FROM agent_tasks WHERE status = 'active'`,
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // ================================================================
  // MCP servers by IDs — called by Runtime's internal-api (AgentBox bundle)
  // ================================================================

  // POST /api/internal/siclaw/mcp-servers/by-ids
  router.post("/api/internal/siclaw/mcp-servers/by-ids", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ ids: string[] }>(req);
    if (!body.ids?.length) {
      sendJson(res, 200, { mcpServers: {} });
      return;
    }
    const db = getDb();
    const placeholders = body.ids.map(() => "?").join(",");
    const [rows] = await db.query(
      `SELECT name, transport, url, command, args, env, headers, enabled
       FROM mcp_servers WHERE id IN (${placeholders}) AND enabled = 1`,
      body.ids,
    ) as any;
    const mcpServers: Record<string, unknown> = {};
    for (const row of rows) {
      mcpServers[row.name] = {
        transport: row.transport,
        ...(row.url ? { url: row.url } : {}),
        ...(row.command ? { command: row.command } : {}),
        ...(row.args ? { args: safeParseJson(row.args, []) } : {}),
        ...(row.env ? { env: safeParseJson(row.env, {}) } : {}),
        ...(row.headers ? { headers: safeParseJson(row.headers, {}) } : {}),
      };
    }
    sendJson(res, 200, { mcpServers });
  });

  // ================================================================
  // Skills bundle by IDs — called by Runtime's internal-api (AgentBox bundle)
  // ================================================================

  // POST /api/internal/siclaw/skills/bundle
  router.post("/api/internal/siclaw/skills/bundle", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ skill_ids: string[]; is_production: boolean }>(req);
    const skillIds = body.skill_ids ?? [];
    const isProduction = body.is_production ?? true;
    if (skillIds.length === 0) {
      sendJson(res, 200, { version: new Date().toISOString(), skills: [] });
      return;
    }
    const db = getDb();
    let rows: any[];
    if (isProduction) {
      const placeholders = skillIds.map(() => "?").join(",");
      const [result] = await db.query(
        `SELECT
           COALESCE(o.id, s.id) AS id,
           COALESCE(o.name, s.name) AS name,
           COALESCE(o.labels, s.labels) AS labels,
           COALESCE(ov.specs, sv.specs) AS specs,
           COALESCE(ov.scripts, sv.scripts) AS scripts
         FROM skills s
         LEFT JOIN skills o ON o.overlay_of = s.id
         LEFT JOIN skill_versions sv ON sv.skill_id = s.id AND sv.is_approved = 1
           AND sv.version = (SELECT MAX(v2.version) FROM skill_versions v2 WHERE v2.skill_id = s.id AND v2.is_approved = 1)
         LEFT JOIN skill_versions ov ON ov.skill_id = o.id AND ov.is_approved = 1
           AND ov.version = (SELECT MAX(v3.version) FROM skill_versions v3 WHERE v3.skill_id = o.id AND v3.is_approved = 1)
         WHERE s.id IN (${placeholders})`,
        skillIds,
      ) as any;
      rows = result;
    } else {
      const placeholders = skillIds.map(() => "?").join(",");
      const [result] = await db.query(
        `SELECT
           COALESCE(o.id, s.id) AS id,
           COALESCE(o.name, s.name) AS name,
           COALESCE(o.labels, s.labels) AS labels,
           COALESCE(o.specs, s.specs) AS specs,
           COALESCE(o.scripts, s.scripts) AS scripts
         FROM skills s
         LEFT JOIN skills o ON o.overlay_of = s.id
         WHERE s.id IN (${placeholders})`,
        skillIds,
      ) as any;
      rows = result;
    }
    const skills = rows
      .filter((row: any) => row.specs != null)
      .map((row: any) => ({
        dirName: row.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
        scope: "global",
        specs: row.specs || "",
        scripts: safeParseJson(row.scripts, []),
      }));
    sendJson(res, 200, { version: new Date().toISOString(), skills });
  });

  // ================================================================
  // Agent task CRUD — called by Runtime's internal-api (AgentBox mTLS)
  // ================================================================

  // POST /api/internal/siclaw/agent-tasks/list
  router.post("/api/internal/siclaw/agent-tasks/list", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ agent_id: string; user_id: string }>(req);
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, name, schedule, status, description, prompt, last_run_at, last_result
       FROM agent_tasks WHERE agent_id = ? AND created_by = ? AND status = 'active'
       ORDER BY created_at, id`,
      [body.agent_id, body.user_id],
    ) as any;
    sendJson(res, 200, { tasks: rows });
  });

  // POST /api/internal/siclaw/agent-tasks/create
  router.post("/api/internal/siclaw/agent-tasks/create", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{
      id: string; agent_id: string; user_id: string;
      name: string; description?: string; schedule: string; prompt: string; status?: string;
    }>(req);
    const db = getDb();
    await db.query(
      `INSERT INTO agent_tasks (id, agent_id, name, description, schedule, prompt, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [body.id, body.agent_id, body.name, body.description ?? null,
       body.schedule, body.prompt, body.status ?? "active", body.user_id],
    );
    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [body.id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // POST /api/internal/siclaw/agent-tasks/update
  router.post("/api/internal/siclaw/agent-tasks/update", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{
      task_id: string; agent_id: string; user_id: string;
      name?: string; description?: string; schedule?: string; prompt?: string; status?: string;
    }>(req);
    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [body.task_id, body.agent_id, body.user_id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    await db.query(
      `UPDATE agent_tasks SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         schedule = COALESCE(?, schedule),
         prompt = COALESCE(?, prompt),
         status = COALESCE(?, status),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [body.name ?? null, body.description ?? null, body.schedule ?? null,
       body.prompt ?? null, body.status ?? null, body.task_id],
    );
    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [body.task_id]) as any;
    sendJson(res, 200, rows[0]);
  });

  // POST /api/internal/siclaw/agent-tasks/delete
  router.post("/api/internal/siclaw/agent-tasks/delete", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ task_id: string; agent_id: string; user_id: string }>(req);
    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [body.task_id, body.agent_id, body.user_id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    await db.query("DELETE FROM agent_tasks WHERE id = ?", [body.task_id]);
    sendJson(res, 200, { ok: true });
  });

  // ================================================================
  // Task coordinator operations — scheduling, run management, pruning
  // ================================================================

  // GET /api/internal/siclaw/tasks/:taskId/status
  router.get("/api/internal/siclaw/tasks/:taskId/status", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const db = getDb();
    const [rows] = await db.query(
      "SELECT status FROM agent_tasks WHERE id = ? LIMIT 1",
      [params.taskId],
    ) as any;
    if (rows.length === 0) {
      sendJson(res, 200, { status: null });
      return;
    }
    sendJson(res, 200, { status: rows[0].status });
  });

  // POST /api/internal/siclaw/task-run/start — reserve a running row
  router.post("/api/internal/siclaw/task-run/start", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ id: string; task_id: string; session_id: string }>(req);
    const db = getDb();
    await db.query(
      `INSERT INTO agent_task_runs (id, task_id, status, session_id)
       VALUES (?, ?, 'running', ?)`,
      [body.id, body.task_id, body.session_id],
    );
    sendJson(res, 200, { id: body.id });
  });

  // POST /api/internal/siclaw/task-run/finalize — update run with result
  router.post("/api/internal/siclaw/task-run/finalize", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{
      run_id: string; status: string; result_text: string;
      error?: string; duration_ms: number;
    }>(req);
    const db = getDb();
    await db.query(
      `UPDATE agent_task_runs
         SET status = ?, result_text = ?, error = ?, duration_ms = ?
       WHERE id = ?`,
      [body.status, body.result_text, body.error ?? null, body.duration_ms, body.run_id],
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/internal/siclaw/task-metadata/update — update task last_run_at + last_result
  router.post("/api/internal/siclaw/task-metadata/update", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ task_id: string; last_result: string }>(req);
    const db = getDb();
    await db.query(
      `UPDATE agent_tasks SET last_run_at = CURRENT_TIMESTAMP, last_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [body.last_result, body.task_id],
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/internal/siclaw/tasks/fire-now — validate + prepare for manual run
  router.post("/api/internal/siclaw/tasks/fire-now", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ task_id: string; cooldown_sec: number }>(req);
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status, created_by,
              last_run_at, last_result, last_manual_run_at
       FROM agent_tasks WHERE id = ? LIMIT 1`,
      [body.task_id],
    ) as any;
    if (rows.length === 0) {
      sendJson(res, 200, { outcome: "not_found" });
      return;
    }
    const row = rows[0];
    // Check in-flight runs
    const [inflight] = await db.query(
      "SELECT id FROM agent_task_runs WHERE task_id = ? AND status = 'running' LIMIT 1",
      [body.task_id],
    ) as any;
    if (inflight.length > 0) {
      sendJson(res, 200, { outcome: "in_flight" });
      return;
    }
    // Check cooldown
    if (row.last_manual_run_at) {
      const elapsed = (Date.now() - new Date(row.last_manual_run_at).getTime()) / 1000;
      if (elapsed < body.cooldown_sec) {
        sendJson(res, 200, { outcome: "cooldown", retry_after_sec: Math.ceil(body.cooldown_sec - elapsed) });
        return;
      }
    }
    // Stamp manual run time
    await db.query(
      "UPDATE agent_tasks SET last_manual_run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [body.task_id],
    );
    sendJson(res, 200, { outcome: "ok", task: row });
  });

  // POST /api/internal/siclaw/tasks/prune — prune old runs + task sessions
  router.post("/api/internal/siclaw/tasks/prune", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ retention_days: number }>(req);
    const db = getDb();
    const days = body.retention_days;
    const cutoff = toSqlTimestamp(Date.now() - days * 86400e3);
    const [sessResult] = await db.query(
      `DELETE FROM chat_sessions
       WHERE origin IN ('task', 'delegation') AND last_active_at < ?`,
      [cutoff],
    ) as any;
    const [runsResult] = await db.query(
      `DELETE FROM agent_task_runs WHERE created_at < ?`,
      [cutoff],
    ) as any;
    sendJson(res, 200, {
      sessions_deleted: sessResult?.affectedRows ?? 0,
      runs_deleted: runsResult?.affectedRows ?? 0,
    });
  });

  // ================================================================
  // Agent model binding — resolve provider + models for an agent
  // ================================================================

  // GET /api/internal/siclaw/agent/:agentId/model-binding
  router.get("/api/internal/siclaw/agent/:agentId/model-binding", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const db = getDb();
    const [agentRows] = await db.query(
      "SELECT model_provider, model_id FROM agents WHERE id = ?",
      [params.agentId],
    ) as any;
    const agent = agentRows[0] as { model_provider?: string; model_id?: string } | undefined;
    if (!agent?.model_provider || !agent?.model_id) {
      sendJson(res, 200, { binding: null });
      return;
    }
    const [providerRows] = await db.query(
      "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
      [agent.model_provider],
    ) as any;
    if (providerRows.length === 0) {
      sendJson(res, 200, { binding: null });
      return;
    }
    const p = providerRows[0];
    const [entryRows] = await db.query(
      "SELECT model_id, name, reasoning, context_window, max_tokens FROM model_entries WHERE provider_id = ?",
      [p.id],
    ) as any;
    const models = (entryRows as any[]).map((m: any) => ({
      id: m.model_id,
      name: m.name ?? m.model_id,
      reasoning: !!m.reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window,
      maxTokens: m.max_tokens,
    }));
    sendJson(res, 200, {
      binding: {
        modelProvider: p.name,
        modelId: agent.model_id,
        modelConfig: {
          name: p.name,
          baseUrl: p.base_url,
          apiKey: p.api_key ?? "",
          api: p.api_type,
          authHeader: true,
          models,
        },
      },
    });
  });

  // ================================================================
  // Channel operations — binding resolution + pairing
  // ================================================================

  // POST /api/internal/siclaw/channel/resolve-binding
  router.post("/api/internal/siclaw/channel/resolve-binding", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ channel_id: string; route_key: string }>(req);
    const db = getDb();
    const [rows] = await db.query(
      "SELECT id, agent_id FROM channel_bindings WHERE channel_id = ? AND route_key = ?",
      [body.channel_id, body.route_key],
    ) as any;
    if (rows.length === 0) {
      sendJson(res, 200, { binding: null });
      return;
    }
    sendJson(res, 200, { binding: { agentId: rows[0].agent_id, bindingId: rows[0].id } });
  });

  // POST /api/internal/siclaw/channel/pair
  router.post("/api/internal/siclaw/channel/pair", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{
      code: string; channel_id: string; route_key: string;
      route_type: "group" | "user";
    }>(req);
    const db = getDb();
    const now = toSqlTimestamp(new Date());
    const [codeRows] = await db.query(
      "SELECT * FROM channel_pairing_codes WHERE code = ? AND channel_id = ? AND expires_at > ?",
      [body.code, body.channel_id, now],
    ) as any;
    if (codeRows.length === 0) {
      sendJson(res, 200, { success: false, error: "Invalid or expired pairing code" });
      return;
    }
    const pairingCode = codeRows[0];
    const bindingId = crypto.randomUUID();
    try {
      const upsert = buildUpsert(
        db,
        "channel_bindings",
        ["id", "channel_id", "agent_id", "route_key", "route_type", "created_by"],
        [bindingId, body.channel_id, pairingCode.agent_id, body.route_key, body.route_type, pairingCode.created_by],
        ["channel_id", "route_key"],
        ["agent_id", "route_type", "created_by"],
      );
      await db.query(upsert.sql, upsert.params);
    } catch (err: any) {
      sendJson(res, 200, { success: false, error: `Failed to create binding: ${err.message}` });
      return;
    }
    await db.query("DELETE FROM channel_pairing_codes WHERE code = ?", [body.code]);
    let agentName = pairingCode.agent_id;
    try {
      const [agentRows] = await db.query(
        "SELECT name FROM agents WHERE id = ?",
        [pairingCode.agent_id],
      ) as any;
      if (agentRows.length > 0) agentName = agentRows[0].name;
    } catch { /* ignore */ }
    sendJson(res, 200, { success: true, agentName });
  });

  // ================================================================
  // System config — key-value store
  // ================================================================

  // GET /api/internal/siclaw/system-config
  router.get("/api/internal/siclaw/system-config", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const db = getDb();
    const [rows] = await db.query(
      "SELECT config_key, config_value FROM system_config",
    ) as any;
    const config: Record<string, string> = {};
    for (const row of rows) {
      if (row.config_value != null) config[row.config_key] = row.config_value;
    }
    sendJson(res, 200, { config });
  });

  // POST /api/internal/siclaw/system-config
  router.post("/api/internal/siclaw/system-config", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ key: string; value: string; updated_by: string }>(req);
    const db = getDb();
    const upsert = buildUpsert(
      db,
      "system_config",
      ["config_key", "config_value", "updated_by"],
      [body.key, body.value, body.updated_by],
      ["config_key"],
      ["config_value", "updated_by", { col: "updated_at", expr: "CURRENT_TIMESTAMP" }],
    );
    await db.query(upsert.sql, upsert.params);
    sendJson(res, 200, { ok: true });
  });

  // ================================================================
  // Chat messages — read messages for session
  // ================================================================

  // POST /api/internal/siclaw/chat/messages
  router.post("/api/internal/siclaw/chat/messages", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const body = await parseBody<{ session_id: string; before?: string; limit?: number }>(req);
    const db = getDb();
    const limit = body.limit ?? 50;
    const params: unknown[] = [body.session_id];
    let where = "session_id = ?";
    if (body.before) {
      where += " AND created_at < ?";
      params.push(toSqlTimestamp(body.before));
    }
    params.push(limit);
    const [rows] = await db.query(
      `SELECT id, session_id, role, content, tool_name, tool_input, metadata, outcome, duration_ms,
              from_agent_id, parent_session_id, delegation_id, target_agent_id, created_at
       FROM chat_messages WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    ) as any;
    for (const row of rows as any[]) {
      if (row.metadata !== undefined) row.metadata = safeParseJson(row.metadata, null);
    }
    sendJson(res, 200, { messages: rows });
  });

  // ================================================================
  // Default model provider — for AI security reviewer
  // ================================================================

  // GET /api/internal/siclaw/model-provider/default
  router.get("/api/internal/siclaw/model-provider/default", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const db = getDb();
    const [providers] = await db.query(
      "SELECT id, base_url, api_key, api_type FROM model_providers ORDER BY sort_order ASC LIMIT 1",
    ) as any;
    if (providers.length === 0) {
      sendJson(res, 200, { provider: null });
      return;
    }
    const provider = providers[0];
    const [models] = await db.query(
      "SELECT model_id FROM model_entries WHERE provider_id = ? ORDER BY is_default DESC, sort_order ASC LIMIT 1",
      [provider.id],
    ) as any;
    if (models.length === 0) {
      sendJson(res, 200, { provider: null });
      return;
    }
    sendJson(res, 200, { provider, model: models[0] });
  });

  // ================================================================
  // Metrics — summary + audit (moved from Runtime)
  // ================================================================

  // GET /api/internal/siclaw/metrics/summary
  router.get("/api/internal/siclaw/metrics/summary", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const qIdx = (req.url ?? "").indexOf("?");
    const qs = qIdx >= 0 ? new URLSearchParams((req.url ?? "").slice(qIdx + 1)) : new URLSearchParams();
    const period = qs.get("period") || "7d";
    const periods: Record<string, number> = { today: 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
    const rangeMs = periods[period];
    if (!rangeMs) { sendJson(res, 400, { error: "Invalid period" }); return; }
    const cutoff = new Date(Date.now() - rangeMs);
    const userFilter = qs.get("userId") || null;

    const db = getDb();
    const sessionParams: unknown[] = [cutoff];
    let totalSessionsSql = "SELECT COUNT(*) AS c FROM chat_sessions WHERE created_at >= ? AND (origin IS NULL OR origin NOT IN ('task', 'delegation'))";
    if (userFilter) { totalSessionsSql += " AND user_id = ?"; sessionParams.push(userFilter); }
    const [sRows] = await db.query(totalSessionsSql, sessionParams) as any;
    const totalSessions = Number(sRows[0]?.c ?? 0);

    const pParams: unknown[] = [cutoff];
    let totalPromptsSql = `SELECT COUNT(*) AS c FROM chat_messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.role = 'user' AND m.created_at >= ?
        AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))
        AND (m.metadata IS NULL OR m.metadata NOT LIKE '%"kind":"delegation_event"%')`;
    if (userFilter) { totalPromptsSql += " AND s.user_id = ?"; pParams.push(userFilter); }
    const [pRows] = await db.query(totalPromptsSql, pParams) as any;
    const totalPrompts = Number(pRows[0]?.c ?? 0);

    let byUser: Array<{ userId: string; sessions: number; messages: number }> = [];
    if (!userFilter) {
      const [uRows] = await db.query(
        `SELECT s.user_id AS userId, COUNT(DISTINCT s.id) AS sessions, SUM(s.message_count) AS messages
         FROM chat_sessions s WHERE s.created_at >= ?
           AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))
         GROUP BY s.user_id ORDER BY sessions DESC LIMIT 50`,
        [cutoff],
      ) as any;
      byUser = uRows.map((r: any) => ({ userId: r.userId, sessions: Number(r.sessions), messages: Number(r.messages ?? 0) }));
    }
    sendJson(res, 200, { totalSessions, totalPrompts, byUser });
  });

  // GET /api/internal/siclaw/metrics/audit
  router.get("/api/internal/siclaw/metrics/audit", async (req, res) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const qIdx = (req.url ?? "").indexOf("?");
    const qs = qIdx >= 0 ? new URLSearchParams((req.url ?? "").slice(qIdx + 1)) : new URLSearchParams();
    const limit = Math.min(200, Math.max(1, parseInt(qs.get("limit") || "50", 10)));
    const startDate = qs.get("startDate") ? new Date(qs.get("startDate")!) : new Date(Date.now() - 86_400_000);
    const endDate = qs.get("endDate") ? new Date(qs.get("endDate")!) : new Date();

    const conds: string[] = ["m.role = 'tool'", "m.created_at BETWEEN ? AND ?"];
    const params: unknown[] = [startDate, endDate];
    if (qs.get("userId")) { conds.push("s.user_id = ?"); params.push(qs.get("userId")); }
    if (qs.get("toolName")) { conds.push("m.tool_name = ?"); params.push(qs.get("toolName")); }
    if (qs.get("outcome")) { conds.push("m.outcome = ?"); params.push(qs.get("outcome")); }
    if (qs.get("cursorTs") && qs.get("cursorId")) {
      const cursorDate = new Date(parseInt(qs.get("cursorTs")!, 10));
      conds.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      params.push(cursorDate, cursorDate, qs.get("cursorId"));
    }
    params.push(limit + 1);

    const db = getDb();
    const [rows] = await db.query(
      `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName,
              SUBSTR(m.tool_input, 1, 500) AS toolInput,
              m.outcome, m.duration_ms AS durationMs, m.created_at AS timestamp,
              s.user_id AS userId, s.agent_id AS agentId
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON m.session_id = s.id
       WHERE ${conds.join(" AND ")}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
      params,
    ) as any;
    const hasMore = rows.length > limit;
    const logs = rows.slice(0, limit).map((r: any) => ({
      id: r.id, sessionId: r.sessionId, userId: r.userId, agentId: r.agentId,
      toolName: r.toolName, toolInput: r.toolInput, outcome: r.outcome,
      durationMs: r.durationMs, timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    }));
    sendJson(res, 200, { logs, hasMore });
  });

  // GET /api/internal/siclaw/metrics/audit/:id
  router.get("/api/internal/siclaw/metrics/audit/:id", async (req, res, params) => {
    if (!requireInternalAuth(req, internalSecret)) {
      sendJson(res, 401, { error: "Invalid internal token" });
      return;
    }
    const db = getDb();
    const [rows] = await db.query(
      `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName, m.tool_input AS toolInput,
              m.outcome, m.duration_ms AS durationMs, m.content, m.created_at AS timestamp,
              s.user_id AS userId, s.agent_id AS agentId
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON m.session_id = s.id
       WHERE m.id = ? AND m.role = 'tool'`,
      [params.id],
    ) as any;
    if (!rows.length) { sendJson(res, 404, { error: "Not found" }); return; }
    const r = rows[0];
    sendJson(res, 200, {
      id: r.id, sessionId: r.sessionId, userId: r.userId, agentId: r.agentId,
      toolName: r.toolName, toolInput: r.toolInput, content: r.content,
      outcome: r.outcome, durationMs: r.durationMs,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    });
  });
}

// ================================================================
// WS RPC handler registry — parallel dispatch layer for phone-home
// ================================================================

export function buildAdapterRpcHandlers(): Map<string, (params: any, agentId: string) => Promise<any>> {
  const handlers = new Map<string, (params: any, agentId: string) => Promise<any>>();

  // --- config.* ---

  handlers.set("config.getAgent", async (params) => {
    const db = getDb();
    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [params.agentId]) as any;
    if (rows.length === 0) throw new Error("Agent not found");
    const agent = rows[0];
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      model_provider: agent.model_provider,
      model_id: agent.model_id,
      system_prompt: agent.system_prompt,
      icon: agent.icon,
      color: agent.color,
    };
  });

  handlers.set("config.getResources", async (params) => {
    const db = getDb();
    const agentId = params.agentId;
    const [[clusters], [hosts], [skills], [mcpServers], [knowledgeRepos], [agentRows]] = await Promise.all([
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
        "SELECT repo_id FROM agent_knowledge_repos WHERE agent_id = ?",
        [agentId],
      ),
      db.query(
        "SELECT is_production FROM agents WHERE id = ?",
        [agentId],
      ),
    ]) as any;
    const isProduction = agentRows.length > 0 ? !!agentRows[0].is_production : true;
    return {
      clusters,
      hosts,
      skill_ids: skills.map((r: { skill_id: string }) => r.skill_id),
      mcp_server_ids: mcpServers.map((r: { mcp_server_id: string }) => r.mcp_server_id),
      knowledge_repo_ids: (knowledgeRepos as any[]).map((r: any) => r.repo_id),
      is_production: isProduction,
    };
  });

  handlers.set("config.getSettings", async (params) => {
    const db = getDb();
    const [agentRows] = await db.query(
      "SELECT model_provider, model_id FROM agents WHERE id = ?",
      [params.agentId],
    ) as any;
    if (agentRows.length === 0 || !agentRows[0].model_provider) {
      return { providers: {} };
    }
    const agent = agentRows[0] as { model_provider: string; model_id: string };
    const [providerRows] = await db.query(
      "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
      [agent.model_provider],
    ) as any;
    if (providerRows.length === 0) {
      return { providers: {} };
    }
    const p = providerRows[0];
    const [modelRows] = await db.query(
      `SELECT model_id, name, reasoning, context_window, max_tokens
       FROM model_entries WHERE provider_id = ? ORDER BY sort_order, created_at`,
      [p.id],
    ) as any;
    return {
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
    };
  });

  handlers.set("config.getModelBinding", async (params) => {
    const db = getDb();
    const [agentRows] = await db.query(
      "SELECT model_provider, model_id FROM agents WHERE id = ?",
      [params.agentId],
    ) as any;
    const agent = agentRows[0] as { model_provider?: string; model_id?: string } | undefined;
    if (!agent?.model_provider || !agent?.model_id) {
      return { binding: null };
    }
    const [providerRows] = await db.query(
      "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
      [agent.model_provider],
    ) as any;
    if (providerRows.length === 0) {
      return { binding: null };
    }
    const p = providerRows[0];
    const [entryRows] = await db.query(
      "SELECT model_id, name, reasoning, context_window, max_tokens FROM model_entries WHERE provider_id = ?",
      [p.id],
    ) as any;
    const models = (entryRows as any[]).map((m: any) => ({
      id: m.model_id,
      name: m.name ?? m.model_id,
      reasoning: !!m.reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window,
      maxTokens: m.max_tokens,
    }));
    return {
      binding: {
        modelProvider: p.name,
        modelId: agent.model_id,
        modelConfig: {
          name: p.name,
          baseUrl: p.base_url,
          apiKey: p.api_key ?? "",
          api: p.api_type,
          authHeader: true,
          models,
        },
      },
    };
  });

  handlers.set("config.getMcpServers", async (params) => {
    if (!params.ids?.length) {
      return { mcpServers: {} };
    }
    const db = getDb();
    const placeholders = params.ids.map(() => "?").join(",");
    const [rows] = await db.query(
      `SELECT name, transport, url, command, args, env, headers, enabled
       FROM mcp_servers WHERE id IN (${placeholders}) AND enabled = 1`,
      params.ids,
    ) as any;
    const mcpServers: Record<string, unknown> = {};
    for (const row of rows) {
      mcpServers[row.name] = {
        transport: row.transport,
        ...(row.url ? { url: row.url } : {}),
        ...(row.command ? { command: row.command } : {}),
        ...(row.args ? { args: safeParseJson(row.args, []) } : {}),
        ...(row.env ? { env: safeParseJson(row.env, {}) } : {}),
        ...(row.headers ? { headers: safeParseJson(row.headers, {}) } : {}),
      };
    }
    return { mcpServers };
  });

  handlers.set("config.getSkillBundle", async (params) => {
    const skillIds = params.skill_ids ?? [];
    const isProduction = params.is_production ?? true;
    if (skillIds.length === 0) {
      return { version: new Date().toISOString(), skills: [] };
    }
    const db = getDb();
    let rows: any[];
    if (isProduction) {
      const placeholders = skillIds.map(() => "?").join(",");
      const [result] = await db.query(
        `SELECT s.id, s.name, s.labels, sv.specs, sv.scripts
         FROM skills s
         JOIN skill_versions sv ON sv.skill_id = s.id AND sv.is_approved = 1
         WHERE s.id IN (${placeholders})
           AND sv.version = (
             SELECT MAX(sv2.version) FROM skill_versions sv2
             WHERE sv2.skill_id = s.id AND sv2.is_approved = 1
           )`,
        skillIds,
      ) as any;
      rows = result;
    } else {
      const placeholders = skillIds.map(() => "?").join(",");
      const [result] = await db.query(
        `SELECT id, name, labels, specs, scripts FROM skills WHERE id IN (${placeholders})`,
        skillIds,
      ) as any;
      rows = result;
    }
    const skills = rows.map((row: any) => ({
      dirName: row.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
      scope: "global",
      specs: row.specs || "",
      scripts: safeParseJson(row.scripts, []),
    }));
    return { version: new Date().toISOString(), skills };
  });

  handlers.set("config.getKnowledgeBundle", async (params) => {
    const agentId = params.agentId as string | undefined;
    const db = getDb();

    // Get bound repo IDs for this agent (like skill filtering)
    let repoIds: string[] = [];
    if (agentId) {
      const [bindings] = await db.query(
        "SELECT repo_id FROM agent_knowledge_repos WHERE agent_id = ?",
        [agentId],
      ) as any;
      repoIds = (bindings as any[]).map((r: any) => r.repo_id);
    }

    if (repoIds.length === 0) {
      return { version: "1", repos: [] };
    }

    const placeholders = repoIds.map(() => "?").join(",");
    const [rows] = await db.query(
      `SELECT r.id AS repo_id, r.name, v.version, v.message, v.data, v.size_bytes,
              v.sha256, v.file_count
       FROM knowledge_repos r
       JOIN knowledge_versions v ON v.repo_id = r.id
       WHERE v.is_active = 1 AND r.id IN (${placeholders})
       ORDER BY r.name`,
      repoIds,
    ) as any;

    return {
      version: "1",
      repos: (rows as any[]).map((row: any) => {
        const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
        return {
          id: row.repo_id,
          name: row.name,
          version: Number(row.version),
          message: row.message ?? null,
          sha256: row.sha256 ?? crypto.createHash("sha256").update(data).digest("hex"),
          sizeBytes: Number(row.size_bytes ?? data.length),
          fileCount: row.file_count == null ? null : Number(row.file_count),
          dataBase64: data.toString("base64"),
        };
      }),
    };
  });

  handlers.set("config.getSystemConfig", async () => {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT config_key, config_value FROM system_config",
    ) as any;
    const config: Record<string, string> = {};
    for (const row of rows) {
      if (row.config_value != null) config[row.config_key] = row.config_value;
    }
    return { config };
  });

  handlers.set("config.setSystemConfig", async (params) => {
    const db = getDb();
    const upsert = buildUpsert(
      db,
      "system_config",
      ["config_key", "config_value", "updated_by"],
      [params.key, params.value, params.updated_by],
      ["config_key"],
      ["config_value", "updated_by", { col: "updated_at", expr: "CURRENT_TIMESTAMP" }],
    );
    await db.query(upsert.sql, upsert.params);
    return { ok: true };
  });

  handlers.set("config.getDefaultModel", async () => {
    const db = getDb();
    const [providers] = await db.query(
      "SELECT id, base_url, api_key, api_type FROM model_providers ORDER BY sort_order ASC LIMIT 1",
    ) as any;
    if (providers.length === 0) {
      return { provider: null };
    }
    const provider = providers[0];
    const [models] = await db.query(
      "SELECT model_id FROM model_entries WHERE provider_id = ? ORDER BY is_default DESC, sort_order ASC LIMIT 1",
      [provider.id],
    ) as any;
    if (models.length === 0) {
      return { provider: null };
    }
    return { provider, model: models[0] };
  });

  // --- credential.* ---

  handlers.set("credential.list", async (params, connectionAgentId) => {
    // Prefer params.agentId (the agent's real UUID, vouched for by Runtime
    // after mTLS-verifying the AgentBox) over the WS-connection agentId. In
    // phone-home architecture the Runtime opens a single WS registered as
    // "runtime" for ALL agents, so connection-level agentId is a placeholder
    // and can never match an agent_clusters / agent_hosts row. Fall back to
    // connectionAgentId for legacy callers that still rely on it (covered
    // by adapter-rpc.test.ts).
    const agentId = (params.agentId as string | undefined) ?? connectionAgentId;
    if (!agentId) throw new Error("agentId required");
    const db = getDb();
    if (params.kind === "host" || params.kind === "hosts") {
      const [rows] = await db.query(
        `SELECT h.name, h.ip, h.port, h.username, h.auth_type, h.is_production, h.description
         FROM agent_hosts ah JOIN hosts h ON ah.host_id = h.id WHERE ah.agent_id = ?`,
        [agentId],
      ) as any;
      return {
        hosts: rows.map((r: any) => ({
          name: r.name, ip: r.ip, port: r.port, username: r.username,
          auth_type: r.auth_type, is_production: !!r.is_production,
          ...(r.description ? { description: r.description } : {}),
        })),
      };
    }
    // Default: clusters
    const [rows] = await db.query(
      `SELECT c.name, c.api_server, c.is_production, c.kubeconfig, c.description, c.debug_image
       FROM agent_clusters ac JOIN clusters c ON ac.cluster_id = c.id WHERE ac.agent_id = ?`,
      [agentId],
    ) as any;
    return {
      clusters: rows.map((r: any) => ({
        name: r.name, is_production: !!r.is_production,
        ...(r.api_server ? { api_server: r.api_server } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.debug_image ? { debug_image: r.debug_image } : {}),
      })),
    };
  });

  handlers.set("credential.get", async (params, connectionAgentId) => {
    if (!params.source || !params.source_id) {
      throw new Error("source and source_id are required");
    }
    // See credential.list for why params.agentId takes precedence. Fall
    // back to connectionAgentId for legacy callers.
    const agentId = (params.agentId as string | undefined) ?? connectionAgentId;
    const db = getDb();

    if (params.source === "cluster") {
      // source_id is the cluster's NAME. Look up by name first, then use the
      // resolved UUID for the agent-binding check.
      const [rows] = await db.query(
        "SELECT id, name, kubeconfig FROM clusters WHERE name = ?",
        [params.source_id],
      ) as any;
      if (rows.length === 0) throw new Error("Cluster not found");
      const cluster = rows[0];

      if (agentId) {
        const [binding] = await db.query(
          "SELECT 1 FROM agent_clusters WHERE agent_id = ? AND cluster_id = ?",
          [agentId, cluster.id],
        ) as any;
        if (binding.length === 0) throw new Error("Agent not bound to this cluster");
      }
      return {
        credential: {
          name: cluster.name,
          type: "kubeconfig",
          files: [{ name: "cluster.kubeconfig", content: cluster.kubeconfig }],
          ttl_seconds: 300,
        },
      };
    }

    if (params.source === "host") {
      // source_id is the host's NAME — see cluster branch above.
      const [rows] = await db.query(
        "SELECT id, name, ip, port, username, auth_type, password, private_key, is_production, description FROM hosts WHERE name = ?",
        [params.source_id],
      ) as any;
      if (rows.length === 0) throw new Error("Host not found");
      const host = rows[0];

      if (agentId) {
        const [binding] = await db.query(
          "SELECT 1 FROM agent_hosts WHERE agent_id = ? AND host_id = ?",
          [agentId, host.id],
        ) as any;
        if (binding.length === 0) throw new Error("Agent not bound to this host");
      }
      const files: { name: string; content: string; mode?: number }[] = [];
      if (host.auth_type === "key") {
        if (!host.private_key) {
          throw new Error(`Host "${host.name}" has auth_type="key" but private_key is empty`);
        }
        files.push({ name: "host.key", content: host.private_key, mode: 0o600 });
      } else if (host.auth_type === "password") {
        if (!host.password) {
          throw new Error(`Host "${host.name}" has auth_type="password" but password is empty`);
        }
        files.push({ name: "host.password", content: host.password });
      } else {
        throw new Error(`Host "${host.name}" has unknown auth_type=${JSON.stringify(host.auth_type)}`);
      }
      return {
        credential: {
          name: host.name,
          type: "ssh",
          files,
          metadata: {
            ip: host.ip,
            port: host.port,
            username: host.username,
            auth_type: host.auth_type,
            is_production: !!host.is_production,
            ...(host.description ? { description: host.description } : {}),
          },
          ttl_seconds: 300,
        },
      };
    }

    throw new Error(`Unknown source type: ${params.source}`);
  });

  handlers.set("credential.checkAccess", async (params) => {
    if (params.action === "review" && params.user_id) {
      const db = getDb();
      const [rows] = await db.query(
        "SELECT role, can_review_skills FROM siclaw_users WHERE id = ?",
        [params.user_id],
      ) as any;
      if (rows.length === 0) {
        return { allowed: false, grant_all: false, agent_group_ids: [] };
      }
      const user = rows[0];
      const allowed = user.role === "admin" || !!user.can_review_skills;
      return { allowed, grant_all: allowed, agent_group_ids: [] };
    }
    return { allowed: true, grant_all: true, agent_group_ids: [] };
  });

  handlers.set("credential.resourceManifest", async (params, connectionAgentId) => {
    const db = getDb();
    // Prefer params.agentId (camel, matches credential.list/get), then
    // params.agent_id (snake, legacy), then connection-level as final fallback.
    const effectiveAgentId = (params.agentId ?? params.agent_id ?? connectionAgentId) as string | undefined;
    if (!effectiveAgentId) throw new Error("agent_id required");
    const [[clusters], [hosts]] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.api_server, 'cluster' AS type FROM agent_clusters ac
         JOIN clusters c ON ac.cluster_id = c.id WHERE ac.agent_id = ?`,
        [effectiveAgentId],
      ),
      db.query(
        `SELECT h.id, h.name, h.ip, h.port, h.username, h.auth_type, 'host' AS type FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id WHERE ah.agent_id = ?`,
        [effectiveAgentId],
      ),
    ]) as any;
    return { resources: [...clusters, ...hosts] };
  });

  handlers.set("credential.hostSearch", async (params, connectionAgentId) => {
    const db = getDb();
    const effectiveAgentId = (params.agentId ?? params.agent_id ?? connectionAgentId) as string | undefined;
    let sql: string;
    const sqlParams: unknown[] = [];

    if (effectiveAgentId) {
      sql = `SELECT h.id, h.name, h.ip, h.port, h.username, h.auth_type, h.description
             FROM agent_hosts ah
             JOIN hosts h ON ah.host_id = h.id
             WHERE ah.agent_id = ?`;
      sqlParams.push(effectiveAgentId);
      if (params.query) {
        sql += " AND (h.name LIKE ? OR h.ip LIKE ? OR h.description LIKE ?)";
        sqlParams.push(`%${params.query}%`, `%${params.query}%`, `%${params.query}%`);
      }
    } else {
      sql = "SELECT id, name, ip, port, username, auth_type, description FROM hosts";
      if (params.query) {
        sql += " WHERE name LIKE ? OR ip LIKE ? OR description LIKE ?";
        sqlParams.push(`%${params.query}%`, `%${params.query}%`, `%${params.query}%`);
      }
    }
    const [rows] = await db.query(sql, sqlParams) as any;
    return { hosts: rows };
  });

  // --- chat.* ---

  /**
   * Verify the calling Runtime owns `sessionId` before mutating it.
   *
   * The chat.* RPCs receive the connection's authenticated agentId as the
   * second arg from buildAdapterRpcHandlers. Without this check, a buggy
   * or compromised Runtime could write rows into another agent's chat
   * session by passing an arbitrary session_id in the body. internal-api's
   * validateDelegationEventActor already covers the delegation.* event
   * surface; this closes the gap on the plain chat.* RPC surface
   * (chent1996 review #4 / jacoblee #6).
   *
   * Permissive on "session not found" so first-write call paths can still
   * land — the adapter's caller is expected to chat.ensureSession first,
   * which sets agent_id atomically and is itself protected by the same
   * authentication.
   */
  async function assertSessionBelongsToAgent(
    db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    sessionId: string,
    callerAgentId: string,
  ): Promise<void> {
    if (!callerAgentId) return;
    if (!sessionId) return;
    const [rows] = (await db.query(
      "SELECT agent_id FROM chat_sessions WHERE id = ?",
      [sessionId],
    )) as [Array<{ agent_id: string | null }>, unknown];
    if (rows.length === 0) return;
    const ownerAgentId = rows[0].agent_id;
    if (ownerAgentId && ownerAgentId !== callerAgentId) {
      throw new Error(`session ${sessionId} not owned by agent ${callerAgentId}`);
    }
  }

  handlers.set("chat.ensureSession", async (params) => {
    const db = getDb();
    // last_active_at omitted: relies on schema DEFAULT CURRENT_TIMESTAMP for
    // new rows, and the updateColumns expression for conflicts. Passing a
    // JS ISO string ("2026-04-22T...Z") would be rejected by MySQL TIMESTAMP.
    const upsert = buildUpsert(
      db,
      "chat_sessions",
      ["id", "agent_id", "user_id", "title", "preview", "message_count", "origin", "parent_session_id", "parent_agent_id", "delegation_id", "target_agent_id"],
      [params.session_id, params.agent_id, params.user_id,
       params.title || "New Session", params.preview || null, 0, params.origin || null,
       params.parent_session_id ?? null, params.parent_agent_id ?? null,
       params.delegation_id ?? null, params.target_agent_id ?? null],
      ["id"],
      [{ col: "last_active_at", expr: "CURRENT_TIMESTAMP" }],
    );
    await db.query(upsert.sql, upsert.params);
    return { ok: true };
  });

  handlers.set("chat.appendMessage", async (params, agentId) => {
    const id = crypto.randomUUID();
    const db = getDb();
    await assertSessionBelongsToAgent(db, params.session_id, agentId);
    await db.query(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_name, tool_input, metadata, outcome, duration_ms, from_agent_id, parent_session_id, delegation_id, target_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, params.session_id, params.role, params.content,
       params.tool_name || null, params.tool_input || null,
       jsonParam(params.metadata),
       params.outcome || null, params.duration_ms ?? null,
       params.from_agent_id ?? null, params.parent_session_id ?? null,
       params.delegation_id ?? null, params.target_agent_id ?? null],
    );
    await db.query(
      `UPDATE chat_sessions SET message_count = message_count + 1, last_active_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [params.session_id],
    );
    return { id };
  });

  handlers.set("chat.updateMessage", async (params, agentId) => {
    const db = getDb();
    await assertSessionBelongsToAgent(db, params.session_id, agentId);
    await db.query(
      `UPDATE chat_messages
       SET content = ?, tool_name = ?, tool_input = ?, metadata = ?, outcome = ?, duration_ms = ?,
           delegation_id = COALESCE(?, delegation_id)
       WHERE id = ? AND session_id = ?`,
      [
        params.content ?? "",
        params.tool_name || null,
        params.tool_input || null,
        jsonParam(params.metadata),
        params.outcome || null,
        params.duration_ms ?? null,
        params.delegation_id ?? null,
        params.id,
        params.session_id,
      ],
    );
    await db.query(
      `UPDATE chat_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [params.session_id],
    );
    return { ok: true };
  });

  handlers.set("chat.updateDelegationToolMessage", async (params, agentId) => {
    const db = getDb();
    await assertSessionBelongsToAgent(db, params.session_id, agentId);
    await db.query(
      `UPDATE chat_messages
       SET content = ?, metadata = ?, outcome = ?, duration_ms = ?
       WHERE session_id = ? AND role = 'tool' AND tool_name = ? AND delegation_id = ?`,
      [
        params.content ?? "",
        jsonParam(params.metadata),
        params.outcome || null,
        params.duration_ms ?? null,
        params.session_id,
        params.tool_name,
        params.delegation_id,
      ],
    );
    await db.query(
      `UPDATE chat_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [params.session_id],
    );
    return { ok: true };
  });

  handlers.set("chat.getMessages", async (params) => {
    const db = getDb();
    const limit = params.limit ?? 50;
    const sqlParams: unknown[] = [params.session_id];
    let where = "session_id = ?";
    if (params.before) {
      where += " AND created_at < ?";
      sqlParams.push(toSqlTimestamp(params.before));
    }
    sqlParams.push(limit);
    const [rows] = await db.query(
      `SELECT id, session_id, role, content, tool_name, tool_input, metadata, outcome, duration_ms,
              from_agent_id, parent_session_id, delegation_id, target_agent_id, created_at
       FROM chat_messages WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      sqlParams,
    ) as any;
    for (const row of rows as any[]) {
      if (row.metadata !== undefined) row.metadata = safeParseJson(row.metadata, null);
    }
    return { messages: rows };
  });

  // --- task.* ---

  handlers.set("task.listActive", async () => {
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status, created_by, last_run_at, last_result
       FROM agent_tasks WHERE status = 'active'`,
    ) as any;
    return { data: rows };
  });

  handlers.set("task.getStatus", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT status FROM agent_tasks WHERE id = ? LIMIT 1",
      [params.taskId],
    ) as any;
    if (rows.length === 0) {
      return { status: null };
    }
    return { status: rows[0].status };
  });

  handlers.set("task.list", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, name, schedule, status, description, prompt, last_run_at, last_result
       FROM agent_tasks WHERE agent_id = ? AND created_by = ? AND status = 'active'
       ORDER BY created_at, id`,
      [params.agent_id, params.user_id],
    ) as any;
    return { tasks: rows };
  });

  handlers.set("task.create", async (params) => {
    const db = getDb();
    await db.query(
      `INSERT INTO agent_tasks (id, agent_id, name, description, schedule, prompt, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [params.id, params.agent_id, params.name, params.description ?? null,
       params.schedule, params.prompt, params.status ?? "active", params.user_id],
    );
    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [params.id]) as any;
    return rows[0];
  });

  handlers.set("task.update", async (params) => {
    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [params.task_id, params.agent_id, params.user_id],
    ) as any;
    if (existing.length === 0) throw new Error("Task not found");
    await db.query(
      `UPDATE agent_tasks SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         schedule = COALESCE(?, schedule),
         prompt = COALESCE(?, prompt),
         status = COALESCE(?, status),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [params.name ?? null, params.description ?? null, params.schedule ?? null,
       params.prompt ?? null, params.status ?? null, params.task_id],
    );
    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [params.task_id]) as any;
    return rows[0];
  });

  handlers.set("task.delete", async (params) => {
    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [params.task_id, params.agent_id, params.user_id],
    ) as any;
    if (existing.length === 0) throw new Error("Task not found");
    await db.query("DELETE FROM agent_tasks WHERE id = ?", [params.task_id]);
    return { ok: true };
  });

  handlers.set("task.runRecord", async (params) => {
    const db = getDb();
    await db.query(
      `INSERT INTO agent_task_runs (id, task_id, status, result_text, error, duration_ms, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [params.id, params.task_id, params.status,
       params.result_text || null, params.error || null,
       params.duration_ms ?? null, params.session_id || null],
    );
    await db.query(
      `UPDATE agent_tasks SET last_run_at = CURRENT_TIMESTAMP, last_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [params.status, params.task_id],
    );
    return { ok: true };
  });

  handlers.set("task.runStart", async (params) => {
    const db = getDb();
    await db.query(
      `INSERT INTO agent_task_runs (id, task_id, status, session_id)
       VALUES (?, ?, 'running', ?)`,
      [params.id, params.task_id, params.session_id],
    );
    return { id: params.id };
  });

  handlers.set("task.runFinalize", async (params) => {
    const db = getDb();
    await db.query(
      `UPDATE agent_task_runs
         SET status = ?, result_text = ?, error = ?, duration_ms = ?
       WHERE id = ?`,
      [params.status, params.result_text, params.error ?? null, params.duration_ms, params.run_id],
    );
    return { ok: true };
  });

  handlers.set("task.updateMeta", async (params) => {
    const db = getDb();
    await db.query(
      `UPDATE agent_tasks SET last_run_at = CURRENT_TIMESTAMP, last_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [params.last_result, params.task_id],
    );
    return { ok: true };
  });

  handlers.set("task.fireNow", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status, created_by,
              last_run_at, last_result, last_manual_run_at
       FROM agent_tasks WHERE id = ? LIMIT 1`,
      [params.task_id],
    ) as any;
    if (rows.length === 0) {
      return { outcome: "not_found" };
    }
    const row = rows[0];
    const [inflight] = await db.query(
      "SELECT id FROM agent_task_runs WHERE task_id = ? AND status = 'running' LIMIT 1",
      [params.task_id],
    ) as any;
    if (inflight.length > 0) {
      return { outcome: "in_flight" };
    }
    if (row.last_manual_run_at) {
      const elapsed = (Date.now() - new Date(row.last_manual_run_at).getTime()) / 1000;
      if (elapsed < params.cooldown_sec) {
        return { outcome: "cooldown", retry_after_sec: Math.ceil(params.cooldown_sec - elapsed) };
      }
    }
    await db.query(
      "UPDATE agent_tasks SET last_manual_run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [params.task_id],
    );
    return { outcome: "ok", task: row };
  });

  // Runtime's TaskCoordinator emits this after each cron run completes.
  // Missing handler = silent drop = no NotificationBell update = user
  // thinks the task never ran. The HTTP /api/internal/task-notify route
  // already existed but no caller reached it; the Runtime uses the RPC path.
  handlers.set("task.notify", async (params) => {
    if (!params.userId || !params.taskId || !params.status) {
      throw new Error("userId, taskId, status are required");
    }
    const { id } = await createTaskNotification({
      userId: params.userId as string,
      taskId: params.taskId as string,
      status: params.status as string,
      agentId: params.agentId as string | undefined,
      runId: params.runId as string | undefined,
      title: params.title as string | undefined,
      message: params.message as string | undefined,
    });
    return { id };
  });

  handlers.set("task.prune", async (params) => {
    const db = getDb();
    const days = params.retention_days;
    const cutoff = toSqlTimestamp(Date.now() - days * 86400e3);
    const [sessResult] = await db.query(
      `DELETE FROM chat_sessions
       WHERE origin IN ('task', 'delegation') AND last_active_at < ?`,
      [cutoff],
    ) as any;
    const [runsResult] = await db.query(
      `DELETE FROM agent_task_runs WHERE created_at < ?`,
      [cutoff],
    ) as any;
    return {
      sessions_deleted: sessResult?.affectedRows ?? 0,
      runs_deleted: runsResult?.affectedRows ?? 0,
    };
  });

  // --- channel.* ---

  handlers.set("channel.list", async () => {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM channels WHERE status = 'active' ORDER BY created_at, id",
    ) as any;
    for (const row of rows as any[]) {
      if (row.config !== undefined) row.config = safeParseJson(row.config, null);
    }
    return { data: rows };
  });

  handlers.set("channel.resolveBinding", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT id, agent_id FROM channel_bindings WHERE channel_id = ? AND route_key = ?",
      [params.channel_id, params.route_key],
    ) as any;
    if (rows.length === 0) {
      return { binding: null };
    }
    return { binding: { agentId: rows[0].agent_id, bindingId: rows[0].id } };
  });

  handlers.set("channel.pair", async (params) => {
    const db = getDb();
    const now = toSqlTimestamp(new Date());
    const [codeRows] = await db.query(
      "SELECT * FROM channel_pairing_codes WHERE code = ? AND channel_id = ? AND expires_at > ?",
      [params.code, params.channel_id, now],
    ) as any;
    if (codeRows.length === 0) {
      return { success: false, error: "Invalid or expired pairing code" };
    }
    const pairingCode = codeRows[0];
    const bindingId = crypto.randomUUID();
    try {
      const upsert = buildUpsert(
        db,
        "channel_bindings",
        ["id", "channel_id", "agent_id", "route_key", "route_type", "created_by"],
        [bindingId, params.channel_id, pairingCode.agent_id, params.route_key, params.route_type, pairingCode.created_by],
        ["channel_id", "route_key"],
        ["agent_id", "route_type", "created_by"],
      );
      await db.query(upsert.sql, upsert.params);
    } catch (err: any) {
      return { success: false, error: `Failed to create binding: ${err.message}` };
    }
    await db.query("DELETE FROM channel_pairing_codes WHERE code = ?", [params.code]);
    let agentName = pairingCode.agent_id;
    try {
      const [agentRows] = await db.query(
        "SELECT name FROM agents WHERE id = ?",
        [pairingCode.agent_id],
      ) as any;
      if (agentRows.length > 0) agentName = agentRows[0].name;
    } catch { /* ignore */ }
    return { success: true, agentName };
  });

  // --- agent.* ---

  handlers.set("agent.listForSkill", async (params) => {
    const db = getDb();
    const sql = params.dev_only
      ? `SELECT ask.agent_id FROM agent_skills ask
         JOIN agents a ON ask.agent_id = a.id
         WHERE ask.skill_id = ? AND a.is_production = 0`
      : "SELECT agent_id FROM agent_skills WHERE skill_id = ?";
    const [rows] = await db.query(sql, [params.skillId]) as any;
    return { agent_ids: rows.map((r: { agent_id: string }) => r.agent_id) };
  });

  handlers.set("agent.listForMcp", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT agent_id FROM agent_mcp_servers WHERE mcp_server_id = ?",
      [params.mcpId],
    ) as any;
    return { agent_ids: rows.map((r: { agent_id: string }) => r.agent_id) };
  });

  handlers.set("agent.listForCluster", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT agent_id FROM agent_clusters WHERE cluster_id = ?",
      [params.clusterId],
    ) as any;
    return { agent_ids: rows.map((r: { agent_id: string }) => r.agent_id) };
  });

  handlers.set("agent.listForHost", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT agent_id FROM agent_hosts WHERE host_id = ?",
      [params.hostId],
    ) as any;
    return { agent_ids: rows.map((r: { agent_id: string }) => r.agent_id) };
  });

  // --- metrics.* ---

  handlers.set("metrics.summary", async (params) => {
    const period = params.period || "7d";
    const periods: Record<string, number> = { today: 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
    const rangeMs = periods[period];
    if (!rangeMs) throw new Error("Invalid period");
    const cutoff = new Date(Date.now() - rangeMs);
    const userFilter = params.userId || null;

    const db = getDb();
    const sessionParams: unknown[] = [cutoff];
    let totalSessionsSql = "SELECT COUNT(*) AS c FROM chat_sessions WHERE created_at >= ? AND (origin IS NULL OR origin NOT IN ('task', 'delegation'))";
    if (userFilter) { totalSessionsSql += " AND user_id = ?"; sessionParams.push(userFilter); }
    const [sRows] = await db.query(totalSessionsSql, sessionParams) as any;
    const totalSessions = Number(sRows[0]?.c ?? 0);

    const pParams: unknown[] = [cutoff];
    let totalPromptsSql = `SELECT COUNT(*) AS c FROM chat_messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.role = 'user' AND m.created_at >= ?
        AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))
        AND (m.metadata IS NULL OR m.metadata NOT LIKE '%"kind":"delegation_event"%')`;
    if (userFilter) { totalPromptsSql += " AND s.user_id = ?"; pParams.push(userFilter); }
    const [pRows] = await db.query(totalPromptsSql, pParams) as any;
    const totalPrompts = Number(pRows[0]?.c ?? 0);

    let byUser: Array<{ userId: string; sessions: number; messages: number }> = [];
    if (!userFilter) {
      const [uRows] = await db.query(
        `SELECT s.user_id AS userId, COUNT(DISTINCT s.id) AS sessions, SUM(s.message_count) AS messages
         FROM chat_sessions s WHERE s.created_at >= ?
           AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))
         GROUP BY s.user_id ORDER BY sessions DESC LIMIT 50`,
        [cutoff],
      ) as any;
      byUser = uRows.map((r: any) => ({ userId: r.userId, sessions: Number(r.sessions), messages: Number(r.messages ?? 0) }));
    }
    return { totalSessions, totalPrompts, byUser };
  });

  handlers.set("metrics.audit", async (params) => {
    const limit = Math.min(200, Math.max(1, parseInt(params.limit || "50", 10)));
    const startDate = params.startDate ? new Date(params.startDate) : new Date(Date.now() - 86_400_000);
    const endDate = params.endDate ? new Date(params.endDate) : new Date();

    const conds: string[] = ["m.role = 'tool'", "m.created_at BETWEEN ? AND ?"];
    const sqlParams: unknown[] = [startDate, endDate];
    if (params.userId) { conds.push("s.user_id = ?"); sqlParams.push(params.userId); }
    if (params.toolName) { conds.push("m.tool_name = ?"); sqlParams.push(params.toolName); }
    if (params.outcome) { conds.push("m.outcome = ?"); sqlParams.push(params.outcome); }
    if (params.cursorTs && params.cursorId) {
      const cursorDate = new Date(parseInt(params.cursorTs, 10));
      conds.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      sqlParams.push(cursorDate, cursorDate, params.cursorId);
    }
    sqlParams.push(limit + 1);

    const db = getDb();
    const [rows] = await db.query(
      `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName,
              SUBSTR(m.tool_input, 1, 500) AS toolInput,
              m.outcome, m.duration_ms AS durationMs, m.created_at AS timestamp,
              s.user_id AS userId, s.agent_id AS agentId
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON m.session_id = s.id
       WHERE ${conds.join(" AND ")}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
      sqlParams,
    ) as any;
    const hasMore = rows.length > limit;
    const logs = rows.slice(0, limit).map((r: any) => ({
      id: r.id, sessionId: r.sessionId, userId: r.userId, agentId: r.agentId,
      toolName: r.toolName, toolInput: r.toolInput, outcome: r.outcome,
      durationMs: r.durationMs, timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    }));
    return { logs, hasMore };
  });

  handlers.set("metrics.auditDetail", async (params) => {
    const db = getDb();
    const [rows] = await db.query(
      `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName, m.tool_input AS toolInput,
              m.outcome, m.duration_ms AS durationMs, m.content, m.created_at AS timestamp,
              s.user_id AS userId, s.agent_id AS agentId
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON m.session_id = s.id
       WHERE m.id = ? AND m.role = 'tool'`,
      [params.id],
    ) as any;
    if (!rows.length) throw new Error("Not found");
    const r = rows[0];
    return {
      id: r.id, sessionId: r.sessionId, userId: r.userId, agentId: r.agentId,
      toolName: r.toolName, toolInput: r.toolInput, content: r.content,
      outcome: r.outcome, durationMs: r.durationMs,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    };
  });

  return handlers;
}
