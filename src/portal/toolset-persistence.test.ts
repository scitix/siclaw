import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../gateway/db.js";
import { buildAdapterRpcHandlers } from "./adapter.js";
import { runPortalMigrations } from "./migrate.js";

describe("standalone Portal tool result persistence", () => {
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

  it("round-trips skill preview metadata larger than 64 KiB across a repeated migration", async () => {
    const handlers = buildAdapterRpcHandlers();
    const specs = "Read-only check\n".repeat(6000) + "END_OF_SKILL";
    const metadata = { skillPreview: { skill: { name: "large-preview", specs,
      files: [{ path: "SKILL.md", content: specs }] } } };
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeGreaterThan(65_535);
    const { id } = await handlers.get("chat.appendMessage")!({
      session_id: "s1", role: "tool", content: "started", tool_name: "skill_preview",
    }, "a1");
    await handlers.get("chat.updateMessage")!({
      id, session_id: "s1", content: "artifact reference", tool_name: "skill_preview",
      outcome: "success", metadata: JSON.stringify(metadata),
    }, "a1");
    await runPortalMigrations();
    const history = await handlers.get("chat.getMessages")!({ session_id: "s1" }, "a1");
    expect(history.messages[0].metadata.skillPreview).toMatchObject({ status: "deferred", name: "large-preview" });
    expect(JSON.stringify(history)).not.toContain("END_OF_SKILL");
    expect(JSON.stringify(history).length).toBeLessThan(2000);
    const result = await handlers.get("chat.getMessages")!({ session_id: "s1", message_id: id }, "a1");
    expect((await handlers.get("chat.getMessages")!({ session_id: "other", message_id: id }, "a1")).messages).toEqual([]);
    const stored = result.messages[0].metadata;
    expect(typeof stored === "string" ? JSON.parse(stored) : stored).toEqual(metadata);
  });
  it("bounds new writes and projects legacy oversized rows before returning them", async () => {
    const handlers = buildAdapterRpcHandlers();
    const metadata = { skillPreview: { skill: { name: "oversized", specs: "界".repeat(400_000) } }, llm_round: 7 };
    const { id } = await handlers.get("chat.appendMessage")!({ session_id: "s1", role: "tool", content: "preview", tool_name: "skill_preview", metadata }, "a1");
    const read = () => handlers.get("chat.getMessages")!({ session_id: "s1", message_id: id }, "a1");
    expect((await read()).messages[0].metadata).toMatchObject({ skillPreview: { status: "omitted", reason: "size_limit" }, llm_round: 7 });
    await getDb().query("UPDATE chat_messages SET metadata = ? WHERE id = ?", [JSON.stringify(metadata), id]);
    const legacy = await read();
    expect(legacy.messages[0].metadata.skillPreview.status).toBe("omitted");
    expect(JSON.stringify(legacy).length).toBeLessThan(2000);
  });

  it("preserves bounded legacy text for detail fallback without returning oversized text", async () => {
    const handlers = buildAdapterRpcHandlers();
    const metadata = { skillPreview: { skill: { name: "invalid", files: "bad" } } };
    const content = JSON.stringify({ skill: { name: "legacy", specs: "LEGACY_END" } });
    const { id } = await handlers.get("chat.appendMessage")!({ session_id: "s1", role: "tool", content, tool_name: "skill_preview", metadata }, "a1");
    const read = () => handlers.get("chat.getMessages")!({ session_id: "s1", message_id: id }, "a1");
    expect((await read()).messages[0].content).toBe(content);
    await getDb().query("UPDATE chat_messages SET content = ? WHERE id = ?", ["界".repeat(400_000), id]);
    expect(JSON.stringify(await read()).length).toBeLessThan(2000);
  });

});
