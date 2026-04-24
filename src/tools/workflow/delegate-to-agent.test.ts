import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, type ToolRefs } from "../../core/tool-registry.js";
import { registration, createDelegateToAgentTool } from "./delegate-to-agent.js";

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

describe("delegate_to_agent", () => {
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
    expect(tools[0].name).toBe("delegate_to_agent");
    expect(tools[0].requiresUserApproval).toBe(true);
  });

  it("passes normalized lineage and task parameters to the executor", async () => {
    const executor = vi.fn(async () => ({
      summary: "child result",
      fullSummary: "full child report",
      summaryTruncated: false,
      sessionId: "session-child",
      toolCalls: 3,
      durationMs: 42,
      toolTrace: [{ toolName: "cluster_list", outcome: "success" as const, durationMs: 10 }],
    }));
    const refs = stubRefs({ delegateToAgentExecutor: executor });
    const tool = createDelegateToAgentTool(refs);

    const result = await tool.execute("call-1", {
      agent_id: " self ",
      scope: "  verify H1 against repo evidence  ",
      context_summary: "  parent context  ",
    });

    expect(executor).toHaveBeenCalledWith({
      agentId: "self",
      scope: "verify H1 against repo evidence",
      contextSummary: "parent context",
      parentSessionId: "session-parent",
      parentAgentId: "agent-parent",
      userId: "u1",
      delegationId: "call-1",
    });
    expect(result.details).toEqual({
      status: "done",
      summary: "child result",
      session_id: "session-child",
      full_summary: "full child report",
      summary_truncated: false,
      tool_calls: 3,
      duration_ms: 42,
      tool_trace: [{ toolName: "cluster_list", outcome: "success", durationMs: 10 }],
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "done",
      summary: "child result",
      tool_calls: 3,
      duration_ms: 42,
    });
  });

  it("preserves non-self target agent ids for expert collaboration", async () => {
    const executor = vi.fn(async () => ({
      summary: "expert result",
      sessionId: "session-expert",
      toolCalls: 2,
      durationMs: 1200,
    }));
    const tool = createDelegateToAgentTool(stubRefs({ delegateToAgentExecutor: executor }));

    await tool.execute("call-1", {
      agent_id: " network-doctor ",
      scope: "Check whether H2 matches networking evidence",
    });

    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "network-doctor",
      parentAgentId: "agent-parent",
      parentSessionId: "session-parent",
    }));
  });

  it("returns a structured error for missing required parameters", async () => {
    const tool = createDelegateToAgentTool(stubRefs({ delegateToAgentExecutor: vi.fn() }));

    const result = await tool.execute("call-1", {
      agent_id: "self",
      scope: " ",
    });

    expect(result.details).toEqual({ error: true });
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: true });
  });
});
