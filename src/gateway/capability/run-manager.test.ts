import { describe, it, expect, beforeEach, vi } from "vitest";
import { CapabilityRunManager, type RunStateBackend } from "./run-manager.js";
import { CAPABILITY_PERSIST_RUN_STATE, CAPABILITY_LIST_ACTIVE_RUNS, CAPABILITY_GET_RUN } from "./contract.js";

/** Records every RPC the manager makes; canned responses for the store reads. */
class FakeBackend implements RunStateBackend {
  calls: Array<{ method: string; params: any }> = [];
  activeRuns: any[] = [];
  getRunRow: any = null;
  failPersist = false;
  async request(method: string, params?: unknown): Promise<any> {
    this.calls.push({ method, params });
    if (method === CAPABILITY_PERSIST_RUN_STATE && this.failPersist) throw new Error("ws down");
    if (method === CAPABILITY_LIST_ACTIVE_RUNS) return { runs: this.activeRuns };
    if (method === CAPABILITY_GET_RUN) return this.getRunRow;
    return { ok: true };
  }
  persists() {
    return this.calls.filter((c) => c.method === CAPABILITY_PERSIST_RUN_STATE);
  }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("CapabilityRunManager", () => {
  it("startRun mints an id, tracks it, and persists a running state", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1", correlationId: "attempt-1" });

    expect(rec.runId).toBeTruthy();
    expect(rec.status).toBe("running");
    expect(mgr.get(rec.runId)).toBe(rec);
    const p = be.persists();
    expect(p).toHaveLength(1);
    expect(p[0].params).toMatchObject({
      run_id: rec.runId, profile: "kb-compile", org_id: "o1",
      correlation_id: "attempt-1", status: "running",
    });
    // The persist payload IS the wire shape — exact snake_case key set, nothing
    // extra, nothing camelCase (contract.ts WIRE RULE; Go reads these keys).
    expect(Object.keys(p[0].params).sort()).toEqual([
      "correlation_id", "org_id", "profile", "run_id", "runtime_id", "session_ref", "status",
    ]);
  });

  it("setSessionRef + setStatus persist each transition", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    await mgr.setSessionRef(runId, "sess-9");
    await mgr.setStatus(runId, "idle");
    expect(mgr.get(runId)?.sessionRef).toBe("sess-9");
    expect(mgr.get(runId)?.status).toBe("idle");
    // running(start) + sessionRef + idle = 3 persists.
    expect(be.persists()).toHaveLength(3);
    expect(be.persists().at(-1)?.params).toMatchObject({ session_ref: "sess-9", status: "idle" });
  });

