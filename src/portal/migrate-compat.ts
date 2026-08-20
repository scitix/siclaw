/**
 * Migration compatibility helpers — cross-driver schema introspection and
 * idempotent DDL operations. MySQL uses information_schema; SQLite uses PRAGMAs.
 *
 * Used by migrate.ts for incremental column additions and index creation
 * that must remain safe to re-run on existing deployments.
 */

import type { Db } from "../gateway/db.js";
import { isDuplicateColumnError, isDuplicateIndexError } from "../gateway/dialect-helpers.js";

export async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  if (db.driver === "mysql") {
    const [rows] = await db.query<Array<{ COLUMN_NAME: string }>>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return rows.length > 0;
  }
  const [rows] = await db.query<Array<{ name: string }>>(`PRAGMA table_info(\`${table}\`)`);
  return rows.some((r) => r.name === column);
}

export async function indexExists(db: Db, table: string, indexName: string): Promise<boolean> {
  if (db.driver === "mysql") {
    const [rows] = await db.query<Array<{ INDEX_NAME: string }>>(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, indexName],
    );
    return rows.length > 0;
  }
  const [rows] = await db.query<Array<{ name: string }>>(`PRAGMA index_list(\`${table}\`)`);
  return rows.some((r) => r.name === indexName);
}

/**
 * Idempotently add a column to an existing table. No-op if the column exists.
 * Tolerates duplicate-column errors from concurrent migration races.
 */
export async function safeAlterTable(
  db: Db,
  table: string,
  column: string,
  definition: string,
): Promise<boolean> {
  // Reports whether it actually added the column, so a caller can run a one-shot backfill
  // exactly once: there is no migration bookkeeping table to record that it already ran.
  if (await columnExists(db, table, column)) return false;
  try {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`[portal-migrate] added ${table}.${column}`);
    return true;
  } catch (err) {
    if (isDuplicateColumnError(err)) return false;
    throw err;
  }
}

/**
 * Tighten an existing nullable column to NOT NULL (MySQL only).
 *
 * Distinct from {@link widenColumn}, which compares COLUMN_TYPE and therefore
 * skips a MODIFY whose only change is nullability — `varchar(50)` equals
 * `varchar(50)` no matter what follows it. Guarded on IS_NULLABLE instead, so
 * it is idempotent and never re-copies an already-tightened table.
 *
 * Callers MUST have backfilled every NULL first; MySQL rejects the MODIFY
 * otherwise. SQLite has no cheap MODIFY COLUMN, so this is a no-op there and
 * the constraint only reaches fresh SQLite files via CREATE TABLE.
 */
