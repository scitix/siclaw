/**
 * Dialect-specific SQL builders for the 3 categories of MySQL/SQLite differences
 * that can't be unified at the DDL level:
 *   1. Upsert: `ON DUPLICATE KEY UPDATE` vs `ON CONFLICT DO UPDATE`
 *   2. INSERT IGNORE: `INSERT IGNORE` vs `INSERT OR IGNORE`
 *   3. JSON array ops: `JSON_CONTAINS` / `JSON_TABLE` vs `json_each`
 *
 * Also provides `safeParseJson()` for the three-state JSON column problem
 * (legacy MySQL `JSON` columns are pre-parsed by mysql2 into objects,
 * new MySQL `TEXT` / SQLite `TEXT` columns return strings).
 */

import type { Db } from "./db.js";

/** Detect unique/PK constraint errors across MySQL and SQLite. */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as { errno?: number; cause?: { errno?: number } };
  if (e.errno === 1062) return true;                       // MySQL ER_DUP_ENTRY
  if (e.cause?.errno === 1062) return true;                // mysql2 may wrap
  if (err.message?.includes("Duplicate entry")) return true;
  if (err.message?.includes("UNIQUE constraint failed")) return true; // SQLite
  return false;
}

/** Detect duplicate-column errors (for idempotent ALTER TABLE ADD COLUMN). */
export function isDuplicateColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as { errno?: number; code?: string };
  if (e.errno === 1060 || e.code === "ER_DUP_FIELDNAME") return true;
  if (err.message?.includes("duplicate column name")) return true;     // SQLite
  return false;
}

/** Detect duplicate-index errors. */
export function isDuplicateIndexError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as { errno?: number; code?: string };
  if (e.errno === 1061 || e.code === "ER_DUP_KEYNAME") return true;
  if (err.message?.includes("already exists") && err.message?.includes("index")) return true;
  return false;
}

export type UpdateColumn = string | { col: string; expr: string };

/**
 * Build an upsert statement that works on both MySQL and SQLite.
 *
 * `updateColumns` supports two forms:
 *   - "col_name"                                 → MySQL: `col = VALUES(col)`; SQLite: `col = excluded.col`
 *   - { col: "last_active_at", expr: "CURRENT_TIMESTAMP" }  → literal expression on both sides
 */
export function buildUpsert(
  db: Db,
  table: string,
  columns: string[],
  values: any[],
  conflictColumns: string[],
  updateColumns: UpdateColumn[],
): { sql: string; params: any[] } {
  const cols = columns.map((c) => `\`${c}\``).join(", ");
  const placeholders = columns.map(() => "?").join(", ");

  if (db.driver === "mysql") {
    const updates = updateColumns
      .map((u) => (typeof u === "string" ? `\`${u}\` = VALUES(\`${u}\`)` : `\`${u.col}\` = ${u.expr}`))
      .join(", ");
    return {
      sql: `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
      params: values,
    };
  }

  const conflictCols = conflictColumns.map((c) => `\`${c}\``).join(", ");
  const updates = updateColumns
    .map((u) => (typeof u === "string" ? `\`${u}\` = excluded.\`${u}\`` : `\`${u.col}\` = ${u.expr}`))
    .join(", ");
  return {
    sql: `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflictCols}) DO UPDATE SET ${updates}`,
    params: values,
  };
}

/** `INSERT IGNORE` (MySQL) / `INSERT OR IGNORE` (SQLite) prefix. */
export function insertIgnorePrefix(db: Db): string {
  return db.driver === "mysql" ? "INSERT IGNORE" : "INSERT OR IGNORE";
}

/**
 * JSON array containment check.
 *   MySQL:  JSON_CONTAINS(col, ?)
 *   SQLite: EXISTS (SELECT 1 FROM json_each(col) WHERE value = ?)
 */
export function jsonArrayContains(db: Db, column: string, paramPlaceholder = "?"): string {
  if (db.driver === "mysql") {
    return `JSON_CONTAINS(${column}, ${paramPlaceholder})`;
  }
  return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${paramPlaceholder})`;
}

/**
 * Flatten a JSON array column into a row set, usable in FROM clauses to get
 * DISTINCT values across arrays in multiple rows.
 *
 *   MySQL:  SELECT DISTINCT jt.label FROM skills, JSON_TABLE(labels, '$[*]' COLUMNS(label VARCHAR(255) PATH '$')) AS jt
 *   SQLite: SELECT DISTINCT je.value FROM skills, json_each(skills.labels) AS je
 */
export function jsonArrayFlattenSql(
  db: Db,
  table: string,
  jsonColumn: string,
): { joinClause: string; valueColumn: string } {
  if (db.driver === "mysql") {
    return {
      joinClause: `${table}, JSON_TABLE(${jsonColumn}, '$[*]' COLUMNS(label VARCHAR(255) PATH '$')) AS jt`,
      valueColumn: "jt.label",
    };
  }
  return {
    joinClause: `${table}, json_each(${jsonColumn}) AS je`,
    valueColumn: "je.value",
  };
}

/**
 * Format a date as a timestamp string accepted by both MySQL and SQLite
 * when used as a bound parameter.
 *
 *   Date → "2026-04-22 06:58:43.123"
 *
 * `.toISOString()` produces a trailing `Z` which MySQL rejects for
 * `TIMESTAMP` / `DATETIME` columns (it can't parse the timezone marker).
 * This helper strips the `T` and `Z` to produce a dialect-neutral form.
 *
 * Use this EVERY time you pass a JS Date/number into a SQL parameter
 * bound to a `TIMESTAMP` or `DATETIME` column. For JSON response
 * serialisation (sendJson/RPC return) keep `.toISOString()` — that
 * goes to JS consumers and should stay ISO-8601.
 */
export function toSqlTimestamp(d: Date | number | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().replace("T", " ").replace(/Z$/, "");
}

/**
 * Defensively parse a value that might be:
 *   - null / undefined          → fallback
 *   - string (new schema: TEXT) → JSON.parse
 *   - object (legacy MySQL JSON column, pre-parsed by mysql2) → pass through
 *
 * Use this at every read site of the 15 JSON columns so the three data states
 * (legacy MySQL JSON, new MySQL TEXT, SQLite TEXT) all work.
 */
export function safeParseJson<T = unknown>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    if (value.length === 0) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}
