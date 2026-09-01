import { describe, it, expect, vi, afterEach } from "vitest";
import { runWithinBudget, startStartupBudget, unlimitedStartupBudget } from "./startup-budget.js";

afterEach(() => vi.restoreAllMocks());

/** A clock the test drives by hand, so no case depends on real elapsed time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("startStartupBudget", () => {
  it("counts down against the injected clock", () => {
    const clock = fakeClock();
    const budget = startStartupBudget(30_000, clock.now);

    expect(budget.remainingMs()).toBe(30_000);
    clock.advance(10_000);
    expect(budget.remainingMs()).toBe(20_000);
    expect(budget.isSpent()).toBe(false);
  });

  it("floors the remainder at zero and reports itself spent", () => {
    const clock = fakeClock();
    const budget = startStartupBudget(30_000, clock.now);

    clock.advance(45_000);
    expect(budget.remainingMs()).toBe(0);
    expect(budget.isSpent()).toBe(true);
  });

  it("is spent exactly at the deadline, not one tick later", () => {
    const clock = fakeClock();
    const budget = startStartupBudget(30_000, clock.now);

    clock.advance(30_000);
    expect(budget.isSpent()).toBe(true);
  });
});

describe("runWithinBudget", () => {
  it("returns the work's value when it finishes in time", async () => {
    const budget = startStartupBudget(30_000);
    await expect(runWithinBudget(budget, "settings", async () => 42)).resolves.toBe(42);
  });

  it("swallows a failure and reports undefined, so listen is never blocked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const budget = startStartupBudget(30_000);

    await expect(runWithinBudget(budget, "settings", async () => { throw new Error("gateway down"); }))
      .resolves.toBeUndefined();
  });

  /**
   * 🔴 THE CONTRACT. Three sequential steps used to get 30s EACH, so a slow Runtime meant up
   * to 90s of silence before listen(). The startupProbe allows 60s from container start and
   * the pod is restartPolicy: Never, so past that kubelet kills the pod into Failed — the
   * Runtime collects it as crashed, refills the slot, and the replacement queues behind the
   * same slow gateway. Steps must therefore draw from ONE allowance.
   */
  it("skips a later step once an earlier one spent the shared budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = fakeClock();
    const budget = startStartupBudget(30_000, clock.now);

    // First step burns the whole allowance.
    clock.advance(30_000);

    const second = vi.fn(async () => "resource sync result");
    const third = vi.fn(async () => "tools result");

    await expect(runWithinBudget(budget, "resource sync", second)).resolves.toBeUndefined();
    await expect(runWithinBudget(budget, "tool-capabilities sync", third)).resolves.toBeUndefined();

    // Not merely timed out — never started. That is what keeps the total bounded.
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
  });

  it("says which step it skipped and names the budget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = fakeClock();
    const budget = startStartupBudget(30_000, clock.now);
    clock.advance(30_000);

    await runWithinBudget(budget, "tool-capabilities sync", async () => "x");

    expect(warn.mock.calls[0][0]).toContain("skipping tool-capabilities sync");
    expect(warn.mock.calls[0][0]).toContain("30000ms");
  });

  it("gives a later step only what the earlier ones left", async () => {
    vi.useFakeTimers();
    try {
      const budget = startStartupBudget(30_000, () => Date.now());
      // 25s gone; the next step must not get a fresh 30s.
      vi.advanceTimersByTime(25_000);

      const pending = runWithinBudget(budget, "resource sync", () => new Promise<string>(() => {}));
      const settled = vi.fn();
      void pending.then(settled);

      // Still inside the remaining 5s.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).not.toHaveBeenCalled();

      // Past it: the step is abandoned rather than allowed a full per-step window.
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unlimitedStartupBudget", () => {
  /**
   * "No budget" must mean run the work, not skip it. setTimeout also coerces anything past
   * 2^31-1 ms into a near-immediate fire, so an unlimited budget must arm no timer at all —
   * otherwise it would abort instantly, the exact opposite of no deadline.
   */
  it("runs the work with no deadline instead of skipping it", async () => {
    const budget = unlimitedStartupBudget();
    expect(budget.isSpent()).toBe(false);

    const work = vi.fn(async () => "done");
    await expect(runWithinBudget(budget, "settings", work)).resolves.toBe("done");
    expect(work).toHaveBeenCalled();
  });

  it("does not fire a bogus immediate timeout", async () => {
    vi.useFakeTimers();
    try {
      const budget = unlimitedStartupBudget();
      let resolveWork: ((v: string) => void) | undefined;
      const pending = runWithinBudget(budget, "settings", () => new Promise<string>((r) => { resolveWork = r; }));

      // A timer armed with Infinity would already have rejected by now.
      await vi.advanceTimersByTimeAsync(5_000);
      resolveWork!("late but fine");

      await expect(pending).resolves.toBe("late but fine");
    } finally {
      vi.useRealTimers();
    }
  });
});
