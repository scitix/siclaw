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

export function registerAgentRoutes(router: RestRouter, jwtSecret: string): void {
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
      whereClause = "WHERE name LIKE ? OR description LIKE ?";
      params.push(`%${search}%`, `%${search}%`);
    }

    const countSql = `SELECT COUNT(*) AS total FROM agents ${whereClause}`;
    const [countRows] = await db.query(countSql, params) as any;
    const total: number = Number(countRows[0].total);

    const listParams = [...params, pageSize, offset];
    const listSql = `SELECT id, name, description, group_name, status, model_provider, model_id, brain_type, icon, color, created_by, created_at, updated_at
      FROM agents ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`;

    const [listRows] = await db.query(listSql, listParams) as any;
    sendJson(res, 200, { data: listRows, total, page, page_size: pageSize });
  });

  // POST /api/v1/agents — create
  router.post("/api/v1/agents", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    if (!body.name) { sendJson(res, 400, { error: "name is required" }); return; }

    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO agents (id, name, description, group_name, status, model_provider, model_id, system_prompt, brain_type, icon, color, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.description ?? null,
        body.group_name ?? null,
        body.status ?? "active",
        body.model_provider ?? null,
        body.model_id ?? null,
        body.system_prompt ?? null,
        body.brain_type ?? "pi-agent",
        body.icon ?? null,
        body.color ?? null,
        auth.userId,
      ],
    );

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

  // PUT /api/v1/agents/:id — update
  router.put("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    // Build dynamic SET clause
    const fields = [
      "name", "description", "group_name", "status", "model_provider",
      "model_id", "system_prompt", "brain_type", "icon", "color",
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
  });

  // DELETE /api/v1/agents/:id
  router.delete("/api/v1/agents/:id", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();

    // Check existence first
    const [existing] = await db.query("SELECT id FROM agents WHERE id = ?", [params.id]) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }

    await db.query("DELETE FROM agents WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true });
  });

  // PUT /api/v1/agents/:id/resources — bind resources
  router.put("/api/v1/agents/:id/resources", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{
      cluster_ids?: string[];
      host_ids?: string[];
      skill_ids?: string[];
      mcp_server_ids?: string[];
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

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    sendJson(res, 200, { ok: true });
  });

  // GET /api/v1/agents/:id/resources — get bindings
  router.get("/api/v1/agents/:id/resources", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const agentId = params.id;

    const [[clusters], [hosts], [skills], [mcpServers]] = await Promise.all([
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
    ]) as any;

    sendJson(res, 200, {
      clusters,
      hosts,
      skills,
      mcp_servers: mcpServers,
    });
  });
}
