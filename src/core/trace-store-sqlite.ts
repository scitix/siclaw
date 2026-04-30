/**
 * SqliteTraceStore — default `TraceStore` implementation backed by a local
 * node:sqlite file (default: <cwd>/.siclaw/traces.sqlite).
 *
 * Interface methods are async even though node:sqlite is synchronous — this
 * keeps the contract uniform across sqlite / mysql / composite implementations
 * so TraceRecorder can await uniformly.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type {
  TraceStore,
  TraceRow,
  TraceListOpts,
  TraceListResult,
  TraceRecord,
} from "./trace-store-types.js";
import { coerceInjectedPromptKind } from "./injected-prompt-kinds.js";

// ── Lazy loader for node:sqlite (stable only in Node ≥22.13) ────────────────

type SqliteCtor = new (path: string) => DatabaseSync;
let _sqliteLoad: { ctor: SqliteCtor } | { error: string } | null = null;

export function loadSqlite(): SqliteCtor | null {
  if (!_sqliteLoad) {
    try {
      const req = createRequire(import.meta.url);
      const mod = req("node:sqlite") as { DatabaseSync: SqliteCtor };
      _sqliteLoad = { ctor: mod.DatabaseSync };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      _sqliteLoad = { error: code || String(err) };
      console.warn(
        `[trace-store-sqlite] node:sqlite unavailable (${code || "load failed"}). ` +
        `Fix: upgrade Node to ≥22.13 (or run with NODE_OPTIONS=--experimental-sqlite on 22.12).`,
      );
    }
  }
  return "ctor" in _sqliteLoad ? _sqliteLoad.ctor : null;
}

// ── Implementation ──────────────────────────────────────────────────────────

export class SqliteTraceStore implements TraceStore {
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

    // Schema management — v1 TEXT PK; v2 INTEGER PK + UNIQUE trace_key;
    // v3 TEXT Beijing timestamps; v4 adds is_injected_prompt + dp_status_end;
    // v5 adds trace_summary + trace_summary_json; v6 changes is_injected_prompt
    // INTEGER (0/1) → TEXT enum (none / dp_confirm_legacy / chip_click / …);
    // v7 adds trace_easy — an even-thinner sibling of trace_summary.
    ensureSchema(this.db);

    // INSERT — hard fails on UNIQUE(trace_key) collision.
    this.insertStmt = this.db.prepare(`
      INSERT INTO agent_traces (
        trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
        user_message, outcome, started_at, ended_at, duration_ms,
        step_count, tool_call_count, tokens_total, cost_usd,
        schema_version, body_json, body_bytes,
        is_injected_prompt, dp_status_end,
        trace_summary, trace_summary_json,
        trace_easy
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?
      )
    `);

    // UPSERT — two-phase persistence: stub at beginPrompt → full row at flush.
    // created_at excluded from UPDATE so it reflects FIRST-seen time.
    this.upsertStmt = this.db.prepare(`
      INSERT INTO agent_traces (
        trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
        user_message, outcome, started_at, ended_at, duration_ms,
        step_count, tool_call_count, tokens_total, cost_usd,
        schema_version, body_json, body_bytes,
        is_injected_prompt, dp_status_end,
        trace_summary, trace_summary_json,
        trace_easy
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?
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
        dp_status_end      = excluded.dp_status_end,
        trace_summary      = excluded.trace_summary,
        trace_summary_json = excluded.trace_summary_json,
        trace_easy         = excluded.trace_easy
    `);

    this.getBodyStmt = this.db.prepare(
      `SELECT trace_key AS id, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
              user_message, outcome, started_at, ended_at, duration_ms,
              step_count, tool_call_count, tokens_total, cost_usd, schema_version,
              created_at, is_injected_prompt, dp_status_end,
              trace_summary, trace_summary_json, trace_easy, body_json
         FROM agent_traces WHERE trace_key = ?`,
    );
  }

  async insert(row: TraceRow & { bodyJson: string }): Promise<void> {
    this.insertStmt.run(...rowToParams(row));
  }

  async upsert(row: TraceRow & { bodyJson: string }): Promise<void> {
    this.upsertStmt.run(...rowToParams(row));
  }

  async list(opts: TraceListOpts): Promise<TraceListResult> {
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
    if (opts.sessionId) {
      where.push("session_id = ?");
      params.push(opts.sessionId);
    }
    if (opts.mode) {
      where.push("mode = ?");
      params.push(opts.mode);
    }
    if (opts.isInjectedPrompt !== undefined) {
      const kinds = Array.isArray(opts.isInjectedPrompt)
        ? opts.isInjectedPrompt
        : [opts.isInjectedPrompt];
      if (kinds.length > 0) {
        where.push(`is_injected_prompt IN (${kinds.map(() => "?").join(", ")})`);
        for (const k of kinds) params.push(k);
      }
    }
    if (opts.dpStatusEnd) {
      where.push("dp_status_end = ?");
      params.push(opts.dpStatusEnd);
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
             is_injected_prompt, dp_status_end, trace_summary, trace_summary_json, trace_easy
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

  async getById(id: string): Promise<TraceRecord | null> {
    const row = this.getBodyStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...rowToTraceRow(row), bodyJson: row.body_json as string };
  }

  async deleteById(id: string): Promise<boolean> {
    const info = this.db.prepare("DELETE FROM agent_traces WHERE trace_key = ?").run(id);
    return Number(info.changes) > 0;
  }

  async close(): Promise<void> {
    try { this.db.close(); } catch { /* best-effort */ }
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function rowToParams(row: TraceRow & { bodyJson: string }): Array<string | number | null> {
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
    row.isInjectedPrompt,
    row.dpStatusEnd,
    row.traceSummary ?? null,
    row.traceSummaryJson ?? null,
    row.traceEasy ?? null,
  ];
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
    isInjectedPrompt: coerceInjectedPromptKind(r.is_injected_prompt),
    dpStatusEnd: (r.dp_status_end as string | null) ?? "idle",
    traceSummary: (r.trace_summary as string | null) ?? null,
    traceSummaryJson: (r.trace_summary_json as string | null) ?? null,
    traceEasy: (r.trace_easy as string | null) ?? null,
  };
}

