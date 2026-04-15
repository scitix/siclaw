/**
 * Host CRUD API for the Portal.
 *
 * Stores SSH credentials in plaintext. GET endpoints never return
 * password or private_key — those are only accessible via the Adapter API.
 */

import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  type RestRouter,
} from "../gateway/rest-router.js";
import { requireAdmin } from "./auth.js";
import { notifyBoundAgents } from "./notify.js";

/** Column list that excludes sensitive fields. */
const SAFE_COLUMNS = "id, name, ip, port, username, auth_type, description, is_production, created_at, updated_at";

export function registerHostRoutes(router: RestRouter, jwtSecret: string, runtimeWsUrl: string, runtimeSecret: string): void {
  // GET /api/v1/hosts — list all (no secrets)
  router.get("/api/v1/hosts", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query(
      `SELECT ${SAFE_COLUMNS} FROM hosts ORDER BY created_at DESC`,
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // POST /api/v1/hosts — create
  router.post("/api/v1/hosts", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<{
      name?: string;
      ip?: string;
      port?: number;
      username?: string;
      auth_type?: string;
      password?: string;
      private_key?: string;
      description?: string;
      is_production?: boolean;
    }>(req);

    if (!body.name || !body.ip) {
      sendJson(res, 400, { error: "name and ip are required" });
      return;
    }

    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO hosts (id, name, ip, port, username, auth_type, password, private_key, description, is_production)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.ip,
        body.port ?? 22,
        body.username ?? "root",
        body.auth_type ?? "password",
        body.password ?? null,
        body.private_key ?? null,
        body.description ?? null,
        body.is_production ?? 1,
      ],
    );

    const [rows] = await db.query(`SELECT ${SAFE_COLUMNS} FROM hosts WHERE id = ?`, [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // GET /api/v1/hosts/:id — get by id (no secrets)
  router.get("/api/v1/hosts/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query(`SELECT ${SAFE_COLUMNS} FROM hosts WHERE id = ?`, [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Host not found" });
      return;
    }

    sendJson(res, 200, rows[0]);
  });

  // PUT /api/v1/hosts/:id — update
  router.put("/api/v1/hosts/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const fields = ["name", "ip", "port", "username", "auth_type", "password", "private_key", "description", "is_production"];
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

    setClauses.push("updated_at = NOW(3)");
    values.push(params.id);

    const sql = `UPDATE hosts SET ${setClauses.join(", ")} WHERE id = ?`;
    const [result] = await db.query(sql, values) as any;

    if (result.affectedRows === 0) {
      sendJson(res, 404, { error: "Host not found" });
      return;
    }

    // Return safe columns only
    const [updated] = await db.query(`SELECT ${SAFE_COLUMNS} FROM hosts WHERE id = ?`, [params.id]) as any;
    sendJson(res, 200, updated[0]);

    // Notify bound agents to clear cached credentials
    notifyBoundAgents(runtimeWsUrl, runtimeSecret, "agent_hosts", "host_id", params.id, ["host"]);
  });

  // DELETE /api/v1/hosts/:id
  router.delete("/api/v1/hosts/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();

    // Check existence first
    const [existing] = await db.query("SELECT id FROM hosts WHERE id = ?", [params.id]) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Host not found" });
      return;
    }

    await db.query("DELETE FROM hosts WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true });
  });

  // POST /api/v1/hosts/:id/test — test SSH connection (stub)
  router.post("/api/v1/hosts/:id/test", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query("SELECT id FROM hosts WHERE id = ?", [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Host not found" });
      return;
    }

    sendJson(res, 200, { ok: true, message: "SSH connection test stub — not yet implemented" });
  });
}
