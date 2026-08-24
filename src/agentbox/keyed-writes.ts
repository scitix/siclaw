/**
 * Two per-key write disciplines, because the plan has two durability paths with opposite needs.
 *
 * Both were fire-and-forget per event, which one event per model turn made look safe: the writes were
 * seconds apart. Batching fires several in one synchronous loop, and then neither is safe.
 *
 *   the ledger SNAPSHOT — a whole-state write, so only the newest matters and the rest are waste.
 *     Concurrent write-tmp-then-rename pairs have no ordering, so the rename that lands last wins and
 *     a snapshot of one task can overwrite a snapshot of five. Wants COALESCING.
 *
 *   the task EVENTS — a log of distinct mutations replayed in order to rebuild the plan. Dropping one
 *     loses a task; reordering applies a stale status over a fresh one, or re-adds a deleted task,
 *     because replay is last-write-wins. Wants a QUEUE.
 *
 * Both own a per-key lifecycle, because a session closes while writes are outstanding and closure is
 * exactly when getting this wrong destroys the durable copy.
 */

/** Latest-wins: at most one write in flight per key, with one follow-up coalesced behind it. */
export type CoalescedWriter = {
  (key: string): void;
  /** Resolve once nothing is in flight or pending for this key. */
  drain(key: string): Promise<void>;
  /** Drop a queued follow-up. An in-flight write is not interrupted. */
  cancel(key: string): void;
};

/**
 * `write` must read its data when CALLED, not when scheduled — the coalesced follow-up exists to
 * observe state that changed after the first request. That is also why it must tolerate the state
 * having gone away entirely by then; see peekLedger.
 */
export function createCoalescedWriter(write: (key: string) => Promise<unknown>): CoalescedWriter {
  const inFlight = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();

  const settleWaiters = (key: string) => {
    if (inFlight.has(key) || pending.has(key)) return;
    const list = waiters.get(key);
    if (!list) return;
    waiters.delete(key);
    for (const resolve of list) resolve();
  };

  const run = (key: string): void => {
    if (inFlight.has(key)) {
      pending.add(key);
      return;
    }
    let started: Promise<unknown>;
    try {
      started = write(key);
    } catch (err) {
      // A synchronous throw must not wedge the key: leaving the flag set drops every later request
      // as "already in flight", so the file silently stops being updated.
      pending.delete(key);
      settleWaiters(key);
      throw err;
    }
    const done = Promise.resolve(started)
      .catch(() => { /* the writer reports its own failures; this only releases the slot */ })
      .then(() => {
        inFlight.delete(key);
        if (pending.delete(key)) run(key);
        settleWaiters(key);
      });
    inFlight.set(key, done);
  };

  const writer = run as CoalescedWriter;
  writer.drain = (key: string): Promise<void> => {
    if (!inFlight.has(key) && !pending.has(key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = waiters.get(key) ?? [];
      list.push(resolve);
      waiters.set(key, list);
    });
  };
  writer.cancel = (key: string): void => {
    pending.delete(key);
    settleWaiters(key);
  };
  return writer;
}

/** Ordered: one item at a time per key, in the order pushed, none dropped. */
export type SerialQueue<T> = {
  push(key: string, item: T): void;
  /** Resolve once everything pushed for this key so far has run. */
  drain(key: string): Promise<void>;
};

export function createSerialQueue<T>(run: (item: T) => Promise<unknown>): SerialQueue<T> {
  // The tail of each key's chain. Serialising the SENDS is what fixes ordering downstream: the
  // receiver assigns its own sequence on arrival, so two concurrent appends can be recorded in
  // either order no matter what order they were emitted in.
  const tails = new Map<string, Promise<void>>();

  return {
    push(key: string, item: T): void {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev
        .then(() => run(item))
        .catch(() => { /* reported by the caller's own handler; the chain must not break */ })
        .then(() => {
          // Only the newest tail clears the entry, or a later push would be dropped from the map
          // while still queued behind this one.
          if (tails.get(key) === next) tails.delete(key);
        });
      tails.set(key, next);
    },
    drain(key: string): Promise<void> {
      return tails.get(key) ?? Promise.resolve();
    },
  };
}
