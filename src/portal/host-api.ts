/**
 * Host CRUD API for the Portal.
 *
 * Stores SSH credentials in plaintext. GET endpoints never return
 * password or private_key — those are only accessible via the Adapter API.
 */

import crypto from "node:crypto";
import { getDb, type Db } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  type RestRouter,
} from "../gateway/rest-router.js";
import { requireAdmin } from "./auth.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";
import { dialSshChain, runCommand, type DialHop } from "../tools/infra/ssh-dial.js";

/** Column list that excludes sensitive fields (password / private_key / passphrase). */
const SAFE_COLUMNS = "id, name, ip, port, username, auth_type, description, is_production, jump_host_id, created_at, updated_at";

/** Cap a target + up to 3 bastions — mirrors ssh-client MAX_JUMP_DEPTH. */
const MAX_JUMP_DEPTH = 3;

/**
 * Validate a host's jump_host_id reference before persisting it. Rejects a
 * self-reference, a dangling reference, a cycle, or a chain deeper than
 * MAX_JUMP_DEPTH. No-op when jumpHostId is empty (clearing the jump). Exported
 * for unit testing.
 */
export async function validateJumpChain(db: Db, hostId: string, jumpHostId: string | null | undefined): Promise<void> {
  if (!jumpHostId) return;
  if (jumpHostId === hostId) {
    throw new Error("A host cannot be its own jump host");
  }
  const visited = new Set<string>([hostId]);
  let cur: string | null = jumpHostId;
  for (let hops = 0; cur; hops++) {
    if (hops >= MAX_JUMP_DEPTH) {
      throw new Error(`Jump-host chain exceeds max depth ${MAX_JUMP_DEPTH}`);
    }
    if (visited.has(cur)) {
      throw new Error("Jump-host chain forms a cycle");
    }
    visited.add(cur);
    const [rows] = (await db.query("SELECT jump_host_id FROM hosts WHERE id = ?", [cur])) as any;
    if (rows.length === 0) {
      throw new Error(`Jump host ${cur} not found`);
    }
    cur = (rows[0].jump_host_id as string | null) ?? null;
  }
}

interface ChainHostRow {
  id: string;
  ip: string;
  port: number;
  username: string;
  auth_type: string;
  password: string | null;
  private_key: string | null;
  passphrase: string | null;
  jump_host_id: string | null;
}

function hopFromDbRow(h: ChainHostRow): DialHop {
  if (h.auth_type === "managed") {
    // No stored key — ssh-dial sources it from the preceding hop (the bastion).
    return { host: h.ip, port: h.port, username: h.username, auth: { managed: true, ...(h.passphrase ? { passphrase: h.passphrase } : {}) } };
  }
  if (h.auth_type === "key") {
    if (!h.private_key) {
      throw new Error(`Host ${h.ip} has auth_type="key" but private_key is empty`);
    }
    return {
      host: h.ip,
      port: h.port,
      username: h.username,
      auth: { privateKey: h.private_key, ...(h.passphrase ? { passphrase: h.passphrase } : {}) },
    };
  }
  if (!h.password) {
    throw new Error(`Host ${h.ip} has auth_type="password" but password is empty`);
  }
  return { host: h.ip, port: h.port, username: h.username, auth: { password: h.password } };
}

/**
 * Resolve a host's full ProxyJump chain (reading plaintext secrets straight
 * from the DB — Portal has no broker) into the ordered hop list dialSshChain
 * expects: [outermost bastion, …, final target]. Throws on cycle, over-depth,
 * dangling reference, or empty credential material.
 */
async function resolveHostDialChain(db: Db, startId: string): Promise<DialHop[]> {
  const targetFirst: DialHop[] = [];
  const seen = new Set<string>();
  let cur: string | null = startId;
  for (let d = 0; cur; d++) {
    if (d > MAX_JUMP_DEPTH) {
      throw new Error(`Jump-host chain exceeds max depth ${MAX_JUMP_DEPTH}`);
    }
    if (seen.has(cur)) {
      throw new Error("Jump-host chain forms a cycle");
    }
    seen.add(cur);
    const [rows] = (await db.query(
      "SELECT id, ip, port, username, auth_type, password, private_key, passphrase, jump_host_id FROM hosts WHERE id = ?",
      [cur],
    )) as any;
    if (rows.length === 0) {
      throw new Error(`Host ${cur} not found in jump chain`);
    }
    const h = rows[0] as ChainHostRow;
    targetFirst.push(hopFromDbRow(h));
    cur = h.jump_host_id ?? null;
  }
  return targetFirst.reverse();
}

