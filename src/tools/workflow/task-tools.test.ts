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

  it("starting a new plan after the previous one fully completed emits a reset before the new task", async () => {
    const events: any[] = [];
    const emit = (e: any) => events.push(e);
    const create = createTaskCreateTool(TLID, emit);
    await create.execute("c1", { subject: "step one", description: "" });        // upsert #1
    await createTaskUpdateTool(TLID, emit).execute("u1", { id: "1", status: "completed" }); // upsert #1 completed
    // Plan is now fully completed → the next create starts a NEW plan.
    const r = await create.execute("c2", { subject: "step two", description: "" });
    expect(events.map((e) => e.action)).toEqual(["upsert", "upsert", "reset", "upsert"]);
    // clear() keeps the id high-water-mark, so the new task continues the sequence.
    expect(events[3]).toMatchObject({ action: "upsert", task: { id: "2", subject: "step two" } });
    expect(text(r)).toContain("#2");
  });

  it("creating a second task while the first is still incomplete does NOT emit a reset", async () => {
    const events: any[] = [];
    const create = createTaskCreateTool(TLID, (e) => events.push(e));
    await create.execute("c1", { subject: "a", description: "" }); // pending
    await create.execute("c2", { subject: "b", description: "" }); // plan not all-completed → no reset
    expect(events.map((e) => e.action)).toEqual(["upsert", "upsert"]);
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
