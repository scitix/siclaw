import { describe, it, expect } from "vitest";
import {
  LlmCallRecorder,
  llmCallFromMessage,
  thinkingBlocksFromMessage,
  type LlmCallEnvelope,
} from "./llm-call-recorder.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Deterministic clock: each call to `now()` returns the next scripted value, then repeats the last. */
function makeClock(ticks: number[]) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

/** Events with the tick at which they are observed; `advanceTo` lets a test place the clock. */
interface Scripted { tick: number; event: unknown }

function makeStream(events: Scripted[], finalMessage: any, clock: { set: (t: number) => void }, endTick?: number) {
  let i = 0;
  return {
    async result() {
      if (endTick !== undefined) clock.set(endTick);
      return finalMessage;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (i < events.length) {
            const { tick, event } = events[i++];
            clock.set(tick);
            return { done: false, value: event };
          }
          return { done: true, value: undefined };
        },
        async return() { return { done: true as const, value: undefined }; },
        async throw() { return { done: true as const, value: undefined }; },
      };
    },
  };
}

function settableClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; } };
}

async function drain(stream: any): Promise<any> {
  for await (const _ of stream) { /* consume */ }
  return stream.result();
}

const AGENT_CTX = { systemPrompt: "s", messages: [], tools: [] };
const AUX_CTX = { systemPrompt: "summarise", messages: [] };
const MODEL = { provider: "openai", id: "gpt-5" };

// ── Tests ──────────────────────────────────────────────────────────────

