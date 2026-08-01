import { describe, it, expect } from "vitest";
import { PendingUserRows } from "./pending-user-rows.js";

/**
 * The property: a user row is ordered when the box starts processing it, and the row that
 * gets ordered is the one that was actually written for that message — never "whichever
 * row is still unordered", which a replayed echo would silently shift.
 */

describe("PendingUserRows", () => {
  it("hands back rows in the order they were written", () => {
    // A box consumes injected messages in the order it was given them, so arrival order
    // is the right queue order — what changes is WHEN each one is ordered.
    const q = new PendingUserRows();
    q.push("s1", "prompt");
    q.push("s1", "steer-1");
    q.push("s1", "steer-2");
    expect([q.claim("s1"), q.claim("s1"), q.claim("s1")]).toEqual(["prompt", "steer-1", "steer-2"]);
  });

  it("answers nothing for an echo belonging to a turn it never saw", () => {
    // A turn started before a restart, or by another entry point: the caller must then
    // leave the row unordered rather than claim someone else's.
    const q = new PendingUserRows();
    expect(q.claim("unknown")).toBeUndefined();
    q.push("s1", "only");
    q.claim("s1");
    expect(q.claim("s1")).toBeUndefined();
  });

  it("keeps sessions apart", () => {
    const q = new PendingUserRows();
    q.push("s1", "a");
    q.push("s2", "b");
    expect(q.claim("s2")).toBe("b");
    expect(q.claim("s1")).toBe("a");
  });

  it("drops what a finished turn left behind", () => {
    // A steer the user sent into a turn that ended first was never consumed. Leaving it
    // queued would give the NEXT turn's first echo a place it never occupied.
    const q = new PendingUserRows();
    q.push("s1", "never-consumed");
    q.clear("s1");
    expect(q.claim("s1")).toBeUndefined();
  });

  it("bounds a session someone hammers", () => {
    const q = new PendingUserRows();
    for (let i = 0; i < 500; i++) q.push("s1", `m${i}`);
    expect(q.size("s1")).toBe(200);
    expect(q.claim("s1")).toBe("m300"); // oldest dropped, order preserved
  });
});
