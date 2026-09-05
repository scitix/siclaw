import { describe, expect, it, vi } from "vitest";
import { HISTORY_PAGE_SIZE, loadFullHistory } from "./session-history-api.js";
import type { StoredMessage } from "./chat-repo.js";

function msg(i: number, secondsAgo: number): StoredMessage {
  return {
    id: `m${i}`, sessionId: "s1", role: "user", content: `msg ${i}`,
    toolName: null, toolset: null, toolInput: null, metadata: null, outcome: null, durationMs: null,
    fromAgentId: null, parentSessionId: null, delegationId: null, targetAgentId: null,
    createdAt: new Date(Date.UTC(2026, 8, 5, 0, 0, 0) - secondsAgo * 1000),
  };
}

/**
 * 模拟控制面的分页:`all` 从旧到新;每次返回 `before` 之前(严格更旧)的最新 limit 条,
 * 页内从旧到新 —— 与 chat-repo.getMessages 的返回形状一致。
 */
function pagedFetcher(all: StoredMessage[]) {
  return vi.fn(async (_sid: string, opts?: { before?: Date; limit?: number }) => {
    const limit = opts?.limit ?? 50;
    const eligible = opts?.before ? all.filter((m) => m.createdAt.getTime() < opts.before!.getTime()) : all;
    return eligible.slice(-limit);
  });
}

describe("loadFullHistory", () => {
  it("returns an empty list for a session the control plane has never seen", async () => {
    const fetchPage = pagedFetcher([]);
    expect(await loadFullHistory("new", fetchPage)).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns a single short page as-is, oldest first", async () => {
    const all = [msg(1, 30), msg(2, 20), msg(3, 10)];
    const out = await loadFullHistory("s1", pagedFetcher(all));
    expect(out.map((r) => r.content)).toEqual(["msg 1", "msg 2", "msg 3"]);
  });

  // ⚠️ 翻页是这个 handler 存在的理由。三页拼起来必须严格从旧到新、不重不漏 ——
  // 页内已经是从旧到新,但页与页之间是从新到旧取的,拍平前要把页序反过来。
  it("stitches several full pages into one oldest-first sequence with no gaps or repeats", async () => {
    const total = HISTORY_PAGE_SIZE * 2 + 7;
    const all = Array.from({ length: total }, (_, i) => msg(i + 1, total - i));
    const fetchPage = pagedFetcher(all);
    const out = await loadFullHistory("s1", fetchPage);
    expect(out).toHaveLength(total);
    expect(out.map((r) => r.content)).toEqual(all.map((m) => m.content));
    // 两整页 + 一短页 = 3 次;短页即终止,不再多打一次空页。
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("stops after an exact multiple of the page size with one extra empty fetch", async () => {
    const total = HISTORY_PAGE_SIZE;
    const all = Array.from({ length: total }, (_, i) => msg(i + 1, total - i));
    const fetchPage = pagedFetcher(all);
    const out = await loadFullHistory("s1", fetchPage);
    expect(out).toHaveLength(total);
    // 第一页正好满,得再取一次才能知道没了。
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  // 游标不前进(控制面切点与预期不符)时要停,截断比死循环好。
  it("bails out rather than looping when the cursor fails to advance", async () => {
    const stuck = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => msg(i + 1, 5));
    const fetchPage = vi.fn(async () => stuck);
    const out = await loadFullHistory("s1", fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(HISTORY_PAGE_SIZE * 2);
  });

  it("projects only the fields the rehydrator needs", async () => {
    const m = msg(1, 1);
    m.role = "tool"; m.toolName = "bash"; m.toolInput = "{}"; m.outcome = "success";
    const [row] = await loadFullHistory("s1", pagedFetcher([m]));
    expect(row).toEqual({
      role: "tool", content: "msg 1", toolName: "bash", toolInput: "{}", outcome: "success",
      createdAt: m.createdAt.toISOString(),
    });
  });
});
