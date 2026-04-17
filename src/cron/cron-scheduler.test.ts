import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronScheduler, type CronJobRow } from "./cron-scheduler.js";

function makeJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
  return {
    id: overrides.id ?? "job-1",
    name: overrides.name ?? "test-job",
    description: overrides.description ?? null,
    schedule: overrides.schedule ?? "0 * * * *", // every hour
    status: overrides.status ?? "active",
    lastRunAt: overrides.lastRunAt ?? null,
    lastResult: overrides.lastResult ?? null,
    ...overrides,
  };
}

describe("CronScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with zero jobs and no scheduled ids", () => {
    const s = new CronScheduler(async () => {});
    expect(s.jobCount).toBe(0);
    expect(s.scheduledJobIds).toEqual([]);
    s.stop();
  });

  it("addOrUpdate schedules an active job", () => {
    const s = new CronScheduler(async () => {});
    s.addOrUpdate(makeJob({ id: "a", status: "active" }));
    expect(s.jobCount).toBe(1);
    expect(s.scheduledJobIds).toEqual(["a"]);
    s.stop();
  });

  it("addOrUpdate does NOT schedule a paused job (but tracks it internally)", () => {
    const s = new CronScheduler(async () => {});
    s.addOrUpdate(makeJob({ id: "p", status: "paused" }));
    // Paused → no timer
    expect(s.jobCount).toBe(0);
    expect(s.scheduledJobIds).toEqual([]);
    s.stop();
  });

  it("cancel removes the timer and job record", () => {
    const s = new CronScheduler(async () => {});
    s.addOrUpdate(makeJob({ id: "a" }));
    expect(s.jobCount).toBe(1);
    s.cancel("a");
    expect(s.jobCount).toBe(0);
    expect(s.scheduledJobIds).toEqual([]);
    s.stop();
  });

  it("cancel is a no-op for unknown job id", () => {
    const s = new CronScheduler(async () => {});
    expect(() => s.cancel("missing")).not.toThrow();
    expect(s.jobCount).toBe(0);
    s.stop();
  });

  it("addOrUpdate replaces an existing timer (re-scheduling)", () => {
    const s = new CronScheduler(async () => {});
    s.addOrUpdate(makeJob({ id: "a", schedule: "0 * * * *" }));
    const countA = s.jobCount;
    // Update with a different schedule
    s.addOrUpdate(makeJob({ id: "a", schedule: "*/30 * * * *" }));
    expect(s.jobCount).toBe(countA); // still exactly 1 timer
    s.stop();
  });

  it("switching from active → paused cancels the timer", () => {
    const s = new CronScheduler(async () => {});
    s.addOrUpdate(makeJob({ id: "a", status: "active" }));
    expect(s.jobCount).toBe(1);
    s.addOrUpdate(makeJob({ id: "a", status: "paused" }));
    expect(s.jobCount).toBe(0);
    s.stop();
  });

  it("stop cancels all timers and clears state", () => {
    const s = new CronScheduler(async () => {});
    s.addOrUpdate(makeJob({ id: "a" }));
    s.addOrUpdate(makeJob({ id: "b" }));
    expect(s.jobCount).toBe(2);
    s.stop();
    expect(s.jobCount).toBe(0);
    expect(s.scheduledJobIds).toEqual([]);
  });

  it("invokes onFire when the timer elapses, then re-schedules next fire", async () => {
    let fireCount = 0;
    const fired: string[] = [];
    const onFire = vi.fn(async (job: CronJobRow) => {
      fireCount++;
      fired.push(job.id);
    });
    const s = new CronScheduler(onFire);
    s.addOrUpdate(makeJob({ id: "t", schedule: "* * * * *" })); // every minute

    // Fast-forward until at least one fire happens
    await vi.advanceTimersByTimeAsync(60_000 + 1000);
    // Drain microtasks
    await Promise.resolve();

    expect(fireCount).toBeGreaterThanOrEqual(1);
    expect(fired[0]).toBe("t");
    // After fire, timer is re-established
    expect(s.jobCount).toBe(1);
    s.stop();
  });

  it("swallows onFire errors and keeps scheduling next fire", async () => {
    let calls = 0;
    const onFire = vi.fn(async () => {
      calls++;
      throw new Error("boom");
    });
    const s = new CronScheduler(onFire);
    s.addOrUpdate(makeJob({ id: "e", schedule: "* * * * *" }));

    await vi.advanceTimersByTimeAsync(60_000 + 1000);
    await Promise.resolve();

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(s.jobCount).toBe(1); // Timer re-established despite error
    s.stop();
  });

  it("does not schedule a job with a bogus cron expression (logs error)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = new CronScheduler(async () => {});
    s.addOrUpdate(makeJob({ id: "bad", schedule: "not a cron" }));
    // Internally jobs map has it, but timers map is empty because scheduleNext threw
    expect(s.jobCount).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    s.stop();
    errSpy.mockRestore();
  });
});
