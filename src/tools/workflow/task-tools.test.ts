import { describe, it, expect, beforeEach } from "vitest";
import { resetLedgers } from "../../core/task-ledger.js";
import {
  createTaskCreateTool, createTaskUpdateTool, createTaskListTool, createTaskGetTool,
  taskCreateRegistration, taskUpdateRegistration, taskListRegistration, taskGetRegistration,
} from "./task-tools.js";

const TLID = "sess-test";
const text = (r: any) => (r.content[0] as any).text as string;

describe("task tools — sub-agent gating", () => {
  it("hides every task tool from a spawned sub-agent (plan is parent-owned)", () => {
    const regs = [taskCreateRegistration, taskUpdateRegistration, taskListRegistration, taskGetRegistration];
    for (const reg of regs) {
      expect(reg.available?.({ isSubagent: true } as any)).toBe(false);
      expect(reg.available?.({ isSubagent: false } as any)).toBe(true);
      expect(reg.available?.({} as any)).toBe(true); // default (top-level) = available
    }
  });
});

describe("task tools", () => {
  beforeEach(() => resetLedgers());

  it("task_create returns the new id and subject", async () => {
    const t = createTaskCreateTool(TLID);
    const r = await t.execute("c1", { subject: "list nodes", description: "kubectl get nodes" });
    expect(text(r)).toContain("#1");
    expect(text(r)).toContain("list nodes");
  });

  it("task_create rejects an empty/whitespace subject", async () => {
    const t = createTaskCreateTool(TLID);
    const r = await t.execute("c1", { subject: "   ", description: "x" });
    expect((r as any).details?.error).toBe(true);
    expect(text(r)).toContain("non-empty subject");
  });

  it("task_update marks status and is reflected by task_get", async () => {
    await createTaskCreateTool(TLID).execute("c1", { subject: "a", description: "" });
    await createTaskUpdateTool(TLID).execute("u1", { id: "1", status: "completed" });
    const r = await createTaskGetTool(TLID).execute("g1", { id: "1" });
    expect(text(r)).toContain("completed");
  });

  it("task_update status=deleted removes the task", async () => {
    await createTaskCreateTool(TLID).execute("c1", { subject: "a", description: "" });
    await createTaskUpdateTool(TLID).execute("u1", { id: "1", status: "deleted" });
    const r = await createTaskGetTool(TLID).execute("g1", { id: "1" });
    expect(text(r)).toContain("not found");
  });

  it("task_create emits an upsert task_event with the snapshot", async () => {
    const events: any[] = [];
    const t = createTaskCreateTool(TLID, (e) => events.push(e));
    await t.execute("c1", { subject: "list nodes", description: "kubectl get nodes" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "task_event",
      taskListId: TLID,
      action: "upsert",
      task: { id: "1", subject: "list nodes", status: "pending" },
    });
  });

  it("task_update emits upsert; delete emits a delete event with the id", async () => {
    const events: any[] = [];
    const emit = (e: any) => events.push(e);
    await createTaskCreateTool(TLID, emit).execute("c1", { subject: "a", description: "" });
    await createTaskUpdateTool(TLID, emit).execute("u1", { id: "1", status: "completed" });
    await createTaskUpdateTool(TLID, emit).execute("u2", { id: "1", status: "deleted" });
    expect(events[1]).toMatchObject({ action: "upsert", task: { id: "1", status: "completed" } });
    expect(events[2]).toMatchObject({ action: "delete", taskId: "1" });
  });

  it("task_list shows ready vs blocked with waiting-on ids (deps set via task_update)", async () => {
    const c = createTaskCreateTool(TLID);
    await c.execute("c1", { subject: "n", description: "" });               // #1
    await c.execute("c2", { subject: "correlate", description: "" });       // #2
    // Dependencies are set after creation by real id (CC-aligned), never at create time.
    await createTaskUpdateTool(TLID).execute("u1", { id: "2", addBlockedBy: ["1"] });
    const r = await createTaskListTool(TLID).execute("l1", {});
    const out = text(r);
    expect(out).toMatch(/#1.*ready/i);
    expect(out).toMatch(/#2.*blocked/i);
    expect(out).toContain("waiting on #1");
  });

  it("task_update on an unknown id returns an error result (not a silent ok)", async () => {
    const r = await createTaskUpdateTool(TLID).execute("u1", { id: "999", status: "completed" });
    expect((r as any).details?.error).toBe(true);
    expect(text(r)).toContain("not found");
  });
});

// The array form exists to collapse model round-trips, not ledger writes: a plan of N tasks used to
// cost N round-trips. These pin that one call creates N tasks, that the single-item shape still
// lands (a bounced call would cost the very round-trip being saved), and that a rejected batch
// leaves NOTHING behind — a half-written plan is worse than none, because the model cannot tell
// which half landed.
describe("task tools — batch form", () => {
  beforeEach(() => resetLedgers());

  it("task_create creates every task in one call and reports each id", async () => {
    const r = await createTaskCreateTool(TLID).execute("c1", {
      tasks: [
        { subject: "check pod status", description: "kubectl get pod -o json" },
        { subject: "check node", description: "kubectl get node" },
        { subject: "correlate", description: "" },
      ],
    });
    const out = text(r);
    expect(out).toContain("#1");
    expect(out).toContain("#2");
    expect(out).toContain("#3");
    expect(out).toContain("check pod status");
    const list = text(await createTaskListTool(TLID).execute("l1", {}));
    expect(list).toMatch(/#1/);
    expect(list).toMatch(/#3/);
  });

  it("task_create emits one task_event per task, so the plan panel still ticks task by task", async () => {
    const events: any[] = [];
    await createTaskCreateTool(TLID, (e) => events.push(e)).execute("c1", {
      tasks: [
        { subject: "a", description: "" },
        { subject: "b", description: "" },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "upsert", task: { id: "1", subject: "a" } });
    expect(events[1]).toMatchObject({ action: "upsert", task: { id: "2", subject: "b" } });
  });

  it("task_create rejects the whole batch on one bad entry and creates nothing", async () => {
    const events: any[] = [];
    const r = await createTaskCreateTool(TLID, (e) => events.push(e)).execute("c1", {
      tasks: [
        { subject: "good", description: "" },
        { subject: "  ", description: "" },
      ],
    });
    expect((r as any).details?.error).toBe(true);
    expect(text(r)).toContain("tasks[1]");
    expect(events).toHaveLength(0);
    expect(text(await createTaskListTool(TLID).execute("l1", {}))).toContain("plan is empty");
  });

  it("task_create with neither tasks nor subject is an error, not an empty success", async () => {
    const r = await createTaskCreateTool(TLID).execute("c1", {});
    expect((r as any).details?.error).toBe(true);
    expect(text(r)).toContain("tasks");
  });

  it("task_update applies several updates in one call", async () => {
    await createTaskCreateTool(TLID).execute("c1", {
      tasks: [{ subject: "a", description: "" }, { subject: "b", description: "" }],
    });
    const r = await createTaskUpdateTool(TLID).execute("u1", {
      updates: [
        { id: "1", status: "completed" },
        { id: "2", status: "in_progress" },
      ],
    });
    expect(text(r)).toContain("#1");
    expect(text(r)).toContain("#2");
    expect(text(await createTaskGetTool(TLID).execute("g1", { id: "1" }))).toContain("completed");
    expect(text(await createTaskGetTool(TLID).execute("g2", { id: "2" }))).toContain("in_progress");
  });

  it("a partly-valid task_update batch is NOT a failed call — good entries land, bad ones are named", async () => {
    await createTaskCreateTool(TLID).execute("c1", { tasks: [{ subject: "a", description: "" }] });
    const r = await createTaskUpdateTool(TLID).execute("u1", {
      updates: [
        { id: "1", status: "completed" },
        { id: "999", status: "completed" },
      ],
    });
    expect((r as any).details?.error).toBeUndefined();
    expect(text(r)).toContain("Updated task #1");
    expect(text(r)).toContain("#999");
    expect(text(r)).toContain("not found");
  });

  it("a task_update batch where nothing applied IS a failed call", async () => {
    const r = await createTaskUpdateTool(TLID).execute("u1", {
      updates: [{ id: "998" }, { id: "999" }],
    });
    expect((r as any).details?.error).toBe(true);
    expect(text(r)).toContain("not found");
  });

  it("task_update mixes delete and status in one batch", async () => {
    await createTaskCreateTool(TLID).execute("c1", {
      tasks: [{ subject: "a", description: "" }, { subject: "b", description: "" }],
    });
    await createTaskUpdateTool(TLID).execute("u1", {
      updates: [{ id: "1", status: "deleted" }, { id: "2", status: "completed" }],
    });
    expect(text(await createTaskGetTool(TLID).execute("g1", { id: "1" }))).toContain("not found");
    expect(text(await createTaskGetTool(TLID).execute("g2", { id: "2" }))).toContain("completed");
  });

  it("refuses an oversized batch and creates nothing", async () => {
    // Taking an array removed the implicit bound that N tasks cost N round-trips. One confused call
    // could otherwise write hundreds of rows, since every task emits a persisted task_event.
    const events: any[] = [];
    const tasks = Array.from({ length: 51 }, (_, i) => ({ subject: `t${i}`, description: "" }));
    const r = await createTaskCreateTool(TLID, (e) => events.push(e)).execute("c1", { tasks });
    expect((r as any).details?.error).toBe(true);
    expect(text(r)).toContain("at most 50");
    expect(events).toHaveLength(0);
    expect(text(await createTaskListTool(TLID).execute("l1", {}))).toContain("plan is empty");
  });

  it("accepts a batch right at the limit", async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ subject: `t${i}`, description: "" }));
    const r = await createTaskCreateTool(TLID).execute("c1", { tasks });
    expect((r as any).details?.error).toBeUndefined();
    expect(text(r)).toContain("#50");
  });

  it("refuses an oversized task_update batch and applies nothing", async () => {
    await createTaskCreateTool(TLID).execute("c1", { tasks: [{ subject: "a", description: "" }] });
    const updates = Array.from({ length: 51 }, () => ({ id: "1", status: "completed" as const }));
    const r = await createTaskUpdateTool(TLID).execute("u1", { updates });
    expect((r as any).details?.error).toBe(true);
    expect(text(r)).toContain("at most 50");
    expect(text(await createTaskGetTool(TLID).execute("g1", { id: "1" }))).toContain("pending");
  });

  it("an empty array falls back to the single-item form rather than silently doing nothing", async () => {
    const r = await createTaskCreateTool(TLID).execute("c1", {
      tasks: [], subject: "fallback", description: "",
    });
    expect(text(r)).toContain("fallback");
    expect((r as any).details?.error).toBeUndefined();
  });
});
