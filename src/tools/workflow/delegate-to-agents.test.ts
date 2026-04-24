import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ToolRefs } from "../../core/tool-registry.js";
import { createDelegateToAgentsTool, registration } from "./delegate-to-agents.js";

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
  it("stays hidden until a batch runtime executor is injected", () => {
    const reg = new ToolRegistry();
    reg.register(registration);

    expect(reg.resolve({ mode: "web", refs: stubRefs() })).toEqual([]);
  });

  it("resolves as a user-approved workflow tool when executor is present", () => {
    const reg = new ToolRegistry();
    reg.register(registration);

    const tools = reg.resolve({
      mode: "web",
      refs: stubRefs({ delegateToAgentsExecutor: vi.fn() }),
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("delegate_to_agents");
    expect(tools[0].requiresUserApproval).toBe(true);
  });

  it("starts a normalized background batch and returns immediately with running details", async () => {
    const executor = vi.fn(async () => ({
      status: "running" as const,
      delegation_id: "call-1",
      tasks: [
        {
          index: 1,
          status: "running" as const,
          agent_id: "self",
          scope: "check nodes",
          summary: "Delegated investigation is running.",
          tool_calls: 0 as const,
          duration_ms: 0 as const,
        },
        {
          index: 2,
          status: "running" as const,
          agent_id: "network-doctor",
          scope: "check network",
          summary: "Delegated investigation is running.",
          tool_calls: 0 as const,
          duration_ms: 0 as const,
        },
      ],
      total_tool_calls: 0 as const,
      duration_ms: 0 as const,
    }));
    const tool = createDelegateToAgentsTool(stubRefs({ delegateToAgentsExecutor: executor }));

    const result = await tool.execute("call-1", {
      tasks: [
        { agent_id: " self ", scope: " check nodes ", context_summary: "  cluster prod  " },
        { agent_id: " network-doctor ", scope: " check network " },
      ],
    });
    const content = JSON.parse(result.content[0].text);

    expect(executor).toHaveBeenCalledWith({
      delegationId: "call-1",
      parentSessionId: "session-parent",
      parentAgentId: "agent-parent",
      userId: "u1",
      tasks: [
        { index: 1, agentId: "self", scope: "check nodes", contextSummary: "cluster prod" },
        { index: 2, agentId: "network-doctor", scope: "check network" },
      ],
    });
    expect(content).toMatchObject({
      status: "running",
      delegation_id: "call-1",
      total_tool_calls: 0,
    });
    expect(result.details).toMatchObject({
      status: "running",
      delegation_id: "call-1",
      async: true,
    });
  });

  it("rejects empty, oversized, and blank-scope task batches", async () => {
    const tool = createDelegateToAgentsTool(stubRefs({ delegateToAgentsExecutor: vi.fn() }));

    const empty = await tool.execute("call-1", { tasks: [] });
    const tooMany = await tool.execute("call-2", {
      tasks: [{ scope: "1" }, { scope: "2" }, { scope: "3" }, { scope: "4" }],
    });
    const blank = await tool.execute("call-3", { tasks: [{ scope: " " }] });

    expect(empty.details).toEqual({ error: true });
    expect(tooMany.details).toEqual({ error: true });
    expect(blank.details).toEqual({ error: true });
    expect(JSON.parse(blank.content[0].text).message).toContain("task 1");
  });
});
