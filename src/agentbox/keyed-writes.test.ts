import { describe, it, expect } from "vitest";
import { createCoalescedWriter, createSerialQueue } from "./keyed-writes.js";

const tick = () => new Promise((r) => setImmediate(r));
/** Enough turns of the immediate queue for a short chain of writes to drain. */
const drain = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };

describe("createCoalescedWriter", () => {
  it("collapses a synchronous burst to two writes: the first, and one carrying the latest state", async () => {
    let state = 0;
    const written: number[] = [];
    let release: (() => void) | null = null;
    const w = createCoalescedWriter(async () => {
      const seen = state;
      await new Promise<void>((r) => { release = r; });
      written.push(seen);
    });

    w("k");                 // starts, reads state 0, then blocks
    state = 1; w("k");
    state = 2; w("k");
    state = 3; w("k");      // three requests coalesce into one follow-up
    await tick();
    release!();             // first write completes
    await drain();
    release!();             // follow-up completes
    await drain();

    expect(written).toEqual([0, 3]);
  });

  it("never runs two writes for the same key at once", async () => {
    let concurrent = 0;
    let peak = 0;
    const w = createCoalescedWriter(async () => {
      peak = Math.max(peak, ++concurrent);
      await tick();
      concurrent--;
    });
    for (let i = 0; i < 20; i++) w("k");
    await drain(60);
    expect(peak).toBe(1);
  });

  it("keeps keys independent — one key's write does not block another's", async () => {
    const order: string[] = [];
    const w = createCoalescedWriter(async (key) => { order.push(key); await tick(); });
    w("a");
    w("b");
    await drain();
    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("releases the key after a rejected write, so later requests still land", async () => {
    let calls = 0;
    const w = createCoalescedWriter(async () => {
      calls++;
      if (calls === 1) throw new Error("disk full");
    });
    w("k");
    await drain();
    w("k");
    await drain();
    expect(calls).toBe(2); // a wedged key would leave this at 1
  });

  it("releases the key after a SYNCHRONOUS throw as well", async () => {
    let calls = 0;
    const w = createCoalescedWriter((): Promise<void> => {
      calls++;
      throw new Error("bad argument");
    });
    expect(() => w("k")).toThrow("bad argument");
    await drain();
    expect(() => w("k")).toThrow("bad argument");
    expect(calls).toBe(2);
  });

  it("does not schedule a follow-up when nothing arrived during the write", async () => {
    let calls = 0;
    const w = createCoalescedWriter(async () => { calls++; await tick(); });
    w("k");
    await drain();
    expect(calls).toBe(1);
  });
});

// The lifecycle half. Closure is when getting this wrong destroys the durable copy, so these pin
// what close() relies on: that draining waits for BOTH the in-flight write and the follow-up it
// will schedule, and that the follow-up reads state at write time rather than at request time.
describe("createCoalescedWriter — drain and cancel", () => {
  it("drain waits for the in-flight write AND the follow-up queued behind it", async () => {
    const seen: number[] = [];
    let state = 1;
    let release: (() => void) | null = null;
    const w = createCoalescedWriter(async () => {
      const snap = state;
      await new Promise<void>((r) => { release = r; });
      seen.push(snap);
    });

    w("k");            // in flight, blocked
    state = 2; w("k"); // queued
    let drained = false;
    const p = w.drain("k").then(() => { drained = true; });

    await drain();
    expect(drained).toBe(false); // must not resolve while a write is outstanding
    release!();                  // first completes; follow-up starts
    await drain();
    expect(drained).toBe(false); // still outstanding
    release!();                  // follow-up completes
    await p;
    expect(drained).toBe(true);
    expect(seen).toEqual([1, 2]);
  });

  it("drain resolves immediately when the key is idle", async () => {
    const w = createCoalescedWriter(async () => {});
    await w.drain("never-written"); // would hang if it waited on nothing
  });

  it("cancel drops the queued follow-up without interrupting the write in flight", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const w = createCoalescedWriter(async () => {
      calls++;
      await new Promise<void>((r) => { release = r; });
    });
    w("k");
    w("k");        // queued
    w.cancel("k"); // dropped
    release!();
    await drain();
    expect(calls).toBe(1);
  });

  it("a follow-up sees state as of the WRITE, which is what lets a closed key write nothing", async () => {
    // The shape of the real bug: the follow-up ran after the source was gone and persisted an empty
    // snapshot over a good one. The writer must be able to observe the disappearance itself.
    let source: string[] | null = ["task-1"];
    const written: string[][] = [];
    let release: (() => void) | null = null;
    const w = createCoalescedWriter(async () => {
      const snap = source;
      await new Promise<void>((r) => { release = r; });
      if (snap === null) return; // "the ledger is gone — write nothing"
      written.push(snap);
    });

    w("k");            // write #1 starts, captures ["task-1"], blocks
    w("k");            // queued
    source = null;     // the session closes WHILE write #1 is in flight — the real ordering
    release!();        // write #1 completes with what it captured
    await drain();
    release!();        // follow-up runs, reads null, writes nothing
    await drain();

    expect(written).toEqual([["task-1"]]); // NOT [["task-1"], []]
  });
});

describe("createSerialQueue", () => {
  it("runs items in push order, one at a time", async () => {
    const order: number[] = [];
    let running = 0;
    let peak = 0;
    const q = createSerialQueue<number>(async (n) => {
      peak = Math.max(peak, ++running);
      await tick();
      order.push(n);
      running--;
    });
    for (let i = 1; i <= 6; i++) q.push("k", i);
    await q.drain("k");
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(1);
  });

  it("drops nothing — every pushed item runs", async () => {
    let count = 0;
    const q = createSerialQueue<number>(async () => { count++; await tick(); });
    for (let i = 0; i < 25; i++) q.push("k", i);
    await q.drain("k");
    expect(count).toBe(25);
  });

  it("a rejected item does not break the chain behind it", async () => {
    const done: number[] = [];
    const q = createSerialQueue<number>(async (n) => {
      if (n === 2) throw new Error("append failed");
      done.push(n);
    });
    q.push("k", 1);
    q.push("k", 2);
    q.push("k", 3);
    await q.drain("k");
    expect(done).toEqual([1, 3]);
  });

  it("keeps keys independent", async () => {
    const seen: string[] = [];
    const q = createSerialQueue<string>(async (s) => { await tick(); seen.push(s); });
    q.push("a", "a1");
    q.push("b", "b1");
    q.push("a", "a2");
    await Promise.all([q.drain("a"), q.drain("b")]);
    expect(seen.filter((s) => s.startsWith("a"))).toEqual(["a1", "a2"]);
    expect(seen).toContain("b1");
  });

  it("drain resolves immediately for an untouched key", async () => {
    const q = createSerialQueue<number>(async () => {});
    await q.drain("nothing-here");
  });

  it("drain covers items pushed while an earlier one was still running", async () => {
    const done: number[] = [];
    let release: (() => void) | null = null;
    const q = createSerialQueue<number>(async (n) => {
      if (n === 1) await new Promise<void>((r) => { release = r; });
      done.push(n);
    });
    q.push("k", 1);
    await tick();
    q.push("k", 2); // arrives while 1 is blocked
    const p = q.drain("k");
    release!();
    await p;
    expect(done).toEqual([1, 2]);
  });
});
