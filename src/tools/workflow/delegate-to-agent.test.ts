import { describe, it, expect, vi } from "vitest";
import { type ToolRefs } from "../../core/tool-registry.js";
import { createDelegateToAgentTool, registration } from "./delegate-to-agent.js";
import type { DelegateResponse, DelegateRosterMember } from "../../shared/agent-delegate.js";

const ROSTER: DelegateRosterMember[] = [
  { id: "agent-net", name: "net-agent", description: "network SRE", clusters: ["sh-1"], hosts: [] },
  { id: "agent-gpu", name: "gpu-agent", description: "GPU SRE", clusters: [], hosts: ["gpu-1"] },
];

function makeRefs(overrides: Partial<ToolRefs> = {}): ToolRefs {
  return {
    kubeconfigRef: {} as any,
    userId: "u1",
    agentId: "coordinator-1",
    sessionIdRef: { current: "s1" },
    taskListId: "tl1",
    memoryRef: {} as any,
    dpStateRef: {} as any,
    ...overrides,
  };
}

const okResp = (over: Partial<DelegateResponse> = {}): DelegateResponse => ({
  ok: true, peerAgentId: "agent-net", peerName: "net-agent", status: "done",
  artifact: { findings: "CoreDNS OOMKilled x3", actions_taken: "none (read-only)", residual_state: "bump memory limit?" },
  steps: ["bash", "bash"], ...over,
});

const text = (r: any) => (r.content[0] as any).text as string;

describe("delegate_to_agent tool", () => {
  it("is available only for a coordinator (roster + executor) and NOT on a delegated turn", () => {
    const exec = vi.fn();
    expect(registration.available?.(makeRefs())).toBe(false); // no roster/executor
    expect(registration.available?.(makeRefs({ delegationRoster: ROSTER }))).toBe(false); // no executor
    expect(registration.available?.(makeRefs({ delegateToAgentExecutor: exec as any }))).toBe(false); // empty roster
    expect(registration.available?.(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }))).toBe(true);
    // one-level guard: a delegated worker never gets the tool
    expect(registration.available?.(makeRefs({
      delegationRoster: ROSTER, delegateToAgentExecutor: exec as any,
      delegation: { delegationId: "d1", readOnly: true },
    }))).toBe(false);
  });

  it("lists the roster as name + id + purpose + COUNTS (not the binding names) and points at list_delegates", () => {
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: vi.fn() as any }));
    expect(tool.description).toContain("net-agent");
    expect(tool.description).toContain("[id: agent-net]");
    expect(tool.description).toContain("network SRE");
    expect(tool.description).toContain("gpu-agent");
    // Counts, not binding names — the full coverage is resolved on demand.
    expect(tool.description).toContain("covers 1 clusters / 0 hosts");
    expect(tool.description).not.toContain("clusters: sh-1");
    expect(tool.description).toContain("list_delegates");
  });

  it("resolves the target and calls the executor, shaping the AgentWorkCard result", async () => {
    // ⚠️ The fake MUST drive onProgress. In production the box-side translator
    // pushes the step records through it, and the card's `steps` AND its
    // `tool_calls` count both come from that one list — a fake that skips it
    // was letting the count be read from a second, thinner list instead.
    const exec = vi.fn(async (_req: unknown, onProgress?: (p: unknown) => void) => {
      onProgress?.({
        toolCalls: 2,
        steps: [
          { kind: "tool", toolName: "kubectl", content: "ok", outcome: "success", durationMs: 12 },
          { kind: "assistant", text: "checking coredns" },
          { kind: "tool", toolName: "pod_logs", content: "OOMKilled", outcome: "success", durationMs: 30 },
        ],
      });
      return okResp();
    });
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "agent-net", agent_name: "net-agent", task: "check sh-1 coredns" });
    expect(exec).toHaveBeenCalledWith({ peerAgentId: "agent-net", text: "check sh-1 coredns" }, expect.any(Function), undefined);
    expect(text(r)).toContain("Result from net-agent");
    expect(text(r)).toContain("CoreDNS OOMKilled x3");
    // Card-facing details: target + status + summary the AgentWorkCard reads.
    const d = r.details as any;
    expect(d.status).toBe("done");
    expect(d.agent_id).toBe("agent-net");
    expect(d.agent_name).toBe("net-agent");
    expect(d.summary).toContain("CoreDNS OOMKilled x3");
    // Two tool rows out of three steps: the assistant reasoning line is not a
    // tool call, and it used to be counted as one.
    expect(d.tool_calls).toBe(2);
    expect(d.steps).toHaveLength(3);
  });

  it("accepts a name in agent_id and still resolves", async () => {
    const exec = vi.fn(async () => okResp());
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    await tool.execute("c1", { agent_id: "gpu-agent", task: "check gpu-1" });
    expect(exec).toHaveBeenCalledWith({ peerAgentId: "agent-gpu", text: "check gpu-1" }, expect.any(Function), undefined);
  });

  it("rejects an unknown target and lists the available agents", async () => {
    const exec = vi.fn();
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "storage-agent", task: "x" });
    expect(exec).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/not one of your delegatable agents/i);
    expect(text(r)).toContain("net-agent");
    expect((r.details as any).status).toBe("failed");
  });

  it("reports a clean stop (not an error) when the coordinator turn is aborted", async () => {
    const exec = vi.fn(async () => okResp({ ok: false, status: "failed", steps: [], error: "delegation stopped" }));
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute("c1", { agent_id: "agent-net", task: "x" }, ac.signal);
    expect(exec).toHaveBeenCalledWith({ peerAgentId: "agent-net", text: "x" }, expect.any(Function), ac.signal);
    expect(text(r)).toMatch(/was stopped/i);
    expect((r.details as any).status).toBe("stopped");
  });

  it("surfaces a failed delegation in the card details", async () => {
    const exec = vi.fn(async () => okResp({ ok: false, status: "failed", artifact: null, error: "peer unreachable" }));
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "agent-net", task: "x" });
    expect(text(r)).toMatch(/failed: peer unreachable/i);
    expect((r.details as any).status).toBe("failed");
  });
});

