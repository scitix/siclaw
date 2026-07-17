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
import { notifyCoordinatorsForMembers } from "./coordinator-invalidation.js";
import { dialSshChain, runCommand, type DialHop } from "../tools/infra/ssh-dial.js";
import type { ChainHop, CredentialFile } from "../shared/credential-types.js";

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
  name: string;
  ip: string;
  port: number;
  username: string;
  auth_type: string;
  password: string | null;
  private_key: string | null;
  passphrase: string | null;
  jump_host_id: string | null;
}

/**
 * Walk a host's jump_host_id chain by FK, returning rows ordered
 * [outermost bastion, …, startId]. Throws on over-depth, cycle, or dangling
 * reference. Shared by the dial path (`resolveHostDialChain`) and the adapter's
 * jump_chain emission (`chainHopFromRow`). Exported for reuse + tests.
 */
export async function walkJumpChainRows(db: Db, startId: string): Promise<ChainHostRow[]> {
  const fromStart: ChainHostRow[] = [];
  const seen = new Set<string>();
  let cur: string | null = startId;
  for (let d = 0; cur; d++) {
    // `>=`, not `>`: d counts bastions starting at 0, so MAX_JUMP_DEPTH=3 admits
    // d=0,1,2 (three bastions) and rejects the fourth — matching validateJumpChain's
    // write-time cap. `>` would emit a 4-bastion chain that the write path forbids
    // (e.g. from legacy rows, a migration, or a direct DB write), breaking fail-closed.
    if (d >= MAX_JUMP_DEPTH) {
      throw new Error(`Jump-host chain exceeds max depth ${MAX_JUMP_DEPTH}`);
    }
    if (seen.has(cur)) {
      throw new Error("Jump-host chain forms a cycle");
    }
    seen.add(cur);
    const [rows] = (await db.query(
      "SELECT id, name, ip, port, username, auth_type, password, private_key, passphrase, jump_host_id FROM hosts WHERE id = ?",
      [cur],
    )) as any;
    if (rows.length === 0) {
      throw new Error(`Host ${cur} not found in jump chain`);
    }
    const h = rows[0] as ChainHostRow;
    fromStart.push(h);
    cur = h.jump_host_id ?? null;
  }
  return fromStart.reverse();
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
 * Project a bastion row into a credential `ChainHop` (metadata + materializable
 * files). Enforces jump-chain invariants ③ (a bastion is never "managed") and
 * ④ (a bastion must carry its own credential). Exported for the adapter's
 * jump_chain emission. See docs/design/ssh-jump-host.md §3.2 / §4.
 */
export function chainHopFromRow(h: ChainHostRow): ChainHop {
  if (h.auth_type === "managed") {
    throw new Error(`Jump host "${h.name}" is auth_type="managed" — a bastion cannot be managed`);
  }
  const files: CredentialFile[] = [];
  if (h.auth_type === "key") {
    if (!h.private_key) {
      throw new Error(`Jump host "${h.name}" has auth_type="key" but no credential configured`);
    }
    files.push({ name: "host.key", content: h.private_key, mode: 0o600 });
    if (h.passphrase) files.push({ name: "host.passphrase", content: h.passphrase, mode: 0o600 });
  } else if (h.auth_type === "password") {
    if (!h.password) {
      throw new Error(`Jump host "${h.name}" has auth_type="password" but no credential configured`);
    }
    files.push({ name: "host.password", content: h.password });
  } else {
    throw new Error(`Jump host "${h.name}" has unknown auth_type=${JSON.stringify(h.auth_type)}`);
  }
  return {
    name: h.name,
    metadata: { ip: h.ip, port: h.port, username: h.username, auth_type: h.auth_type as "password" | "key" },
    files,
  };
}

/**
 * Resolve a host's full ProxyJump chain (reading plaintext secrets straight
 * from the DB — Portal has no broker) into the ordered hop list dialSshChain
 * expects: [outermost bastion, …, final target]. Throws on cycle, over-depth,
 * dangling reference, or empty credential material.
 */
async function resolveHostDialChain(db: Db, startId: string): Promise<DialHop[]> {
  return (await walkJumpChainRows(db, startId)).map(hopFromDbRow);
}

interface HostFormBody {
  /** Set when re-testing an existing host being edited: blank credential fields
   *  fall back to its stored secret (the form omits unchanged passwords/keys). */
  id?: string;
  ip?: string;
  port?: number;
  username?: string;
  auth_type?: string;
  password?: string;
  private_key?: string;
  passphrase?: string;
  jump_host_id?: string | null;
}

/**
 * Build the target DialHop from submitted (unsaved) form data. When `stored` is
 * given (re-testing an edited host), a blank credential field falls back to the
 * stored secret — the edit form omits unchanged passwords/keys, so "leave blank
 * to keep the saved value" tests the same credential it would save.
 */
function hopFromForm(b: HostFormBody, stored?: ChainHostRow): DialHop {
  const host = b.ip ?? "";
  const port = b.port ?? 22;
  const username = b.username || "root";
  const authType = b.auth_type || "password";
  const passphrase = b.passphrase || stored?.passphrase || undefined;
  if (authType === "managed") {
    return { host, port, username, auth: { managed: true, ...(passphrase ? { passphrase } : {}) } };
  }
  if (authType === "key") {
    const privateKey = b.private_key || stored?.private_key;
    if (!privateKey) throw new Error('auth_type="key" requires a private_key to test');
    return { host, port, username, auth: { privateKey, ...(passphrase ? { passphrase } : {}) } };
  }
  const password = b.password || stored?.password;
  if (!password) throw new Error('auth_type="password" requires a password to test');
  return { host, port, username, auth: { password } };
}

/** Dial a resolved hop chain and run `echo ok`; never throws. */
async function runConnectionTest(hops: DialHop[]): Promise<{ ok: boolean; message: string }> {
  const timeoutMs = 10000;
  let dialed;
  try {
    dialed = await dialSshChain(hops, { timeoutMs });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  try {
    const result = await runCommand(dialed.client, "echo ok", { timeoutMs });
    const ok = result.exitCode === 0 && result.stdout.trim() === "ok";
    return {
      ok,
      message: ok
        ? `SSH connection OK${hops.length > 1 ? ` (via ${hops.length - 1} jump host(s))` : ""}`
        : `Unexpected probe result (exit ${result.exitCode}): ${result.stdout}${result.stderr}`.trim(),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    dialed.teardown();
  }
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
        // Same treatment for coordinators delegating to those members (this host's
        // rename changes the member's coverage in their roster manifest).
        void notifyCoordinatorsForMembers(connectionMap, agentIds);
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

    // Capture bound agents BEFORE delete — the FK cascade removes agent_hosts
    // rows, so querying them afterwards would return nothing.
    const [boundRows] = await db.query("SELECT agent_id FROM agent_hosts WHERE host_id = ?", [params.id]) as any;

    await db.query("DELETE FROM hosts WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true });

    // Notify formerly-bound agents so they drop the now-deleted host from their
    // cached list/credentials (mirror of the PUT notify; the host vanishing from
    // the snapshot makes reconcileFullList unlink it on the next refresh).
    const agentIds = ((boundRows ?? []) as { agent_id: string }[]).map((r) => r.agent_id);
    if (agentIds.length > 0) connectionMap.notifyMany(agentIds, "agent.reload", { resources: ["host"] });
    // Coordinators delegating to those members: the deleted host vanishes from their
    // roster coverage too (captured before the cascade, same as agentIds).
    void notifyCoordinatorsForMembers(connectionMap, agentIds);
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
    sendJson(res, 200, await runConnectionTest(hops));
  });

  // POST /api/v1/hosts/test-connection — test using submitted (unsaved) form
  // data, so an operator can validate what they typed before saving. The jump
  // chain is resolved from saved hosts (jump_host_id); the target hop uses the
  // inline credentials in the request.
  router.post("/api/v1/hosts/test-connection", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const body = await parseBody<HostFormBody>(req);
    if (!body.ip) {
      sendJson(res, 400, { error: "ip is required" });
      return;
    }
    if (body.auth_type === "managed" && !body.jump_host_id) {
      sendJson(res, 200, { ok: false, message: 'auth_type="managed" requires a jump host' });
      return;
    }

    const db = getDb();
    // On edit (id present), load the stored host so blank credential fields can
    // fall back to its saved secret instead of failing with "requires a password".
    let stored: ChainHostRow | undefined;
    if (body.id) {
      const [rows] = (await db.query(
        "SELECT id, ip, port, username, auth_type, password, private_key, passphrase, jump_host_id FROM hosts WHERE id = ?",
        [body.id],
      )) as any;
      stored = rows[0];
    }

    let hops: DialHop[];
    try {
      const jumpChain = body.jump_host_id ? await resolveHostDialChain(db, body.jump_host_id) : [];
      hops = [...jumpChain, hopFromForm(body, stored)];
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    sendJson(res, 200, await runConnectionTest(hops));
  });
}
