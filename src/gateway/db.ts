/**
 * Unified database factory for Siclaw.
 *
 * Dispatches on the DATABASE_URL scheme:
 *   mysql://...             → MySQL via mysql2/promise
 *   sqlite:///abs/path.db   → SQLite via node:sqlite (absolute path)
 *   sqlite://./rel/path.db  → SQLite via node:sqlite (relative to cwd)
 *   sqlite::memory:         → SQLite in-memory (tests)
 *   file:/path/to/db        → SQLite alias
 *
 * Business code calls `await db.query(sql, params)` and receives
 * `[rows, undefined]` for SELECT or `[{affectedRows, insertId}, undefined]` for
 * DML — shape is identical to mysql2/promise so ~386 existing call sites stay
 * unchanged regardless of the underlying driver.
 */

import { MysqlDb } from "./db-mysql.js";
import { SqliteDb } from "./db-sqlite.js";

export interface Db {
  /**
   * SELECT → [rows: T[], undefined]
   * INSERT/UPDATE/DELETE → [{affectedRows, insertId?}, undefined]
   */
  query<T = any>(sql: string, params?: any[]): Promise<[T, unknown]>;
  execute(sql: string, params?: any[]): Promise<{ affectedRows: number; insertId?: string | number }>;
  getConnection(): Promise<Conn>;
  close(): Promise<void>;
  readonly driver: "mysql" | "sqlite";
}

export interface Conn {
  query<T = any>(sql: string, params?: any[]): Promise<[T, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

let db: Db | null = null;

export function initDb(databaseUrl: string): Db {
  db = createDb(databaseUrl);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not initialized");
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

function createDb(databaseUrl: string): Db {
  if (databaseUrl.startsWith("mysql://") || databaseUrl.startsWith("mysql2://")) {
    return new MysqlDb(databaseUrl);
  }
  if (
    databaseUrl.startsWith("sqlite://") ||
    databaseUrl.startsWith("sqlite:") ||
    databaseUrl.startsWith("file:")
  ) {
    return new SqliteDb(resolveSqlitePath(databaseUrl));
  }
  throw new Error(
    `Unsupported DATABASE_URL scheme: "${databaseUrl}". Expected mysql://..., sqlite://..., or file:...`,
  );
}

/**
 * Resolve SQLite path from a URL. Handles:
 *   sqlite::memory:            → :memory:
 *   sqlite:///abs/path.db      → /abs/path.db
 *   sqlite://./rel/path.db     → ./rel/path.db
 *   sqlite:./rel/path.db       → ./rel/path.db
 *   file:/path                 → /path
 */
function resolveSqlitePath(url: string): string {
  if (url === "sqlite::memory:" || url === "sqlite://:memory:") return ":memory:";
  if (url.startsWith("sqlite:///")) return "/" + url.slice("sqlite:///".length);
  if (url.startsWith("sqlite://")) return url.slice("sqlite://".length);
  if (url.startsWith("sqlite:")) return url.slice("sqlite:".length);
  if (url.startsWith("file:")) return url.slice("file:".length);
  throw new Error(`Cannot resolve sqlite path from "${url}"`);
}
