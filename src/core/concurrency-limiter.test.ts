import { describe, it, expect } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import { getSubagentConcurrency, DEFAULT_SUBAGENT_CONCURRENCY } from "./subagent-registry.js";

describe("ConcurrencyLimiter", () => {
  it("never runs more than `limit` tasks at once and finishes them all", async () => {
    const limit = 3;
    const limiter = new ConcurrencyLimiter(limit);
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    // Start 10 tasks that each block until manually released.
    const results = Array.from({ length: 10 }, (_, i) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => release.push(r));
        active--;
        return i;
      }),
    );

    // Let the microtask queue settle: exactly `limit` should be running.
    await new Promise((r) => setTimeout(r, 0));
    expect(active).toBe(limit);

    // Drain: releasing one frees a slot for the next queued task.
    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(limit);
    expect(active).toBe(0);
  });

  it("exposes activeCount / pendingCount / atCapacity for observability", async () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.atCapacity).toBe(false);

    const release: Array<() => void> = [];
    const block = () => limiter.run(() => new Promise<void>((r) => release.push(r)));
    const tasks = [block(), block(), block()]; // 2 run, 1 queues
    await new Promise((r) => setTimeout(r, 0));

    expect(limiter.activeCount).toBe(2);
    expect(limiter.atCapacity).toBe(true);
    expect(limiter.pendingCount).toBe(1);

    // Drain one slot at a time — releasing a runner lets the queued task start
    // (and push its own resolver), so iterate until every task has resolved.
    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(tasks);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it("releases the slot even when a task throws", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // If the slot leaked, this second task would hang forever.
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });

  it("coerces invalid limits to at least 1", () => {
    expect(new ConcurrencyLimiter(0).limit).toBe(1);
    expect(new ConcurrencyLimiter(-5).limit).toBe(1);
    expect(new ConcurrencyLimiter(Number.NaN).limit).toBe(1);
    expect(new ConcurrencyLimiter(4).limit).toBe(4);
  });
});

describe("getSubagentConcurrency", () => {
  it("defaults when unset or blank", () => {
    expect(getSubagentConcurrency({})).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "" })).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "  " })).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
  });

  it("reads a valid positive integer", () => {
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "10" })).toBe(10);
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "1" })).toBe(1);
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "2.9" })).toBe(2);
  });

  it("falls back to default on invalid / non-positive values", () => {
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "0" })).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "-3" })).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
    expect(getSubagentConcurrency({ SICLAW_SUBAGENT_CONCURRENCY: "abc" })).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
  });
});
