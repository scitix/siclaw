/**
 * Ships LLM-call measurements from a box to the Runtime.
 *
 * Core produces measurements at the provider boundary and knows nothing about
 * databases; this is the seam where they leave the box. Metering must never be
 * able to fail a user's turn, so nothing here ever throws at the caller.
 *
 * Three properties the first version got wrong, each for the same underlying
 * reason — it treated "handed to a promise" as "delivered":
 *
 *   1. A batch was removed from the buffer BEFORE the send, so a transient
 *      failure lost it permanently. Entries now stay queued until the Runtime
 *      has acknowledged them, and a failed batch is retried with backoff.
 *   2. The size cap counted only the pending buffer, while dispatched-but-
 *      unacknowledged batches piled up in a promise chain outside it. There is
 *      now ONE queue and one drain loop, so the cap bounds everything in flight.
 *   3. Losses were recorded in a private counter nobody could read. Delivery
 *      gaps are now reportable (`stats()`), because a coverage report that
 *      cannot see them would present incomplete data as complete.
 */

import type { LlmCallMeasurement } from "../shared/llm-call-record.js";

/** Measurements per delivery. */
const BATCH_SIZE = 16;
/** Idle delay before draining a partial batch. */
const FLUSH_INTERVAL_MS = 2_000;
/**
 * Total measurements held — queued AND awaiting acknowledgement. Past this the
 * OLDEST are dropped: a Runtime outage must not become a memory leak, and newer
 * measurements are the ones still worth having.
 */
const MAX_QUEUED = 512;
/** Attempts per batch before it is declared undeliverable. */
const MAX_SEND_ATTEMPTS = 3;
/** Base backoff; doubles per attempt. */
const RETRY_BASE_MS = 200;
/**
 * Wall-clock budget for teardown delivery. Comfortably inside a pod's default
 * termination grace, so a slow Runtime delays shutdown rather than preventing it.
 */
const CLOSE_DEADLINE_MS = 5_000;

export interface LlmCallDispatcherDeps {
  sessionId: string;
  send: (batch: { session_id: string; measurements: LlmCallMeasurement[] }) => Promise<void>;
  warn?: (message: string) => void;
  /** Injectable for tests; real callers use the default timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock so a test can drive the close deadline deterministically. */
  now?: () => number;
}

/** What was delivered and what was lost — the basis of a coverage statement. */
export interface DeliveryStats {
  delivered: number;
  /** Measurements discarded: queue overflow, or a batch that exhausted retries. */
  dropped: number;
  /** Still queued or being retried. */
  pending: number;
  /** Batches that failed every attempt. */
  failedBatches: number;
}

/** A promise that can be resolved from outside, used as a one-way latch. */
function deferredFalse(): { promise: Promise<boolean>; resolve: (v: boolean) => void } {
  let resolve: (v: boolean) => void = () => {};
  const promise = new Promise<boolean>((r) => { resolve = r; });
  // Nothing rejects it, and an unobserved resolution is fine.
  return { promise, resolve };
}

