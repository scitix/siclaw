import { describe, it, expect } from "vitest";
import { BoxBindings, type BoxCandidate } from "./box-bindings.js";

/**
 * The property under test throughout: a session that is being served never changes box.
 * Everything else here is in service of that — a moved session loses its background jobs,
 * whose abort handles are in-memory closures and cannot follow it.
 */

const box = (boxId: string, turnsInFlight = 0, accepting = true): BoxCandidate =>
  ({ boxId, accepting, turnsInFlight });

const none = new Set<string>();

describe("BoxBindings — placement", () => {
  it("binds a new session and keeps it there on every later call", () => {
    const b = new BoxBindings();
    const pool = [box("a"), box("b")];
    const first = b.place("agent", "s1", pool, none)!;
    expect(first.bound).toBe(true);

    for (let i = 0; i < 5; i++) {
      const again = b.place("agent", "s1", pool, none)!;
      expect(again.boxId).toBe(first.boxId);
      expect(again.bound).toBe(false); // affinity, not a re-placement
    }
  });

  it("rotates across boxes instead of stacking every session on the least loaded", () => {
    // in-flight turns is a SAMPLE: without rotation a burst placed between two
    // observations would all land on whichever box happened to read as idle.
    const b = new BoxBindings();
    const pool = [box("a"), box("b"), box("c")];
    const placed = ["s1", "s2", "s3"].map((s) => b.place("agent", s, pool, none)!.boxId);
    expect(new Set(placed).size).toBe(3);
  });

  it("prefers the box with fewer in-flight turns", () => {
    const b = new BoxBindings();
    const chosen = b.place("agent", "s1", [box("busy", 4), box("idle", 0)], none)!;
    expect(chosen.boxId).toBe("idle");
  });

  it("never places onto a box that has stopped accepting", () => {
    const b = new BoxBindings();
    const chosen = b.place("agent", "s1", [box("draining", 0, false), box("open", 9)], none)!;
    expect(chosen.boxId).toBe("open");
  });

  it("returns undefined when no box can take the session, rather than picking a draining one", () => {
    // The caller has to spawn; placing here would lose the work moments later.
    const b = new BoxBindings();
    expect(b.place("agent", "s1", [box("draining", 0, false)], none)).toBeUndefined();
    expect(b.place("agent", "s1", [], none)).toBeUndefined();
  });
});

describe("BoxBindings — affinity survives a drain", () => {
  it("keeps a bound session on its box even after the box stops accepting", () => {
    // Draining means "no NEW sessions", not "abandon what you are holding".
    const b = new BoxBindings();
    b.bind("agent", "s1", "a");
    const r = b.place("agent", "s1", [box("a", 0, false), box("b")], new Set(["s1"]))!;
    expect(r.boxId).toBe("a");
    expect(r.bound).toBe(false);
  });

  it("re-places a session whose box has disappeared", () => {
    const b = new BoxBindings();
    b.bind("agent", "s1", "gone");
    const r = b.place("agent", "s1", [box("b")], none)!;
    expect(r.boxId).toBe("b");
    expect(r.bound).toBe(true);
  });

  it("declines to place a session that is resident somewhere it has no binding for", () => {
    // The Runtime restarted and lost the table. Placing it fresh would send a live
    // conversation to a box holding none of its state; the caller must adopt instead.
    const b = new BoxBindings();
    expect(b.place("agent", "s1", [box("a")], new Set(["s1"]))).toBeUndefined();
  });
});

describe("BoxBindings — rebalancing off a draining box", () => {
  it("moves only the sessions the box has released", () => {
    const b = new BoxBindings();
    b.bind("agent", "resident", "old");
    b.bind("agent", "released", "old");
    const moved = b.rebalanceOff("agent", "old", [box("old", 0, false), box("new")], new Set(["resident"]));

    expect(moved).toEqual(["released"]);
    expect(b.get("agent", "released")).toBe("new");
    // Still in memory → still has state → not movable, whatever the drain wants.
    expect(b.get("agent", "resident")).toBe("old");
  });

  it("leaves bindings alone when there is nowhere to move them", () => {
    const b = new BoxBindings();
    b.bind("agent", "s1", "old");
    expect(b.rebalanceOff("agent", "old", [box("old", 0, false)], none)).toEqual([]);
    expect(b.get("agent", "s1")).toBe("old");
  });
});

describe("BoxBindings — bookkeeping", () => {
  it("drops bindings to boxes that no longer exist", () => {
    const b = new BoxBindings();
    b.bind("agent", "s1", "a");
    b.bind("agent", "s2", "gone");
    b.retainBoxes("agent", new Set(["a"]));
    expect(b.get("agent", "s1")).toBe("a");
    expect(b.get("agent", "s2")).toBeUndefined();
  });

  it("reports what each box holds", () => {
    const b = new BoxBindings();
    b.bind("agent", "s1", "a");
    b.bind("agent", "s2", "a");
    b.bind("agent", "s3", "b");
    expect(b.sessionsOn("agent", "a").sort()).toEqual(["s1", "s2"]);
    expect(Object.fromEntries(b.countsByBox("agent"))).toEqual({ a: 2, b: 1 });
  });

  it("keeps agents independent", () => {
    const b = new BoxBindings();
    b.bind("a1", "s", "box-1");
    b.bind("a2", "s", "box-2");
    expect(b.get("a1", "s")).toBe("box-1");
    expect(b.get("a2", "s")).toBe("box-2");
    b.forget("a1");
    expect(b.get("a1", "s")).toBeUndefined();
    expect(b.get("a2", "s")).toBe("box-2");
  });
});
