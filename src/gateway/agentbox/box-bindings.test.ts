import { describe, it, expect } from "vitest";
import { BoxBindings, type BoxCandidate } from "./box-bindings.js";

/**
 * The rule under test: live work pins a session, nothing else does. A box holding the
 * conversation in memory is the one appending to its transcript, so the turn must go
 * there; once no box holds it, the session is free and goes wherever the load says.
 */

const box = (boxId: string, turnsInFlight = 0, accepting = true): BoxCandidate =>
  ({ boxId, accepting, turnsInFlight });

describe("BoxBindings — a held session goes to its holder", () => {
  it("sends the turn to the box reported to be holding it", () => {
    const b = new BoxBindings();
    const r = b.place("agent", "s1", [box("a"), box("busy", 9)], "busy")!;
    expect(r.boxId).toBe("busy"); // load is irrelevant: that box has the conversation
  });

  it("sends it to the holder even while that box is draining", () => {
    // Draining means "no NEW sessions". It does not mean abandoning a turn in progress.
    const b = new BoxBindings();
    const r = b.place("agent", "s1", [box("old", 0, false), box("new")], "old")!;
    expect(r.boxId).toBe("old");
  });

  it("places freely when the reported holder is no longer in the pool", () => {
    const b = new BoxBindings();
    const r = b.place("agent", "s1", [box("a")], "vanished")!;
    expect(r.boxId).toBe("a");
  });
});

describe("BoxBindings — an unheld session is free", () => {
  it("goes back to its last box when that box is no busier than the rest", () => {
    // Preference, not a rule: returning skips re-initialising MCP and re-creating the
    // per-box debug pod, which a follow-up about the same node would otherwise pay for.
    const b = new BoxBindings();
    b.remember("agent", "s1", "a");
    const r = b.place("agent", "s1", [box("a"), box("b")], undefined)!;
    expect(r.boxId).toBe("a");
    expect(r.bound).toBe(false);
  });

  it("abandons the preference when the last box became the busy one", () => {
    const b = new BoxBindings();
    b.remember("agent", "s1", "a");
    const r = b.place("agent", "s1", [box("a", 7), box("b", 0)], undefined)!;
    expect(r.boxId).toBe("b");
    expect(r.bound).toBe(true);
  });

  it("spreads sessions that have no history across the pool", () => {
    const b = new BoxBindings();
    const placed = ["s1", "s2", "s3"].map((s) => b.place("agent", s, [box("a"), box("b"), box("c")], undefined)!.boxId);
    expect(new Set(placed).size).toBe(3);
  });

  it("prefers the least loaded box over rotation", () => {
    const b = new BoxBindings();
    expect(b.place("agent", "s1", [box("busy", 4), box("idle", 0)], undefined)!.boxId).toBe("idle");
  });

  it("never places onto a box that has stopped accepting", () => {
    const b = new BoxBindings();
    const r = b.place("agent", "s1", [box("draining", 0, false), box("open", 9)], undefined)!;
    expect(r.boxId).toBe("open");
  });

  it("will not send a free session to a box that is about to be removed", () => {
    // The caller has to spawn instead; placing here loses the work moments later.
    const b = new BoxBindings();
    expect(b.place("agent", "s1", [box("draining", 0, false)], undefined)).toBeUndefined();
    expect(b.place("agent", "s1", [], undefined)).toBeUndefined();
  });

  it("ignores a preference pointing at a draining box", () => {
    const b = new BoxBindings();
    b.remember("agent", "s1", "old");
    const r = b.place("agent", "s1", [box("old", 0, false), box("new", 5)], undefined)!;
    expect(r.boxId).toBe("new");
  });
});

describe("BoxBindings — the hint is disposable", () => {
  it("drops hints pointing at boxes that no longer exist", () => {
    const b = new BoxBindings();
    b.remember("agent", "s1", "a");
    b.remember("agent", "s2", "gone");
    b.retainBoxes("agent", new Set(["a"]));
    expect(b.get("agent", "s1")).toBe("a");
    expect(b.get("agent", "s2")).toBeUndefined();
  });

  it("still places correctly with no hint at all", () => {
    // Losing the whole map costs a cold tool environment once, never correctness.
    const b = new BoxBindings();
    expect(b.place("agent", "never-seen", [box("a")], undefined)!.boxId).toBe("a");
  });

  it("keeps agents independent", () => {
    const b = new BoxBindings();
    b.remember("a1", "s", "box-1");
    b.remember("a2", "s", "box-2");
    expect(b.get("a1", "s")).toBe("box-1");
    expect(b.get("a2", "s")).toBe("box-2");
    b.forgetAgent("a1");
    expect(b.get("a1", "s")).toBeUndefined();
    expect(b.get("a2", "s")).toBe("box-2");
  });

  it("bounds the hint map so a long-lived agent cannot grow it forever", () => {
    const b = new BoxBindings();
    for (let i = 0; i < 5_200; i++) b.remember("agent", `s${i}`, "a");
    expect(b.get("agent", "s0")).toBeUndefined();      // oldest evicted
    expect(b.get("agent", "s5199")).toBe("a");         // newest kept
  });
});