describe("LlmCallRecorder", () => {
  it("measures net_ttft / thinking / output as a partition of total, with ordered non-overlapping blocks", async () => {
    const clock = settableClock(1_000);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    recorder.beginPrompt(0, { explicit: true });

    const final = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: {} },
      ],
      usage: { input: 100, output: 40, reasoning: 25, cacheRead: 80, cacheWrite: 0, totalTokens: 140 },
      stopReason: "toolUse",
      responseId: "chatcmpl-1",
    };
    const events: Scripted[] = [
      { tick: 1_300, event: { type: "start" } },
      { tick: 1_500, event: { type: "thinking_start", contentIndex: 0 } },
      { tick: 1_600, event: { type: "thinking_delta", contentIndex: 0, delta: "let me " } },
      { tick: 3_500, event: { type: "thinking_end", contentIndex: 0, content: "let me think" } },
      { tick: 3_510, event: { type: "text_start", contentIndex: 1 } },
      { tick: 4_000, event: { type: "text_end", contentIndex: 1, content: "answer" } },
      { tick: 4_010, event: { type: "toolcall_start", contentIndex: 2 } },
      { tick: 4_500, event: { type: "toolcall_end", contentIndex: 2, toolCall: { id: "call_1", name: "bash" } } },
    ];
    const streamFn = recorder.wrapStreamFn(() => makeStream(events, final, clock, 4_600));

    clock.set(1_000);
    const message = await drain(streamFn(MODEL, AGENT_CTX, {}));

    const env = llmCallFromMessage(message)!;
    expect(env).toBeDefined();
    expect(env.round).toBe(1);
    expect(env.kind).toBe("agent");
    expect(env.prompt_received_at).toBe(new Date(0).toISOString());
    expect(env.since_prev_ms).toBe(1_000);
    expect(env.request_at).toBe(new Date(1_000).toISOString());
    expect(env.headers_at).toBe(new Date(1_300).toISOString());
    expect(env.first_token_at).toBe(new Date(1_500).toISOString());
    expect(env.response_end_at).toBe(new Date(4_600).toISOString());
    expect(env.ms.total).toBe(3_600);
    expect(env.ms.net_ttft).toBe(500);
    expect(env.ms.thinking).toBe(2_000);
    expect(env.ms.output).toBe(1_100);
    expect(env.ms.net_ttft + env.ms.thinking + env.ms.output).toBe(env.ms.total);
    expect(env.blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_call"]);
    for (let i = 1; i < env.blocks.length; i++) {
      expect(Date.parse(env.blocks[i].start_at)).toBeGreaterThanOrEqual(Date.parse(env.blocks[i - 1].end_at));
    }
    expect(env.blocks[0].chars).toBe("let me think".length);
    expect(env.blocks[2]).toMatchObject({ id: "call_1", name: "bash" });
    expect(env.usage).toEqual({ input: 100, output: 40, reasoning: 25, cache_read: 80, cache_write: 0, total: 140 });
    expect(env.stop_reason).toBe("toolUse");
    expect(env.model).toMatchObject({ provider: "openai", id: "gpt-5", response_id: "chatcmpl-1" });
    expect(env.thinking_visible).toBe(true);
    expect(env.tool_call_ids).toEqual(["call_1"]);
  });

  it("numbers agent rounds contiguously and derives since_prev_ms from the previous response end", async () => {
    const clock = settableClock(0);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    recorder.beginPrompt(0, { explicit: true });
    const streamFn = recorder.wrapStreamFn(() => makeStream([], { role: "assistant", content: [], stopReason: "stop" }, clock));

    clock.set(100);
    const m1 = await drain(streamFn(MODEL, AGENT_CTX, {})); // seals at 100
    // tool group runs 100 → 5_000
    clock.set(5_000);
    const m2 = await drain(streamFn(MODEL, AGENT_CTX, {}));

    const e1 = llmCallFromMessage(m1)!;
    const e2 = llmCallFromMessage(m2)!;
    expect(e1.round).toBe(1);
    expect(e2.round).toBe(2);
    expect(e2.prompt_received_at).toBeUndefined();
    expect(e2.since_prev_ms).toBe(4_900);
    expect(e2.since_prev_ms).toBe(Date.parse(e2.request_at) - Date.parse(e1.response_end_at));
  });

  it("does not consume a round for aux (compaction) calls and folds them into the next agent call", async () => {
    const clock = settableClock(0);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    recorder.beginPrompt(0, { explicit: true });
    const streamFn = recorder.wrapStreamFn(() => makeStream([], { role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "stop" }, clock));

    clock.set(10);
    const agent1 = await drain(streamFn(MODEL, AGENT_CTX, {}));
    clock.set(20);
    const aux = await drain(streamFn(MODEL, AUX_CTX, {}));
    clock.set(30);
    const agent2 = await drain(streamFn(MODEL, AGENT_CTX, {}));

    expect(llmCallFromMessage(agent1)!.round).toBe(1);
    const auxEnv = llmCallFromMessage(aux)!;
    expect(auxEnv.kind).toBe("aux");
    expect(auxEnv.round).toBe(0);
    const e2 = llmCallFromMessage(agent2)!;
    expect(e2.round).toBe(2);
    expect(e2.aux_calls).toHaveLength(1);
    expect(e2.aux_calls![0].kind).toBe("aux");
    expect(recorder.snapshot().pendingAux).toBe(0);
  });

  it("marks hidden reasoning as thinking_visible=false with zero thinking time", async () => {
    const clock = settableClock(0);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    const final = { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 10, output: 50, reasoning: 40 }, stopReason: "stop" };
    const events: Scripted[] = [
      { tick: 100, event: { type: "start" } },
      { tick: 2_000, event: { type: "text_start", contentIndex: 0 } },
      { tick: 2_100, event: { type: "text_end", contentIndex: 0, content: "hi" } },
    ];
    const streamFn = recorder.wrapStreamFn(() => makeStream(events, final, clock, 2_100));
    clock.set(0);
    const env = llmCallFromMessage(await drain(streamFn(MODEL, AGENT_CTX, {})))!;
    expect(env.thinking_visible).toBe(false);
    expect(env.ms.thinking).toBe(0);
    expect(env.ms.net_ttft).toBe(2_000);
    expect(env.ms.output).toBe(100);
    expect(env.usage?.reasoning).toBe(40);
  });

  it("closes blocks left open at stream end and records error / aborted stop reasons", async () => {
    const clock = settableClock(0);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    const final = { role: "assistant", content: [{ type: "text", text: "par" }], stopReason: "error", errorMessage: "boom" };
    const events: Scripted[] = [
      { tick: 50, event: { type: "start" } },
      { tick: 100, event: { type: "text_start", contentIndex: 0 } },
      { tick: 150, event: { type: "text_delta", contentIndex: 0, delta: "par" } },
    ];
    const streamFn = recorder.wrapStreamFn(() => makeStream(events, final, clock, 300));
    const env = llmCallFromMessage(await drain(streamFn(MODEL, AGENT_CTX, {})))!;
    expect(env.blocks).toHaveLength(1);
    expect(env.blocks[0].end_at).toBe(new Date(300).toISOString());
    expect(env.blocks[0].chars).toBe(3);
    expect(env.stop_reason).toBe("error");
    expect(env.error_message).toBe("boom");
  });

  it("supports promise-returning base streamFn and result()-only consumers", async () => {
    const clock = settableClock(0);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    const final = { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "x" }], stopReason: "toolUse" };
    const streamFn = recorder.wrapStreamFn(async () => makeStream([], final, clock, 400));
    const stream = await streamFn(MODEL, AGENT_CTX, {});
    const message = await stream.result();
    const again = await stream.result();
    expect(again).toBe(message);
    const env = llmCallFromMessage(message)!;
    expect(env.ms.total).toBe(400);
    expect(env.ms.net_ttft).toBe(400);
    expect(env.first_token_at).toBeUndefined();
    expect(env.tool_call_ids).toEqual(["c9"]);
  });

  it("rewinds rounds on rollbackAttempt and bumps attempt; keeps prev response end", async () => {
    const clock = settableClock(0);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    recorder.beginPrompt(0, { explicit: true });
    const streamFn = recorder.wrapStreamFn(() => makeStream([], { role: "assistant", content: [], stopReason: "error" }, clock));

    recorder.beginAttempt(1);
    clock.set(100);
    const failed = await drain(streamFn(MODEL, AGENT_CTX, {}));
    expect(llmCallFromMessage(failed)!.round).toBe(1);
    expect(llmCallFromMessage(failed)!.attempt).toBe(1);

    recorder.rollbackAttempt(); // attempt failed
    recorder.rollbackAttempt(); // live rollback — idempotent
    recorder.beginAttempt(2);
    clock.set(900);
    const survivor = await drain(streamFn(MODEL, AGENT_CTX, {}));
    const env = llmCallFromMessage(survivor)!;
    expect(env.round).toBe(1);
    expect(env.attempt).toBe(2);
    // spans the discarded attempt: 900 − 100
    expect(env.since_prev_ms).toBe(800);
  });

  it("explicit prompt boundaries win over implicit ones", () => {
    const recorder = new LlmCallRecorder({ now: () => 0, warn: () => {} });
    recorder.beginPrompt(5, { explicit: true });
    recorder.beginPrompt(99); // implicit — ignored
    recorder.endPrompt(); // implicit — ignored
    expect(recorder.snapshot().promptOpen).toBe(true);
    recorder.endPrompt({ explicit: true });
    expect(recorder.snapshot().promptOpen).toBe(false);
  });

  it("opens a prompt implicitly on the first call when nobody did", async () => {
    const clock = settableClock(0);
    const recorder = new LlmCallRecorder({ now: clock.now, warn: () => {} });
    const streamFn = recorder.wrapStreamFn(() => makeStream([], { role: "assistant", content: [] }, clock));
    const env = llmCallFromMessage(await drain(streamFn(MODEL, AGENT_CTX, {})))!;
    expect(env.round).toBe(1);
    expect(env.since_prev_ms).toBe(0);
  });
});

describe("thinkingBlocksFromMessage", () => {
  it("returns text with redaction and signature flags", () => {
    const blocks = thinkingBlocksFromMessage({
      content: [
        { type: "thinking", thinking: "abc", thinkingSignature: "sig" },
        { type: "thinking", thinking: "", redacted: true, thinkingSignature: "enc" },
        { type: "text", text: "x" },
      ],
    });
    expect(blocks).toEqual([
      { text: "abc", redacted: false, signature_present: true },
      { text: "", redacted: true, signature_present: true },
    ]);
  });

  it("is empty for non-array content", () => {
    expect(thinkingBlocksFromMessage({ content: "plain" })).toEqual([]);
    expect(thinkingBlocksFromMessage(undefined)).toEqual([]);
  });
});

describe("llmCallFromMessage", () => {
  it("rejects foreign versions", () => {
    const env = { v: 2 } as unknown as LlmCallEnvelope;
    expect(llmCallFromMessage({ llmCall: env })).toBeUndefined();
    expect(llmCallFromMessage({})).toBeUndefined();
  });
});