export class LlmCallMeasurementDispatcher {
  private queue: LlmCallMeasurement[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  /** Batch taken from the queue and awaiting acknowledgement; counted by the cap. */
  private inFlight: LlmCallMeasurement[] = [];
  private delivered = 0;
  private dropped = 0;
  private failedBatches = 0;
  private closed = false;
  /** Wall-clock cutoff for teardown delivery; the drain loop honours it too. */
  private closeDeadline: number | null = null;

  constructor(private readonly deps: LlmCallDispatcherDeps) {}

  /** Queue one measurement. Never throws; never blocks the caller. */
  record(measurement: LlmCallMeasurement): void {
    if (this.closed) { this.dropped += 1; return; }
    this.queue.push(measurement);
    // The cap covers EVERYTHING held, in-flight included — counting only the
    // queue let dispatched-but-unacknowledged batches push the real total past
    // the limit. In-flight rows are never dropped: they may yet be delivered.
    const excess = this.held - MAX_QUEUED;
    if (excess > 0) {
      // Drop from the FRONT of the queue: the oldest are the least likely to
      // still matter, and dropping the newest would hide an ongoing problem.
      this.dropped += this.queue.splice(0, Math.min(excess, this.queue.length)).length;
    }
    if (this.queue.length >= BATCH_SIZE) { void this.drain(); return; }
    this.scheduleDrain();
  }

  /** Delivery accounting, so a report can state coverage rather than assume it. */
  stats(): DeliveryStats {
    return {
      delivered: this.delivered,
      dropped: this.dropped,
      pending: this.held,
      failedBatches: this.failedBatches,
    };
  }

  /** Drain everything currently queued. Safe to call concurrently. */
  async flush(): Promise<void> {
    await this.drain();
  }

  /**
   * Final drain under a WALL-CLOCK budget, then refuse further records.
   *
   * A pass count is not a time bound: one drain empties the whole queue, so 512
   * measurements at 16 per batch and 4s per send is 128 seconds — every request
   * inside the client's own timeout, the total far past a pod's termination
   * grace. Teardown needs its own deadline.
   *
   * Whatever misses it is COUNTED AS DROPPED and discarded. The alternative is
   * leaving rows on a dispatcher the session has already released — unreachable,
   * never retried, yet still counted as `pending`, which would let a coverage
   * report overstate what was delivered.
   */
  async close(deadlineMs = CLOSE_DEADLINE_MS): Promise<void> {
    this.clearTimer();
    const now = () => (this.deps.now ? this.deps.now() : Date.now());
    // Published so the RUNNING drain loop can see it too. Checking the clock only
    // around `await drain()` bounds nothing: one drain empties the entire queue,
    // so 512 rows at 4s per batch took 128 seconds while every individual send
    // stayed inside the client's own timeout.
    this.closeDeadline = now() + deadlineMs;
    // Arm the cutoff HERE, before awaiting anything.
    //
    // A send that started BEFORE close() had no deadline to arm a timer against,
    // so it is parked on the cutoff latch alone — and `await this.drain()` below
    // returns that very drain's promise. Signalling only after the loop therefore
    // makes the signal wait on precisely the wait it exists to bound: measured at
    // 5s budget / 9s actual, with 16 rows still pending at the 5s mark. Every
    // caller of close() is a teardown path (release, sub-agent settle, closeAll),
    // so the overrun is paid by shutdown.
    const cutoffTimer = setTimeout(() => { this.signalCutoff(); }, Math.max(0, deadlineMs));
    cutoffTimer.unref?.();
    try {
      while (this.held > 0 && now() < this.closeDeadline) {
        const before = this.held;
        await this.drain();
        // No progress while still inside the budget ⇒ the Runtime is refusing;
        // spinning would burn the remaining grace for nothing.
        if (this.held >= before) break;
      }
    } finally {
      clearTimeout(cutoffTimer);
    }
    this.closed = true;
    this.clearTimer();
    // Idempotent: releases anything still parked if the loop exited first.
    this.signalCutoff();
    const abandoned = this.held;
    if (abandoned > 0) {
      this.queue = [];
      this.inFlight = [];
      this.dropped += abandoned;
      this.deps.warn?.(
        `[llm-call-dispatcher] abandoned ${abandoned} measurement(s) at close: delivery budget exhausted`,
      );
    }
  }

  /**
   * True when `work` finishes first, false when the close deadline does.
   *
   * With no deadline set (ordinary operation) this is a plain await. A rejected
   * send still propagates, so only the TIMEOUT branch becomes a value.
   */
  private async raceDeadline(work: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.closeDeadline !== null) {
        const clock = this.deps.now ? this.deps.now() : Date.now();
        const remaining = this.closeDeadline - clock;
        if (remaining <= 0) { void work.catch(() => {}); return false; }
        timer = setTimeout(() => { this.signalCutoff(); }, remaining);
        timer.unref?.();
      }
      // Always race the cutoff signal, even with no deadline YET: a send that
      // began before `close()` was called would otherwise never learn of the
      // deadline it later acquired, and a 5s close returned at 9s waiting on it.
      const finished = await Promise.race([work.then(() => true), this.cutoff.promise]);
      if (!finished) void work.catch(() => {});
      return finished;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Wake every in-flight wait: the teardown budget is spent. */
  private signalCutoff(): void {
    this.cutoff.resolve(false);
  }

  /** A latch the deadline flips; all waiters observe it, whenever they started. */
  private cutoff = deferredFalse();

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Everything this dispatcher is holding: queued plus awaiting acknowledgement. */
  private get held(): number {
    return this.queue.length + this.inFlight.length;
  }

  /** Arm the idle timer, unless one is already pending or a drain is running. */
  private scheduleDrain(): void {
    if (this.closed || this.timer !== null || this.draining) return;
    if (this.queue.length === 0) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /**
   * The single consumer. Only one runs at a time, so a batch cannot be sent
   * twice and `held` is the whole of what we retain.
   */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.clearTimer();
    // Nothing to do: return WITHOUT entering the draining state. Setting it here
    // parked an already-resolved promise in `this.draining` — the loop never
    // awaited, so its cleanup ran before the assignment — and every later drain
    // then short-circuited on it, silently stopping delivery for good.
    if (this.queue.length === 0) return Promise.resolve();
    const task = (async () => {
      try {
        while (this.queue.length > 0) {
          // Honour a teardown deadline BETWEEN batches: close must be able to
          // stop a drain that would otherwise run the whole backlog past the
          // pod's termination grace.
          if (this.closeDeadline !== null) {
            const clock = this.deps.now ? this.deps.now() : Date.now();
            if (clock >= this.closeDeadline) break;
          }
          // TAKE the batch out of the queue and hold it in `inFlight`, so the
          // cap still counts it and a front-drop cannot delete rows that are
          // mid-send. Removing by count later could splice a DIFFERENT batch
          // that had since moved to the front.
          this.inFlight = this.queue.splice(0, BATCH_SIZE);
          const ok = await this.sendWithRetry(this.inFlight);
          if (ok) {
            this.delivered += this.inFlight.length;
          } else {
            this.dropped += this.inFlight.length;
            this.failedBatches += 1;
            this.inFlight = [];
            break; // stop hammering a Runtime that is clearly unavailable
          }
          this.inFlight = [];
        }
      } finally {
        // Safe to clear unconditionally: the guard above admits one drain at a
        // time, and the loop always awaits, so this runs after the assignment.
        this.draining = null;
        this.inFlight = [];
        // Anything left — a failed batch's successors, or records that arrived
        // mid-drain — must get another chance, or the queue silently stalls.
        this.scheduleDrain();
      }
    })();
    this.draining = task;
    return task;
  }

  private async sendWithRetry(measurements: LlmCallMeasurement[]): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }));
    const clock = () => (this.deps.now ? this.deps.now() : Date.now());
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      // The deadline has to bound the SENDS too, not just the gaps between
      // batches: three retries against a 5s-timeout Runtime ran 15.6s past a
      // close that was supposed to cap at 5s.
      if (this.closeDeadline !== null && clock() >= this.closeDeadline) return false;
      try {
        // RACE the send against the deadline. Checking the clock beforehand
        // bounds nothing once we are inside `await send()`: two 4s batches ran a
        // 5s close out to 8s. Losing the race abandons the WAIT, not necessarily
        // the request — it may still land, and the receiver is idempotent on
        // call_id, so a late arrival is harmless.
        const sent = await this.raceDeadline(
          this.deps.send({ session_id: this.deps.sessionId, measurements }),
        );
        return sent;
      } catch (error) {
        // Do not spend the remaining grace on a backoff we cannot afford.
        if (this.closeDeadline !== null && clock() >= this.closeDeadline) return false;
        if (attempt === MAX_SEND_ATTEMPTS) {
          this.deps.warn?.(
            `[llm-call-dispatcher] gave up on ${measurements.length} measurement(s) after ${attempt} attempts: ` +
            (error instanceof Error ? error.message : String(error)),
          );
          return false;
        }
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    return false;
  }
}