/** HH:mm:ss.SSS zero-padded. Wraps past 24h. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00:00.000";
  const hh = Math.floor(ms / 3600_000);
  const mm = Math.floor((ms / 60_000) % 60);
  const ss = Math.floor((ms / 1000) % 60);
  const sss = Math.floor(ms % 1000);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(sss).padStart(3, "0")}`;
}

// ── Schema management + migration ───────────────────────────────────────────

const SCHEMA_VERSION = 7;

// v6 changed `is_injected_prompt` from INTEGER (0/1) to TEXT enum.
// Default value `'none'` matches the boolean-false case; legacy 1 rows are
// migrated to `'unknown_legacy'` because the original kind is unrecoverable
// from the DB row alone (re-running classifyInjectedPrompt against the stored
// user_message would re-derive it, but that is a backfill concern, not a
// schema concern).
const DDL_V6_TABLE = `
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
    is_injected_prompt  TEXT NOT NULL DEFAULT 'none',
    dp_status_end       TEXT NOT NULL DEFAULT 'idle',
    trace_summary       TEXT,
    trace_summary_json  TEXT,
    trace_easy          TEXT
  );
`;

const DDL_V6_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_traces_user_time ON agent_traces(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_time      ON agent_traces(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_session   ON agent_traces(session_id, prompt_idx);
  CREATE INDEX IF NOT EXISTS idx_traces_injected  ON agent_traces(is_injected_prompt);
`;

/**
 * Create or migrate the schema to v6.
 *   fresh DB                              → create v6 directly
 *   v1 / v2 legacy (integer ms columns)   → full rebuild via rebuildFromLegacy,
 *                                           then forwarded through v3/v4/v5/v6
 *   v3 (no injected/dp columns)           → additive ALTER TABLE ADD COLUMN
 *                                           (column added directly as TEXT)
 *   v4 (no summary columns)               → additive ALTER TABLE ADD COLUMN
 *   v5 (is_injected_prompt INTEGER 0/1)   → table rebuild to TEXT enum
 *   v6                                    → no-op (idempotent index reassert)
 */
