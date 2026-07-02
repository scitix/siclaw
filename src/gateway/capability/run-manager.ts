/**
 * CapabilityRunManager — siclaw's ownership of a capability run's EXECUTION
 * lifecycle (option B, 2026-07-01).
 *
 * The runtime is stateless (no DB of its own), so this manager holds runs
 * in-memory AND persists each transition to the consumer's opaque store via
 * `capability.persistRunState`. On boot it recovers in-flight runs via
 * `capability.listActiveRuns`, and a watchdog fails runs that went stale without
 * a terminal signal — the same durability the sicore compile state machine gave,
 * but now OWNED BY SICLAW with the consumer as a dumb backing store.
 *
 * ⚠️ B2a: this is the run-lifecycle + persistence core. Box spawning/driving and
 * the capability.start/message/cancel handlers live in server.ts and use this
 * manager; the event-protocol rename (→ capability.event) is B2b.
 */

import type {
  CapabilityGetRunRequest,
  CapabilityLifecycleStatus,
  CapabilityListActiveRunsResponse,
  CapabilityRunRow,
  CapabilityRunState,
  CapabilityTerminalStatus,
} from "./contract.js";
import {
  CAPABILITY_GET_RUN,
  CAPABILITY_PERSIST_RUN_STATE,
  CAPABILITY_LIST_ACTIVE_RUNS,
  isTerminalCapabilityStatus,
} from "./contract.js";

/** Just the RPC surface the manager needs (so tests can pass a fake). */
export interface RunStateBackend {
  request(method: string, params?: unknown): Promise<any>;
}

export interface CapabilityRunRecord {
  runId: string;
  profile: string;
  orgId: string;
  correlationId?: string;
  status: CapabilityLifecycleStatus;
  sessionRef?: string;
  runtimeId?: string;
  /** Wall-clock ms of the last activity; drives the stale-run watchdog. */
  lastActivityMs: number;
}

export interface CapabilityRunManagerOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** A run with no activity for this long while non-terminal is reaped as failed. */
  staleMs?: number;
  /** Watchdog tick interval. */
  watchdogIntervalMs?: number;
  /**
   * Invoked for each run the watchdog reaps, BEFORE it is marked failed — the
   * place to stop the run's box so a reaped run never leaves an orphan pod
   * running behind a store row that says "failed". Errors are logged, not fatal.
   */
  onReap?: (rec: CapabilityRunRecord) => Promise<void> | void;
}

export class CapabilityRunManager {
  private runs = new Map<string, CapabilityRunRecord>();
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly onReap?: (rec: CapabilityRunRecord) => Promise<void> | void;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private reconciling = false;

  constructor(
    private readonly backend: RunStateBackend,
    opts: CapabilityRunManagerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 10 * 60_000; // 10 min
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? 60_000; // 1 min
    this.onReap = opts.onReap;
  }

  /** siclaw mints the run id (the consumer never does — option B). */
  mintRunId(): string {
    return crypto.randomUUID();
  }

  /** Create + persist a new run (status "running"). Returns the record. */
  async startRun(p: {
    profile: string;
    orgId: string;
    correlationId?: string;
    runtimeId?: string;
    runId?: string; // caller may supply one (else minted)
  }): Promise<CapabilityRunRecord> {
    const rec: CapabilityRunRecord = {
      runId: p.runId ?? this.mintRunId(),
      profile: p.profile,
      orgId: p.orgId,
      correlationId: p.correlationId,
      runtimeId: p.runtimeId,
      status: "running",
      lastActivityMs: this.now(),
    };
    // Persist BEFORE registering: a run must not exist without its store row
    // (start is the one transition that fails closed — see persist()).
    await this.persist(rec, { failFast: true });
    this.runs.set(rec.runId, rec);
    return rec;
  }

  get(runId: string): CapabilityRunRecord | undefined {
    return this.runs.get(runId);
  }

