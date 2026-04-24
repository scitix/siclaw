import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, type ToolRefs } from "../../core/tool-registry.js";
import { registration, createDelegateToAgentsTool } from "./delegate-to-agents.js";

function stubRefs(overrides: Partial<ToolRefs> = {}): ToolRefs {
  return {
    kubeconfigRef: {},
    userId: "u1",
    agentId: "agent-parent",
    sessionIdRef: { current: "session-parent" },
    memoryRef: {},
    dpStateRef: { active: false },
    ...overrides,
  };
}

describe("delegate_to_agents", () => {
  it("stays hidden until a runtime executor is injected", () => {
    const reg = new ToolRegistry();
    reg.register(registration);

    expect(reg.resolve({ mode: "web", refs: stubRefs() })).toEqual([]);
  });

  it("resolves as a user-approved workflow tool when executor is present", () => {
    const reg = new ToolRegistry();
    reg.register(registration);

    const tools = reg.resolve({
      mode: "web",
      refs: stubRefs({ delegateToAgentExecutor: vi.fn() }),
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("delegate_to_agents");
    expect(tools[0].requiresUserApproval).toBe(true);
  });

  it("runs 1-3 tasks concurrently and keeps full reports out of model-visible content", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const executor = vi.fn(async (request) => {
      started.push(request.scope);
      if (request.scope === "first") await firstGate;
      return {
        summary: `${request.scope} capsule`,
        fullSummary: `${request.scope} full report`,
        summaryTruncated: false,
        sessionId: `${request.scope}-session`,
        toolCalls: request.scope === "first" ? 2 : 3,
        durationMs: 10,
        toolTrace: [{ toolName: `${request.scope}_tool`, outcome: "success" as const, durationMs: 5 }],
      };
    });
    const tool = createDelegateToAgentsTool(stubRefs({ delegateToAgentExecutor: executor }));

    const pending = tool.execute("call-1", {
      tasks: [
        { agent_id: " self ", scope: " first ", context_summary: " c1 " },
        { scope: " second " },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(started).toEqual(["first", "second"]);
    releaseFirst?.();
    const result = await pending;
    const content = JSON.parse(result.content[0].text);

    expect(executor).toHaveBeenNthCalledWith(1, {
      agentId: "self",
      scope: "first",
      contextSummary: "c1",
      parentSessionId: "session-parent",
      parentAgentId: "agent-parent",
      userId: "u1",
      delegationId: "call-1",
      taskIndex: 1,
      totalTasks: 2,
    });
    expect(executor).toHaveBeenNthCalledWith(2, {
      agentId: "self",
      scope: "second",
      contextSummary: undefined,
      parentSessionId: "session-parent",
      parentAgentId: "agent-parent",
      userId: "u1",
      delegationId: "call-1",
      taskIndex: 2,
      totalTasks: 2,
    });
    expect(content).toMatchObject({
      status: "done",
      total_tool_calls: 5,
      tasks: [
        { index: 1, status: "done", agent_id: "self", scope: "first", summary: "first capsule", tool_calls: 2 },
        { index: 2, status: "done", agent_id: "self", scope: "second", summary: "second capsule", tool_calls: 3 },
      ],
    });
    expect(JSON.stringify(content)).not.toContain("full report");
    expect(JSON.stringify(content)).not.toContain("session");
    expect(result.details.tasks).toEqual([
      expect.objectContaining({
        index: 1,
        session_id: "first-session",
        full_summary: "first full report",
        summary_truncated: false,
        tool_trace: [{ toolName: "first_tool", outcome: "success", durationMs: 5 }],
      }),
      expect.objectContaining({
        index: 2,
        session_id: "second-session",
        full_summary: "second full report",
        tool_trace: [{ toolName: "second_tool", outcome: "success", durationMs: 5 }],
      }),
    ]);
  });

  it("returns partial results when one delegated task fails", async () => {
    const executor = vi.fn(async (request) => {
      if (request.scope === "bad") throw new Error("child crashed");
      return {
        status: "timed_out" as const,
        summary: "partial capsule",
        sessionId: "partial-session",
        toolCalls: 4,
        durationMs: 120,
      };
    });
    const tool = createDelegateToAgentsTool(stubRefs({ delegateToAgentExecutor: executor }));

    const result = await tool.execute("call-1", {
      tasks: [{ scope: "ok" }, { scope: "bad" }],
    });
    const content = JSON.parse(result.content[0].text);

    expect(content).toMatchObject({
      status: "failed",
      total_tool_calls: 4,
      tasks: [
        { index: 1, status: "timed_out", summary: "partial capsule", tool_calls: 4 },
        { index: 2, status: "failed", summary: "Delegated agent failed: child crashed", tool_calls: 0 },
      ],
    });
    expect(result.details.tasks).toEqual([
      expect.objectContaining({ index: 1, session_id: "partial-session", status: "timed_out" }),
      expect.objectContaining({ index: 2, status: "failed", error: "child crashed" }),
    ]);
  });

  it("rejects empty or oversized task batches", async () => {
    const tool = createDelegateToAgentsTool(stubRefs({ delegateToAgentExecutor: vi.fn() }));

    const empty = await tool.execute("call-1", { tasks: [] });
    const tooMany = await tool.execute("call-2", { tasks: [
      { scope: "1" }, { scope: "2" }, { scope: "3" }, { scope: "4" },
    ] });

    expect(empty.details).toEqual({ error: true });
    expect(tooMany.details).toEqual({ error: true });
  });

  it("rejects tasks with empty scope", async () => {
    const tool = createDelegateToAgentsTool(stubRefs({ delegateToAgentExecutor: vi.fn() }));

    const result = await tool.execute("call-1", { tasks: [{ scope: " " }] });

    expect(result.details).toEqual({ error: true });
    expect(JSON.parse(result.content[0].text).message).toContain("task 1");
  });
});