/**
 * The delegated leg runs as its OWN trace (the peer answers to its own config),
 * so the coordinator's tool row is where the cross-trace link lives: details
 * carry `child_trace_id` next to `child_session_id`, and the sse-consumer
 * persists details into the tool row's metadata. These tests pin the link's
 * presence/absence contract; the transport side is covered in
 * delegate-api.test.ts.
 */
describe("delegate_to_agent tool — child trace link", () => {
  const TRACE = "a".repeat(32);

  it("persists child_trace_id next to child_session_id when the leg reported its trace", async () => {
    const exec = vi.fn(async () => okResp({ peerSessionId: "child-sess", peerTraceId: TRACE }));
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "agent-net", task: "x" });
    expect(r.details as any).toMatchObject({
      status: "done",
      child_session_id: "child-sess",
      child_trace_id: TRACE,
    });
  });

  it("omits child_trace_id when the leg has none (tracing off / older runtime)", async () => {
    const exec = vi.fn(async () => okResp({ peerSessionId: "child-sess" }));
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "agent-net", task: "x" });
    expect((r.details as any).child_session_id).toBe("child-sess");
    expect(r.details as any).not.toHaveProperty("child_trace_id");
  });

  it("keeps the link on a failed leg — failed legs are exactly what a review drills into", async () => {
    const exec = vi.fn(async () => okResp({
      ok: false, status: "failed", artifact: null, error: "kubectl timed out",
      peerSessionId: "child-sess", peerTraceId: TRACE,
    }));
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "agent-net", task: "x" });
    expect(r.details as any).toMatchObject({
      status: "failed",
      child_session_id: "child-sess",
      child_trace_id: TRACE,
    });
  });
});
