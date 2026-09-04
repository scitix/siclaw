import { describe, it, expect } from "vitest";
import { summariseLatency, extractLlmCallMs } from "./metrics-timing.js";

describe("summariseLatency", () => {
  it("returns zeros for an empty list", () => {
    expect(summariseLatency([])).toEqual({ count: 0, avg: 0, min: 0, max: 0, p90: 0 });
  });

  it("handles a single sample", () => {
    expect(summariseLatency([42])).toEqual({ count: 1, avg: 42, min: 42, max: 42, p90: 42 });
  });

  it("computes nearest-rank p90 on unsorted input", () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const s = summariseLatency([...vals].reverse());
    expect(s.count).toBe(10);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.avg).toBe(55);
    expect(s.p90).toBe(90);
  });

  it("rounds the average", () => {
    expect(summariseLatency([1, 2]).avg).toBe(2); // 1.5 → 2
  });
});

describe("extractLlmCallMs", () => {
  const md = JSON.stringify({ llm_call: { v: 1, ms: { net_ttft: 120, thinking: 30, output: 400, total: 550 } } });

  it("reads each partition key from a JSON string", () => {
    expect(extractLlmCallMs(md, "net_ttft")).toBe(120);
    expect(extractLlmCallMs(md, "thinking")).toBe(30);
    expect(extractLlmCallMs(md, "output")).toBe(400);
    expect(extractLlmCallMs(md, "total")).toBe(550);
  });

  it("accepts a pre-decoded object", () => {
    expect(extractLlmCallMs({ llm_call: { ms: { net_ttft: 7 } } }, "net_ttft")).toBe(7);
  });

  it("ignores the retired timing.* / pre_thinking_ms shapes", () => {
    expect(extractLlmCallMs(JSON.stringify({ timing: { ttft_ms: 5 } }), "net_ttft")).toBeUndefined();
    expect(extractLlmCallMs(JSON.stringify({ pre_thinking_ms: 5 }), "thinking")).toBeUndefined();
    expect(extractLlmCallMs(JSON.stringify({ llm_call: {} }), "total")).toBeUndefined();
  });

  it("returns undefined for absent / malformed / negative / non-numeric values", () => {
    expect(extractLlmCallMs(null, "total")).toBeUndefined();
    expect(extractLlmCallMs("{not json", "total")).toBeUndefined();
    expect(extractLlmCallMs(JSON.stringify({ llm_call: { ms: { total: -5 } } }), "total")).toBeUndefined();
    expect(extractLlmCallMs(JSON.stringify({ llm_call: { ms: { total: "x" } } }), "total")).toBeUndefined();
  });

  it("rounds fractional milliseconds", () => {
    expect(extractLlmCallMs(JSON.stringify({ llm_call: { ms: { total: 12.7 } } }), "total")).toBe(13);
  });
});
