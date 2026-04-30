#!/usr/bin/env -S node --experimental-strip-types
/**
 * Backfill `trace_summary` + `trace_summary_json` for historical rows in
 * `agent_traces` whose summary columns are NULL.
 *
 * Pure local computation: parses each row's `body_json`, calls
 * `buildTraceSummary`, writes the two columns. No LLM, no network. Safe to
 * re-run; only NULL rows are visited.
 *
 * Backend selection mirrors `getTraceStore()`:
 *   - SICLAW_TRACE_MYSQL_URL set        → MySQL
 *   - SICLAW_TRACE_SQLITE_ENABLED=1     → SQLite at SICLAW_TRACE_DB or default
 *
 * Usage:
 *   SICLAW_TRACE_MYSQL_URL=mysql://... node --experimental-strip-types \
 *     scripts/backfill-trace-summary.ts
 *
 *   SICLAW_TRACE_SQLITE_ENABLED=1 SICLAW_TRACE_DB=/path/to/traces.sqlite \
 *     node --experimental-strip-types scripts/backfill-trace-summary.ts
 */

import path from "node:path";
import mysql from "mysql2/promise";
import { loadSqlite } from "../src/core/trace-store-sqlite.js";
import { buildTraceSummary, type SummaryStepInput } from "../src/core/trace-summary.js";

const BATCH_SIZE = 200;

interface BodyShape {
  userMessage?: string;
  steps?: SummaryStepInput[];
}

function summarize(bodyJson: string): { line: string; events: string } | null {
  let body: BodyShape;
  try {
    body = JSON.parse(bodyJson) as BodyShape;
  } catch {
    return null;
  }
  const r = buildTraceSummary({
    userMessage: body.userMessage ?? "",
    steps: Array.isArray(body.steps) ? body.steps : [],
  });
  return { line: r.line, events: JSON.stringify(r.events) };
}

async function backfillMysql(url: string): Promise<void> {
  const pool = mysql.createPool({ uri: url, connectionLimit: 4 });
  let done = 0;
  let lastId = 0;
  try {
    for (;;) {
      const [rows] = await pool.execute(
        `SELECT id, trace_key, body_json
           FROM agent_traces
          WHERE trace_summary IS NULL AND id > ?
          ORDER BY id ASC
          LIMIT ${BATCH_SIZE}`,
        [lastId],
      );
      const arr = rows as Array<{ id: number; trace_key: string; body_json: string }>;
      if (arr.length === 0) break;
      for (const row of arr) {
        lastId = row.id;
        const s = summarize(row.body_json);
        if (!s) continue;
        await pool.execute(
          `UPDATE agent_traces SET trace_summary = ?, trace_summary_json = ? WHERE id = ?`,
          [s.line, s.events, row.id],
        );
        done += 1;
      }
      console.log(`[backfill-mysql] processed batch up to id=${lastId}, total=${done}`);
    }
  } finally {
    await pool.end();
  }
  console.log(`[backfill-mysql] DONE — ${done} row(s) updated.`);
}

async function backfillSqlite(dbPath: string): Promise<void> {
  const Ctor = loadSqlite();
  if (!Ctor) throw new Error("node:sqlite not available");
  const db = new Ctor(dbPath);
  const select = db.prepare(
    `SELECT id, trace_key, body_json
       FROM agent_traces
      WHERE trace_summary IS NULL AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
  );
  const update = db.prepare(
    `UPDATE agent_traces SET trace_summary = ?, trace_summary_json = ? WHERE id = ?`,
  );
  let done = 0;
  let lastId = 0;
  for (;;) {
    const rows = select.all(lastId, BATCH_SIZE) as Array<{ id: number; trace_key: string; body_json: string }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row.id;
      const s = summarize(row.body_json);
      if (!s) continue;
      update.run(s.line, s.events, row.id);
      done += 1;
    }
    console.log(`[backfill-sqlite] processed batch up to id=${lastId}, total=${done}`);
  }
  db.close();
  console.log(`[backfill-sqlite] DONE — ${done} row(s) updated.`);
}

async function main(): Promise<void> {
  const mysqlUrl = process.env.SICLAW_TRACE_MYSQL_URL?.trim();
  const sqliteEnabled = process.env.SICLAW_TRACE_SQLITE_ENABLED === "1";
  if (!mysqlUrl && !sqliteEnabled) {
    console.error(
      "Set SICLAW_TRACE_MYSQL_URL=mysql://... or SICLAW_TRACE_SQLITE_ENABLED=1 to choose a backend.",
    );
    process.exit(2);
  }
  if (mysqlUrl) await backfillMysql(mysqlUrl);
  if (sqliteEnabled) {
    const dbPath = process.env.SICLAW_TRACE_DB ?? path.join(process.cwd(), ".siclaw", "traces.sqlite");
    await backfillSqlite(dbPath);
  }
}

main().catch((err) => {
  console.error("[backfill-trace-summary] failed:", err);
  process.exit(1);
});
