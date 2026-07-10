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
  it("startRun initialStatus idle — a hosting-only run is a conversation at rest, not a stuck turn", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1", initialStatus: "idle" });
    expect(rec.status).toBe("idle");
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: rec.runId, status: "idle" });
    // The first real turn flips it running, exactly like any at-rest run.
    await mgr.setStatus(rec.runId, "running");
    expect(mgr.get(rec.runId)?.status).toBe("running");
  });

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

  it("setStatus persists the transition", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    await mgr.setStatus(runId, "idle");
    expect(mgr.get(runId)?.status).toBe("idle");
    // running(start) + idle = 2 persists.
    expect(be.persists()).toHaveLength(2);
    expect(be.persists().at(-1)?.params).toMatchObject({ status: "idle" });
  });

  it("checkpoints the installed input revision and restores it after restart", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    await mgr.setInputRevision(runId, "manifest-1");
    expect(mgr.get(runId)?.inputRevision).toBe("manifest-1");
    expect(be.persists().at(-1)?.params).toMatchObject({
      checkpoint: { input_revision: "manifest-1" },
    });

    const recoveredBackend = new FakeBackend();
    recoveredBackend.activeRuns = [{
      id: runId,
      profile: "kb-compile",
      org_id: "o1",
      status: "running",
      checkpoint: JSON.stringify({ input_revision: "manifest-1" }),
    }];
    const recovered = new CapabilityRunManager(recoveredBackend);
    await recovered.recover();
    expect(recovered.get(runId)?.inputRevision).toBe("manifest-1");
  });

  it("fails closed when the installed input revision cannot be checkpointed", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });
    be.failPersist = true;
    await expect(mgr.setInputRevision(runId, "manifest-1")).rejects.toThrow("ws down");
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
    expect(mgr.get("r1")).toMatchObject({ profile: "kb-compile", orgId: "o1", correlationId: "a1" });
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

  it("two-clock: heartbeats bridge a data-silent phase up to dataStaleMs", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, dataStaleMs: 5000 });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" }); // data+hb at t=1000

    // Data silent past staleMs (a long read-only compile phase), but heartbeats
    // keep arriving → NOT reaped, because data silence is still < dataStaleMs.
    clock = 2000;
    mgr.touchHeartbeat(rec.runId); // heartbeat at 2000; last DATA still 1000
    clock = 2200; // data silent 1200ms (> staleMs 500) but heartbeat only 200ms ago
    expect(await mgr.reapStale()).toEqual([]);
    expect(mgr.get(rec.runId)).toBeDefined();
  });

  it("two-clock: a box that ONLY heartbeats is reaped at dataStaleMs (no wedged-turn immortality)", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, dataStaleMs: 5000 });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" }); // last DATA at 1000

    // Heartbeats keep firing but no DATA ever comes again.
    for (const t of [2000, 3000, 4000, 5000, 6000]) {
      clock = t;
      mgr.touchHeartbeat(rec.runId);
    }
    clock = 6001; // data silent 5001ms > dataStaleMs(5000), despite a fresh heartbeat
    expect(await mgr.reapStale()).toEqual([rec.runId]);
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: rec.runId, status: "failed" });
  });

  it("two-clock: a fully silent box (no data, no heartbeat) is reaped at staleMs", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, dataStaleMs: 5000 });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    clock = 1600; // 600ms since last data AND last heartbeat: > staleMs(500), < dataStaleMs
    expect(await mgr.reapStale()).toEqual([rec.runId]);
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: rec.runId, status: "failed" });
  });

  it("two-clock invariant: dataStaleMs below staleMs is clamped up (heartbeat bridge never silently disabled)", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    // Misconfigured: dataStaleMs(100) < staleMs(500). Unclamped, the data clock
    // would reap at +100ms of data silence and the heartbeat bridge would never matter.
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, dataStaleMs: 100 });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" }); // data+hb at 1000

    clock = 1300;
    mgr.touchHeartbeat(rec.runId); // heartbeat fresh; data silent 300ms > misconfigured 100
    clock = 1350;
    expect(await mgr.reapStale()).toEqual([]); // clamped to staleMs(500) → still alive
    clock = 1600; // data silent 600ms > clamped dataStaleMs(500) → reaped, heartbeats or not
    expect(await mgr.reapStale()).toEqual([rec.runId]);
  });

  it("two-clock: a non-positive CAPABILITY_DATA_STALE_MS env falls back to the default instead of 0", async () => {
    process.env.CAPABILITY_DATA_STALE_MS = "0";
    try {
      const be = new FakeBackend();
      let clock = 1000;
      const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500 }); // dataStaleMs from env
      const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

      clock = 1800;
      mgr.touchHeartbeat(rec.runId); // data silent 800ms; an honored env 0 would mean instant data-stale
      clock = 1900;
      expect(await mgr.reapStale()).toEqual([]); // default 60min in force, heartbeat bridges
    } finally {
      delete process.env.CAPABILITY_DATA_STALE_MS;
    }
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
    // status running = the row was lost mid-turn; the strict staleMs tier applies.
    be.activeRuns = [{ id: "r-zombie", profile: "kb-compile", org_id: "o1", status: "running" }];

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

  it("tiered TTLs: a resting idle run outlives staleMs and closes as done at idleTtl", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const stopped: string[] = [];
    const mgr = new CapabilityRunManager(be, {
      now: () => clock,
      staleMs: 500,
      idleTtlMs: 5000,
      onReap: (rec) => void stopped.push(rec.runId),
    });
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });
    await mgr.setStatus(runId, "idle"); // turn finished — conversation at rest

    clock = 3000; // way past staleMs(500) but inside idleTtl(5000)
    expect(await mgr.reapStale()).toEqual([]); // idle is NOT a wedged turn
    expect(mgr.get(runId)).toBeDefined();

    clock = 7000; // past idleTtl
    expect(await mgr.reapStale()).toEqual([runId]);
    expect(stopped).toEqual([runId]); // box still stopped (resource hygiene)
    // ...but the outcome is a normal session end, not a failure.
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: runId, status: "done" });
  });

  it("onAdopt fires once per NEWLY adopted run — never for runs already tracked", async () => {
    const be = new FakeBackend();
    const adopted: string[] = [];
    const mgr = new CapabilityRunManager(be, { onAdopt: (rec) => void adopted.push(rec.runId) });
    const mine = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    be.activeRuns = [
      { id: mine.runId, profile: "kb-compile", org_id: "o1", status: "running" }, // already tracked
      { id: "r-lost", profile: "kb-compile", org_id: "o1", status: "idle" }, // lost during restart
    ];
    await mgr.recover();
    expect(adopted).toEqual(["r-lost"]);

    be.getRunRow = { id: "r-solo", profile: "kb-compile", org_id: "o1", status: "idle" };
    await mgr.adopt("r-solo");
    expect(adopted).toEqual(["r-lost", "r-solo"]);
    await mgr.adopt("r-solo"); // second adopt = already tracked, no re-fire
    expect(adopted).toEqual(["r-lost", "r-solo"]);
  });

  it("reapStale silently forgets a resurrection artifact whose store row is already terminal", async () => {
    // recover()'s listing is a snapshot: a run that ended while the listing was
    // in flight can re-enter the map as non-terminal. The reap must re-check the
    // store and drop it — no box stop, no failed overwrite of a done outcome.
    const be = new FakeBackend();
    let clock = 1000;
    const onReap = vi.fn();
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, onReap });
    be.activeRuns = [{ id: "r-ghost", profile: "kb-compile", org_id: "o1", status: "running" }];
    await mgr.recover(); // resurrects the ghost (stale snapshot)
    be.getRunRow = { id: "r-ghost", profile: "kb-compile", status: "done" }; // store truth

    clock = 2000;
    const reaped = await mgr.reapStale();
    expect(reaped).toEqual([]); // dropped, not reaped
    expect(mgr.get("r-ghost")).toBeUndefined();
    expect(onReap).not.toHaveBeenCalled(); // its box was never stopped
    expect(be.persists()).toHaveLength(0); // and done was never overwritten
  });

  it("reapStale spares a run touched DURING the store re-check await (finding A)", async () => {
    // A message landing in the getRun window bumps lastActivityMs. The post-await
    // freshness re-derive must see it fresh again and skip — no box stop, no
    // failed mark on a live run.
    const be = new FakeBackend();
    let clock = 1000;
    const onReap = vi.fn();
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, onReap });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" }); // lastActivity=1000
    be.getRunRow = { id: rec.runId, profile: "kb-compile", status: "running" }; // non-terminal
    // Simulate a capability.message arriving during the getRun round-trip.
    const orig = be.request.bind(be);
    be.request = async (method: string, params?: unknown) => {
      if (method === CAPABILITY_GET_RUN) mgr.touch(rec.runId); // fresh at clock=2000
      return orig(method, params);
    };
    clock = 2000; // snapshot sees it stale (2000-1000 > 500)…

    const reaped = await mgr.reapStale();
    expect(reaped).toEqual([]); // …but the re-derive after getRun sees it fresh
    expect(onReap).not.toHaveBeenCalled();
    expect(mgr.get(rec.runId)?.status).toBe("running"); // not failed
  });

  it("reapStale defers (never reaps) when the store is unreachable during the re-check (finding B)", async () => {
    // A resurrection artifact that is `done` in the store must not be overwritten
    // to failed while the store is down — the reap is deferred to a later tick.
    const be = new FakeBackend();
    let clock = 1000;
    const onReap = vi.fn();
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, onReap });
    be.activeRuns = [{ id: "r-ghost", profile: "kb-compile", org_id: "o1", status: "running" }];
    await mgr.recover(); // resurrects the ghost (its store row is really `done`)
    // Store unreachable for the GET_RUN re-check.
    const orig = be.request.bind(be);
    be.request = async (method: string, params?: unknown) => {
      if (method === CAPABILITY_GET_RUN) throw new Error("store down");
      return orig(method, params);
    };
    clock = 2000;

    const reaped = await mgr.reapStale();
    expect(reaped).toEqual([]); // deferred, not reaped
    expect(onReap).not.toHaveBeenCalled(); // box not stopped
    expect(be.persists()).toHaveLength(0); // no failed persist → done not clobbered
    expect(mgr.get("r-ghost")?.status).toBe("running"); // still held for the next tick
  });

  it("reapStale gives up deferring after repeated re-check failures and reaps a poison row (bounded give-up)", async () => {
    // A PERMANENT per-run getRun throw (a store row that never deserializes) must
    // not defer forever and pin its box — after MAX_REAP_DEFERRALS the reap proceeds.
    const be = new FakeBackend();
    let clock = 1000;
    const onReap = vi.fn();
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500, onReap });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });
    const orig = be.request.bind(be);
    be.request = async (method: string, params?: unknown) => {
      if (method === CAPABILITY_GET_RUN) throw new Error("poison row"); // permanent per-run failure
      return orig(method, params);
    };
    clock = 2000; // stale

    // The first four ticks defer (< MAX_REAP_DEFERRALS = 5); the fifth gives up and reaps.
    for (let i = 0; i < 4; i++) expect(await mgr.reapStale()).toEqual([]);
    expect(onReap).not.toHaveBeenCalled();
    const reaped = await mgr.reapStale();
    expect(reaped).toEqual([rec.runId]);
    expect(onReap).toHaveBeenCalledTimes(1);
    expect(mgr.get(rec.runId)).toBeUndefined(); // reaped → dropped
  });

  it("a successful re-check clears the give-up counter (a transient outage doesn't accrue)", async () => {
    const be = new FakeBackend();
    let clock = 1000;
    const mgr = new CapabilityRunManager(be, { now: () => clock, staleMs: 500 });
    const rec = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });
    let throwGet = true;
    const orig = be.request.bind(be);
    be.request = async (method: string, params?: unknown) => {
      if (method === CAPABILITY_GET_RUN) {
        if (throwGet) throw new Error("transient outage");
        return { id: rec.runId, profile: "kb-compile", status: "running" }; // non-terminal
      }
      return orig(method, params);
    };
    clock = 2000;
    // Three failing ticks (defer), then the store recovers → counter resets, and
    // a message keeps the run fresh so it's never wrongly reaped.
    for (let i = 0; i < 3; i++) expect(await mgr.reapStale()).toEqual([]);
    throwGet = false;
    mgr.touch(rec.runId); // fresh again on the recovered tick
    expect(await mgr.reapStale()).toEqual([]); // re-check succeeds, run is fresh → spared, counter cleared
    // Now fail again: it must take a FULL MAX_REAP_DEFERRALS run, not carry the old 3.
    throwGet = true;
    clock = 4000; // stale once more
    for (let i = 0; i < 4; i++) expect(await mgr.reapStale()).toEqual([]);
    expect(await mgr.reapStale()).toEqual([rec.runId]); // 5th consecutive failure reaps
  });

  it("endRun is terminal-sticky — the first outcome wins", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    be.failPersist = true;
    await mgr.endRun(runId, "done"); // terminal reached in memory, persist pending
    be.failPersist = false;
    await mgr.endRun(runId, "failed"); // e.g. the relay's error catch racing in
    expect(mgr.get(runId)?.status).toBe("done"); // not overwritten

    await mgr.reconcile(); // flushTerminal retries the ORIGINAL outcome
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: runId, status: "done" });
  });

  it("setStatus is terminal-sticky — a racing message cannot resurrect a retained terminal record", async () => {
    const be = new FakeBackend();
    const mgr = new CapabilityRunManager(be);
    const { runId } = await mgr.startRun({ profile: "kb-compile", orgId: "o1" });

    be.failPersist = true;
    await mgr.endRun(runId, "done"); // terminal reached in memory, persist pending
    be.failPersist = false;
    // capability.message's post-/message setStatus("running") landing after the
    // terminal: without the guard this flipped the record non-terminal, hid it
    // from flushTerminal, and the watchdog later degraded the outcome to failed.
    await mgr.setStatus(runId, "running");
    expect(mgr.get(runId)?.status).toBe("done"); // not resurrected

    await mgr.reconcile(); // flushTerminal still sees the terminal record and lands it
    expect(mgr.get(runId)).toBeUndefined();
    expect(be.persists().at(-1)?.params).toMatchObject({ run_id: runId, status: "done" });
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
