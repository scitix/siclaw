/**
 * Trace Store — standalone SQLite persistence for per-prompt agent traces.
 *
 * Standalone node:sqlite file (default: <cwd>/.siclaw/traces.sqlite), NOT part of
 * the Gateway DB. Same pattern as src/memory/schema.ts. Swap the underlying
 * implementation (e.g. MySQL) by replacing this module while keeping the
 * TraceStore interface stable.
 *
 * Query shapes supported:
 *   - by time range:          WHERE started_at_ms BETWEEN ? AND ?
 *   - by user:                WHERE user_id = ?
 *   - by user + time:         WHERE user_id = ? AND started_at_ms BETWEEN ? AND ?
 *   - by minimum duration:    + AND duration_ms >= ?
 * All lists are ordered by started_at_ms DESC with keyset pagination.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * Lazy-load node:sqlite via createRequire so that environments without the
 * stable builtin (Node <22.13 without --experimental-sqlite) do not crash
 * at module import time. Callers get null → trace persistence silently
 * falls back to file-only, matching pre-DB behavior.
 */
type SqliteCtor = new (path: string) => DatabaseSync;
let _sqliteLoad: { ctor: SqliteCtor } | { error: string } | null = null;

function loadSqlite(): SqliteCtor | null {
  if (!_sqliteLoad) {
    try {
      const req = createRequire(import.meta.url);
      const mod = req("node:sqlite") as { DatabaseSync: SqliteCtor };
      _sqliteLoad = { ctor: mod.DatabaseSync };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      _sqliteLoad = { error: code || String(err) };
      console.warn(
        `[trace-store] node:sqlite unavailable (${code || "load failed"}). ` +
        `Trace persistence disabled (file-only fallback). ` +
        `Fix: upgrade Node to ≥22.13 (or run with NODE_OPTIONS=--experimental-sqlite on 22.12).`,
      );
    }
  }
  return "ctor" in _sqliteLoad ? _sqliteLoad.ctor : null;
}

export interface TraceRow {
  /** Business id (human-readable, globally unique, matches trace-*.json filename stem).
   *  Internally stored in DB column `trace_key`; the numeric DB primary key `id`
   *  is an auto-increment clustered key that is never exposed to API clients. */
  id: string;
  sessionId: string;
  promptIdx: number;
  userId: string | null;
  username: string | null;
  mode: string;
  brainType: string | null;
  modelName: string | null;
  userMessage: string | null;
  outcome: string;
  /** Beijing time, "YYYY-MM-DD HH:mm:ss.SSS". Zero-padded → safe for lex sort. */
  startedAt: string;
  endedAt: string;
  /** Interval kept as integer ms for filtering/sorting; exposed as `duration`
   *  (formatted HH:mm:ss.SSS) in API responses. */
  durationMs: number;
  /** Formatted duration, HH:mm:ss.SSS. Derived from durationMs on read.
   *  Optional because insert() callers don't supply it — rowToTraceRow fills it. */
  duration?: string;
  stepCount: number;
  toolCallCount: number;
  tokensTotal: number | null;
  costUsd: number | null;
  schemaVersion: string;
  /** Beijing time string. Set by DB DEFAULT on insert, populated on read. */
  createdAt?: string;
}

export interface TraceListOpts {
  userId?: string;
  username?: string;
  /** Inclusive lower bound, Beijing "YYYY-MM-DD HH:mm:ss.SSS". */
  from?: string;
  /** Inclusive upper bound, Beijing "YYYY-MM-DD HH:mm:ss.SSS". */
  to?: string;
  minDurationMs?: number;
  outcome?: string;
  limit?: number;
  /** Keyset cursor: last row's (startedAt, id). Next page is strictly older. */
  cursorStartedAt?: string;
  cursorId?: string;
}

export interface TraceListResult {
  items: TraceRow[];
  nextCursor: { startedAt: string; id: string } | null;
}

export interface TraceRecord extends TraceRow {
  bodyJson: string;
}

