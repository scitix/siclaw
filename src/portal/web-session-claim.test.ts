import { afterEach, beforeEach, expect, it } from "vitest";
import { closeDb, initDb, getDb } from "../gateway/db.js";
import { claimWebChatSession } from "./web-session-claim.js";

beforeEach(async () => {
  const db = initDb("sqlite::memory:");
  await db.query("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, agent_id TEXT, user_id TEXT, title TEXT, origin TEXT, parent_session_id TEXT, deleted_at TEXT, next_seq INTEGER DEFAULT 0)");
});
afterEach(closeDb);

it("atomically claims a new session and never reassigns it across users or agents", async () => {
  const results = await Promise.all([claimWebChatSession("s", "a", "owner", "title"), claimWebChatSession("s", "a", "other", "overwrite")]);
  expect(results).toEqual([true, false]);
  expect(await claimWebChatSession("s", "different-agent", "owner", "overwrite")).toBe(false);
  await getDb().query("UPDATE chat_sessions SET next_seq = 42 WHERE id = 's'");
  expect(await claimWebChatSession("s", "a", "owner", "overwrite")).toBe(true);
  const [rows] = await getDb().query("SELECT user_id, title, next_seq FROM chat_sessions");
  expect(rows).toEqual([{ user_id: "owner", title: "title", next_seq: 42 }]);
});

it.each(["deleted_at = 'deleted'", "parent_session_id = 'parent'", "origin = 'api'"])("rejects an owned session with %s", async change => {
  await claimWebChatSession("s", "a", "u", "title");
  await getDb().query(`UPDATE chat_sessions SET ${change} WHERE id = 's'`);
  expect(await claimWebChatSession("s", "a", "u", "title")).toBe(false);
});
