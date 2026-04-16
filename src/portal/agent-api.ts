/**
 * Agent CRUD API for the Portal.
 *
 * All agents are globally visible (no org_id filtering).
 * Auth required for every route.
 */

import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  parseQuery,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";
import { requireAdmin } from "./auth.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

export function registerAgentRoutes(
  router: RestRouter,
  jwtSecret: string,
  connectionMap: RuntimeConnectionMap,
): void {
  // GET /api/v1/agents — list (paginated, search)
  router.get("/api/v1/agents", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const query = parseQuery(req.url ?? "");
    const page = Math.max(1, parseInt(query.page ?? "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size ?? "20", 10)));
    const search = query.search ?? "";
    const offset = (page - 1) * pageSize;

    const db = getDb();

    let whereClause = "";
    const params: unknown[] = [];

    if (search) {
      whereClause = "WHERE a.name LIKE ? OR a.description LIKE ?";
      params.push(`%${search}%`, `%${search}%`);
    }

    const countSql = `SELECT COUNT(*) AS total FROM agents a ${whereClause}`;
    const [countRows] = await db.query(countSql, params) as any;
    const total: number = Number(countRows[0].total);

    const listParams = [...params, pageSize, offset];
    const listSql = `SELECT a.id, a.name, a.description, a.status, a.model_provider, a.model_id,
        a.is_production, a.icon, a.color, a.created_by, a.created_at, a.updated_at,
        (SELECT COUNT(*) FROM agent_skills ask WHERE ask.agent_id = a.id) AS skills_count,
        (SELECT COUNT(*) FROM agent_mcp_servers ams WHERE ams.agent_id = a.id) AS mcp_count,
        (SELECT COUNT(*) FROM agent_clusters ac WHERE ac.agent_id = a.id) AS clusters_count,
        (SELECT COUNT(*) FROM agent_hosts ah WHERE ah.agent_id = a.id) AS hosts_count,
        (SELECT COUNT(*) FROM agent_tasks at2 WHERE at2.agent_id = a.id) AS tasks_count,
        (SELECT COUNT(*) FROM agent_tasks at3 WHERE at3.agent_id = a.id AND at3.status = 'active') AS tasks_active_count,
        (SELECT COUNT(*) FROM agent_channel_auth ach WHERE ach.agent_id = a.id) AS channels_count
      FROM agents a ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?`;

    const [listRows] = await db.query(listSql, listParams) as any;
    sendJson(res, 200, { data: listRows, total, page, page_size: pageSize });
  });

  // POST /api/v1/agents — create (admin only)
  router.post("/api/v1/agents", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<Record<string, unknown>>(req);
    if (!body.name) { sendJson(res, 400, { error: "name is required" }); return; }

    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO agents (id, name, description, status, model_provider, model_id, system_prompt, is_production, icon, color, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.description ?? null,
        body.status ?? "active",
        body.model_provider ?? null,
        body.model_id ?? null,
        body.system_prompt ?? null,
        body.is_production ?? 1,
        body.icon ?? null,
        body.color ?? null,
        auth.userId,
      ],
    );

    // Auto-bind builtin skills to new agent
    try {
      const [builtinSkills] = await db.query(
        "SELECT id FROM skills WHERE created_by = 'system' AND status = 'installed'",
      ) as any;
      for (const skill of builtinSkills) {
        await db.query(
          "INSERT IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)",
          [id, skill.id],
        );
      }
    } catch (err) {
      console.warn("[agent-api] Failed to auto-bind builtin skills:", err);
      // Non-fatal — agent is still created successfully
    }

    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // GET /api/v1/agents/:id — get by id
  router.get("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    sendJson(res, 200, rows[0]);
  });

  // PUT /api/v1/agents/:id — update (admin only)
  router.put("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    // Build dynamic SET clause
    const fields = [
      "name", "description", "status", "model_provider",
      "model_id", "system_prompt", "is_production", "icon", "color",
    ];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (field in body) {
        setClauses.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (setClauses.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    setClauses.push(`updated_at = NOW(3)`);
    values.push(params.id);

    const sql = `UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`;
    await db.query(sql, values);

    const [rows] = await db.query("SELECT * FROM agents WHERE id = ?", [params.id]) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    sendJson(res, 200, rows[0]);

    // is_production change affects skills bundle (prod=approved only, dev=all)
    if ("is_production" in body) {
      connectionMap.notify(params.id, "agent.reload", { resources: ["skills"] });
    }
  });

  // DELETE /api/v1/agents/:id (admin only)
  router.delete("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();

    // Check existence first
    const [existing] = await db.query("SELECT id FROM agents WHERE id = ?", [params.id]) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    // Terminate any running AgentBox pods bound to this agent before DB delete
    // so they don't become orphans. Log and proceed on failure — the DB delete
    // is the user's explicit intent; orphan pods can be cleaned up via kubectl.
    const termResult = await connectionMap.sendCommand(
      params.id,
      "agent.terminate",
      { agentId: params.id },
    );
    if (!termResult.ok) {
      console.warn(`[agent-api] delete ${params.id}: runtime terminate failed: ${termResult.error}`);
    }

    await db.query("DELETE FROM agents WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true, terminate: termResult });
  });

  // PUT /api/v1/agents/:id/resources — bind resources (admin only)
  router.put("/api/v1/agents/:id/resources", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<{
      cluster_ids?: string[];
      host_ids?: string[];
      skill_ids?: string[];
      mcp_server_ids?: string[];
      channel_ids?: string[];
    }>(req);

    const db = getDb();
    const agentId = params.id;

    // Verify agent exists
    const [agentRows] = await db.query("SELECT id FROM agents WHERE id = ?", [agentId]) as any;
    if (agentRows.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    // Replace junction rows in a transaction
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      if (body.cluster_ids !== undefined) {
        await conn.query("DELETE FROM agent_clusters WHERE agent_id = ?", [agentId]);
        for (const cid of body.cluster_ids) {
          await conn.query("INSERT INTO agent_clusters (agent_id, cluster_id) VALUES (?, ?)", [agentId, cid]);
        }
      }
      if (body.host_ids !== undefined) {
        await conn.query("DELETE FROM agent_hosts WHERE agent_id = ?", [agentId]);
        for (const hid of body.host_ids) {
          await conn.query("INSERT INTO agent_hosts (agent_id, host_id) VALUES (?, ?)", [agentId, hid]);
        }
      }
      if (body.skill_ids !== undefined) {
        await conn.query("DELETE FROM agent_skills WHERE agent_id = ?", [agentId]);
        for (const sid of body.skill_ids) {
          await conn.query("INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)", [agentId, sid]);
        }
      }
      if (body.mcp_server_ids !== undefined) {
        await conn.query("DELETE FROM agent_mcp_servers WHERE agent_id = ?", [agentId]);
        for (const mid of body.mcp_server_ids) {
          await conn.query("INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)", [agentId, mid]);
        }
      }
      if (body.channel_ids !== undefined) {
        await conn.query("DELETE FROM agent_channel_auth WHERE agent_id = ?", [agentId]);
        for (const cid of body.channel_ids) {
          await conn.query("INSERT INTO agent_channel_auth (agent_id, channel_id) VALUES (?, ?)", [agentId, cid]);
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    sendJson(res, 200, { ok: true });

    // Notify running AgentBox to reload (fire-and-forget)
    connectionMap.notify(params.id, "agent.reload", {});
  });

  // GET /api/v1/agents/:id/resources — get bindings
  router.get("/api/v1/agents/:id/resources", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const agentId = params.id;

    const [[clusters], [hosts], [skills], [mcpServers], [channels]] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.api_server FROM agent_clusters ac
         JOIN clusters c ON ac.cluster_id = c.id WHERE ac.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT h.id, h.name, h.ip, h.port FROM agent_hosts ah
         JOIN hosts h ON ah.host_id = h.id WHERE ah.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT s.id, s.name, s.description FROM agent_skills ask
         JOIN skills s ON ask.skill_id = s.id WHERE ask.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT m.id, m.name, m.transport FROM agent_mcp_servers ams
         JOIN mcp_servers m ON ams.mcp_server_id = m.id WHERE ams.agent_id = ?`,
        [agentId],
      ),
      db.query(
        `SELECT ch.id, ch.name, ch.type FROM agent_channel_auth ach
         JOIN channels ch ON ach.channel_id = ch.id WHERE ach.agent_id = ?`,
        [agentId],
      ),
    ]) as any;

    sendJson(res, 200, {
      clusters,
      hosts,
      skills,
      mcp_servers: mcpServers,
      channels,
    });
  });

  // ================================================================
  // API Keys (Portal-owned)
  // ================================================================

  // List API keys
  router.get("/api/v1/siclaw/agents/:id/api-keys", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, key_plain, key_prefix, last_used_at, expires_at, created_by, created_at
       FROM agent_api_keys WHERE agent_id = ? ORDER BY created_at DESC`,
      [params.id],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Create API key
  router.post("/api/v1/siclaw/agents/:id/api-keys", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    const rawKey = crypto.randomBytes(32).toString("hex");
    const plaintext = `sk-${rawKey}`;
    const keyPrefix = plaintext.slice(0, 7);
    const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");

    const db = getDb();
    await db.query(
      `INSERT INTO agent_api_keys (id, agent_id, name, key_hash, key_plain, key_prefix, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, params.id, body.name || "API Key", keyHash, plaintext, keyPrefix, body.expires_at || null, auth.userId],
    );

    const [rows] = await db.query(
      "SELECT id, agent_id, name, key_prefix, expires_at, created_by, created_at FROM agent_api_keys WHERE id = ?",
      [id],
    ) as any;
    sendJson(res, 201, { ...rows[0], key: plaintext });
  });

  // Delete API key
  router.delete("/api/v1/siclaw/agents/:id/api-keys/:kid", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_api_keys WHERE id = ? AND agent_id = ?",
      [params.kid, params.id],
    ) as any;
    if (existing.length === 0) { sendJson(res, 404, { error: "API key not found" }); return; }

    await db.query("DELETE FROM api_key_service_accounts WHERE api_key_id = ?", [params.kid]);
    await db.query("DELETE FROM agent_api_keys WHERE id = ?", [params.kid]);
    sendJson(res, 200, { ok: true });
  });
}
