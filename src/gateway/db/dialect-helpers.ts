/**
 * Dialect Helpers — runtime dialect tracking for MySQL / SQLite dual-driver support.
 */

let _dialect: "mysql" | "sqlite" = "mysql";

export function setDialect(d: "mysql" | "sqlite") {
  _dialect = d;
}

export function getDialect() {
  return _dialect;
}

export function isSqlite() {
  return _dialect === "sqlite";
}

/** Detect unique/PK constraint errors — MySQL ER_DUP_ENTRY or SQLite UNIQUE constraint */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // MySQL: ER_DUP_ENTRY (errno 1062) — direct from mysql2
  if ((err as any).errno === 1062) return true;
  // MySQL: Drizzle may wrap the original mysql2 error in .cause
  if ((err as any).cause?.errno === 1062) return true;
  // MySQL: message-based fallback (works regardless of error wrapping)
  if (err.message?.includes("Duplicate entry")) return true;
  // SQLite (sql.js): "UNIQUE constraint failed: table.column"
  if (err.message?.includes("UNIQUE constraint failed")) return true;
  return false;
}
