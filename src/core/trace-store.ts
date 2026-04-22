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
  /** True when userMessage starts with one of the UI-button injection prefixes
   *  (dig-deeper / DP_* / Feedback etc.). Computed once at beginPrompt(). Lets
   *  analytics exclude button-triggered prompts from real-user-intent stats. */
  isInjectedPrompt: boolean;
  /** DP (Deep Probe) workflow status at the moment the trace was flushed.
   *  One of: idle | investigating | awaiting_confirmation | validating |
   *  concluding | completed. "idle" when DP isn't tracked for this session. */
  dpStatusEnd: string;
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
  private upsertStmt: StatementSync;
  private getBodyStmt: StatementSync;

  constructor(dbPath: string) {
    const DbCtor = loadSqlite();
    if (!DbCtor) throw new Error("node:sqlite not available");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DbCtor(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");

    // Schema management — v1 used TEXT PK; v2 added INTEGER PK + UNIQUE
    // trace_key; v3 switched *_at fields from INTEGER ms to TEXT Beijing time;
    // v4 added is_injected_prompt + dp_status_end.
    ensureSchema(this.db);

    // INSERT — hard fails on UNIQUE(trace_key) collision. Use this when the
    // caller wants "fail loudly on duplicate id" semantics.
    this.insertStmt = this.db.prepare(`
      INSERT INTO agent_traces (
        trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
        user_message, outcome, started_at, ended_at, duration_ms,
        step_count, tool_call_count, tokens_total, cost_usd,
        schema_version, body_json, body_bytes,
        is_injected_prompt, dp_status_end
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
    `);

    // UPSERT — used by the trace-recorder's two-phase persistence:
    //   1. beginPrompt() writes a stub row with outcome='in_progress' so that
    //      a prompt which later HANGS (propose_hypotheses infinite loop,
    //      network stall, pod killed mid-run …) still has a DB record.
    //   2. flush() writes again with the same trace_key once the prompt
    //      genuinely finishes — ON CONFLICT overwrites the stub with the
    //      complete data. Normal-completion path therefore still has full
    //      duration / steps / body_json in the final row.
    // Columns excluded from the UPDATE: id (auto PK), trace_key (the conflict
    // target itself), created_at (set once by DB DEFAULT when the stub was
    // inserted; we want it to reflect FIRST-seen time, not last-flush time).
    this.upsertStmt = this.db.prepare(`
      INSERT INTO agent_traces (
        trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
        user_message, outcome, started_at, ended_at, duration_ms,
        step_count, tool_call_count, tokens_total, cost_usd,
        schema_version, body_json, body_bytes,
        is_injected_prompt, dp_status_end
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(trace_key) DO UPDATE SET
        session_id         = excluded.session_id,
        prompt_idx         = excluded.prompt_idx,
        user_id            = excluded.user_id,
        username           = excluded.username,
        mode               = excluded.mode,
        brain_type         = excluded.brain_type,
        model_name         = excluded.model_name,
        user_message       = excluded.user_message,
        outcome            = excluded.outcome,
        started_at         = excluded.started_at,
        ended_at           = excluded.ended_at,
        duration_ms        = excluded.duration_ms,
        step_count         = excluded.step_count,
        tool_call_count    = excluded.tool_call_count,
        tokens_total       = excluded.tokens_total,
        cost_usd           = excluded.cost_usd,
        schema_version     = excluded.schema_version,
        body_json          = excluded.body_json,
        body_bytes         = excluded.body_bytes,
        is_injected_prompt = excluded.is_injected_prompt,
        dp_status_end      = excluded.dp_status_end
    `);

    this.getBodyStmt = this.db.prepare(
      `SELECT trace_key AS id, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
              user_message, outcome, started_at, ended_at, duration_ms,
              step_count, tool_call_count, tokens_total, cost_usd, schema_version,
              created_at, is_injected_prompt, dp_status_end, body_json
         FROM agent_traces WHERE trace_key = ?`,
    );
  }

  insert(row: TraceRow & { bodyJson: string }): void {
    this.insertStmt.run(...this.rowToParams(row));
  }

  /**
   * UPSERT — insert if trace_key is new, otherwise UPDATE all mutable columns.
   * Used by the two-phase persistence in TraceRecorder: stub at beginPrompt,
   * full body at flush. Safe to call repeatedly for the same trace_key.
   */
  upsert(row: TraceRow & { bodyJson: string }): void {
    this.upsertStmt.run(...this.rowToParams(row));
  }

  /** Shared positional-parameter builder for insert/upsert (same column order). */
  private rowToParams(row: TraceRow & { bodyJson: string }): Array<string | number | null> {
    return [
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
      row.isInjectedPrompt ? 1 : 0,
      row.dpStatusEnd,
    ];
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
             step_count, tool_call_count, tokens_total, cost_usd, schema_version, created_at,
             is_injected_prompt, dp_status_end
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
const SCHEMA_VERSION = 4;

/**
 * Canonical v4 DDL.
 *   - Clustered INTEGER PK + UNIQUE trace_key (since v2).
 *   - Beijing-time TEXT timestamps (since v3).
 *   - `is_injected_prompt INTEGER NOT NULL DEFAULT 0` — 0/1 (boolean). True
 *     when userMessage starts with a UI-button injection prefix.
 *   - `dp_status_end TEXT NOT NULL DEFAULT 'idle'` — DP workflow status at
 *     the moment the trace was flushed (idle / investigating /
 *     awaiting_confirmation / validating / concluding / completed).
 *   NOT NULL + DEFAULT so that legacy rows copied during migration get safe
 *   values without touching every migration branch's SELECT list.
 */
const DDL_V4_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_traces (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_key           TEXT NOT NULL UNIQUE,
    session_id          TEXT NOT NULL,
    prompt_idx          INTEGER NOT NULL,
    user_id             TEXT,
    username            TEXT,
    mode                TEXT NOT NULL,
    brain_type          TEXT,
    model_name          TEXT,
    user_message        TEXT,
    outcome             TEXT NOT NULL,
    started_at          TEXT NOT NULL,
    ended_at            TEXT NOT NULL,
    duration_ms         INTEGER NOT NULL,
    step_count          INTEGER NOT NULL DEFAULT 0,
    tool_call_count     INTEGER NOT NULL DEFAULT 0,
    tokens_total        INTEGER,
    cost_usd            REAL,
    schema_version      TEXT NOT NULL,
    body_json           TEXT NOT NULL,
    body_bytes          INTEGER NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now', '+8 hours')),
    is_injected_prompt  INTEGER NOT NULL DEFAULT 0,
    dp_status_end       TEXT NOT NULL DEFAULT 'idle'
  );
`;

const DDL_V4_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_traces_user_time ON agent_traces(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_time      ON agent_traces(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_session   ON agent_traces(session_id, prompt_idx);
`;

/**
 * Create or migrate the schema to v4.
 *   fresh DB                              → create v4 directly
 *   v1 (TEXT PK, integer ms) / v2         → rebuild to v4 (new-columns get DEFAULT)
 *   v3 (missing isInjectedPrompt/dpStatus)→ cheap ALTER TABLE ADD COLUMN
 *   v4                                    → no-op (idempotent index reassert)
 */
function ensureSchema(db: DatabaseSync): void {
  const currentVersion =
    (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
  if (currentVersion >= SCHEMA_VERSION) {
    db.exec(DDL_V4_INDEXES);
    return;
  }

  const tableExists = db
    .prepare(`SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='agent_traces'`)
    .get() !== undefined;

  if (!tableExists) {
    db.exec(DDL_V4_TABLE);
    db.exec(DDL_V4_INDEXES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  const cols = db.prepare(`PRAGMA table_info(agent_traces)`).all() as Array<{ name: string }>;
  const hasTraceKey = cols.some((c) => c.name === "trace_key");
  const hasStartedAt = cols.some((c) => c.name === "started_at");
  const hasStartedAtMs = cols.some((c) => c.name === "started_at_ms");
  const hasIsInjected = cols.some((c) => c.name === "is_injected_prompt");
  const hasDpStatusEnd = cols.some((c) => c.name === "dp_status_end");

  // Branch 1: v1 schema (TEXT PK, started_at_ms). Full rebuild → v4.
  if (!hasTraceKey && hasStartedAtMs) {
    console.log("[trace-store] Migrating agent_traces v1 → v4...");
    rebuildFromLegacy(db, "v1");
    return;
  }

  // Branch 2: v2 schema (INTEGER PK + trace_key, but still started_at_ms). Full rebuild → v4.
  if (hasTraceKey && hasStartedAtMs && !hasStartedAt) {
    console.log("[trace-store] Migrating agent_traces v2 → v4...");
    rebuildFromLegacy(db, "v2");
    return;
  }

  // Branch 3: v3 schema (TEXT timestamps, missing the two new columns).
  // Non-destructive additive migration — no rebuild, keeps existing rows untouched.
  if (hasTraceKey && hasStartedAt && (!hasIsInjected || !hasDpStatusEnd)) {
    console.log("[trace-store] Migrating agent_traces v3 → v4 (adding is_injected_prompt + dp_status_end)...");
    db.exec("BEGIN");
    try {
      if (!hasIsInjected) {
        db.exec(`ALTER TABLE agent_traces ADD COLUMN is_injected_prompt INTEGER NOT NULL DEFAULT 0`);
      }
      if (!hasDpStatusEnd) {
        db.exec(`ALTER TABLE agent_traces ADD COLUMN dp_status_end TEXT NOT NULL DEFAULT 'idle'`);
      }
      db.exec(DDL_V4_INDEXES);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
      const count = (db.prepare("SELECT COUNT(*) AS n FROM agent_traces").get() as { n: number }).n;
      console.log(`[trace-store] Migration complete. ${count} existing row(s) kept, new columns defaulted.`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return;
  }

  // Branch 4: already looks like v4 but missing version stamp — just stamp.
  if (hasTraceKey && hasStartedAt && hasIsInjected && hasDpStatusEnd) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec(DDL_V4_INDEXES);
    return;
  }

  throw new Error("[trace-store] Unrecognized agent_traces schema — refusing to migrate blindly.");
}

/**
 * Shared in-place rebuild used when migrating v1 or v2 directly to v4.
 * Rename old → create v4 → copy+convert → drop old → rebuild indexes.
 * One transaction, so the file is never observed half-migrated.
 *
 * SELECT list intentionally omits the two new v4 columns
 * (`is_injected_prompt`, `dp_status_end`) — their NOT NULL DEFAULT fills them
 * in automatically for legacy rows. Safe defaults: not injected, idle.
 */
function rebuildFromLegacy(db: DatabaseSync, legacy: "v1" | "v2"): void {
  db.exec("BEGIN");
  try {
    db.exec(`ALTER TABLE agent_traces RENAME TO agent_traces_legacy`);
    db.exec(DDL_V4_TABLE);

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
    db.exec(DDL_V4_INDEXES);
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
    isInjectedPrompt: Boolean(r.is_injected_prompt),
    dpStatusEnd: (r.dp_status_end as string | null) ?? "idle",
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
