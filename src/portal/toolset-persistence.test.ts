import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../gateway/db.js";
import { buildAdapterRpcHandlers } from "./adapter.js";
import { runPortalMigrations } from "./migrate.js";

describe("standalone Portal toolset persistence", () => {
  beforeEach(async () => {
    initDb("sqlite::memory:");
    await runPortalMigrations();
    const db = getDb();
    await db.query("INSERT INTO siclaw_users (id, username, password_hash, role) VALUES ('u1','u','x','user')");
    await db.query("INSERT INTO agents (id, name) VALUES ('a1','agent')");
    await db.query("INSERT INTO chat_sessions (id, agent_id, user_id, title) VALUES ('s1','a1','u1','t')");
  });

  afterEach(async () => {
    await closeDb();
  });

  it("round-trips toolset through append, update, and getMessages", async () => {
    const handlers = buildAdapterRpcHandlers();
    const append = handlers.get("chat.appendMessage")!;
    const update = handlers.get("chat.updateMessage")!;
    const getMessages = handlers.get("chat.getMessages")!;

    const { id } = await append({
      session_id: "s1",
      role: "tool",
      content: "started",
      tool_name: "read",
      toolset: "filesystem",
    }, "a1");
    let result = await getMessages({ session_id: "s1" }, "a1");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].toolset).toBe("filesystem");

    await update({
      id,
      session_id: "s1",
      content: "finished",
      tool_name: "read",
      toolset: "mcp:storage",
      outcome: "success",
    }, "a1");
    result = await getMessages({ session_id: "s1" }, "a1");
    expect(result.messages[0]).toMatchObject({ content: "finished", toolset: "mcp:storage", outcome: "success" });
  });
});
