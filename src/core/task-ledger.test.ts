import { describe, it, expect } from "vitest";
import { TaskLedger, getOrCreateLedger, resetLedgers } from "./task-ledger.js";

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
