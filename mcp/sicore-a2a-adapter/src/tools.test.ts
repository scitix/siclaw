import { describe, expect, it, vi } from "vitest";
import type { SiclawA2aApi, SiclawTask } from "./a2a-client.js";
import { AgentRouter } from "./router.js";
import { buildToolDefinitions, createToolHandler } from "./tools.js";

function task(state: SiclawTask["state"] = "working", taskId = "task-1"): SiclawTask {
  return {
    task_id: taskId,
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

function fakeApi(overrides: Partial<SiclawA2aApi> = {}): SiclawA2aApi {
  return {
    sendMessage: vi.fn(async () => task()),
    getTask: vi.fn(async () => task("completed")),
    cancelTask: vi.fn(async () => ({ ...task(), state: "canceled", a2a_state: "TASK_STATE_CANCELED", is_terminal: true })),
    listTasks: vi.fn(async () => ({ tasks: [task()], total_size: 1, page_size: 20, next_page_token: null })),
    waitForTask: vi.fn(async () => task("completed")),
    ...overrides,
  };
}

function router(entries: Array<[string, SiclawA2aApi]>): AgentRouter {
  return new AgentRouter(entries.map(([alias, api]) => ({ alias, agentId: `agent-${alias}`, api })));
}

function singleRouter(api: SiclawA2aApi = fakeApi()): AgentRouter {
  return router([["default", api]]);
}

describe("tool contract", () => {
  it("keeps agent aliases, never a key parameter, in every model-visible input schema", () => {
    const defs = buildToolDefinitions(singleRouter());
    expect(defs.map((tool) => tool.name)).toEqual([
      "siclaw_investigate",
      "siclaw_wait_task",
      "siclaw_get_task",
      "siclaw_cancel_task",
      "siclaw_list_tasks",
    ]);
    for (const tool of defs) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      expect(properties).not.toHaveProperty("agent_id");
      expect(properties).not.toHaveProperty("key");
      expect(properties).not.toHaveProperty("api_key");
      expect(properties).toHaveProperty("agent");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      expect(required).not.toContain("agent");
    }
  });

  it("injects the configured aliases and agent ids into descriptions", () => {
    const defs = buildToolDefinitions(router([["sre", fakeApi()], ["kb", fakeApi()]]));
    const investigate = defs.find((tool) => tool.name === "siclaw_investigate")!;
    expect(investigate.description).toContain("sre = agent-sre");
    expect(investigate.description).toContain("kb = agent-kb");
    expect(investigate.description).toMatch(/must pass "agent"/);
    const list = defs.find((tool) => tool.name === "siclaw_list_tasks")!;
    expect(list.description).toMatch(/aggregates tasks from every configured agent/);
  });

  it("submits and waits for a bounded investigation and tags the agent", async () => {
    const api = fakeApi();
    const handle = createToolHandler(singleRouter(api));
    const result = await handle("siclaw_investigate", {
      question: "check node",
      context_id: "context-1",
      wait_seconds: 5,
    });
    expect(api.sendMessage).toHaveBeenCalledWith("check node", "context-1");
    expect(api.waitForTask).toHaveBeenCalledWith("task-1", 5);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ state: "completed", result: "root cause", agent: "default" });
  });

  it("maps simple list status to the A2A enum", async () => {
    const api = fakeApi();
    const handle = createToolHandler(singleRouter(api));
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
    const handle = createToolHandler(singleRouter(api));
    const result = await handle("siclaw_wait_task", {
      task_id: "task-1",
      wait_seconds: 45,
    });
    expect(api.waitForTask).toHaveBeenCalledWith("task-1", 45);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ state: "completed", result: "root cause", agent: "default" });
  });

  it("keeps a working response compact until the terminal result", async () => {
    const api = fakeApi();
    vi.mocked(api.getTask).mockResolvedValue({
      ...task(),
      result: "partial evidence that should not be repeated",
      updated_at: "2026-07-18T00:00:00.000Z",
    });
    const result = await createToolHandler(singleRouter(api))("siclaw_get_task", { task_id: "task-1" });
    expect(result.content[0].text).not.toContain("partial evidence that should not be repeated");
    expect(result.content[0].text).toContain("siclaw_wait_task");
    expect(result.structuredContent).toMatchObject({
      state: "working",
      progress_chars: 44,
    });
    expect(result.structuredContent).not.toHaveProperty("result");
  });

  it("keeps the submitted task_id when the bounded wait fails after submission", async () => {
    const api = fakeApi();
    vi.mocked(api.waitForTask).mockRejectedValue(new Error("Sicore A2A request timed out"));
    const result = await createToolHandler(singleRouter(api))("siclaw_investigate", { question: "check node" });

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      task_id: "task-1",
      state: "working",
      wait_error: "Sicore A2A request timed out",
    });
    expect(result.content[0].text).toContain("task-1");
    expect(result.content[0].text).toContain("wait_error: Sicore A2A request timed out");
    expect(result.content[0].text).toContain("do not submit the same investigation again");
  });

  it("returns MCP tool errors for invalid arguments", async () => {
    const result = await createToolHandler(singleRouter())("siclaw_get_task", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/task_id/);
  });

  it("keeps waits below common MCP client request timeouts", async () => {
    const result = await createToolHandler(singleRouter())("siclaw_investigate", {
      question: "check node",
      wait_seconds: 51,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/between 0 and 50/);

    const waitResult = await createToolHandler(singleRouter())("siclaw_wait_task", {
      task_id: "task-1",
      wait_seconds: 51,
    });
    expect(waitResult.isError).toBe(true);
    expect(waitResult.content[0].text).toMatch(/between 1 and 50/);
  });
});

