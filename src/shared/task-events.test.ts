import { describe, it, expect } from "vitest";
import { isTaskEvent, buildTaskEventChatMessage, type TaskEvent } from "./task-events.js";

describe("task-events", () => {
  it("isTaskEvent recognizes task_event and rejects others", () => {
    expect(isTaskEvent({ kind: "task_event", taskListId: "x", action: "upsert" })).toBe(true);
    expect(isTaskEvent({ kind: "tool_call" })).toBe(false);
    expect(isTaskEvent({})).toBe(false);
  });

  it("builds an upsert chat message with task_event metadata", () => {
    const ev: TaskEvent = {
      kind: "task_event",
      taskListId: "tl-1",
      action: "upsert",
      task: { id: "3", subject: "check disks", description: "", status: "in_progress", blockedBy: [] },
    };
    const msg = buildTaskEventChatMessage("sess-1", ev);
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.role).toBe("user");
    expect(msg.content).toContain("#3");
    expect(msg.content).toContain("in_progress");
    expect((msg.metadata as any).kind).toBe("task_event");
    expect((msg.metadata as any).task.id).toBe("3");
  });

  it("builds a delete chat message carrying the id", () => {
    const ev: TaskEvent = { kind: "task_event", taskListId: "tl-1", action: "delete", taskId: "3" };
    const msg = buildTaskEventChatMessage("sess-1", ev);
    expect(msg.content).toContain("#3");
    expect(msg.content).toContain("deleted");
    expect((msg.metadata as any).action).toBe("delete");
  });
});
