import { describe, it, expect } from "vitest";
import { TaskLedger, getOrCreateLedger, deleteLedger, resetLedgers } from "./task-ledger.js";

describe("TaskLedger — snapshot / hydrate (durability)", () => {
  it("round-trips tasks and restores the id sequence so new ids continue past the max", () => {
    const a = new TaskLedger();
    a.create({ subject: "t1", description: "" });            // #1
    a.create({ subject: "t2", description: "" });            // #2
    a.update("2", { status: "in_progress", addBlockedBy: ["1"] });
    const snap = a.snapshot();

    const b = new TaskLedger();
    b.hydrate(snap);
    expect(b.size).toBe(2);
    expect(b.get("2")?.status).toBe("in_progress");
    expect(b.get("2")?.blockedBy).toEqual(["1"]);
    // next create must not collide with restored ids
    expect(b.create({ subject: "t3", description: "" }).id).toBe("3");
  });

  it("allCompleted() is true only when non-empty and every task completed", () => {
    const l = new TaskLedger();
    expect(l.allCompleted()).toBe(false);          // empty
    l.create({ subject: "a", description: "" });    // #1 pending
    l.create({ subject: "b", description: "" });    // #2 pending
    expect(l.allCompleted()).toBe(false);
    l.update("1", { status: "completed" });
    expect(l.allCompleted()).toBe(false);           // #2 still pending
    l.update("2", { status: "completed" });
    expect(l.allCompleted()).toBe(true);
  });

  it("addBlockedBy ignores a self-reference (a task can't block itself) and dedupes", () => {
    const l = new TaskLedger();
    l.create({ subject: "a", description: "" }); // #1
    // Self-block + duplicate: "1" is dropped (self), "2" added once even if repeated.
    l.create({ subject: "b", description: "" }); // #2
    l.update("2", { addBlockedBy: ["2", "1", "1"] });
    expect(l.get("2")?.blockedBy).toEqual(["1"]); // no "2" (self), "1" once
  });

  it("clear() empties tasks but keeps the id sequence (next id continues, no reuse)", () => {
    const l = new TaskLedger();
    l.create({ subject: "a", description: "" });    // #1
    l.create({ subject: "b", description: "" });    // #2
    l.clear();
    expect(l.size).toBe(0);
    expect(l.allCompleted()).toBe(false);
    expect(l.create({ subject: "c", description: "" }).id).toBe("3"); // continues, not "1"
  });

  it("deleteLedger drops the shared ledger; getOrCreateLedger then returns a fresh one", () => {
    resetLedgers();
    const l1 = getOrCreateLedger("sess-x");
    l1.create({ subject: "a", description: "" });
    expect(getOrCreateLedger("sess-x")).toBe(l1);   // same instance while alive
    deleteLedger("sess-x");
    expect(getOrCreateLedger("sess-x").size).toBe(0); // fresh, empty
  });
});

describe("TaskLedger", () => {
  it("creates tasks with monotonic numeric ids and pending status", () => {
    const l = new TaskLedger();
    const a = l.create({ subject: "list nodes", description: "kubectl get nodes" });
    const b = l.create({ subject: "check disks", description: "df on each node" });
    expect(a.id).toBe("1");
    expect(b.id).toBe("2");
    expect(a.status).toBe("pending");
    expect(a.blockedBy).toEqual([]);
  });

  it("ids stay monotonic after deletion (no reuse)", () => {
    const l = new TaskLedger();
    l.create({ subject: "a", description: "" });
    l.create({ subject: "b", description: "" });
    l.delete("2");
    const c = l.create({ subject: "c", description: "" });
    expect(c.id).toBe("3");
  });

  it("update changes fields and status; delete removes", () => {
    const l = new TaskLedger();
    l.create({ subject: "a", description: "" });
    const u = l.update("1", { status: "in_progress", owner: "sub-agent-1" });
    expect(u?.status).toBe("in_progress");
    expect(u?.owner).toBe("sub-agent-1");
    expect(l.delete("1")).toBe(true);
    expect(l.get("1")).toBeUndefined();
  });

  it("list computes ready: pending task with no incomplete blockers is ready", () => {
    const l = new TaskLedger();
    l.create({ subject: "n", description: "" });           // #1
    l.create({ subject: "p", description: "" });           // #2
    l.create({ subject: "correlate", description: "", blockedBy: ["1", "2"] }); // #3
    let view = l.list();
    expect(view.find(t => t.id === "1")!.ready).toBe(true);
    expect(view.find(t => t.id === "3")!.ready).toBe(false); // blocked by 1,2
    l.update("1", { status: "completed" });
    l.update("2", { status: "completed" });
    view = l.list();
    const t3 = view.find(t => t.id === "3")!;
    expect(t3.ready).toBe(true);                  // blockers complete -> ready
    expect(t3.blockedBy).toEqual([]);             // completed blockers filtered from view
  });

  it("list derives blocks (reverse of blockedBy)", () => {
    const l = new TaskLedger();
    l.create({ subject: "n", description: "" });           // #1
    l.create({ subject: "c", description: "", blockedBy: ["1"] }); // #2
    const t1 = l.list().find(t => t.id === "1")!;
    expect(t1.blocks).toEqual(["2"]);
  });

  it("getOrCreateLedger returns the same instance per taskListId", () => {
    resetLedgers();
    const a = getOrCreateLedger("sess-1");
    const b = getOrCreateLedger("sess-1");
    const c = getOrCreateLedger("sess-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
