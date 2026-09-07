import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../gateway/db.js";
import { transcriptVisiblePredicate } from "./transcript-rows.js";

describe("transcript visibility SQL", () => {
  it("keeps NULL-metadata prompts and answers while filtering before count and pagination", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, metadata TEXT)");
      const insert = db.prepare("INSERT INTO chat_messages VALUES (?, 's', ?, ?, ?)");
      const rows = [
        [1, "user", "question", null],
        [2, "assistant", "legacy answer", null],
        [3, "assistant", "", '{"llm_call":{"v":1}}'],
        [4, "assistant", "reasoning", '{ "kind": "thinking" }'],
        [5, "assistant", "answer", '{"llm_call":{"v":1}}'],
        [6, "assistant", "", '{"kind":"error_response","llm_call":{"v":1}}'],
        [7, "assistant", "notice", '{"nested":{"kind":"thinking"}}'],
        [8, "assistant", "legacy malformed metadata", 'not json'],
        [9, "assistant", "", '{"kind":"model_route_notice","llm_call":{"v":1}}'],
      ] as const;
      for (const row of rows) insert.run(...row);
      const where = `session_id = 's' AND ${transcriptVisiblePredicate({ driver: "sqlite" } as Db)}`;
      expect(db.prepare(`SELECT id FROM chat_messages WHERE ${where} ORDER BY id`).all().map(r => r.id))
        .toEqual([1, 2, 5, 6, 7, 8, 9]);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE ${where}`).get()?.count).toBe(7);
      expect(db.prepare(`SELECT id FROM chat_messages WHERE ${where} ORDER BY id LIMIT 3`).all().map(r => r.id))
        .toEqual([1, 2, 5]);
    } finally { db.close(); }
  });
});
