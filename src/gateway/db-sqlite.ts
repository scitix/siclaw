/**
 * SQLite driver — wraps node:sqlite (Node 22+) to conform to the Db interface.
 *
 * Used by `siclaw local` for zero-dependency single-process deployment.
 * All SQL is routed through `preprocessSql()` as a defensive fallback for
 * any remaining MySQL-specific syntax residues (e.g. CURRENT_TIMESTAMP(3)).
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { AsyncMutex } from "./async-mutex.js";
import type { Db, Conn } from "./db.js";

export class SqliteDb implements Db {
  readonly driver = "sqlite" as const;
  private readonly raw: DatabaseSync;
  private readonly mutex = new AsyncMutex();

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      const dir = path.dirname(filePath);
      if (dir && dir !== "." && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.raw = new DatabaseSync(filePath);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA synchronous = NORMAL");
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<[T, unknown]> {
    return [runSql<T>(this.raw, sql, params), undefined];
  }

  async execute(sql: string, params: any[] = []): Promise<{ affectedRows: number; insertId?: string | number }> {
    const result = runSql<any>(this.raw, sql, params);
    if (Array.isArray(result)) {
      // SELECT-like; treat as zero rows changed
      return { affectedRows: 0 };
    }
    return { affectedRows: result.affectedRows ?? 0, insertId: result.insertId };
  }

  async getConnection(): Promise<Conn> {
    const release = await this.mutex.acquire();
    return new SqliteConn(this.raw, release);
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

class SqliteConn implements Conn {
  private released = false;
  constructor(
    private readonly raw: DatabaseSync,
    private readonly releaseMutex: () => void,
  ) {}

  async query<T = any>(sql: string, params: any[] = []): Promise<[T, unknown]> {
    return [runSql<T>(this.raw, sql, params), undefined];
  }

  async beginTransaction(): Promise<void> {
    this.raw.exec("BEGIN IMMEDIATE");
  }

  async commit(): Promise<void> {
    this.raw.exec("COMMIT");
  }

  async rollback(): Promise<void> {
    this.raw.exec("ROLLBACK");
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseMutex();
  }
}

/**
 * Run a SQL statement and return either an array of rows (SELECT-like)
 * or an OkPacket-shaped object (DML / DDL), matching mysql2's contract.
 */
function runSql<T>(raw: DatabaseSync, sql: string, params: any[]): T {
  const cleaned = preprocessSql(sql);
  const kind = sqlKind(cleaned);

  // PRAGMA table_info / index_list etc. return rows even though they start with PRAGMA.
  // Detect that explicitly and go through the SELECT path.
  const isPragmaQuery = /^\s*PRAGMA\s+\w+\s*\(/i.test(cleaned);

  if (kind === "select" || isPragmaQuery) {
    const stmt = raw.prepare(cleaned);
    const rows = stmt.all(...normaliseParams(params));
    return rows as T;
  }

  // DDL (CREATE/DROP/ALTER) and bare PRAGMA statements — use exec() which
  // tolerates multi-statement DDL but doesn't bind params.
  if (kind === "ddl" && params.length === 0) {
    raw.exec(cleaned);
    return { affectedRows: 0, insertId: undefined } as T;
  }

  const stmt = raw.prepare(cleaned);
  const r = stmt.run(...normaliseParams(params));
  return {
    affectedRows: Number(r.changes ?? 0),
    insertId: typeof r.lastInsertRowid === "bigint"
      ? Number(r.lastInsertRowid)
      : (r.lastInsertRowid as number | undefined),
  } as T;
}

function sqlKind(sql: string): "select" | "dml" | "ddl" {
  const head = sql.trimStart().slice(0, 16).toUpperCase();
  if (head.startsWith("SELECT") || head.startsWith("WITH") || head.startsWith("PRAGMA")) return "select";
  if (head.startsWith("CREATE") || head.startsWith("DROP") || head.startsWith("ALTER")) return "ddl";
  return "dml";
}

/**
 * Defensive text substitution for MySQL-specific syntax that might slip through
 * business-layer cleanup. This is a safety net, not the primary mechanism.
 */
export function preprocessSql(sql: string): string {
  return sql
    .replace(/CURRENT_TIMESTAMP\s*\(\s*\d+\s*\)/gi, "CURRENT_TIMESTAMP")
    .replace(/\bNOW\s*\(\s*\d+\s*\)/gi, "CURRENT_TIMESTAMP");
}

/**
 * node:sqlite's bind() rejects `undefined` and some special values. Normalise
 * undefined → null to match mysql2's behaviour; convert Date → dialect-neutral
 * SQL timestamp string (same format MySQL accepts — "YYYY-MM-DD HH:MM:SS.sss")
 * so that ORDER BY comparisons between rows written by both drivers sort
 * identically.
 */
function normaliseParams(params: any[]): any[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString().replace("T", " ").replace(/Z$/, "");
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}
