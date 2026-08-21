/**
 * One write in flight per key, with the latest request coalesced behind it.
 *
 * For a writer that persists a WHOLE snapshot, concurrency is not a throughput problem, it is a
 * correctness one: the writes are `writeFile(tmp)` then `rename(tmp, file)`, and nothing orders one
 * pair against another. Whichever rename happens to land last wins, so a snapshot taken earlier can
 * overwrite a later one and the file ends up behind the state it is meant to mirror.
 *
 * A single event per turn hid this by spacing the writes seconds apart. A batch fires several in one
 * synchronous loop, and then the race is real: the plan ledger lost tasks that way, visible only
 * after a pod restart re-read the file.
 *
 * Because each write persists everything, only the newest matters. A request arriving while one is
 * in flight therefore sets a flag rather than queueing, and the follow-up write re-reads the source.
 * That bounds a burst of N to two writes and makes the last one on disk always the latest state.
 */
export type CoalescedWriter = (key: string) => void;

/**
 * `write` must read its data when CALLED, not when scheduled — the coalesced follow-up exists
 * precisely to observe state that changed after the first request.
 */
export function createCoalescedWriter(write: (key: string) => Promise<unknown>): CoalescedWriter {
  const inFlight = new Set<string>();
  const pending = new Set<string>();

  const run = (key: string): void => {
    if (inFlight.has(key)) {
      pending.add(key);
      return;
    }
    inFlight.add(key);
    let started: Promise<unknown>;
    try {
      started = write(key);
    } catch (err) {
      // A synchronous throw must not wedge the key: without this the flag stays set and every later
      // request is dropped as "already in flight", so the file silently stops being updated.
      inFlight.delete(key);
      pending.delete(key);
      throw err;
    }
    void Promise.resolve(started)
      .catch(() => { /* the writer reports its own failures; this only releases the slot */ })
      .finally(() => {
        inFlight.delete(key);
        if (pending.delete(key)) run(key);
      });
  };

  return run;
}
