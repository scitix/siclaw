/**
 * TraceStore — public entry point.
 *
 * Re-exports the interface + concrete implementations and provides the async
 * factory `getTraceStore()` that inspects env-var config and returns a ready
 * store (or null if tracing is fully disabled).
 *
 * Config (environment variables):
 *   SICLAW_TRACE_DISABLE=1           → master kill switch; factory returns null
 *   SICLAW_TRACE_SQLITE_ENABLED=1    → enable SQLite sink (DEFAULT OFF)
 *   SICLAW_TRACE_MYSQL_ENABLED=0     → disable MySQL sink (DEFAULT ON)
 *   SICLAW_TRACE_MYSQL_URL=mysql://user:pass@host:3306/db
 *                                    → required when MySQL is enabled
 *   SICLAW_TRACE_DB=/path/to/file    → override SQLite path (default
 *                                      <cwd>/.siclaw/traces.sqlite)
 *
 * Enablement matrix:
 *   sqlite=0 mysql=0 → null (no tracing)
 *   sqlite=1 mysql=0 → SqliteTraceStore
 *   sqlite=0 mysql=1 → MysqlTraceStore (default)
 *   sqlite=1 mysql=1 → CompositeTraceStore([mysql, sqlite])  — MySQL primary,
 *                       dual-write, warn-on-partial-failure
 *
 * If MySQL is enabled but SICLAW_TRACE_MYSQL_URL is missing, MySQL is skipped
 * with a warning; if SQLite is also disabled, factory returns null.
 */

import path from "node:path";
import type { TraceStore } from "./trace-store-types.js";
import { SqliteTraceStore } from "./trace-store-sqlite.js";
import { MysqlTraceStore } from "./trace-store-mysql.js";
import { CompositeTraceStore, type NamedStore } from "./trace-store-composite.js";

// Re-exports — consumers should import everything from this barrel.
export type {
  TraceStore,
  TraceRow,
  TraceListOpts,
  TraceListResult,
  TraceRecord,
} from "./trace-store-types.js";
export { SqliteTraceStore } from "./trace-store-sqlite.js";
export { MysqlTraceStore } from "./trace-store-mysql.js";
export { CompositeTraceStore } from "./trace-store-composite.js";

// ── Factory ─────────────────────────────────────────────────────────────────

let _storePromise: Promise<TraceStore | null> | null = null;

/**
 * Return the process-level TraceStore, constructing it lazily. Memoized —
 * subsequent calls return the same promise (which resolves to the same
 * instance). Async because MySQL schema init happens on first use.
 */
export function getTraceStore(): Promise<TraceStore | null> {
  if (!_storePromise) _storePromise = buildStore();
  return _storePromise;
}

/** Close any open store. Idempotent. */
export async function closeTraceStore(): Promise<void> {
  if (!_storePromise) return;
  const p = _storePromise;
  _storePromise = null;
  const store = await p;
  if (store) {
    try { await store.close(); }
    catch (err) { console.warn("[trace-store] close failed:", err); }
  }
}

/** Internal: resolve config → named stores → single / composite. */
async function buildStore(): Promise<TraceStore | null> {
  if (process.env.SICLAW_TRACE_DISABLE === "1") {
    console.log("[trace-store] SICLAW_TRACE_DISABLE=1 — tracing disabled");
    return null;
  }

  // Explicit flags: default SQLite OFF, default MySQL ON (per product
  // decision — production is K8s with a MySQL pod; local SQLite is opt-in).
  const sqliteEnabled = readBool("SICLAW_TRACE_SQLITE_ENABLED", false);
  const mysqlEnabled = readBool("SICLAW_TRACE_MYSQL_ENABLED", true);

  const stores: NamedStore[] = [];

  // MySQL first so it becomes the composite's primary (reads go here).
  if (mysqlEnabled) {
    const url = process.env.SICLAW_TRACE_MYSQL_URL?.trim();
    if (!url) {
      console.warn(
        "[trace-store] SICLAW_TRACE_MYSQL_ENABLED is on but SICLAW_TRACE_MYSQL_URL is unset — skipping MySQL sink. " +
        "Set the URL or SICLAW_TRACE_MYSQL_ENABLED=0 to silence this warning.",
      );
    } else {
      try {
        const store = new MysqlTraceStore(url);
        await store.ensureSchema();
        stores.push({ name: "mysql", store });
        console.log(`[trace-store] MySQL sink ready: ${redactUrl(url)}`);
      } catch (err) {
        console.warn("[trace-store] MySQL sink init failed, continuing without it:", err);
      }
    }
  }

  if (sqliteEnabled) {
    try {
      const dbPath =
        process.env.SICLAW_TRACE_DB ??
        path.join(process.cwd(), ".siclaw", "traces.sqlite");
      stores.push({ name: "sqlite", store: new SqliteTraceStore(dbPath) });
      console.log(`[trace-store] SQLite sink ready: ${dbPath}`);
    } catch (err) {
      console.warn("[trace-store] SQLite sink init failed, continuing without it:", err);
    }
  }

  if (stores.length === 0) {
    console.warn(
      "[trace-store] No trace sinks enabled. Traces will NOT be persisted. " +
      "Enable MySQL (SICLAW_TRACE_MYSQL_URL=...) or SQLite (SICLAW_TRACE_SQLITE_ENABLED=1).",
    );
    return null;
  }

  if (stores.length === 1) {
    return stores[0].store;
  }

  return new CompositeTraceStore(stores);
}

/** Parse an env var as boolean, with an explicit default for unset/empty. */
function readBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

/** Mask the password segment when logging a MySQL URL. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
  }
}
