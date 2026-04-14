/**
 * Channel CRUD API for the Portal.
 *
 * Channels are global resources (like clusters/hosts). Each channel
 * represents a messaging platform connection (Lark, Slack, etc.)
 * that can be shared across multiple agents via channel_bindings.
 */

import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  type RestRouter,
} from "../gateway/rest-router.js";
import { requireAdmin } from "./auth.js";

export function registerChannelRoutes(router: RestRouter, jwtSecret: string): void {
  // GET /api/v1/channels — list all
  router.get("/api/v1/channels", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query(
      "SELECT id, name, type, status, created_by, created_at, updated_at FROM channels ORDER BY created_at DESC",
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // POST /api/v1/channels — create
  router.post("/api/v1/channels", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<{
      name?: string; type?: string; config?: Record<string, unknown>;
    }>(req);

    if (!body.name || !body.type || !body.config) {
      sendJson(res, 400, { error: "name, type, and config are required" });
      return;
    }

    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO channels (id, name, type, config, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, body.name, body.type, JSON.stringify(body.config), auth.userId],
    );

    const [rows] = await db.query(
      "SELECT id, name, type, status, created_by, created_at, updated_at FROM channels WHERE id = ?",
      [id],
    ) as any;
    sendJson(res, 201, rows[0]);
  });

  // GET /api/v1/channels/:id — get by id (includes config)
  router.get("/api/v1/channels/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query("SELECT * FROM channels WHERE id = ?", [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Channel not found" });
      return;
    }

    sendJson(res, 200, rows[0]);
  });

  // PUT /api/v1/channels/:id — update
  router.put("/api/v1/channels/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const fields = ["name", "type", "status"];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (field in body) {
        setClauses.push(`${field} = ?`);
        values.push(body[field]);
      }
    }
    if ("config" in body) {
      setClauses.push("config = ?");
      values.push(JSON.stringify(body.config));
    }

    if (setClauses.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    setClauses.push("updated_at = NOW(3)");
    values.push(params.id);

    await db.query(`UPDATE channels SET ${setClauses.join(", ")} WHERE id = ?`, values);

    const [rows] = await db.query(
      "SELECT id, name, type, status, created_by, created_at, updated_at FROM channels WHERE id = ?",
      [params.id],
    ) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "Channel not found" });
      return;
    }
    sendJson(res, 200, rows[0]);
  });

  // DELETE /api/v1/channels/:id
  router.delete("/api/v1/channels/:id", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [existing] = await db.query("SELECT id FROM channels WHERE id = ?", [params.id]) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Channel not found" });
      return;
    }

    // Delete all related data, then channel
    await db.query("DELETE FROM channel_bindings WHERE channel_id = ?", [params.id]);
    await db.query("DELETE FROM channel_pairing_codes WHERE channel_id = ?", [params.id]);
    await db.query("DELETE FROM agent_channel_auth WHERE channel_id = ?", [params.id]);
    await db.query("DELETE FROM channels WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true });
  });
}
