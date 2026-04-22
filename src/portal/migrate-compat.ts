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
): Promise<void> {
  if (await columnExists(db, table, column)) return;
  try {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`[portal-migrate] added ${table}.${column}`);
  } catch (err) {
    if (isDuplicateColumnError(err)) return;
    throw err;
  }
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