export class TraceStore {
  private db: DatabaseSync;
  private insertStmt: StatementSync;
  private getBodyStmt: StatementSync;

  constructor(dbPath: string) {
    const DbCtor = loadSqlite();
    if (!DbCtor) throw new Error("node:sqlite not available");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DbCtor(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");

    // Schema management — v1 used TEXT PK; v2 added INTEGER PK + UNIQUE
    // trace_key; v3 switched *_at fields from INTEGER ms to TEXT Beijing time.
    ensureSchema(this.db);

    // INSERT — UNIQUE(trace_key) surfaces collisions as hard errors instead of
    // silently overwriting. created_at defaults to Beijing "now" via strftime.
    this.insertStmt = this.db.prepare(`
      INSERT INTO agent_traces (
        trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
        user_message, outcome, started_at, ended_at, duration_ms,
        step_count, tool_call_count, tokens_total, cost_usd,
        schema_version, body_json, body_bytes
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `);

    this.getBodyStmt = this.db.prepare(
      `SELECT trace_key AS id, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
              user_message, outcome, started_at, ended_at, duration_ms,
              step_count, tool_call_count, tokens_total, cost_usd, schema_version,
              created_at, body_json
         FROM agent_traces WHERE trace_key = ?`,
    );
  }

  insert(row: TraceRow & { bodyJson: string }): void {
    this.insertStmt.run(
      row.id,
      row.sessionId,
      row.promptIdx,
      row.userId,
      row.username,
      row.mode,
      row.brainType,
      row.modelName,
      row.userMessage,
      row.outcome,
      row.startedAt,
      row.endedAt,
      row.durationMs,
      row.stepCount,
      row.toolCallCount,
      row.tokensTotal,
      row.costUsd,
      row.schemaVersion,
      row.bodyJson,
      Buffer.byteLength(row.bodyJson, "utf8"),
    );
  }

  list(opts: TraceListOpts): TraceListResult {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const where: string[] = [];
    const params: Array<string | number | null> = [];

    if (opts.userId) {
      where.push("user_id = ?");
      params.push(opts.userId);
    }
    if (opts.username) {
      where.push("username = ?");
      params.push(opts.username);
    }
    if (typeof opts.from === "string" && opts.from) {
      where.push("started_at >= ?");
      params.push(opts.from);
    }
    if (typeof opts.to === "string" && opts.to) {
      where.push("started_at <= ?");
      params.push(opts.to);
    }
    if (typeof opts.minDurationMs === "number") {
      where.push("duration_ms >= ?");
      params.push(opts.minDurationMs);
    }
    if (opts.outcome) {
      where.push("outcome = ?");
      params.push(opts.outcome);
    }
    // Keyset cursor: strictly older than (cursorStartedAt, cursorId). Lex sort
    // is safe because YYYY-MM-DD HH:mm:ss.SSS is zero-padded and monotonic.
    if (typeof opts.cursorStartedAt === "string" && opts.cursorStartedAt && opts.cursorId) {
      where.push("(started_at < ? OR (started_at = ? AND trace_key < ?))");
      params.push(opts.cursorStartedAt, opts.cursorStartedAt, opts.cursorId);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT trace_key AS id, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
             user_message, outcome, started_at, ended_at, duration_ms,
             step_count, tool_call_count, tokens_total, cost_usd, schema_version, created_at
        FROM agent_traces
        ${whereSql}
       ORDER BY started_at DESC, trace_key DESC
       LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>;
    const items = rows.map(rowToTraceRow);
    const nextCursor = items.length === limit
      ? { startedAt: items[items.length - 1].startedAt, id: items[items.length - 1].id }
      : null;
    return { items, nextCursor };
  }

  getById(id: string): TraceRecord | null {
    const row = this.getBodyStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...rowToTraceRow(row), bodyJson: row.body_json as string };
  }

  close(): void {
    try { this.db.close(); } catch { /* best-effort */ }
  }
}

// ── Schema management + migration ────────────────────────

/** Current schema version. Bumped when a destructive change requires migration. */
const SCHEMA_VERSION = 3;

/**
 * Canonical v3 DDL.
 *   - `id INTEGER PRIMARY KEY AUTOINCREMENT` — clustered integer key.
 *   - `trace_key TEXT NOT NULL UNIQUE` — business key.
 *   - `started_at` / `ended_at` / `created_at` — TEXT, Beijing
 *     "YYYY-MM-DD HH:mm:ss.SSS". Zero-padded so lex sort matches chrono sort;
 *     range filters work on index.
 *   - `duration_ms INTEGER` — kept numeric for filtering (`minDurationMs=...`);
 *     formatted as `duration` (HH:mm:ss.SSS) at read time.
 */
const DDL_V3_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_traces (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_key        TEXT NOT NULL UNIQUE,
    session_id       TEXT NOT NULL,
    prompt_idx       INTEGER NOT NULL,
    user_id          TEXT,
    username         TEXT,
    mode             TEXT NOT NULL,
    brain_type       TEXT,
    model_name       TEXT,
    user_message     TEXT,
    outcome          TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    ended_at         TEXT NOT NULL,
    duration_ms      INTEGER NOT NULL,
    step_count       INTEGER NOT NULL DEFAULT 0,
    tool_call_count  INTEGER NOT NULL DEFAULT 0,
    tokens_total     INTEGER,
    cost_usd         REAL,
    schema_version   TEXT NOT NULL,
    body_json        TEXT NOT NULL,
    body_bytes       INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', '+8 hours'))
  );
`;

const DDL_V3_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_traces_user_time ON agent_traces(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_time      ON agent_traces(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_session   ON agent_traces(session_id, prompt_idx);
`;

/**
 * Create or migrate the schema to v3.
 *   fresh DB                           → create v3 directly
 *   v1 DB (TEXT PK, integer ms)        → v1→v2→v3 in sequence
 *   v2 DB (INTEGER PK, integer ms)     → v2→v3
 *   v3 DB                              → no-op (plus idempotent index reassert)
 */
function ensureSchema(db: DatabaseSync): void {
  const currentVersion =
    (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
  if (currentVersion >= SCHEMA_VERSION) {
    db.exec(DDL_V3_INDEXES);
    return;
  }

  const tableExists = db
    .prepare(`SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='agent_traces'`)
    .get() !== undefined;

  if (!tableExists) {
    db.exec(DDL_V3_TABLE);
    db.exec(DDL_V3_INDEXES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  const cols = db.prepare(`PRAGMA table_info(agent_traces)`).all() as Array<{ name: string }>;
  const hasTraceKey = cols.some((c) => c.name === "trace_key");
  const hasStartedAt = cols.some((c) => c.name === "started_at");
  const hasStartedAtMs = cols.some((c) => c.name === "started_at_ms");

  // Branch 1: v1 schema (TEXT PK, started_at_ms). Go v1→v3 directly in one pass.
  if (!hasTraceKey && hasStartedAtMs) {
    console.log("[trace-store] Migrating agent_traces v1 → v3 (INTEGER PK + Beijing TEXT timestamps)...");
    rebuildFromLegacy(db, "v1");
    return;
  }

  // Branch 2: v2 schema (INTEGER PK + trace_key, but still started_at_ms). Go v2→v3.
  if (hasTraceKey && hasStartedAtMs && !hasStartedAt) {
    console.log("[trace-store] Migrating agent_traces v2 → v3 (Beijing TEXT timestamps)...");
    rebuildFromLegacy(db, "v2");
    return;
  }

  // Branch 3: already looks like v3 but missing version stamp — just stamp.
  if (hasTraceKey && hasStartedAt) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec(DDL_V3_INDEXES);
    return;
  }

  throw new Error("[trace-store] Unrecognized agent_traces schema — refusing to migrate blindly.");
}

/**
 * Shared in-place rebuild: rename old → create v3 → copy+convert → drop old →
 * rebuild indexes → stamp version. One transaction, so the file is never
 * observed half-migrated.
 *
 * Legacy mode determines how timestamps are converted:
 *   - v1/v2 store integer ms in started_at_ms / ended_at_ms and integer seconds
 *     in created_at (DEFAULT unixepoch()). We convert both to Beijing strings.
 */
function rebuildFromLegacy(db: DatabaseSync, legacy: "v1" | "v2"): void {
  db.exec("BEGIN");
  try {
    db.exec(`ALTER TABLE agent_traces RENAME TO agent_traces_legacy`);
    db.exec(DDL_V3_TABLE);

    // trace_key source column differs: v1 had `id TEXT` (the old business id);
    // v2 already has `trace_key`.
    const traceKeyCol = legacy === "v1" ? "id" : "trace_key";

    db.exec(`
      INSERT INTO agent_traces (
        trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
        user_message, outcome, started_at, ended_at, duration_ms,
        step_count, tool_call_count, tokens_total, cost_usd,
        schema_version, body_json, body_bytes, created_at
      )
      SELECT ${traceKeyCol}, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
             user_message, outcome,
             strftime('%Y-%m-%d %H:%M:%f', started_at_ms / 1000.0, 'unixepoch', '+8 hours'),
             strftime('%Y-%m-%d %H:%M:%f', ended_at_ms   / 1000.0, 'unixepoch', '+8 hours'),
             duration_ms,
             step_count, tool_call_count, tokens_total, cost_usd,
             schema_version, body_json, body_bytes,
             strftime('%Y-%m-%d %H:%M:%f', created_at, 'unixepoch', '+8 hours')
        FROM agent_traces_legacy
       ORDER BY started_at_ms ASC, rowid ASC
    `);
    db.exec(`DROP TABLE agent_traces_legacy`);
    db.exec(DDL_V3_INDEXES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM agent_traces").get() as { n: number }).n;
    console.log(`[trace-store] Migration complete. ${count} row(s) carried over.`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function rowToTraceRow(r: Record<string, unknown>): TraceRow {
  const durationMs = r.duration_ms as number;
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    promptIdx: r.prompt_idx as number,
    userId: (r.user_id as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    mode: r.mode as string,
    brainType: (r.brain_type as string | null) ?? null,
    modelName: (r.model_name as string | null) ?? null,
    userMessage: (r.user_message as string | null) ?? null,
    outcome: r.outcome as string,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string,
    durationMs,
    duration: formatDuration(durationMs),
    stepCount: r.step_count as number,
    toolCallCount: r.tool_call_count as number,
    tokensTotal: (r.tokens_total as number | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    schemaVersion: r.schema_version as string,
    createdAt: r.created_at as string,
  };
}

/** Format a duration in ms as HH:mm:ss.SSS (zero-padded). Wraps past 24h. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00:00.000";
  const hh = Math.floor(ms / 3600_000);
  const mm = Math.floor((ms / 60_000) % 60);
  const ss = Math.floor((ms / 1000) % 60);
  const sss = Math.floor(ms % 1000);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(sss).padStart(3, "0")}`;
}

// ── Singleton + env-var gated factory ────────────────────

let _store: TraceStore | null = null;

/** Default location: <cwd>/.siclaw/traces.sqlite. Override with SICLAW_TRACE_DB. */
export function getTraceStore(): TraceStore | null {
  if (process.env.SICLAW_TRACE_DISABLE === "1") return null;
  if (_store) return _store;
  // Probe early: if node:sqlite itself is unavailable, skip silently —
  // loadSqlite() already logged the one-time remediation warning.
  if (!loadSqlite()) return null;
  const dbPath =
    process.env.SICLAW_TRACE_DB ??
    path.join(process.cwd(), ".siclaw", "traces.sqlite");
  try {
    _store = new TraceStore(dbPath);
    return _store;
  } catch (err) {
    console.warn(`[trace-store] Failed to open ${dbPath}:`, err);
    return null;
  }
}

export function closeTraceStore(): void {
  if (_store) {
    _store.close();
    _store = null;
  }
}
