import { describe, expect, it, vi } from "vitest";
import { AssistantItemStream } from "./assistant-item-stream.js";
import { toRehydratedMessages } from "../shared/session-rehydrate.js";

const block = (text: string, phase: string, id: string) => ({ type: "text", text, textSignature: JSON.stringify({ v: 1, id, phase }) });

describe("native assistant items", () => {
  it("keeps simultaneous text block identities and native phases through complete messages and history", () => {
    const stream = new AssistantItemStream();
    const first = stream.update({ type: "text_delta", contentIndex: 1, delta: "Checking" })!;
    const second = stream.update({ type: "text_delta", contentIndex: 3, delta: "5 nodes" })!;
    const done = stream.complete({ role: "assistant", api: "openai-responses", provider: "openai", model: "test",
      content: [{ type: "thinking", thinking: "not public" }, block("Checking", "commentary", "msg_p"), { type: "toolCall" }, block("5 nodes", "final_answer", "msg_f")], stopReason: "stop" });
    expect(done.map(item => item.id)).toEqual([first.item.id, second.item.id]);
    expect(done.map(item => item.phase)).toEqual(["commentary", "final_answer"]);
    const restored = toRehydratedMessages(done.map(item => ({ role: "assistant", content: item.text, metadata: { assistant_item: item } })));
    expect(restored).toMatchObject(done.map(item => ({ role: "assistant", api: item.api, provider: item.provider, model: item.model, content: [{ type: "text", text: item.text, textSignature: item.textSignature }] })));
    expect(JSON.stringify(restored)).not.toContain("not public");
  });

  it("uses full text at text_end and does not infer a phase from stopReason", () => {
    const stream = new AssistantItemStream();
    const delta = stream.update({ type: "text_delta", delta: "par" })!;
    const end = stream.update({ type: "text_end", content: "partial corrected" })!;
    const done = stream.complete({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "partial corrected" }] });
    expect(end.item.id).toBe(delta.item.id);
    expect(done[0]).toMatchObject({ id: delta.item.id, text: "partial corrected" });
    expect(done[0].phase).toBeUndefined();
    const next = stream.complete({ role: "assistant", content: [{ type: "text", text: "partial corrected" }] });
    expect(next[0].id).not.toBe(done[0].id);
  });
});


it("stamps completion once for both the event snapshot and persisted item", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    const stream = new AssistantItemStream();
    stream.update({ type: "text_delta", delta: "Checking" });
    expect(stream.snapshot()[0].completedAt).toBeUndefined();
    vi.advanceTimersByTime(51000);
    const completed = stream.complete({ content: [{ type: "text", text: "5 nodes" }] });
    expect(completed[0].completedAt).toBe("2026-09-08T00:00:51.000Z");
    vi.advanceTimersByTime(30000);
    expect(stream.snapshot()[0].completedAt).toBe(completed[0].completedAt);
    const serialized = JSON.parse(JSON.stringify({ assistant_item: { ...completed[0], text: undefined } }));
    expect(serialized.assistant_item.completedAt).toBe(completed[0].completedAt);
    stream.begin();
    expect(stream.snapshot()).toEqual([]);
  } finally { vi.useRealTimers(); }
});
