import { describe, expect, it } from "vitest";
import { REHYDRATED_MODEL, isRehydratedUsage, toRehydratedMessages, type RehydrateRow } from "./session-rehydrate.js";

const at = "2026-09-05T01:02:03.000Z";
const row = (r: Partial<RehydrateRow> & { role: string }): RehydrateRow => ({ content: "", createdAt: at, ...r });

describe("toRehydratedMessages", () => {
  it("maps user / assistant rows one-to-one", () => {
    const out = toRehydratedMessages([
      row({ role: "user", content: "roce-test 有几个节点?" }),
      row({ role: "assistant", content: "5 个。" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "user", content: "roce-test 有几个节点?", timestamp: Date.parse(at) });
    expect(out[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "5 个。" }],
      stopReason: "stop",
      model: REHYDRATED_MODEL,
    });
  });

  // ⚠️ 控制面一行 tool = pi 侧两条。这是整个转换里唯一不是逐行映射的地方,也是
  // 最容易写错的地方:少了带 ToolCall 的 assistant,toolResult 就是孤儿,pi 侧
  // 构建上下文时接不起来。
  it("expands one tool row into a ToolCall assistant + a paired toolResult", () => {
    const out = toRehydratedMessages([
      row({ role: "tool", toolName: "bash", toolInput: '{"command":"kubectl get nodes"}', content: "NAME READY", outcome: "success" }),
    ], (i) => `id-${i}`);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "id-0", name: "bash", arguments: { command: "kubectl get nodes" } }],
    });
    expect(out[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "id-0",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "NAME READY" }],
    });
  });

  it("pairs by row order, so two consecutive tool rows get two distinct ids", () => {
    const out = toRehydratedMessages([
      row({ role: "tool", toolName: "bash", content: "a" }),
      row({ role: "tool", toolName: "bash", content: "b" }),
    ]);
    const calls = out.filter((m) => m.role === "assistant");
    const results = out.filter((m) => m.role === "toolResult");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    const callIds = calls.map((m) => (m.role === "assistant" ? (m.content[0] as { id: string }).id : ""));
    expect(new Set(callIds).size).toBe(2);
    results.forEach((r, i) => expect(r.role === "toolResult" && r.toolCallId).toBe(callIds[i]));
  });

  it("marks a failed tool row as isError and treats unknown outcomes as success", () => {
    const out = toRehydratedMessages([
      row({ role: "tool", toolName: "bash", content: "boom", outcome: "error" }),
      row({ role: "tool", toolName: "bash", content: "?", outcome: "weird" }),
      row({ role: "tool", toolName: "bash", content: "ok", outcome: null }),
    ]);
    const results = out.filter((m) => m.role === "toolResult") as Array<{ isError: boolean }>;
    expect(results.map((r) => r.isError)).toEqual([true, false, false]);
  });

  // tool_input 是存下来的字符串。坏 JSON 不能让整段历史回灌失败 —— 参数的内容对
  // 模型仍有意义,原样带过去。
  it("keeps a non-JSON tool_input as { input } instead of throwing", () => {
    const out = toRehydratedMessages([row({ role: "tool", toolName: "bash", toolInput: "not json {" })]);
    expect(out[0]).toMatchObject({ content: [{ type: "toolCall", arguments: { input: "not json {" } }] });
  });

  it("skips empty user / assistant rows and tool rows without a name", () => {
    const out = toRehydratedMessages([
      row({ role: "user", content: "   " }),
      row({ role: "assistant", content: "" }),
      row({ role: "tool", toolName: "", content: "orphan" }),
      row({ role: "user", content: "real" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "user", content: "real" });
  });

  it("renders error rows as assistant text so later turns keep their referent", () => {
    const out = toRehydratedMessages([row({ role: "error", content: "provider timeout" })]);
    expect(out[0]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "provider timeout" }] });
  });

  it("uses timestamp 0 rather than NaN for a missing or malformed created_at", () => {
    const out = toRehydratedMessages([
      row({ role: "user", content: "a", createdAt: null }),
      row({ role: "user", content: "b", createdAt: "garbage" }),
    ]);
    expect(out.map((m) => m.timestamp)).toEqual([0, 0]);
  });

  // ⚠️ 占位用量必须是零,而且不能与真实调用共享同一个对象 —— 任何对它的原地修改
  // 都会串到别的消息上。这条断言的是"每条消息的 usage 是独立对象"。
  it("gives every rehydrated assistant its own zeroed usage object", () => {
    const out = toRehydratedMessages([
      row({ role: "assistant", content: "x" }),
      row({ role: "assistant", content: "y" }),
    ]) as Array<{ role: string; usage?: { totalTokens: number; cost: { total: number } } }>;
    expect(out[0].usage).not.toBe(out[1].usage);
    expect(out[0].usage?.cost).not.toBe(out[1].usage?.cost);
    expect(out[0].usage).toMatchObject({ totalTokens: 0, cost: { total: 0 } });
  });
});

describe("usage provenance marking", () => {
  it("marks a rebuilt tool call so its zeros are never read as a report", () => {
    const [assistant] = toRehydratedMessages([
      row({ role: "tool", content: "ok", toolName: "bash", toolInput: "{}", outcome: "success" }),
    ]);
    expect(isRehydratedUsage(assistant)).toBe(true);
  });

  it("marks a rebuilt assistant even when api/provider were restored to the originals", () => {
    // The case api/provider cannot detect: restored values make the message look
    // native, so this mark is the only surviving evidence of a rebuild.
    const [assistant] = toRehydratedMessages([
      row({
        role: "assistant",
        content: "hello",
        metadata: { assistant_item: { api: "openai-responses", provider: "example-gateway", model: "gpt-5" } },
      }),
    ]);
    expect(assistant).toMatchObject({ api: "openai-responses", model: "gpt-5" });
    expect(isRehydratedUsage(assistant)).toBe(true);
  });

  it("does not mark a message it did not synthesise", () => {
    expect(isRehydratedUsage({ role: "assistant", usage: { input: 0 } })).toBe(false);
    expect(isRehydratedUsage(null)).toBe(false);
    expect(isRehydratedUsage("assistant")).toBe(false);
  });
});
