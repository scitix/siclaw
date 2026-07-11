/**
 * CapabilityRunManager — siclaw's ownership of a capability run's EXECUTION
 * lifecycle (option B, 2026-07-01).
 *
 * The runtime is stateless (no DB of its own), so this manager holds runs
 * in-memory AND persists each transition to the consumer's opaque store via
 * `capability.persistRunState`. On boot it recovers in-flight runs via
 * `capability.listActiveRuns`, and a watchdog fails runs that went stale without
 * a terminal signal — the same durability the consumer's compile state machine gave,
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
  runtimeId?: string;
  /** Frozen consumer input installed into this run's box. */
  inputRevision?: string;
  /** Recent consumer turn ids durably accepted by this run (retry dedupe). */
  messageIds: string[];
  /** Recent typed commands durably accepted by this run (id + payload digest). */
  commandReceipts: CapabilityCommandReceipt[];
  /** Wall-clock ms of the last DATA event; drives the stale-run watchdog. */
  lastActivityMs: number;
  /**
   * Wall-clock ms of the last liveness signal that is NOT a data event — the
   * box's `: heartbeat` SSE comments. Tracked separately from lastActivityMs so
   * a box that only heartbeats (a wedged turn) cannot stay alive forever:
   * heartbeats bridge a data-silent phase up to dataStaleMs, but data silence
   * past dataStaleMs is reaped regardless of heartbeats.
   */
  lastHeartbeatMs: number;
}

export interface CapabilityRunManagerOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * A RUNNING run with NO liveness at all (neither data nor heartbeat) for this
   * long is a dead box — reaped as failed. Heartbeats bridge this window.
   */
  staleMs?: number;
  /**
   * A RUNNING run with no DATA event for this long is reaped as failed EVEN IF
   * heartbeats keep arriving — a box that only heartbeats is a wedged turn, not
   * a healthy long read-only phase. Defaults to 60 min (env
   * CAPABILITY_DATA_STALE_MS); must be ≥ staleMs to give heartbeats room to work.
   */
  dataStaleMs?: number;
  /**
   * An IDLE run (conversation at rest) is kept warm this long, then closed as
   * "done" — inactivity is a normal session end, not a failure. Defaults to 2h.
   */
  idleTtlMs?: number;
  /** Watchdog tick interval. */
  watchdogIntervalMs?: number;
  /**
   * Invoked for each run the watchdog reaps, BEFORE its terminal mark — the
   * place to stop the run's box so a reaped run never leaves an orphan pod
   * running behind a terminal store row. Errors are logged, not fatal.
   */
  onReap?: (rec: CapabilityRunRecord) => Promise<void> | void;
  /**
   * Invoked for each run recover()/adopt() newly registers from the consumer's
   * store — the place to re-attach the event relay to a still-alive box so a
   * runtime restart doesn't leave a working box deaf (its queued events replay
   * on re-attach) and stale-looking to the watchdog. Fire-and-forget.
   */
  onAdopt?: (rec: CapabilityRunRecord) => void;
}

// A run whose reap re-check (getRun) throws is deferred to a later tick — but a
// PERMANENT per-run throw (a poison store row that never deserializes) must not
// defer forever and pin its box. After this many consecutive failed re-checks we
// stop deferring and reap the run anyway.
const MAX_REAP_DEFERRALS = 5;
const INPUT_REVISION_PERSIST_ATTEMPTS = 4;
const INPUT_REVISION_RETRY_BASE_MS = 250;
const MAX_MESSAGE_IDS = 128;
const MAX_COMMAND_RECEIPTS = 128;

export interface CapabilityCommandReceipt {
  id: string;
  digest: string;
}

export class CapabilityRunManager {
  private runs = new Map<string, CapabilityRunRecord>();
  // runId → consecutive failed reap re-checks; cleared on a successful re-check.
  private reapDeferrals = new Map<string, number>();
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly dataStaleMs: number;
  private readonly idleTtlMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly onReap?: (rec: CapabilityRunRecord) => Promise<void> | void;
  private readonly onAdopt?: (rec: CapabilityRunRecord) => void;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private reconciling = false;

