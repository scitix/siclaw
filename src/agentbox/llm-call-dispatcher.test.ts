import { describe, it, expect, vi } from "vitest";
import { LlmCallMeasurementDispatcher } from "./llm-call-dispatcher.js";
import type { LlmCallMeasurement } from "../shared/llm-call-record.js";

const measurement = (callId: string): LlmCallMeasurement => ({
  call_id: callId,
  prompt_id: "p1",
  kind: "agent",
  round: 1,
  attempt: 1,
  network_attempts: 1,
  provider: "example-gateway",
  model_id: "gpt-5",
  api_type: "openai-responses",
  usage_status: "reported",
  usage_source: "provider",
  reported_fields: ["input", "output"],
  input_tokens_total: 10,
  output_tokens_total: 5,
  reasoning_tokens: null,
  cache_read_tokens: 0,
  cache_write_tokens: null,
  payload_bytes: 100,
  payload_tokens_estimated: 25,
  request_snapshot: {
    model_settings: {},
    system_sha256: "s",
    tools_sha256: "t",
    history_prefix_sha256: "h",
    history_message_count: 1,
  },
  request_at: "2026-09-12T00:00:00.000Z",
  response_end_at: "2026-09-12T00:00:01.000Z",
  since_prev_ms: null,
  cost_micros: null,
  inconsistencies: [],
});

describe("LlmCallMeasurementDispatcher", () => {
  it("batches rather than sending one request per call", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send });

    for (let i = 0; i < 5; i++) d.record(measurement(`c${i}`));
    expect(send).not.toHaveBeenCalled();   // still buffered

    await d.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].measurements).toHaveLength(5);
    expect(send.mock.calls[0][0].session_id).toBe("s1");
  });

  it("flushes automatically once the batch fills", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send });

    for (let i = 0; i < 16; i++) d.record(measurement(`c${i}`));
    await d.flush();
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls[0][0].measurements).toHaveLength(16);
  });

  it("never lets a delivery failure reach the caller", async () => {
    const send = vi.fn().mockRejectedValue(new Error("runtime down"));
    const warn = vi.fn();
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send, warn, sleep: async () => {} });

    d.record(measurement("c1"));
    await expect(d.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(d.stats().dropped).toBe(1);
  });

  it("retries a transient failure instead of losing the batch", async () => {
    // The failure mode that mattered: first send fails, Runtime recovers, and
    // the measurements must still arrive rather than being gone for good.
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send, sleep: async () => {} });

    d.record(measurement("c1"));
    await d.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(d.stats().delivered).toBe(1);
    expect(d.stats().dropped).toBe(0);
  });

  it("reports a delivery gap that a coverage statement can read", async () => {
    const send = vi.fn().mockRejectedValue(new Error("down"));
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send, sleep: async () => {} });
    d.record(measurement("c1"));
    await d.flush();

    const stats = d.stats();
    expect(stats.dropped).toBe(1);
    expect(stats.failedBatches).toBe(1);
    expect(stats.delivered).toBe(0);
  });

  it("bounds EVERYTHING it holds, including batches awaiting acknowledgement", async () => {
    // The earlier cap counted only the pending buffer while dispatched batches
    // accumulated outside it, so 1024 records produced zero drops.
    let release: () => void = () => {};
    const firstSendHangs = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const send = vi.fn().mockImplementation(async () => {
      if (++calls === 1) await firstSendHangs;
    });
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send, sleep: async () => {} });

    for (let i = 0; i < 1_024; i++) d.record(measurement(`c${i}`));
    // With the first send still in flight, the cap must already have bitten.
    expect(d.stats().dropped).toBeGreaterThan(0);
    expect(d.stats().pending).toBeLessThanOrEqual(512);

    release();
    await d.flush();
  });

  it("does not send the same measurement twice across concurrent flushes", async () => {
    const seen: string[] = [];
    const send = vi.fn().mockImplementation(async (batch: any) => {
      for (const m of batch.measurements) seen.push(m.call_id);
      await new Promise((r) => setTimeout(r, 5));
    });
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send });

    d.record(measurement("a"));
    const first = d.flush();
    d.record(measurement("b"));
    const second = d.flush();
    await Promise.all([first, second]);

    expect(seen.sort()).toEqual(["a", "b"]);   // each exactly once
  });

  it("flushes what is pending on close", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send });
    d.record(measurement("c1"));
    await d.close();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("bounds a send that STARTED BEFORE close, not only ones begun after it", async () => {
    // The hard case: with no deadline set yet, such a send arms no timer and is
    // parked on the cutoff latch alone — while close's own `await drain()` is
    // waiting on that same send. Signalling after the loop would make the bound
    // wait on the thing it bounds.
    let releaseSend: () => void = () => {};
    const send = vi.fn(() => new Promise<void>((r) => { releaseSend = r; }));
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send });

    for (let i = 0; i < 16; i++) d.record(measurement(`c${i}`)); // fills a batch ⇒ drains now
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);                        // in flight, unresolved

    const startedAt = Date.now();
    await d.close(30);
    const elapsed = Date.now() - startedAt;

    // Generous upper bound: the point is that it returns on the budget rather
    // than on the send. Before the fix this waited for `releaseSend`.
    expect(elapsed).toBeLessThan(2_000);
    expect(d.stats().dropped).toBe(16);   // counted as lost, not left as pending
    expect(d.stats().pending).toBe(0);
    releaseSend();                        // the abandoned request may still land
  });

  it("is a no-op when nothing is pending", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new LlmCallMeasurementDispatcher({ sessionId: "s1", send });
    await d.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
