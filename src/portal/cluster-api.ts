/**
 * Cluster CRUD API for the Portal.
 *
 * Stores kubeconfig in plaintext. Auto-extracts api_server from the YAML.
 */

import crypto from "node:crypto";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";

/** Extract the first `server:` value from a kubeconfig YAML string. */
function extractApiServer(kubeconfig: string): string | null {
  const match = kubeconfig.match(/server:\s*(.+)/);
  return match ? match[1].trim() : null;
}

export function registerClusterRoutes(router: RestRouter, jwtSecret: string): void {
  // GET /api/v1/clusters — list all
  router.get("/api/v1/clusters", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT id, name, description, api_server, is_production, created_at, updated_at FROM clusters ORDER BY created_at DESC",
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // POST /api/v1/clusters — create
  router.post("/api/v1/clusters", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{
      name?: string;
      description?: string;
      kubeconfig?: string;
      api_server?: string;
      is_production?: boolean;
    }>(req);

    if (!body.name) { sendJson(res, 400, { error: "name is required" }); return; }

    const id = crypto.randomUUID();
    const apiServer = body.api_server ?? (body.kubeconfig ? extractApiServer(body.kubeconfig) : null);

    const db = getDb();
    await db.query(
      `INSERT INTO clusters (id, name, description, kubeconfig, api_server, is_production)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, body.name, body.description ?? null, body.kubeconfig ?? null, apiServer, body.is_production ?? 1],
    );

    const [rows] = await db.query(
      "SELECT id, name, description, api_server, is_production, created_at, updated_at FROM clusters WHERE id = ?",
      [id],
    ) as any;
    sendJson(res, 201, rows[0]);
  });

  // GET /api/v1/clusters/:id — get by id
  router.get("/api/v1/clusters/:id", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [rows] = await db.query("SELECT * FROM clusters WHERE id = ?", [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Cluster not found" });
      return;
    }

    sendJson(res, 200, rows[0]);
  });

  // PUT /api/v1/clusters/:id — update
  router.put("/api/v1/clusters/:id", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const fields = ["name", "description", "kubeconfig", "api_server", "is_production"];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (field in body) {
        setClauses.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    // Auto-extract api_server if kubeconfig changed but api_server not explicitly set
    if ("kubeconfig" in body && !("api_server" in body) && typeof body.kubeconfig === "string") {
      const extracted = extractApiServer(body.kubeconfig);
      if (extracted) {
        setClauses.push(`api_server = ?`);
        values.push(extracted);
      }
    }

    if (setClauses.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    setClauses.push("updated_at = NOW(3)");
    values.push(params.id);

    const sql = `UPDATE clusters SET ${setClauses.join(", ")} WHERE id = ?`;
    await db.query(sql, values);

    const [rows] = await db.query("SELECT * FROM clusters WHERE id = ?", [params.id]) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "Cluster not found" });
      return;
    }

    sendJson(res, 200, rows[0]);
  });

  // DELETE /api/v1/clusters/:id
  router.delete("/api/v1/clusters/:id", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();

    // Check existence first
    const [existing] = await db.query("SELECT id FROM clusters WHERE id = ?", [params.id]) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Cluster not found" });
      return;
    }

    await db.query("DELETE FROM clusters WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true });
  });

  // POST /api/v1/clusters/:id/test — test connection (stub)
  router.post("/api/v1/clusters/:id/test", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const db = getDb();
    const [rows] = await db.query("SELECT id FROM clusters WHERE id = ?", [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Cluster not found" });
      return;
    }

    sendJson(res, 200, { ok: true, message: "Connection test stub — not yet implemented" });
  });
}
