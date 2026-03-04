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
  // MySQL: ER_DUP_ENTRY (errno 1062)
  if ((err as any).errno === 1062) return true;
  // SQLite (sql.js): "UNIQUE constraint failed: table.column"
  if (err.message?.includes("UNIQUE constraint failed")) return true;
  return false;
}