function ensureSchema(db: DatabaseSync): void {
  const currentVersion =
    (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
  if (currentVersion >= SCHEMA_VERSION) {
    db.exec(DDL_V6_INDEXES);
    return;
  }

  const tableExists = db
    .prepare(`SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='agent_traces'`)
    .get() !== undefined;

  if (!tableExists) {
    db.exec(DDL_V6_TABLE);
    db.exec(DDL_V6_INDEXES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  const inspect = () => {
    const cols = db.prepare(`PRAGMA table_info(agent_traces)`).all() as Array<{ name: string; type: string }>;
    const findCol = (n: string) => cols.find((c) => c.name === n);
    return {
      hasTraceKey: !!findCol("trace_key"),
      hasStartedAt: !!findCol("started_at"),
      hasStartedAtMs: !!findCol("started_at_ms"),
      hasIsInjected: !!findCol("is_injected_prompt"),
      isInjectedTypeIsText: (findCol("is_injected_prompt")?.type ?? "").toUpperCase().includes("TEXT"),
      hasDpStatusEnd: !!findCol("dp_status_end"),
      hasTraceSummary: !!findCol("trace_summary"),
      hasTraceSummaryJson: !!findCol("trace_summary_json"),
      hasTraceEasy: !!findCol("trace_easy"),
    };
  };

  let info = inspect();

  if (!info.hasTraceKey && info.hasStartedAtMs) {
    console.log("[trace-store-sqlite] Migrating agent_traces v1 → v6...");
    rebuildFromLegacy(db, "v1");
    return;
  }

  if (info.hasTraceKey && info.hasStartedAtMs && !info.hasStartedAt) {
    console.log("[trace-store-sqlite] Migrating agent_traces v2 → v6...");
    rebuildFromLegacy(db, "v2");
    return;
  }

  if (info.hasTraceKey && info.hasStartedAt) {
    db.exec("BEGIN");
    try {
      if (!info.hasIsInjected) {
        // Pre-v4 table: add directly as TEXT enum (skips the v5 INTEGER step).
        db.exec(`ALTER TABLE agent_traces ADD COLUMN is_injected_prompt TEXT NOT NULL DEFAULT 'none'`);
      }
      if (!info.hasDpStatusEnd) {
        db.exec(`ALTER TABLE agent_traces ADD COLUMN dp_status_end TEXT NOT NULL DEFAULT 'idle'`);
      }
      info = inspect();
      if (!info.hasTraceSummary) {
        db.exec(`ALTER TABLE agent_traces ADD COLUMN trace_summary TEXT`);
      }
      if (!info.hasTraceSummaryJson) {
        db.exec(`ALTER TABLE agent_traces ADD COLUMN trace_summary_json TEXT`);
      }
      if (!info.hasTraceEasy) {
        db.exec(`ALTER TABLE agent_traces ADD COLUMN trace_easy TEXT`);
      }
      info = inspect();
      // v5 → v6: column existed as INTEGER 0/1. SQLite does not support
      // ALTER COLUMN, so do an in-place rebuild that translates 0 → 'none'
      // and 1 → 'unknown_legacy'. (A separate offline backfill script can
      // re-classify rows from user_message after this completes.)
      if (info.hasIsInjected && !info.isInjectedTypeIsText) {
        rebuildIsInjectedToText(db);
      }
      db.exec(DDL_V6_INDEXES);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
      const count = (db.prepare("SELECT COUNT(*) AS n FROM agent_traces").get() as { n: number }).n;
      console.log(`[trace-store-sqlite] Migrated to v${SCHEMA_VERSION}. ${count} existing row(s) kept; legacy injected=1 rows mapped to 'unknown_legacy'; trace_easy defaults to NULL until backfilled.`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return;
  }

  throw new Error("[trace-store-sqlite] Unrecognized agent_traces schema — refusing to migrate blindly.");
}

/**
 * Rebuild `agent_traces` so `is_injected_prompt` is TEXT (enum) rather than
 * INTEGER (0/1). Called from inside an existing transaction in ensureSchema().
 */
function rebuildIsInjectedToText(db: DatabaseSync): void {
  db.exec(`ALTER TABLE agent_traces RENAME TO agent_traces_v5`);
  db.exec(DDL_V6_TABLE);
  db.exec(`
    INSERT INTO agent_traces (
      id, trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
      user_message, outcome, started_at, ended_at, duration_ms,
      step_count, tool_call_count, tokens_total, cost_usd,
      schema_version, body_json, body_bytes, created_at,
      is_injected_prompt, dp_status_end, trace_summary, trace_summary_json, trace_easy
    )
    SELECT
      id, trace_key, session_id, prompt_idx, user_id, username, mode, brain_type, model_name,
      user_message, outcome, started_at, ended_at, duration_ms,
      step_count, tool_call_count, tokens_total, cost_usd,
      schema_version, body_json, body_bytes, created_at,
      CASE
        WHEN is_injected_prompt IS NULL OR is_injected_prompt = 0 OR is_injected_prompt = '0' THEN 'none'
        WHEN is_injected_prompt = 1 OR is_injected_prompt = '1'                              THEN 'unknown_legacy'
        ELSE COALESCE(CAST(is_injected_prompt AS TEXT), 'none')
      END,
      dp_status_end, trace_summary, trace_summary_json, trace_easy
      FROM agent_traces_v5
     ORDER BY id ASC
  `);
  db.exec(`DROP TABLE agent_traces_v5`);
}

function rebuildFromLegacy(db: DatabaseSync, legacy: "v1" | "v2"): void {
  db.exec("BEGIN");
  try {
    db.exec(`ALTER TABLE agent_traces RENAME TO agent_traces_legacy`);
    db.exec(DDL_V6_TABLE);

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
    db.exec(DDL_V6_INDEXES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM agent_traces").get() as { n: number }).n;
    console.log(`[trace-store-sqlite] Migration complete. ${count} row(s) carried over.`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
