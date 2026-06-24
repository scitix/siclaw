import { describe, it, expect } from "vitest";
import { summariseLatency, extractTimingMs } from "./metrics-timing.js";

describe("summariseLatency", () => {
  it("returns all-zero for an empty sample", () => {
    expect(summariseLatency([])).toEqual({ count: 0, avg: 0, min: 0, max: 0, p90: 0 });
  });

  it("summarises a single value", () => {
    expect(summariseLatency([42])).toEqual({ count: 1, avg: 42, min: 42, max: 42, p90: 42 });
  });

  it("computes count/avg/min/max + nearest-rank p90 (order-independent)", () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]; // n=10
    const s = summariseLatency([...vals].reverse());
    expect(s.count).toBe(10);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.avg).toBe(55);
    // nearest-rank p90: index ceil(0.9*10)-1 = 8 → 90
    expect(s.p90).toBe(90);
  });

  it("rounds avg to an integer", () => {
    expect(summariseLatency([1, 2]).avg).toBe(2); // 1.5 → 2
  });
});

describe("extractTimingMs", () => {
  it("reads timing.<key> from a JSON metadata string", () => {
    const md = JSON.stringify({ timing: { ttft_ms: 120, thinking_ms: 30 } });
    expect(extractTimingMs(md, "ttft_ms")).toBe(120);
    expect(extractTimingMs(md, "thinking_ms")).toBe(30);
  });

  it("accepts a pre-decoded object", () => {
    expect(extractTimingMs({ timing: { ttft_ms: 7 } }, "ttft_ms")).toBe(7);
  });

  it("returns undefined when timing / key is absent", () => {
    expect(extractTimingMs(JSON.stringify({ pre_thinking_ms: 5 }), "ttft_ms")).toBeUndefined();
    expect(extractTimingMs(JSON.stringify({ timing: {} }), "ttft_ms")).toBeUndefined();
  });

  it("returns undefined for null / malformed / negative / non-numeric", () => {
    expect(extractTimingMs(null, "ttft_ms")).toBeUndefined();
    expect(extractTimingMs("{not json", "ttft_ms")).toBeUndefined();
    expect(extractTimingMs(JSON.stringify({ timing: { ttft_ms: -5 } }), "ttft_ms")).toBeUndefined();
    expect(extractTimingMs(JSON.stringify({ timing: { ttft_ms: "x" } }), "ttft_ms")).toBeUndefined();
  });

  it("rounds a fractional value", () => {
    expect(extractTimingMs(JSON.stringify({ timing: { ttft_ms: 12.7 } }), "ttft_ms")).toBe(13);
  });
});
