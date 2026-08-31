import { describe, it, expect } from "vitest";
import { setColumnDefault, widenColumn } from "./migrate-compat.js";
import type { Db } from "../gateway/db.js";

/**
 * `setColumnDefault` exists for the case the SQLite migration test cannot reach: a
 * database that already HAS the table. `CREATE TABLE IF NOT EXISTS` skips it,
 * `safeAlterTable` only adds missing columns, and `widenColumn` compares
 * COLUMN_TYPE — where INT vs INT reads as "no change" however the default differs.
 * So an upgraded MySQL deployment kept `max_tokens DEFAULT 65536`, above the
 * ceiling of the Claude models in use, with nothing to correct it.
 *
 * MySQL is the driver that matters here and there is no MySQL instance in tests,
 * so these drive a recording fake: what is asserted is the SQL issued and, just as
 * importantly, when none is.
 */
function fakeMysql(currentDefault: string | null, columnPresent = true): {
  db: Db;
  queries: Array<{ sql: string; params?: unknown[] }>;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    driver: "mysql",
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("COLUMN_NAME") && sql.includes("SELECT COLUMN_NAME")) {
        return [columnPresent ? [{ COLUMN_NAME: "max_tokens" }] : [], undefined];
      }
      if (sql.includes("COLUMN_DEFAULT")) {
        return [[{ COLUMN_DEFAULT: currentDefault }], undefined];
      }
      return [[], undefined];
    },
  } as unknown as Db;
  return { db, queries };
}

const alters = (queries: Array<{ sql: string }>) => queries.filter((q) => q.sql.startsWith("ALTER TABLE"));

describe("setColumnDefault", () => {
  it("corrects a legacy default on an existing MySQL table", async () => {
    const { db, queries } = fakeMysql("65536");
    await setColumnDefault(db, "model_entries", "max_tokens", "INT NOT NULL DEFAULT 16384", "16384");
    expect(alters(queries).map((q) => q.sql)).toEqual([
      "ALTER TABLE `model_entries` MODIFY COLUMN `max_tokens` INT NOT NULL DEFAULT 16384",
    ]);
  });

  // Idempotence is the whole reason this is guarded: migrations re-run on every
  // boot, and an unguarded MODIFY would be issued forever.
  it("issues nothing when the default is already correct", async () => {
    const { db, queries } = fakeMysql("16384");
    await setColumnDefault(db, "model_entries", "max_tokens", "INT NOT NULL DEFAULT 16384", "16384");
    expect(alters(queries)).toEqual([]);
  });

  it("issues nothing when the column does not exist yet", async () => {
    const { db, queries } = fakeMysql(null, false);
    await setColumnDefault(db, "model_entries", "max_tokens", "INT NOT NULL DEFAULT 16384", "16384");
    expect(alters(queries)).toEqual([]);
  });

  // Not a limitation to fix quietly: changing a default on SQLite means rebuilding
  // the table, and the value is a backstop no writer reads. An existing SQLite file
  // therefore keeps its old default, and that has to be stated rather than assumed
  // away — a fresh file gets the right one from CREATE TABLE.
  it("is a no-op on SQLite", async () => {
    const queries: string[] = [];
    const db = {
      driver: "sqlite",
      query: async (sql: string) => { queries.push(sql); return [[], undefined]; },
    } as unknown as Db;
    await setColumnDefault(db, "model_entries", "max_tokens", "INT NOT NULL DEFAULT 16384", "16384");
    expect(queries).toEqual([]);
  });
});

describe("widenColumn", () => {
  it("widens the legacy toolset label column to hold a dispatch envelope once", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      driver: "mysql",
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT COLUMN_NAME")) return [[{ COLUMN_NAME: "toolset" }], undefined];
        if (sql.includes("COLUMN_TYPE")) return [[{ COLUMN_TYPE: "varchar(255)" }], undefined];
        return [[], undefined];
      },
    } as unknown as Db;

    await widenColumn(db, "chat_messages", "toolset", "MEDIUMTEXT DEFAULT NULL");
    expect(alters(queries).map((q) => q.sql)).toEqual([
      "ALTER TABLE `chat_messages` MODIFY COLUMN `toolset` MEDIUMTEXT DEFAULT NULL",
    ]);
  });

  it("does not rewrite an already widened toolset column", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      driver: "mysql",
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT COLUMN_NAME")) return [[{ COLUMN_NAME: "toolset" }], undefined];
        if (sql.includes("COLUMN_TYPE")) return [[{ COLUMN_TYPE: "mediumtext" }], undefined];
        return [[], undefined];
      },
    } as unknown as Db;

    await widenColumn(db, "chat_messages", "toolset", "MEDIUMTEXT DEFAULT NULL");
    expect(alters(queries)).toEqual([]);
  });
});
