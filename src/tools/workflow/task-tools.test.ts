import { describe, it, expect, beforeEach } from "vitest";
import { resetLedgers } from "../../core/task-ledger.js";
import {
  createTaskCreateTool, createTaskUpdateTool, createTaskListTool, createTaskGetTool,
} from "./task-tools.js";

const TLID = "sess-test";
const text = (r: any) => (r.content[0] as any).text as string;

describe("task tools", () => {
  beforeEach(() => resetLedgers());

  it("task_create returns the new id and subject", async () => {
    const t = createTaskCreateTool(TLID);
    const r = await t.execute("c1", { subject: "list nodes", description: "kubectl get nodes" });
    expect(text(r)).toContain("#1");
    expect(text(r)).toContain("list nodes");
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

  it("task_list shows ready vs blocked with waiting-on ids", async () => {
    const c = createTaskCreateTool(TLID);
    await c.execute("c1", { subject: "n", description: "" });               // #1
    await c.execute("c2", { subject: "correlate", description: "", blockedBy: ["1"] }); // #2
    const r = await createTaskListTool(TLID).execute("l1", {});
    const out = text(r);
    expect(out).toMatch(/#1.*ready/i);
    expect(out).toMatch(/#2.*blocked/i);
    expect(out).toContain("waiting on #1");
  });
});
