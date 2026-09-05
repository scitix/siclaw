import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeRehydratedSession } from "./session-rehydrate-store.js";
import type { RehydrateRow } from "../shared/session-rehydrate.js";

/**
 * ⚠️ 这个文件**不 mock** SessionManager。session.test.ts 把它换成了假的,那对测
 * 会话管理器的状态机是对的,但对这里是错的:回灌的全部意义是"写出去的东西
 * pi-agent 自己读得回来",只有真实的 SessionManager 能证明这一点。
 */
let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "rehydrate-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const rows: RehydrateRow[] = [
  { role: "user", content: "roce-test 有几个节点?", createdAt: "2026-09-05T00:00:01Z" },
  { role: "tool", toolName: "bash", toolInput: '{"command":"kubectl get nodes"}', content: "5 nodes", outcome: "success", createdAt: "2026-09-05T00:00:02Z" },
  { role: "assistant", content: "共 5 个节点。", createdAt: "2026-09-05T00:00:03Z" },
];

describe("writeRehydratedSession", () => {
  it("writes a session that continueRecent reads back with the same messages, in order", () => {
    const { written } = writeRehydratedSession(process.cwd(), dir, rows);
    expect(written).toBe(4); // user + (toolCall assistant + toolResult) + assistant

    const back = SessionManager.continueRecent(process.cwd(), dir);
    const ctx = back.buildSessionContext();
    expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(ctx.messages[0]).toMatchObject({ role: "user", content: "roce-test 有几个节点?" });
    // toolCall 与 toolResult 靠 id 配对 —— 读回来之后这对关系必须还在。
    const call = ctx.messages[1] as { content: Array<{ type: string; id?: string; name?: string }> };
    const result = ctx.messages[2] as { toolCallId: string; toolName: string };
    expect(call.content[0]).toMatchObject({ type: "toolCall", name: "bash" });
    expect(result.toolCallId).toBe(call.content[0].id);
    expect(result.toolName).toBe("bash");
  });

  // 这是 session.ts 里既有恢复路径的判据:entries 里得有真实的 user/assistant
  // 消息。回灌出来的目录必须让它判为"可恢复",否则 requireExistingSession 仍然 412。
  it("produces a directory that the resumable-context predicate accepts", () => {
    writeRehydratedSession(process.cwd(), dir, rows);
    const entries = SessionManager.continueRecent(process.cwd(), dir).getEntries();
    const hasReal = entries.some(
      (e: { type?: string; message?: { role?: string } }) =>
        e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
    );
    expect(hasReal).toBe(true);
  });

  // 空历史不能留下一个只有头的文件:那在恢复判据眼里仍是"不可恢复",却会让
  // isNewSession 的 `entries.length <= 1` 多出一个歧义分支。
  it("creates nothing for an empty history", () => {
    const { written } = writeRehydratedSession(process.cwd(), dir, []);
    expect(written).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("creates nothing when every row is skippable", () => {
    const { written } = writeRehydratedSession(process.cwd(), dir, [
      { role: "user", content: "   " },
      { role: "tool", toolName: "", content: "orphan" },
    ]);
    expect(written).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
