import { describe, expect, it, vi } from "vitest";
import type { SiclawA2aApi, SiclawTask } from "./a2a-client.js";
import { createToolHandler, TOOL_DEFINITIONS } from "./tools.js";

function task(state: SiclawTask["state"] = "working"): SiclawTask {
  return {
    task_id: "task-1",
    context_id: "context-1",
    state,
    a2a_state: state === "completed" ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING",
    is_terminal: state === "completed",
    status_message: state === "completed" ? "completed" : "working",
    result: state === "completed" ? "root cause" : null,
    error: null,
    updated_at: null,
  };
}

function fakeApi(): SiclawA2aApi {
  return {
    sendMessage: vi.fn(async () => task()),
    getTask: vi.fn(async () => task("completed")),
    cancelTask: vi.fn(async () => ({ ...task(), state: "canceled", a2a_state: "TASK_STATE_CANCELED", is_terminal: true })),
    listTasks: vi.fn(async () => ({ tasks: [task()], total_size: 1, page_size: 20, next_page_token: null })),
    waitForTask: vi.fn(async () => task("completed")),
  };
}

describe("tool contract", () => {
  it("keeps the configured agent out of every model-visible input schema", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "siclaw_investigate",
      "siclaw_wait_task",
      "siclaw_get_task",
      "siclaw_cancel_task",
      "siclaw_list_tasks",
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.properties).not.toHaveProperty("agent_id");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("submits and waits for a bounded investigation", async () => {
    const api = fakeApi();
    const handle = createToolHandler(api);
    const result = await handle("siclaw_investigate", {
      question: "check node",
      context_id: "context-1",
      wait_seconds: 5,
    });
    expect(api.sendMessage).toHaveBeenCalledWith("check node", "context-1");
    expect(api.waitForTask).toHaveBeenCalledWith("task-1", 5);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ state: "completed", result: "root cause" });
  });

  it("maps simple list status to the A2A enum", async () => {
    const api = fakeApi();
    const handle = createToolHandler(api);
    const result = await handle("siclaw_list_tasks", { status: "working", page_size: 10 });
    expect(api.listTasks).toHaveBeenCalledWith({
      contextId: undefined,
      status: "TASK_STATE_WORKING",
      pageSize: 10,
      pageToken: 0,
    });
    expect(result.structuredContent).toMatchObject({ total_size: 1 });
  });

  it("waits on an existing task without submitting another investigation", async () => {
    const api = fakeApi();
    const handle = createToolHandler(api);
    const result = await handle("siclaw_wait_task", {
      task_id: "task-1",
      wait_seconds: 45,
    });
    expect(api.waitForTask).toHaveBeenCalledWith("task-1", 45);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ state: "completed", result: "root cause" });
  });

  it("keeps a working response compact until the terminal result", async () => {
    const api = fakeApi();
    vi.mocked(api.getTask).mockResolvedValue({
      ...task(),
      result: "partial evidence that should not be repeated",
      updated_at: "2026-07-18T00:00:00.000Z",
    });
    const result = await createToolHandler(api)("siclaw_get_task", { task_id: "task-1" });
    expect(result.content[0].text).not.toContain("partial evidence that should not be repeated");
    expect(result.content[0].text).toContain("siclaw_wait_task");
    expect(result.structuredContent).toMatchObject({
      state: "working",
      progress_chars: 44,
    });
    expect(result.structuredContent).not.toHaveProperty("result");
  });

  it("returns MCP tool errors for invalid arguments", async () => {
    const result = await createToolHandler(fakeApi())("siclaw_get_task", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/task_id/);
  });

  it("keeps waits below common MCP client request timeouts", async () => {
    const result = await createToolHandler(fakeApi())("siclaw_investigate", {
      question: "check node",
      wait_seconds: 51,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/between 0 and 50/);

    const waitResult = await createToolHandler(fakeApi())("siclaw_wait_task", {
      task_id: "task-1",
      wait_seconds: 51,
    });
    expect(waitResult.isError).toBe(true);
    expect(waitResult.content[0].text).toMatch(/between 1 and 50/);
  });
});
