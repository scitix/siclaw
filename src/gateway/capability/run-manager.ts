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

import type { CapabilityLifecycleStatus, CapabilityRunState } from "./contract.js";
import { CAPABILITY_PERSIST_RUN_STATE, CAPABILITY_LIST_ACTIVE_RUNS } from "./contract.js";

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

const TERMINAL: CapabilityLifecycleStatus[] = ["done", "failed"];

export interface CapabilityRunManagerOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** A run with no activity for this long while non-terminal is reaped as failed. */
  staleMs?: number;
  /** Watchdog tick interval. */
  watchdogIntervalMs?: number;
}

export class CapabilityRunManager {
  private runs = new Map<string, CapabilityRunRecord>();
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly watchdogIntervalMs: number;
  private watchdogTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly backend: RunStateBackend,
    opts: CapabilityRunManagerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 10 * 60_000; // 10 min
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? 60_000; // 1 min
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
    this.runs.set(rec.runId, rec);
    await this.persist(rec);
    return rec;
  }

  get(runId: string): CapabilityRunRecord | undefined {
    return this.runs.get(runId);
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
   * the live map so the watchdog + recovery ignore it.
   */
  async endRun(runId: string, status: "done" | "failed"): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.status = status;
    rec.lastActivityMs = this.now();
    await this.persist(rec);
    this.runs.delete(runId);
  }

  /**
   * On boot, rebuild the in-memory map from the consumer's store so a restarted
   * runtime knows about in-flight runs (the watchdog can then reap ones whose box
   * died during the downtime). Best-effort: a backend error is logged, not fatal.
   */
  async recover(): Promise<number> {
    try {
      const res = await this.backend.request(CAPABILITY_LIST_ACTIVE_RUNS, {});
      const rows: any[] = res?.runs ?? [];
      let n = 0;
      for (const r of rows) {
        const runId = r.id ?? r.runId;
        if (!runId) continue;
        this.runs.set(runId, {
          runId,
          profile: r.profile ?? "",
          orgId: r.org_id ?? r.orgId ?? "",
          correlationId: r.correlation_id ?? r.correlationId,
          runtimeId: r.runtime_id ?? r.runtimeId,
          sessionRef: r.session_ref ?? r.sessionRef,
          status: (r.status as CapabilityLifecycleStatus) || "running",
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

  /** Reap non-terminal runs idle longer than staleMs (mark failed + persist). */
  async reapStale(): Promise<string[]> {
    const cutoff = this.now() - this.staleMs;
    const reaped: string[] = [];
    for (const rec of [...this.runs.values()]) {
      if (!TERMINAL.includes(rec.status) && rec.lastActivityMs < cutoff) {
        reaped.push(rec.runId);
      }
    }
    for (const runId of reaped) {
      console.warn(`[capability] watchdog reaping stale run ${runId}`);
      await this.endRun(runId, "failed");
    }
    return reaped;
  }

  startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.reapStale();
    }, this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private async persist(rec: CapabilityRunRecord): Promise<void> {
    const state: CapabilityRunState = {
      runId: rec.runId,
      orgId: rec.orgId,
      correlationId: rec.correlationId,
      profile: rec.profile,
      status: rec.status,
      sessionRef: rec.sessionRef,
      runtimeId: rec.runtimeId,
    };
    // Wire field names match the Go handler (snake_case).
    await this.backend.request(CAPABILITY_PERSIST_RUN_STATE, {
      run_id: state.runId,
      org_id: state.orgId ?? "",
      correlation_id: state.correlationId ?? "",
      profile: state.profile,
      status: state.status,
      session_ref: state.sessionRef ?? "",
      runtime_id: state.runtimeId ?? "",
    });
  }
}
