import { describe, it, expect } from "vitest";
import { createCoalescedWriter } from "./coalesced-write.js";

const tick = () => new Promise((r) => setImmediate(r));
/** Enough turns of the microtask/immediate queue for a short chain of writes to drain. */
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
