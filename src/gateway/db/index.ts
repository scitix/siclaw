/**
 * Database Connection Factory
 *
 * Creates a Drizzle ORM instance connected to MySQL or SQLite.
 * Requires SICLAW_DATABASE_URL environment variable.
 *
 * URL schemes:
 *   mysql://...  → MySQL via mysql2
 *   sqlite:/path → SQLite via sql.js (pure WASM, zero native deps)
 *   file:/path   → SQLite via sql.js
 */

import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema-mysql.js";
import { setDialect } from "./dialect-helpers.js";

export type Database = MySql2Database<typeof schema>;

let _db: Database | undefined;
let _closeHook: (() => Promise<void>) | undefined;

// sql.js persistence state (module-level for flushSqliteDb)
let _sqlJsDb: import("sql.js").Database | null = null;
let _sqlitePath: string | null = null;
let _writeFileSync: typeof import("node:fs").writeFileSync | null = null;

export async function createDb(): Promise<Database> {
  if (_db) return _db;

  const dbUrl = process.env.SICLAW_DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "SICLAW_DATABASE_URL is required. Example: mysql://user:pass@host:3306/siclaw or sqlite:/path/to/db",
    );
  }

  const urlWantsSqlite = dbUrl.startsWith("sqlite:") || dbUrl.startsWith("file:");

  if (urlWantsSqlite) {
    setDialect("sqlite");
    const sqlitePath = dbUrl.replace(/^(sqlite:|file:)/, "");

    const { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(sqlitePath), { recursive: true });

    // Lockfile: prevent multi-process access (sql.js loads entire DB into memory)
    const lockPath = sqlitePath + ".lock";
    acquireSqliteLock(lockPath, readFileSync, writeFileSync);

    // sql.js: WASM initialization
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();

    // Load existing DB file or create new
    const sqlJsDb = existsSync(sqlitePath)
      ? new SQL.Database(readFileSync(sqlitePath))
      : new SQL.Database();

    sqlJsDb.run("PRAGMA foreign_keys = ON");

    const { drizzle: sqliteDrizzle } = await import("drizzle-orm/sql-js");
    const sqliteSchema = await import("./schema-sqlite.js");
    _db = sqliteDrizzle(sqlJsDb, { schema: sqliteSchema }) as unknown as Database;

    // Store raw references for flushSqliteDb
    _sqlJsDb = sqlJsDb;
    _sqlitePath = sqlitePath;
    _writeFileSync = writeFileSync;

    // Periodic persistence + close hook
    const save = () => writeFileSync(sqlitePath, Buffer.from(sqlJsDb.export()));
    const saveInterval = setInterval(save, 30_000);

    _closeHook = async () => {
      clearInterval(saveInterval);
      save();
      sqlJsDb.close();
      _sqlJsDb = null;
      _sqlitePath = null;
      try { unlinkSync(lockPath); } catch {}
    };

    console.log(`[db] Connected to SQLite (sql.js): ${sqlitePath}`);
  } else {
    setDialect("mysql");
    const pool = mysql.createPool(dbUrl);
    _db = drizzle(pool, { schema, mode: "default" });
    _closeHook = async () => { await pool.end(); };
    console.log("[db] Connected to MySQL");
  }

  return _db;
}

export function getDb(): Database {
  if (!_db) {
    throw new Error("Database not initialized. Call createDb() first.");
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_closeHook) {
    await _closeHook();
    _closeHook = undefined;
    _db = undefined;
    console.log("[db] Connection closed");
  }
}

/** Flush sql.js in-memory DB to disk immediately. No-op for MySQL. */
export function flushSqliteDb(): void {
  if (_sqlJsDb && _sqlitePath && _writeFileSync) {
    _writeFileSync(_sqlitePath, Buffer.from(_sqlJsDb.export()));
  }
}

export { schema };

/** Acquire a PID-based lockfile. Reclaims stale locks from dead processes. */
function acquireSqliteLock(
  lockPath: string,
  readFileSync: typeof import("node:fs").readFileSync,
  writeFileSync: typeof import("node:fs").writeFileSync,
): void {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;
    // Lock file exists — check if the holder is still alive
    let holderPid: number;
    try {
      holderPid = parseInt(readFileSync(lockPath, "utf8"), 10);
      process.kill(holderPid, 0); // signal 0 = existence check
    } catch {
      // Holder process is dead — reclaim stale lock
      writeFileSync(lockPath, String(process.pid));
      return;
    }
    throw new Error(
      `SQLite database locked by process ${holderPid}. ` +
      `sql.js does not support concurrent multi-process access. ` +
      `If the process is dead, remove: ${lockPath}`,
    );
  }
}