  /**
   * Adopt a run this runtime doesn't hold in memory by reading it back from the
   * consumer's store — heals the drift where boot-time recovery missed it (e.g.
   * the consumer wasn't ready yet). Only non-terminal runs are adopted; returns
   * undefined when the store doesn't know the run or it already ended, so the
   * caller can refuse instead of spawning an unmanaged box.
   */
  async adopt(runId: string): Promise<CapabilityRunRecord | undefined> {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    try {
      const req: CapabilityGetRunRequest = { run_id: runId };
      const row = (await this.backend.request(CAPABILITY_GET_RUN, req)) as CapabilityRunRow | null;
      if (!row?.id) return undefined;
      const status: CapabilityLifecycleStatus = row.status || "running";
      if (isTerminalCapabilityStatus(status)) return undefined;
      const rec: CapabilityRunRecord = {
        runId: row.id,
        profile: row.profile ?? "",
        orgId: row.org_id ?? "",
        correlationId: row.correlation_id || undefined,
        runtimeId: row.runtime_id || undefined,
        sessionRef: row.session_ref || undefined,
        status,
        lastActivityMs: this.now(),
      };
      this.runs.set(rec.runId, rec);
      console.log(`[capability] adopted run ${runId} from the consumer store (missed by boot recovery)`);
      return rec;
    } catch (err) {
      console.warn(`[capability] adopt(${runId}) failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Bump last-activity so the watchdog doesn't reap an actively-used run. */
  touch(runId: string): void {
    const rec = this.runs.get(runId);
    if (rec) rec.lastActivityMs = this.now();
  }

  /** Record the box session id (for resume) + persist. */
  async setSessionRef(runId: string, sessionRef: string): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.sessionRef = sessionRef;
    rec.lastActivityMs = this.now();
    await this.persist(rec);
  }

  /** Move a live run to idle/running (non-terminal) + persist. */
  async setStatus(runId: string, status: CapabilityLifecycleStatus): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.status = status;
    rec.lastActivityMs = this.now();
    await this.persist(rec);
  }

  /**
   * Terminate a run (done/failed): persist the terminal state, then drop it from
   * the live map so the watchdog + recovery ignore it. When the terminal persist
   * fails, the record STAYS in memory with its terminal status — the reconcile
   * loop retries the same terminal write (flushTerminal) until it lands, so the
   * store converges to the true outcome instead of a later blanket "failed".
   */
  async endRun(runId: string, status: CapabilityTerminalStatus): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.status = status;
    rec.lastActivityMs = this.now();
    try {
      await this.persist(rec, { failFast: true });
      this.runs.delete(runId);
    } catch (err) {
      console.warn(
        `[capability] terminal persist(${runId} → ${status}) failed; reconcile will retry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Rebuild the in-memory map from the consumer's store — at boot AND on every
   * watchdog tick (so a listing the consumer wasn't ready to serve at boot, or a
   * run this runtime lost track of, is picked up later instead of living forever
   * as an "active" store row nobody reaps). Runs already tracked are left alone:
   * clobbering them would reset their staleness clock every tick and blind the
   * watchdog. Best-effort: a backend error is logged, not fatal.
   */
  async recover(): Promise<number> {
    try {
      const res = (await this.backend.request(CAPABILITY_LIST_ACTIVE_RUNS, {})) as CapabilityListActiveRunsResponse;
      const rows = res?.runs ?? [];
      let n = 0;
      for (const r of rows) {
        // Store rows key the run id as `id` (the consumer's DB primary key) —
        // see CapabilityRunRow in contract.ts.
        if (!r.id || this.runs.has(r.id)) continue;
        this.runs.set(r.id, {
          runId: r.id,
          profile: r.profile ?? "",
          orgId: r.org_id ?? "",
          correlationId: r.correlation_id || undefined,
          runtimeId: r.runtime_id || undefined,
          sessionRef: r.session_ref || undefined,
          status: r.status || "running",
          lastActivityMs: this.now(),
        });
        n++;
      }
      return n;
    } catch (err) {
      console.warn(`[capability] run recovery skipped: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** Reap non-terminal runs idle longer than staleMs (stop box, mark failed + persist). */
  async reapStale(): Promise<string[]> {
    const cutoff = this.now() - this.staleMs;
    const reaped: string[] = [];
    for (const rec of [...this.runs.values()]) {
      if (!isTerminalCapabilityStatus(rec.status) && rec.lastActivityMs < cutoff) {
        reaped.push(rec.runId);
      }
    }
    for (const runId of reaped) {
      console.warn(`[capability] watchdog reaping stale run ${runId}`);
      const rec = this.runs.get(runId);
      if (rec && this.onReap) {
        // Stop the run's box BEFORE declaring it failed, so the store never says
        // "failed" while an orphan pod keeps working behind its back.
        try {
          await this.onReap(rec);
        } catch (err) {
          console.warn(`[capability] onReap(${runId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await this.endRun(runId, "failed");
    }
    return reaped;
  }

  /**
   * One watchdog tick: retry unflushed terminal writes, adopt store rows we lost
   * track of, then reap the stale.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.flushTerminal();
      await this.recover();
      await this.reapStale();
    } finally {
      this.reconciling = false;
    }
  }

  /** Retry terminal states whose persist failed at endRun time (keeps "done" done). */
  private async flushTerminal(): Promise<void> {
    for (const rec of [...this.runs.values()]) {
      if (!isTerminalCapabilityStatus(rec.status)) continue;
      try {
        await this.persist(rec, { failFast: true });
        this.runs.delete(rec.runId);
      } catch {
        // still unreachable — keep for the next tick
      }
    }
  }

  startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.reconcile();
    }, this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Write the run row to the consumer's store. The in-memory record is the
   * runtime's authority (option B — the store is a dumb mirror), so transitions
   * of an EXISTING run swallow a persist failure with a warning: a transient WS
   * blip must not fail a healthy run, and the reconcile loop re-converges the
   * store. The one exception is `failFast` (startRun): a run must not come into
   * existence without its store row, so start fails closed.
   */
  private async persist(rec: CapabilityRunRecord, opts?: { failFast?: boolean }): Promise<void> {
    // The contract type IS the wire shape (snake_case) — see contract.ts WIRE RULE.
    const state: CapabilityRunState = {
      run_id: rec.runId,
      org_id: rec.orgId ?? "",
      correlation_id: rec.correlationId ?? "",
      profile: rec.profile,
      status: rec.status,
      session_ref: rec.sessionRef ?? "",
      runtime_id: rec.runtimeId ?? "",
    };
    try {
      await this.backend.request(CAPABILITY_PERSIST_RUN_STATE, state);
    } catch (err) {
      if (opts?.failFast) throw err;
      console.warn(
        `[capability] persistRunState(${rec.runId} → ${rec.status}) failed (kept in memory; reconcile heals the store): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