export function registerHostRoutes(router: RestRouter, jwtSecret: string, connectionMap: RuntimeConnectionMap): void {
  // GET /api/v1/hosts — list all (no secrets)
  router.get("/api/v1/hosts", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query(
      `SELECT ${SAFE_COLUMNS} FROM hosts ORDER BY created_at DESC, id DESC`,
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
      passphrase?: string;
      description?: string;
      is_production?: boolean;
      jump_host_id?: string | null;
    }>(req);

    if (!body.name || !body.ip) {
      sendJson(res, 400, { error: "name and ip are required" });
      return;
    }

    const id = crypto.randomUUID();
    const db = getDb();

    if (body.auth_type === "managed" && !body.jump_host_id) {
      sendJson(res, 400, { error: 'auth_type="managed" requires a jump_host_id (the bastion that holds the key)' });
      return;
    }

    try {
      await validateJumpChain(db, id, body.jump_host_id);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    await db.query(
      `INSERT INTO hosts (id, name, ip, port, username, auth_type, password, private_key, passphrase, description, is_production, jump_host_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.ip,
        body.port ?? 22,
        body.username ?? "root",
        body.auth_type ?? "password",
        body.password ?? null,
        body.private_key ?? null,
        body.passphrase ?? null,
        body.description ?? null,
        body.is_production ?? 1,
        body.jump_host_id || null,
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

    // When switching a host to managed, it must end up with a jump host. Reject
    // the obvious "managed + clear jump" case; the runtime layers fail closed on
    // any managed-without-jump that slips through.
    if (body.auth_type === "managed" && "jump_host_id" in body && !body.jump_host_id) {
      sendJson(res, 400, { error: 'auth_type="managed" requires a jump_host_id (the bastion that holds the key)' });
      return;
    }

    if ("jump_host_id" in body) {
      try {
        await validateJumpChain(db, params.id, (body.jump_host_id as string | null) || null);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    const fields = ["name", "ip", "port", "username", "auth_type", "password", "private_key", "passphrase", "description", "is_production", "jump_host_id"];
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (field in body) {
        setClauses.push(`${field} = ?`);
        // Normalize an empty jump_host_id to NULL (clearing the jump).
        values.push(field === "jump_host_id" ? ((body[field] as string | null) || null) : body[field]);
      }
    }

    if (setClauses.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }

    setClauses.push("updated_at = CURRENT_TIMESTAMP");
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
    getDb().query("SELECT agent_id FROM agent_hosts WHERE host_id = ?", [params.id])
      .then(([rows]: any) => {
        const agentIds = (rows as { agent_id: string }[]).map((r) => r.agent_id);
        if (agentIds.length > 0) connectionMap.notifyMany(agentIds, "agent.reload", { resources: ["host"] });
      })
      .catch((err: any) => console.warn("[host-api] notify failed:", err.message));
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

  // POST /api/v1/hosts/:id/test — test SSH connection (dials the full ProxyJump
  // chain and runs `echo ok`). Portal reads plaintext secrets straight from the
  // DB; there is no broker in this process.
  router.post("/api/v1/hosts/:id/test", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query("SELECT id FROM hosts WHERE id = ?", [params.id]) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Host not found" });
      return;
    }

    let hops: DialHop[];
    try {
      hops = await resolveHostDialChain(db, params.id);
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timeoutMs = 10000;
    let dialed;
    try {
      dialed = await dialSshChain(hops, { timeoutMs });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    try {
      const result = await runCommand(dialed.client, "echo ok", { timeoutMs });
      const ok = result.exitCode === 0 && result.stdout.trim() === "ok";
      sendJson(res, 200, {
        ok,
        message: ok
          ? `SSH connection OK${hops.length > 1 ? ` (via ${hops.length - 1} jump host(s))` : ""}`
          : `Unexpected probe result (exit ${result.exitCode}): ${result.stdout}${result.stderr}`.trim(),
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      dialed.teardown();
    }
  });
}
