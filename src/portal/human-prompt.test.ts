/**
 * The Prompts figure's predicate, tested on both dialects.
 *
 * The SQLite half RUNS the SQL. The first version of this predicate hardcoded
 * MySQL's `JSON_UNQUOTE` — a function SQLite does not have — and every metrics
 * endpoint 500'd under `siclaw local`. Tests that asserted on the string alone
 * passed the whole time, which is the reason this file executes instead.
 */

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import type { Db } from "../gateway/db.js";
import { humanPromptPredicate } from "./human-prompt.js";
import { SYNTHETIC_USER_KINDS } from "../shared/message-kinds.js";

const mysql = { driver: "mysql" } as Db;
const sqlite = { driver: "sqlite" } as Db;

describe("humanPromptPredicate — dialect", () => {
  it("unquotes on MySQL, where JSON_EXTRACT returns a quoted JSON string", () => {
    // Without JSON_UNQUOTE the extracted value is `"task_event"`, quotes
    // included, so it never equals the plain literal and the filter silently
    // stops filtering — a no-op that looks exactly like a working predicate.
    expect(humanPromptPredicate(mysql, "m")).toContain("JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.kind'))");
  });

  it("does not emit JSON_UNQUOTE on SQLite, which has no such function", () => {
    const sql = humanPromptPredicate(sqlite, "m");
    expect(sql).not.toContain("JSON_UNQUOTE");
    expect(sql).toContain("json_extract(m.metadata, '$.kind')");
  });

  it("guards with JSON_VALID on both — an unparseable row must not fail the query", () => {
    // Not an optimisation: MySQL raises ER_INVALID_JSON_TEXT and SQLite raises
    // "malformed JSON" rather than returning NULL.
    expect(humanPromptPredicate(mysql, "m")).toContain("JSON_VALID(m.metadata)");
    expect(humanPromptPredicate(sqlite, "m")).toContain("JSON_VALID(m.metadata)");
  });

  it("names every synthetic kind, on both dialects", () => {
    for (const db of [mysql, sqlite]) {
      const sql = humanPromptPredicate(db, "m");
      for (const kind of SYNTHETIC_USER_KINDS) expect(sql).toContain(`'${kind}'`);
    }
  });

  it("qualifies the column with the caller's alias", () => {
    expect(humanPromptPredicate(mysql, "m")).toContain("m.metadata");
    expect(humanPromptPredicate(mysql, "msg")).toContain("msg.metadata");
    // No alias: bare column, for callers with a single table in scope.
    expect(humanPromptPredicate(mysql, "")).toContain("JSON_VALID(metadata)");
  });
});

describe("humanPromptPredicate — executed against real SQLite", () => {
  /** Count the rows the predicate keeps, running it the way local mode does. */
  function countKept(rows: Array<string | null>): number {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, role TEXT, metadata TEXT)");
    const insert = db.prepare("INSERT INTO chat_messages (role, metadata) VALUES ('user', ?)");
    for (const r of rows) insert.run(r);
    const sql = `SELECT COUNT(*) AS c FROM chat_messages m
      WHERE m.role = 'user' AND ${humanPromptPredicate(sqlite, "m")}`;
    const result = db.prepare(sql).get() as { c: number };
    db.close();
    return result.c;
  }

  it("runs at all — the regression that shipped was `no such function: JSON_UNQUOTE`", () => {
    expect(() => countKept([null])).not.toThrow();
  });

  it("drops every synthetic kind", () => {
    expect(countKept(SYNTHETIC_USER_KINDS.map((k) => JSON.stringify({ kind: k })))).toBe(0);
  });

  it("keeps a plain question, which carries no metadata at all", () => {
    expect(countKept([null])).toBe(1);
  });

  it("keeps a row whose metadata has no kind, and one that is not JSON", () => {
    expect(countKept(['{"model_route":{"attempt":1}}', "not json at all", ""])).toBe(3);
  });

  it("keeps a steer — a person typing mid-turn is still a person asking", () => {
    expect(countKept(['{"kind":"steer"}'])).toBe(1);
  });

  it("does not match a kind name mentioned in some other field", () => {
    // The LIKE predicate this replaced matched anywhere in the column, so a row
    // merely quoting a kind name was dropped from the count.
    expect(countKept(['{"kind":"steer","content":"what is task_event for?"}'])).toBe(1);
  });

  it("is unaffected by the serialized shape — the LIKE predicate was not", () => {
    // `{"kind": "task_event"}` with a space after the colon never matched
    // '%"kind":"task_event"%'.
    expect(countKept(['{"kind": "task_event"}'])).toBe(0);
  });
});