  it("endRun persists the terminal state then drops the run from the live map", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    await mgr.endRun(runId, "done");
    expect(mgr.get(runId)).toBeUndefined();
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: runId, status: "done" });
  });

  it("recover rebuilds the in-memory map from the consumer's active runs", async () => {
    const be = new FakeBackend();
    be.activeRuns = [
      { id: "r1", profile: "kb-compile", org_id: "o1", correlation_id: "a1", status: "running", session_ref: "s1" },
      { id: "r2", profile: "kb-test", org_id: "o2", status: "idle" },
    ];
    const mgr = new CapabilityRunManager(be);
    const n = await mgr.recover();
    expect(n).toBe(2);
    expect(mgr.get("r1")).toMatchObject({ profile: "kb-compile", orgId: "o1", correlationId: "a1", sessionRef: "s1" });
    expect(mgr.get("r2")?.status).toBe("idle");
  });

  it("adopt re-registers a non-terminal run the store knows but memory lost", async () => {
    const be = new FakeBackend();
    be.getRunRow = { id: "r9", profile: "kb-test", org_id: "o1", correlation_id: "a9", status: "idle" };
    const mgr = new CapabilityRunManager(be);

    const rec = await mgr.adopt("r9");
    expect(rec).toMatchObject({ runId: "r9", profile: "kb-test", orgId: "o1", correlationId: "a9", status: "idle" });
    expect(mgr.get("r9")).toBe(rec);
    // The store read uses the contract request shape.
    expect(be.calls.find((c) => c.method === CAPABILITY_GET_RUN)?.params).toEqual({ run_id: "r9" });
  });

  it("adopt refuses terminal and unknown runs (no unmanaged resurrection)", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);

    be.getRunRow = { id: "r-done", profile: "kb-compile", status: "done" };
    expect(await mgr.adopt("r-done")).toBeUndefined();
    expect(mgr.get("r-done")).toBeUndefined();

    be.getRunRow = null;
    expect(await mgr.adopt("r-nope")).toBeUndefined();
  });

  it("recover is best-effort — a backend failure yields 0, not a throw", async () => {
    const be = new FakeBackend();
    be.request = vi.fn().mockRejectedValue(new Error("ws down"));
    const mgr = new CapabilityRunManager(be);
    await expect(mgr.recover()).resolves.toBe(0);
  });

  it("reapStale fails only non-terminal runs idle past staleMs", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500 });

    const fresh = await mgr.startRun({ profile: "kb-compile", orgId: "o1" }); // active at t=1000
    clock = 2000; // 1000ms later → past staleMs(500)
    const reaped = await mgr.reapStale();

    expect(reaped).toEqual([fresh.runId]);
    expect(mgr.get(fresh.runId)).toBeUndefined(); // ended → dropped
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: fresh.runId, status: "failed" });
  });

  it("reapStale spares a run that was recently touched", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500 });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    clock = 2000;
    mgr.touch(rec.runId); // activity at t=2000
    clock = 2200; // only 200ms since touch < staleMs(500)
    expect(await mgr.reapStale()).toEqual([]);
    expect(mgr.get(rec.runId)).toBeDefined();
  });

  it("reapStale stops the box via onReap before failing the run; an onReap error doesn't block the reap", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const seen: string[] = [];
    const onReap = vi.fn(async (rec: any) => {
      // At reap time the run is still known + non-terminal (box stop precedes the failed mark).
      seen.push(rec.status);
      throw new Error("stop failed");
    });
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, onReap });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    clock = 2000;
    await mgr.reapStale();
    expect(onReap).toHaveBeenCalledTimes(1);
    expect(onReap.mock.calls[0][0].runId).toBe(rec.runId);
    expect(seen).toEqual(["running"]);
    expect(mgr.get(rec.runId)).toBeUndefined(); // reaped despite onReap throwing
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: rec.runId, status: "failed" });
  });

  it("recover never clobbers a run already in memory (staleness clock survives ticks)", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500 });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" }); // lastActivity = 1000
    be.activeRuns = [{ id: rec.runId, profile: "kb-compile", org_id: "o1", status: "running" }];

    clock = 1400; // recover at t=1400 must NOT reset the run's activity to now
    expect(await mgr.recover()).toBe(0);
    expect(mgr.get(rec.runId)).toBe(rec);
    expect(rec.lastActivityMs).toBe(1000);
  });

  it("reconcile adopts store rows this runtime lost, then reaps them once stale", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const stopped: string[] = [];
    const mgr = new CapabilityRunManager(be, {
      now: () => clock,
      staleMs: 500,
      onReap: (rec) => void stopped.push(rec.runId),
    });
    be.activeRuns = [{ id: "r-zombie", profile: "kb-compile", org_id: "o1", status: "idle" }];

    await mgr.reconcile(); // adopts at t=1000 (fresh — not reaped this tick)
    expect(mgr.get("r-zombie")).toBeDefined();

    clock = 2000; // > staleMs later, still no activity
    await mgr.reconcile();
    expect(mgr.get("r-zombie")).toBeUndefined();
    expect(stopped).toEqual(["r-zombie"]);
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: "r-zombie", status: "failed" });
  });

  it("startRun fails closed on persist failure — no run without a store row", async () => {
    const be = new FakeBackend();
    be.failPersist = true;
    const mgr = new CapabilityRunManager(be);
    await expect(mgr.startRun({ profile: "kb-compile", orgId: "o1" })).rejects.toThrow("ws down");
    // The map stays clean: nothing to drive, nothing for the watchdog.
    expect((mgr as any).runs.size).toBe(0);
  });

  it("setStatus swallows a persist failure (memory is the authority; reconcile heals the store)", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    be.failPersist = true;
    await expect(mgr.setStatus(runId, "idle")).resolves.toBeUndefined(); // no throw
    expect(mgr.get(runId)?.status).toBe("idle"); // memory advanced
  });

  it("endRun keeps the terminal record until flushTerminal lands it — 'done' stays done", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    be.failPersist = true;
    await mgr.endRun(runId, "done");
    expect(mgr.get(runId)?.status).toBe("done"); // retained for retry, not dropped

    be.failPersist = false;
    await mgr.reconcile(); // flushTerminal retries the SAME terminal status
    expect(mgr.get(runId)).toBeUndefined();
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: runId, status: "done" });
  });
});
