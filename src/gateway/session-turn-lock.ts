/**
 * One turn at a time, per session — enforced in the Runtime.
 *
 * Two requests for the same session must never run concurrently, because a turn is what
 * appends to that session's transcript. Both would hold their own in-memory copy of the
 * conversation and append their own version of it, leaving the file interleaved.
 *
 * The AgentBox already refuses a second concurrent prompt (409, "Session is already
 * running"), but that check lives INSIDE one box and only sees its own sessions. Once an
 * agent runs more than one box, two requests for one session can be dispatched to two
 * different boxes, neither of which sees a conflict. The guarantee therefore has to sit
 * where every request passes through, which is the Runtime.
 *
 * This is also what makes free scheduling safe: because no two turns for a session can
 * overlap, a session that has no turn running (and no background work) can be sent to any
 * box without risking a second writer.
 *
 * Deliberately in-memory. The Runtime is a single replica, so a plain map is the whole
 * mechanism; a restart drops the locks, and the placement layer re-derives who is busy by
 * asking the boxes rather than trusting anything it remembered.
 */

/** Shape a caller can map to HTTP 409 — matches what an AgentBox returns for the same reason. */
export class SessionBusyError extends Error {
  readonly status = 409;
  constructor(sessionId: string, waitedMs: number) {
    super(`Session is already running (waited ${waitedMs}ms for session ${sessionId})`);
    this.name = "SessionBusyError";
  }
}

/**
 * How long a second request waits before giving up.
 *
 * Not zero: a user double-clicking send, or a client retrying a dropped request, should
 * queue rather than see an error. Not long either — past a few seconds the caller is
 * better off being told the session is busy so it can decide (the Lark path, for one,
 * already queues on a 409 rather than showing it).
 */
const DEFAULT_WAIT_MS = 5_000;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Entry {
  /** Where the in-flight turn was dispatched, when known. Dropped on release. */
  boxId?: string;
  endpoint?: string;
  /**
   * Whether the box has ACCEPTED the prompt — i.e. the session now exists there.
   *
   * `noteBox` records the destination as soon as placement decides, which is before the
   * box has been asked to do anything. A steer arriving in that gap reaches the right box
   * and is still told "Session not found", because the session is not created until the
   * prompt is processed. Waiting on this is what turns that race into an ordering.
   */
  accepted?: boolean;
  acceptWaiters: Array<() => void>;
  queue: Waiter[];
}

export class SessionTurnLocks {
  private held = new Map<string, Entry>();

  /** Whether a turn is currently running for this session, as far as this Runtime knows. */
  isBusy(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /**
   * Where the in-flight turn is running, if any.
   *
   * This is what lets a rejected second send reach the box that is ACTUALLY running the
   * turn, so it can be injected as a steer rather than failed — which is what the box's
   * own 409 used to achieve before the lock started rejecting earlier.
   */
  busyOn(sessionId: string): { boxId: string; endpoint: string } | undefined {
    const e = this.held.get(sessionId);
    return e?.boxId && e.endpoint ? { boxId: e.boxId, endpoint: e.endpoint } : undefined;
  }

  /** Record where the in-flight turn went, once placement has decided. */
  noteBox(sessionId: string, boxId: string, endpoint: string): void {
    const entry = this.held.get(sessionId);
    if (entry) { entry.boxId = boxId; entry.endpoint = endpoint; }
  }

  /** The box took the prompt: the session exists there and can be steered. */
  markPromptAccepted(sessionId: string): void {
    const entry = this.held.get(sessionId);
    if (!entry || entry.accepted) return;
    entry.accepted = true;
    for (const resolve of entry.acceptWaiters.splice(0)) resolve();
  }

  /**
   * Wait until the in-flight turn's box has taken the prompt.
   *
   * Resolves immediately when there is no turn to wait for (the caller then has nothing
   * to synchronise with) or when the box has already accepted. Resolves rather than
   * rejects on timeout: the caller should still try, and get the box's own answer.
   */
  whenPromptAccepted(sessionId: string, timeoutMs: number): Promise<void> {
    const entry = this.held.get(sessionId);
    if (!entry || entry.accepted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      entry.acceptWaiters.push(done);
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
    });
  }

  /**
   * Run `fn` with the session's turn lock held.
   *
   * Releases on both success and failure — a caller that throws must not wedge the session
   * permanently, which is the failure mode that makes an in-memory lock dangerous.
   */
  async run<T>(sessionId: string, fn: () => Promise<T>, waitMs = DEFAULT_WAIT_MS): Promise<T> {
    const release = await this.acquire(sessionId, waitMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Take the lock and get back the release.
   *
   * For call sites whose turn body cannot be wrapped in a closure — `chat.send`'s has
   * early returns that a closure would silently turn into "carry on with the rest of the
   * function". Release from a `finally` so a throw cannot wedge the session.
   */
  async acquire(sessionId: string, waitMs = DEFAULT_WAIT_MS): Promise<() => void> {
    await this.waitForTurn(sessionId, waitMs);
    let released = false;
    return () => {
      if (released) return; // idempotent: a finally may run alongside an explicit release
      released = true;
      this.release(sessionId);
    };
  }

  private waitForTurn(sessionId: string, waitMs: number): Promise<void> {
    const entry = this.held.get(sessionId);
    if (!entry) {
      this.held.set(sessionId, { queue: [], acceptWaiters: [] });
      return Promise.resolve();
    }
    const startedAt = Date.now();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = entry.queue.indexOf(waiter);
          if (i >= 0) entry.queue.splice(i, 1);
          reject(new SessionBusyError(sessionId, Date.now() - startedAt));
        }, waitMs),
      };
      waiter.timer.unref?.();
      entry.queue.push(waiter);
    });
  }

  private release(sessionId: string): void {
    const entry = this.held.get(sessionId);
    if (!entry) return;
    const next = entry.queue.shift();
    if (!next) {
      this.held.delete(sessionId);
      return;
    }
    clearTimeout(next.timer);
    // Hand the lock straight to the next waiter — dropping and re-acquiring would let a
    // request that arrived later jump the queue.
    entry.boxId = undefined;
    entry.endpoint = undefined;
    entry.accepted = false;
    // A waiter that outlived its turn must not block on the NEXT turn's acceptance.
    for (const resolve of entry.acceptWaiters.splice(0)) resolve();
    next.resolve();
  }
}

/** Process-wide locks. One Runtime, one set. */
export const sessionTurnLocks = new SessionTurnLocks();
