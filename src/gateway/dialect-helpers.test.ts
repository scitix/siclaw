import { describe, it, expect } from "vitest";
import {
  buildUpsert,
  insertIgnorePrefix,
  jsonArrayContains,
  jsonArrayFlattenSql,
  safeParseJson,
  isUniqueViolation,
  isDuplicateColumnError,
  isDuplicateIndexError,
} from "./dialect-helpers.js";
import type { Db } from "./db.js";

const mysql = { driver: "mysql" } as Db;
const sqlite = { driver: "sqlite" } as Db;

describe("buildUpsert", () => {
  it("builds MySQL ON DUPLICATE KEY UPDATE with VALUES() copies", () => {
    const { sql, params } = buildUpsert(
      mysql,
      "users",
      ["id", "name", "email"],
      ["u1", "Alice", "a@x.com"],
      ["id"],
      ["name", "email"],
    );
    expect(sql).toContain("INSERT INTO `users`");
    expect(sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(sql).toContain("`name` = VALUES(`name`)");
    expect(sql).toContain("`email` = VALUES(`email`)");
    expect(params).toEqual(["u1", "Alice", "a@x.com"]);
  });

  it("builds SQLite ON CONFLICT DO UPDATE with excluded.* copies", () => {
    const { sql } = buildUpsert(
      sqlite,
      "users",
      ["id", "name"],
      ["u1", "Alice"],
      ["id"],
      ["name"],
    );
    expect(sql).toContain("ON CONFLICT(`id`) DO UPDATE SET");
    expect(sql).toContain("`name` = excluded.`name`");
  });

  it("supports literal expression form for MySQL", () => {
    const { sql } = buildUpsert(
      mysql,
      "chat_sessions",
      ["id"],
      ["s1"],
      ["id"],
      [{ col: "last_active_at", expr: "CURRENT_TIMESTAMP" }],
    );
    expect(sql).toContain("`last_active_at` = CURRENT_TIMESTAMP");
    expect(sql).not.toContain("VALUES(`last_active_at`)");
  });

  it("supports literal expression form for SQLite", () => {
    const { sql } = buildUpsert(
      sqlite,
      "chat_sessions",
      ["id"],
      ["s1"],
      ["id"],
      [{ col: "last_active_at", expr: "CURRENT_TIMESTAMP" }],
    );
    expect(sql).toContain("ON CONFLICT(`id`) DO UPDATE");
    expect(sql).toContain("`last_active_at` = CURRENT_TIMESTAMP");
  });

  it("mixes string and expression update columns", () => {
    const { sql } = buildUpsert(
      mysql,
      "system_config",
      ["config_key", "config_value", "updated_by"],
      ["k", "v", "u"],
      ["config_key"],
      ["config_value", "updated_by", { col: "updated_at", expr: "CURRENT_TIMESTAMP" }],
    );
    expect(sql).toContain("`config_value` = VALUES(`config_value`)");
    expect(sql).toContain("`updated_at` = CURRENT_TIMESTAMP");
  });
});

describe("insertIgnorePrefix", () => {
  it("returns MySQL INSERT IGNORE", () => {
    expect(insertIgnorePrefix(mysql)).toBe("INSERT IGNORE");
  });
  it("returns SQLite INSERT OR IGNORE", () => {
    expect(insertIgnorePrefix(sqlite)).toBe("INSERT OR IGNORE");
  });
});

describe("jsonArrayContains", () => {
  it("produces JSON_CONTAINS for MySQL", () => {
    expect(jsonArrayContains(mysql, "labels")).toBe("JSON_CONTAINS(labels, ?)");
  });
  it("produces json_each EXISTS clause for SQLite", () => {
    const expr = jsonArrayContains(sqlite, "labels");
    expect(expr).toContain("json_each(labels)");
    expect(expr).toContain("WHERE value = ?");
  });
});

describe("jsonArrayFlattenSql", () => {
  it("produces JSON_TABLE join for MySQL", () => {
    const r = jsonArrayFlattenSql(mysql, "skills", "labels");
    expect(r.joinClause).toContain("JSON_TABLE(labels, '$[*]'");
    expect(r.valueColumn).toBe("jt.label");
  });
  it("produces json_each join for SQLite", () => {
    const r = jsonArrayFlattenSql(sqlite, "skills", "labels");
    expect(r.joinClause).toContain("json_each(labels)");
    expect(r.valueColumn).toBe("je.value");
  });
});

describe("safeParseJson", () => {
  it("returns fallback for null/undefined", () => {
    expect(safeParseJson(null, [])).toEqual([]);
    expect(safeParseJson(undefined, [])).toEqual([]);
  });
  it("returns fallback for empty string", () => {
    expect(safeParseJson("", [])).toEqual([]);
  });
  it("parses string to object", () => {
    expect(safeParseJson('[1,2,3]', [])).toEqual([1, 2, 3]);
    expect(safeParseJson('{"a":1}', {})).toEqual({ a: 1 });
  });
  it("passes through already-parsed object (legacy MySQL JSON column)", () => {
    const obj = { a: 1, b: [2, 3] };
    expect(safeParseJson(obj, {})).toBe(obj);
    const arr = [1, 2, 3];
    expect(safeParseJson(arr, [])).toBe(arr);
  });
  it("returns fallback for malformed JSON string", () => {
    expect(safeParseJson("{not json", [])).toEqual([]);
  });
});

describe("isUniqueViolation", () => {
  it("matches MySQL ER_DUP_ENTRY by errno", () => {
    const err = Object.assign(new Error("dup"), { errno: 1062 });
    expect(isUniqueViolation(err)).toBe(true);
  });
  it("matches mysql2 wrapped error via cause", () => {
    const inner = Object.assign(new Error("inner"), { errno: 1062 });
    const err = Object.assign(new Error("outer"), { cause: inner });
    expect(isUniqueViolation(err)).toBe(true);
  });
  it("matches MySQL message substring", () => {
    expect(isUniqueViolation(new Error("Duplicate entry 'x' for key 'y'"))).toBe(true);
  });
  it("matches SQLite UNIQUE constraint message", () => {
    expect(isUniqueViolation(new Error("UNIQUE constraint failed: users.email"))).toBe(true);
  });
  it("returns false for unrelated errors", () => {
    expect(isUniqueViolation(new Error("connection refused"))).toBe(false);
    expect(isUniqueViolation("not an error")).toBe(false);
  });
});

describe("isDuplicateColumnError", () => {
  it("matches MySQL ER_DUP_FIELDNAME", () => {
    const err = Object.assign(new Error("dup col"), { errno: 1060, code: "ER_DUP_FIELDNAME" });
    expect(isDuplicateColumnError(err)).toBe(true);
  });
  it("matches SQLite duplicate column name", () => {
    expect(isDuplicateColumnError(new Error("duplicate column name: foo"))).toBe(true);
  });
});

describe("isDuplicateIndexError", () => {
  it("matches MySQL ER_DUP_KEYNAME", () => {
    const err = Object.assign(new Error("dup idx"), { errno: 1061, code: "ER_DUP_KEYNAME" });
    expect(isDuplicateIndexError(err)).toBe(true);
  });
});