describe("multi-key routing", () => {
  it("refuses to guess when several agents are configured and none is named", async () => {
    const handle = createToolHandler(router([["sre", fakeApi()], ["kb", fakeApi()]]));
    const result = await handle("siclaw_investigate", { question: "check node" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Multiple Siclaw agents/);
    expect(result.content[0].text).toContain("sre = agent-sre");
    expect(result.content[0].text).toContain("kb = agent-kb");
  });

  it("rejects an unknown alias and lists valid ones without leaking a key", async () => {
    const handle = createToolHandler(router([["sre", fakeApi()], ["kb", fakeApi()]]));
    const result = await handle("siclaw_investigate", { question: "check node", agent: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown agent alias "nope"/);
    expect(result.content[0].text).toContain("sre = agent-sre");
  });

  it("routes a named investigation to that agent only", async () => {
    const sre = fakeApi();
    const kb = fakeApi();
    const handle = createToolHandler(router([["sre", sre], ["kb", kb]]));
    const result = await handle("siclaw_investigate", { question: "check node", agent: "kb", wait_seconds: 0 });
    expect(kb.sendMessage).toHaveBeenCalledWith("check node", undefined);
    expect(sre.sendMessage).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ agent: "kb" });
  });

  it("auto-routes a follow-up task op to the agent that created the task", async () => {
    const sre = fakeApi();
    const kb = fakeApi();
    const handle = createToolHandler(router([["sre", sre], ["kb", kb]]));
    await handle("siclaw_investigate", { question: "check node", agent: "kb", wait_seconds: 0 });

    const waited = await handle("siclaw_wait_task", { task_id: "task-1", wait_seconds: 5 });
    expect(kb.waitForTask).toHaveBeenCalledWith("task-1", 5);
    expect(sre.waitForTask).not.toHaveBeenCalled();
    expect(waited.structuredContent).toMatchObject({ agent: "kb" });
    expect(waited.structuredContent).not.toHaveProperty("routing_note");
  });

  it("honors the recorded creator over a mismatched agent argument and notes the override", async () => {
    const sre = fakeApi();
    const kb = fakeApi();
    const handle = createToolHandler(router([["sre", sre], ["kb", kb]]));
    await handle("siclaw_investigate", { question: "check node", agent: "kb", wait_seconds: 0 });

    const got = await handle("siclaw_get_task", { task_id: "task-1", agent: "sre" });
    expect(kb.getTask).toHaveBeenCalledWith("task-1");
    expect(sre.getTask).not.toHaveBeenCalled();
    expect(got.structuredContent).toMatchObject({ agent: "kb" });
    expect((got.structuredContent as { routing_note?: string }).routing_note)
      .toMatch(/Routed to agent "kb".*ignored agent="sre"/);
    expect(got.content[0].text).toContain("routing_note:");
  });

  it("refuses an untracked task op that cannot be attributed to one agent", async () => {
    const handle = createToolHandler(router([["sre", fakeApi()], ["kb", fakeApi()]]));
    const result = await handle("siclaw_cancel_task", { task_id: "ghost" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/was not created in this session/);
  });

  it("aggregates list_tasks across every agent and tags each row", async () => {
    const sre = fakeApi({
      listTasks: vi.fn(async () => ({ tasks: [task("working", "sre-1")], total_size: 1, page_size: 20, next_page_token: 20 })),
    });
    const kb = fakeApi({
      listTasks: vi.fn(async () => ({ tasks: [task("completed", "kb-1")], total_size: 1, page_size: 20, next_page_token: null })),
    });
    const handle = createToolHandler(router([["sre", sre], ["kb", kb]]));
    const result = await handle("siclaw_list_tasks", {});
    expect(result.structuredContent).toMatchObject({ total_size: 2, next_page_token: null, truncated_agents: ["sre"] });
    const tasks = (result.structuredContent as { tasks: Array<{ task_id: string; agent: string }> }).tasks;
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: "sre-1", agent: "sre" }),
      expect.objectContaining({ task_id: "kb-1", agent: "kb" }),
    ]));
    expect(result.content[0].text).toContain("agent=sre");
    expect(result.content[0].text).toContain("More tasks exist for agents: sre");
  });

  it("recovers and remembers ownership from a per-agent list", async () => {
    const sre = fakeApi();
    const kb = fakeApi({
      listTasks: vi.fn(async () => ({ tasks: [task("working", "kb-9")], total_size: 1, page_size: 20, next_page_token: null })),
    });
    const handle = createToolHandler(router([["sre", sre], ["kb", kb]]));
    await handle("siclaw_list_tasks", { agent: "kb" });

    const waited = await handle("siclaw_wait_task", { task_id: "kb-9", wait_seconds: 5 });
    expect(kb.waitForTask).toHaveBeenCalledWith("kb-9", 5);
    expect(sre.waitForTask).not.toHaveBeenCalled();
    expect(waited.structuredContent).toMatchObject({ agent: "kb" });
  });
});