  constructor(
    private readonly backend: RunStateBackend,
    opts: CapabilityRunManagerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 10 * 60_000; // 10 min
    // Two-clock invariant: dataStaleMs >= staleMs, or the heartbeat bridge is
    // silently disabled (a run would be reaped by the data clock before the
    // heartbeat clock ever mattered). Clamp rather than trust the env; a
    // non-positive/garbage env value falls back to the 60 min default.
    const envDataStale = Number(process.env.CAPABILITY_DATA_STALE_MS);
    const rawDataStale = opts.dataStaleMs ??
      (Number.isFinite(envDataStale) && envDataStale > 0 ? envDataStale : 60 * 60_000); // 60 min
    this.dataStaleMs = Math.max(rawDataStale, this.staleMs);
    this.idleTtlMs = opts.idleTtlMs ?? 2 * 60 * 60_000; // 2 h
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? 60_000; // 1 min
    this.onReap = opts.onReap;
    this.onAdopt = opts.onAdopt;
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
    /**
     * Initial lifecycle status. "running" ONLY when a kickoff instruction will
     * drive an immediate turn; an instruction-less start (find-or-start for a
     * chat that follows via capability.message, or a run minted just to HOST
     * test sessions) is a conversation at rest — "idle". A hosting-only run
     * never gets a turn_done, so an initial "running" would stick forever:
     * consumers reading run status as "the draft is being updated" would gate
     * asks against a box that is just idling (seen live 07-08).
     */
    initialStatus?: "running" | "idle";
  }): Promise<CapabilityRunRecord> {
    const rec: CapabilityRunRecord = {
      runId: p.runId ?? this.mintRunId(),
      profile: p.profile,
      orgId: p.orgId,
      correlationId: p.correlationId,
      runtimeId: p.runtimeId,
      status: p.initialStatus ?? "running",
      messageIds: [],
      commandReceipts: [],
      lastActivityMs: this.now(),
      lastHeartbeatMs: this.now(),
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

  /** Current non-terminal runs, sampled by the gateway Prometheus endpoint. */
  activeCount(): number {
    let count = 0;
    for (const rec of this.runs.values()) {
      if (!isTerminalCapabilityStatus(rec.status)) count++;
    }
    return count;
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
        inputRevision: inputRevisionFromCheckpoint(row.checkpoint),
        messageIds: messageIdsFromCheckpoint(row.checkpoint),
        commandReceipts: commandReceiptsFromCheckpoint(row.checkpoint),
        status,
        lastActivityMs: this.now(),
        lastHeartbeatMs: this.now(),
      };
      this.runs.set(rec.runId, rec);
      console.log(`[capability] adopted run ${runId} from the consumer store (missed by boot recovery)`);
      this.onAdopt?.(rec);
      return rec;
    } catch (err) {
      console.warn(`[capability] adopt(${runId}) failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Checkpoint the exact input before the box session is allowed to run. */
  async setInputRevision(runId: string, inputRevision: string): Promise<void> {
    const rec = this.runs.get(runId);
    const revision = inputRevision.trim();
    if (!rec || !revision || rec.inputRevision === revision) return;
    const previousRevision = rec.inputRevision;
    rec.inputRevision = revision;
    try {
      for (let attempt = 1; attempt <= INPUT_REVISION_PERSIST_ATTEMPTS; attempt += 1) {
        try {
          await this.persist(rec, { failFast: true });
          return;
        } catch (err) {
          if (attempt === INPUT_REVISION_PERSIST_ATTEMPTS) throw err;
          const delayMs = INPUT_REVISION_RETRY_BASE_MS * 2 ** (attempt - 1);
          console.warn(
            `[capability] checkpoint input revision for ${runId} failed ` +
            `(attempt ${attempt}/${INPUT_REVISION_PERSIST_ATTEMPTS}); retrying in ${delayMs}ms: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } catch (err) {
      // Never retain an in-memory checkpoint the consumer did not durably ack.
      // A later session setup must retry instead of returning early on a value
      // that exists only in this process.
      rec.inputRevision = previousRevision;
      throw err;
    }
  }

  hasMessageId(runId: string, messageId: string): boolean {
    const id = messageId.trim();
    return id !== "" && (this.runs.get(runId)?.messageIds.includes(id) ?? false);
  }

  /**
   * Persist a turn id only AFTER the box accepted it. If this checkpoint write
   * fails, roll the in-memory mark back: the caller returns an error and retries
   * the same id; the box-level dedupe then turns that retry into a harmless ack.
   */
  async rememberMessageId(runId: string, messageId: string): Promise<void> {
    const rec = this.runs.get(runId);
    const id = messageId.trim();
    if (!rec || !id || rec.messageIds.includes(id)) return;
    const previous = rec.messageIds;
    rec.messageIds = [...previous, id].slice(-MAX_MESSAGE_IDS);
    try {
      await this.persist(rec, { failFast: true });
    } catch (err) {
      rec.messageIds = previous;
      throw err;
    }
  }

  commandReceipt(runId: string, commandId: string): CapabilityCommandReceipt | undefined {
    const id = commandId.trim();
    return id ? this.runs.get(runId)?.commandReceipts.find((receipt) => receipt.id === id) : undefined;
  }

  /** Persist a typed-command receipt only after the box accepted the command. */
  async rememberCommandReceipt(runId: string, commandId: string, digest: string): Promise<void> {
    const rec = this.runs.get(runId);
    const id = commandId.trim();
    const normalizedDigest = digest.trim().toLowerCase();
    if (!rec || !id || !normalizedDigest) return;
    const existing = rec.commandReceipts.find((receipt) => receipt.id === id);
    if (existing) {
      if (existing.digest !== normalizedDigest) throw new Error("command_id was already used with a different payload");
      return;
    }
    const previous = rec.commandReceipts;
    rec.commandReceipts = [...previous, { id, digest: normalizedDigest }].slice(-MAX_COMMAND_RECEIPTS);
    try {
      await this.persist(rec, { failFast: true });
    } catch (err) {
      rec.commandReceipts = previous;
      throw err;
    }
  }

  /** Bump last-DATA activity so the watchdog doesn't reap an actively-used run. */
  touch(runId: string): void {
    const rec = this.runs.get(runId);
    if (rec) rec.lastActivityMs = this.now();
    // Real activity ⇒ not a poison row — reset any accrued reap-defer count so a
    // later stale episode starts its give-up budget fresh.
    this.reapDeferrals.delete(runId);
  }

  /**
   * Bump the heartbeat clock only (a `: heartbeat` SSE comment — liveness, not
   * data). Kept separate from touch() so heartbeats bridge a data-silent phase
   * up to dataStaleMs but can never keep a wedged (data-silent) turn alive
   * forever — see reapStale.
   */
  touchHeartbeat(runId: string): void {
    const rec = this.runs.get(runId);
    if (rec) rec.lastHeartbeatMs = this.now();
  }

  // No box session id anywhere: the runtime routes/recovers a run by runId and
  // restores continuity by rehydrating the workspace FILES into a box, never by
  // resuming the box's Claude Code session id (the box also uses an in-memory
  // session store, so a session id wouldn't survive a container restart anyway).
  // `session_ref` stays a reserved wire field (persisted as ""), with no record
  // mirror and no runtime handling — a future persistent-session design would
  // re-introduce both without a protocol change.

  /** Move a live run to idle/running (non-terminal) + persist. */
  async setStatus(runId: string, status: CapabilityLifecycleStatus): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) return;
    // Terminal is sticky — mirror endRun. A record can sit here in a TERMINAL
    // state while its final persist retries (flushTerminal). A concurrent
    // done/error/cancel must never be flipped back to non-terminal — that would
    // hide the record from flushTerminal and degrade the true outcome.
    if (isTerminalCapabilityStatus(rec.status)) return;
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
    // Terminal is sticky: the FIRST outcome wins. Without this, a done whose
    // persist is still retrying (flushTerminal) gets overwritten to failed by
    // the relay's error catch when the box stream closes right after `done`.
    if (isTerminalCapabilityStatus(rec.status)) return;
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
        const rec: CapabilityRunRecord = {
          runId: r.id,
          profile: r.profile ?? "",
          orgId: r.org_id ?? "",
          correlationId: r.correlation_id || undefined,
          runtimeId: r.runtime_id || undefined,
          inputRevision: inputRevisionFromCheckpoint(r.checkpoint),
          messageIds: messageIdsFromCheckpoint(r.checkpoint),
          commandReceipts: commandReceiptsFromCheckpoint(r.checkpoint),
          status: r.status || "running",
          lastActivityMs: this.now(),
          lastHeartbeatMs: this.now(),
        };
        this.runs.set(r.id, rec);
        this.onAdopt?.(rec);
        n++;
      }
      return n;
    } catch (err) {
      console.warn(`[capability] run recovery skipped: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * The terminal outcome a run has EARNED by its staleness right now, or null if
   * it is still fresh. Shared by reapStale's initial snapshot AND its post-await
   * re-validation (finding A) so both judge freshness by exactly the same rule:
   *   - running: two-clock — data silent past dataStaleMs (heartbeats can't
   *     extend it), OR no liveness at all (neither data nor heartbeat) past
   *     staleMs → failed
   *   - idle past idleTtlMs → done
   */
  private stalenessOutcome(rec: CapabilityRunRecord, now: number): CapabilityTerminalStatus | null {
    if (isTerminalCapabilityStatus(rec.status)) return null;
    if (rec.status === "idle") {
      return rec.lastActivityMs < now - this.idleTtlMs ? "done" : null;
    }
    const stale =
      now - rec.lastActivityMs > this.dataStaleMs ||
      now - Math.max(rec.lastActivityMs, rec.lastHeartbeatMs) > this.staleMs;
    return stale ? "failed" : null;
  }

  /**
   * Reap non-terminal runs that outlived their tier's TTL (stop box + persist a
   * terminal state). Two very different kinds of stale:
   *   - running stale = a wedged turn           → failed (two-clock, see below)
   *   - idle past idleTtlMs = a conversation at rest → done (normal end)
   *
   * The RUNNING tier uses two clocks so heartbeats can't make a wedged box
   * immortal: reap when data has been silent past dataStaleMs (60 min — even if
   * heartbeats keep arriving), OR when there is NO liveness at all (neither data
   * nor heartbeat) past staleMs (10 min). So heartbeats bridge a quiet read-only
   * phase up to dataStaleMs, but a box that never emits data again dies at
   * dataStaleMs, and a box that goes fully silent dies at staleMs.
   */
  async reapStale(): Promise<string[]> {
    const candidates: string[] = [];
    for (const rec of [...this.runs.values()]) {
      if (this.stalenessOutcome(rec, this.now())) candidates.push(rec.runId);
    }
    const reaped: string[] = [];
    for (const runId of candidates) {
      const rec = this.runs.get(runId);
      if (!rec) continue;
      // A candidate can be a resurrection artifact: recover()'s active-run
      // listing is a snapshot, so a run that ended WHILE the listing was in
      // flight re-enters the map with its stale non-terminal status. Re-check
      // the store before acting — if the run already reached a terminal state
      // there, just forget it (no box stop, and NEVER overwrite a successful
      // "done" with "failed").
      try {
        const req: CapabilityGetRunRequest = { run_id: runId };
        const row = (await this.backend.request(CAPABILITY_GET_RUN, req)) as CapabilityRunRow | null;
        this.reapDeferrals.delete(runId); // a successful re-check clears the poison counter
        if (row?.status && isTerminalCapabilityStatus(row.status)) {
          this.runs.delete(runId);
          continue;
        }
      } catch {
        // Store unreachable (finding B): we can't confirm this run didn't already
        // end. A resurrection artifact could be `done` in the store — reaping it
        // now would overwrite done→failed via flushTerminal, violating "a done
        // never degrades to failed". Defer to the next tick; a genuinely wedged
        // box isn't persisting anything while the store is down anyway.
        //
        // Bounded give-up (jacoblee review): a PERMANENT per-run getRun throw (a
        // poison row that never deserializes) would defer on every tick and pin
        // the box forever. After MAX_REAP_DEFERRALS consecutive failures, stop
        // deferring and reap — a store outage is transient (the counter clears on
        // the next success), so only a genuinely stuck row reaches the cap.
        const n = (this.reapDeferrals.get(runId) ?? 0) + 1;
        if (n < MAX_REAP_DEFERRALS) {
          this.reapDeferrals.set(runId, n);
          continue;
        }
        console.warn(`[capability] run ${runId}: reap re-check failed ${n}× — giving up the defer and reaping`);
        this.reapDeferrals.delete(runId);
        // fall through to reap
      }
      // Re-validate freshness AFTER the store re-check's async gap (finding A): a
      // capability.message landing during that await bumps lastActivityMs, so a
      // run snapshotted as stale can be active again by now. Reaping it here would
      // kill a live turn AND mark the fresh run failed. Re-derive against the
      // current record; if it's no longer stale, leave it for a later tick.
      const outcome = this.stalenessOutcome(rec, this.now());
      if (!outcome) continue;
      console.warn(`[capability] watchdog reaping stale run ${runId} → ${outcome}`);
      if (this.onReap) {
        // Stop the run's box BEFORE the terminal mark, so the store never says
        // "ended" while an orphan pod keeps working behind its back.
        try {
          await this.onReap(rec);
        } catch (err) {
          console.warn(`[capability] onReap(${runId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await this.endRun(runId, outcome);
      reaped.push(runId);
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
    const checkpoint = {
      ...(rec.inputRevision ? { input_revision: rec.inputRevision } : {}),
      ...(rec.messageIds.length > 0 ? { message_ids: rec.messageIds } : {}),
      ...(rec.commandReceipts.length > 0 ? { command_receipts: rec.commandReceipts } : {}),
    };
    const state: CapabilityRunState = {
      run_id: rec.runId,
      org_id: rec.orgId ?? "",
      correlation_id: rec.correlationId ?? "",
      profile: rec.profile,
      status: rec.status,
      ...(Object.keys(checkpoint).length > 0 ? { checkpoint } : {}),
      // Reserved wire field, always "" — the runtime does not track a box session
      // id (see the note above adopt()); a future persistent-session design would
      // re-introduce the mirror + carry-through.
      session_ref: "",
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

function inputRevisionFromCheckpoint(checkpoint: unknown): string | undefined {
  let value = checkpoint;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const revision = (value as { input_revision?: unknown }).input_revision;
  return typeof revision === "string" && revision.trim() ? revision.trim() : undefined;
}

function messageIdsFromCheckpoint(checkpoint: unknown): string[] {
  let value = checkpoint;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object") return [];
  const ids = (value as { message_ids?: unknown }).message_ids;
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is string => typeof id === "string" && id.trim() !== "" && id.trim().length <= 128)
    .map((id) => id.trim())
    .slice(-MAX_MESSAGE_IDS);
}

function commandReceiptsFromCheckpoint(checkpoint: unknown): CapabilityCommandReceipt[] {
  let value = checkpoint;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object") return [];
  const receipts = (value as { command_receipts?: unknown }).command_receipts;
  if (!Array.isArray(receipts)) return [];
  const seen = new Set<string>();
  const normalized: CapabilityCommandReceipt[] = [];
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") continue;
    const id = (receipt as { id?: unknown }).id;
    const digest = (receipt as { digest?: unknown }).digest;
    if (typeof id !== "string" || typeof digest !== "string") continue;
    const cleanID = id.trim();
    const cleanDigest = digest.trim().toLowerCase();
    if (!cleanID || cleanID.length > 128 || !/^[0-9a-f]{64}$/.test(cleanDigest) || seen.has(cleanID)) continue;
    seen.add(cleanID);
    normalized.push({ id: cleanID, digest: cleanDigest });
  }
  return normalized.slice(-MAX_COMMAND_RECEIPTS);
}
