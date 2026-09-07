import { beforeEach, expect, it, vi } from "vitest";
import { consumeAgentSse } from "./sse-consumer.js";
import { toRehydratedMessages } from "../shared/session-rehydrate.js";

const rows = vi.hoisted(() => [] as any[]);
vi.mock("./chat-repo.js", () => ({
  appendMessage: vi.fn(async (row: any) => { rows.push(row); return `db-${rows.length}`; }),
  incrementMessageCount: vi.fn(async () => {}), updateMessage: vi.fn(async () => {}),
}));
beforeEach(() => rows.splice(0));
const text = (value: string, phase: string, id: string) => ({ type: "text", text: value, textSignature: JSON.stringify({ v: 1, id, phase }) });

it("preserves phase, identity, author and order across multi-tool batches and message/turn completion", async () => {
  const progress = text("检查数量和就绪状态。", "commentary", "msg_p");
  const final = text("5 个节点均就绪。", "final_answer", "msg_f");
  const origin = { api: "openai-responses", provider: "openai", model: "test" };
  const events = [
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: progress.text } },
    { type: "message_end", message: { ...origin, role: "assistant", content: [progress], stopReason: "toolUse" } },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "lookup", args: { name: "nodes" } },
    { type: "tool_execution_start", toolCallId: "c2", toolName: "lookup", args: { name: "ready" } },
    { type: "turn_start" },
    { type: "message_end", message: { ...origin, role: "assistant", content: [text("状态已核对。", "commentary", "msg_p2"), final], stopReason: "stop" } },
  ];
  events.push({ type: "turn_end", message: events[7].message } as any);
  const seen: any[] = [];
  const result = await consumeAgentSse({ client: { async *streamEvents() { yield* events; } } as any,
    sessionId: "s", userId: "u", agentId: "worker", persistMessages: true, onEvent: (event, _, extras) => seen.push({ ...event, ...extras }) });
  expect(rows.map(row => row.role)).toEqual(["assistant", "tool", "tool", "assistant", "assistant"]);
  const replies = rows.filter(row => row.role === "assistant");
  expect(replies.map(row => row.metadata.phase)).toEqual(["commentary", "commentary", "final_answer"]);
  expect(replies.every(row => row.fromAgentId === "worker")).toBe(true);
  expect(result.resultText).toBe(final.text);
  const restored = toRehydratedMessages(replies);
  expect(restored[0]).toMatchObject({ ...origin, content: [{ textSignature: progress.textSignature }] });
  const firstText = seen.find(event => event.type === "item/agentMessage/delta");
  expect(replies[0].metadata.assistant_item.id).toBe(firstText.itemId);
  expect(seen.findIndex(event => event.type === "item/completed")).toBeLessThan(seen.findIndex(event => event.type === "tool_execution_start"));
  expect(seen.some(event => event.type === "progress_update")).toBe(false);
});

it("does not create narration from tool arguments when the model emits no text", async () => {
  const seen: any[] = [];
  await consumeAgentSse({ client: { async *streamEvents() {
    yield { type: "tool_execution_start", toolCallId: "c", toolName: "lookup", args: { description: "domain value" } };
  } } as any, sessionId: "s", userId: "u", persistMessages: true, onEvent: e => seen.push(e) });
  expect(rows.map(row => row.role)).toEqual(["tool"]);
  expect(seen.some(event => event.type.startsWith("item/"))).toBe(false);
});
