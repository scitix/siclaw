import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../gateway/db.js", () => ({ getDb: vi.fn() }));
import { getDb } from "../gateway/db.js";
import { sandboxResolveHandler } from "./script-sandbox.js";

beforeEach(() => vi.clearAllMocks());
const params = { agent_id: "a", session_id: "s", source: "cluster", name: "prod" };
it("refuses missing identities and unknown credential/identity fields", async () => {
  const handler = sandboxResolveHandler(new Map());
  await expect(handler({ ...params, user_id: "admin" }, "runtime")).rejects.toThrow();
  await expect(handler({ ...params, session_id: "" }, "runtime")).rejects.toThrow();
  expect(getDb).not.toHaveBeenCalled();
});
it("requires a live administrator-owned web session before decrypting", async () => {
  const query = vi.fn().mockResolvedValue([[]]); vi.mocked(getDb).mockReturnValue({ query } as any);
  const credential = vi.fn();
  const handler = sandboxResolveHandler(new Map([["credential.get", credential]]));
  await expect(handler(params, "runtime")).rejects.toThrow();
  expect(query.mock.calls[0][0]).toContain("s.deleted_at IS NULL");
  expect(query.mock.calls[0][0]).toContain("s.origin = 'web'");
  expect(query.mock.calls[0][0]).toContain("u.role = 'admin'");
  expect(credential).not.toHaveBeenCalled();
});
it("keeps existing agent resource binding checks on the credential path", async () => {
  const query = vi.fn().mockResolvedValue([[{ user_id: "u" }]]); vi.mocked(getDb).mockReturnValue({ query } as any);
  const credential = vi.fn().mockResolvedValue({ credential: { name: "prod" } });
  const result = await sandboxResolveHandler(new Map([["credential.get", credential]]))(params, "runtime");
  expect(result.user_id).toBe("u");
  expect(credential).toHaveBeenCalledWith({ source: "cluster", source_id: "prod", agentId: "a" }, "runtime");
});

it("uses real SQL origin filtering: only explicit Web administrator sessions authorize", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE chat_sessions(id TEXT,agent_id TEXT,user_id TEXT,origin TEXT,deleted_at TEXT,parent_session_id TEXT); CREATE TABLE siclaw_users(id TEXT,role TEXT); CREATE TABLE agents(id TEXT,status TEXT); INSERT INTO siclaw_users VALUES('u','admin'); INSERT INTO agents VALUES('a','active');");
    vi.mocked(getDb).mockReturnValue({ query: async (sql: string, args: any[]) => [db.prepare(sql).all(...args)] } as any);
    const credential = vi.fn(async () => ({ credential: { name: "prod" } }));
    const handler = sandboxResolveHandler(new Map([["credential.get", credential]]));
    for (const origin of [null, "webchat", "api", "task", "web"]) {
      db.exec("DELETE FROM chat_sessions"); db.prepare("INSERT INTO chat_sessions VALUES('s','a','u',?,NULL,NULL)").run(origin);
      if (origin === "web") await expect(handler(params, "runtime")).resolves.toMatchObject({ user_id: "u" });
      else await expect(handler(params, "runtime")).rejects.toThrow("web session");
    }
    expect(credential).toHaveBeenCalledOnce();
  } finally { db.close(); }
});
