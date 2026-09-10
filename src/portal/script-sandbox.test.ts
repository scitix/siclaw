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