export async function tightenColumnNotNull(
  db: Db,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (db.driver !== "mysql") return;
  if (!(await columnExists(db, table, column))) return;
  const [rows] = await db.query<Array<{ IS_NULLABLE: string }>>(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((rows[0]?.IS_NULLABLE ?? "").toUpperCase() === "NO") return; // already tightened
  await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  console.log(`[portal-migrate] tightened ${table}.${column} to NOT NULL`);
}

/**
 * Idempotently change a column's DEFAULT (MySQL only).
 *
 * Distinct from {@link widenColumn}, which compares COLUMN_TYPE: an INT staying an
 * INT reads as "no change" however the default differs, so a default correction
 * would silently skip. `CREATE TABLE IF NOT EXISTS` cannot reach an existing table
 * either, and {@link safeAlterTable} only ADDs missing columns — so a wrong default
 * on an upgraded database has no other way out.
 *
 * A default-only MODIFY is a metadata change in MySQL 8 (no table copy), and this
 * is guarded on the current COLUMN_DEFAULT so it runs at most once. SQLite has no
 * cheap MODIFY COLUMN — changing a default there means rebuilding the table — so it
 * is a no-op, and an existing SQLite file keeps whatever default it was created
 * with. Callers must therefore treat a column default as a backstop, never as the
 * value writers rely on.
 */
export async function setColumnDefault(
  db: Db,
  table: string,
  column: string,
  definition: string,
  expectedDefault: string,
): Promise<void> {
  if (db.driver !== "mysql") return;
  if (!(await columnExists(db, table, column))) return; // fresh install already has it
  const [rows] = await db.query<Array<{ COLUMN_DEFAULT: string | null }>>(
    `SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  const current = (rows[0]?.COLUMN_DEFAULT ?? "").trim();
  if (current === expectedDefault) return; // already correct — skip the MODIFY
  await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  console.log(`[portal-migrate] default for ${table}.${column}: ${current || "(none)"} → ${expectedDefault}`);
}

/**
 * Idempotently widen a column's TYPE (MySQL only). CHAR→VARCHAR is a type change that
 * {@link safeAlterTable} (add-if-missing) never applies to an existing column, so widening an
 * existing deployment needs an explicit MODIFY. Guarded on the current COLUMN_TYPE so a large
 * table (chat_messages) is copied at most ONCE — never re-copied on every migration run. SQLite
 * has no fixed CHAR width and no cheap MODIFY COLUMN, so it is a no-op there.
 */
export async function widenColumn(
  db: Db,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (db.driver !== "mysql") return;
  if (!(await columnExists(db, table, column))) return; // a fresh install already made it wide
  const [rows] = await db.query<Array<{ COLUMN_TYPE: string }>>(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  const current = (rows[0]?.COLUMN_TYPE ?? "").toLowerCase();
  // Target column type = the definition up to its first attribute keyword (DEFAULT/NULL/NOT).
  const targetType = definition.trim().split(/\s+(?=default\b|null\b|not\b)/i)[0].toLowerCase();
  if (!targetType || current === targetType) return; // already at the target type — skip the copy
  await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  console.log(`[portal-migrate] widened ${table}.${column}: ${current} → ${targetType}`);
}

/**
 * Idempotently create a non-unique index. MySQL doesn't support
 * `CREATE INDEX IF NOT EXISTS` in versions <= 8.0.28, so we check first.
 */
export async function ensureIndex(
  db: Db,
  table: string,
  indexName: string,
  columnsExpr: string,
): Promise<void> {
  if (db.driver === "mysql") {
    if (await indexExists(db, table, indexName)) return;
    try {
      await db.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (${columnsExpr})`);
      console.log(`[portal-migrate] created index ${table}.${indexName}`);
    } catch (err) {
      if (isDuplicateIndexError(err)) return;
      throw err;
    }
    return;
  }
  // SQLite supports IF NOT EXISTS natively.
  await db.query(`CREATE INDEX IF NOT EXISTS \`${indexName}\` ON \`${table}\` (${columnsExpr})`);
}

/** Idempotently create a unique index (same logic as ensureIndex but UNIQUE). */
export async function ensureUniqueIndex(
  db: Db,
  table: string,
  indexName: string,
  columnsExpr: string,
): Promise<void> {
  if (db.driver === "mysql") {
    if (await indexExists(db, table, indexName)) return;
    try {
      await db.query(`CREATE UNIQUE INDEX \`${indexName}\` ON \`${table}\` (${columnsExpr})`);
      console.log(`[portal-migrate] created unique index ${table}.${indexName}`);
    } catch (err) {
      if (isDuplicateIndexError(err)) return;
      throw err;
    }
    return;
  }
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS \`${indexName}\` ON \`${table}\` (${columnsExpr})`);
}

/** Drop an index if it exists. Cross-driver. */
export async function dropIndexIfExists(db: Db, table: string, indexName: string): Promise<void> {
  if (!(await indexExists(db, table, indexName))) return;
  if (db.driver === "mysql") {
    try {
      await db.query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``);
      console.log(`[portal-migrate] dropped index ${table}.${indexName}`);
    } catch (err) {
      const e = err as { errno?: number; code?: string };
      // ER_CANT_DROP_FIELD_OR_KEY: index didn't exist — treat as success
      if (e.errno === 1091 || e.code === "ER_CANT_DROP_FIELD_OR_KEY") return;
      throw err;
    }
    return;
  }
  await db.query(`DROP INDEX IF EXISTS \`${indexName}\``);
}
