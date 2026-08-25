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

  it("states the call is synchronous and that a plan is not a result", () => {
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: vi.fn() as any }));
    // A coordinator read a plan-shaped return as "still working" and waited, then re-delegated the
    // same question twice. Both facts below are what the description exists to state; a future edit
    // that drops either one reproduces that trace.
    expect(tool.description).toContain("SYNCHRONOUS");
    expect(tool.description).toContain("not still working in the background");
    expect(tool.description).toContain("Narration that describes a plan is not a result");
    // Where the rest of the text went — this is what stops a re-delegation to recover it.
    expect(tool.description).toContain("the complete record stays in the peer's own session");
    // Must NOT promise findings unconditionally: what comes back may be narration.
    expect(tool.description).not.toContain("and get back its findings");
    // Nor call that narration a "summary": without an artifact the model receives resp.finalText
    // VERBATIM (see the `const summary = a ? a.findings : resp.finalText` shaping below), so there
    // is no condensation step to name.
    expect(tool.description).not.toContain("a summary of");
    // The shortening is stated WITHOUT naming an algorithm, and without claiming both branches are
    // capped. Neither is true uniformly: only the narration is truncated today (MAX_FINAL_TEXT,
    // tail-kept), report_findings has no cap at all, and C1 replaces the narration's tail-keep with
    // head+tail. A description that names the algorithm is wrong on one branch now and on both
    // later; "may reach you shortened" is what stays true across all three states.
    expect(tool.description).toContain("may reach you shortened");
    expect(tool.description).not.toContain("drops the START");
    expect(tool.description).not.toContain("both subject to");
  });

  it("resolves the target and calls the executor, shaping the AgentWorkCard result", async () => {
    const exec = vi.fn(async () => okResp());
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "agent-net", agent_name: "net-agent", task: "check sh-1 coredns" });
    // toolCallId is forwarded so the peer's turn can nest under THIS tool span and be correlated
    // with THIS tool row — a coordinator may have several delegations in flight, and a session id
    // alone cannot say which row is which.
    expect(exec).toHaveBeenCalledWith(
      { peerAgentId: "agent-net", text: "check sh-1 coredns", peerSessionId: undefined, toolCallId: "c1" },
      expect.any(Function), undefined,
    );
    expect(text(r)).toContain("Result from net-agent");
    expect(text(r)).toContain("CoreDNS OOMKilled x3");
    // Card-facing details: target + status + summary the AgentWorkCard reads.
    const d = r.details as any;
    expect(d.status).toBe("done");
    expect(d.agent_id).toBe("agent-net");
    expect(d.agent_name).toBe("net-agent");
    expect(d.summary).toContain("CoreDNS OOMKilled x3");
    expect(d.tool_calls).toBe(2);
  });

  it("copies the v1 result fields into `details`, which is what the card reads", async () => {
    // The gateway's HTTP response and the tool's `details` are two different readers. Emitting the
    // contract on the response alone left it implemented and unreadable at the same time — the card
    // renders from `details`, so nothing about task_status reached the UI. That is how "landed" and
    // "in effect" come apart, and it is invisible from either side alone.
    const exec = vi.fn(async () => ({
      ...okResp(),
      schema_version: 1, turn_status: "completed", task_status: "partial",
      payload_kind: "artifact", truncation: { original_bytes: 100, omitted_bytes: 40, fields: ["steps"] },
    }));
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const r = await tool.execute("c1", { agent_id: "agent-net", task: "t" });

    const d = (r as any).details;
    expect(d.schema_version).toBe(1);
    expect(d.turn_status).toBe("completed");
    expect(d.task_status).toBe("partial");
    expect(d.payload_kind).toBe("artifact");
    expect(d.truncation).toEqual({ original_bytes: 100, omitted_bytes: 40, fields: ["steps"] });
    // Copied verbatim, never re-derived: a second implementation of task_status here would let the
    // card disagree with the wire about whether a task completed, which is worse than showing
    // nothing.
    expect(d.task_status).toBe((await exec.mock.results[0].value).task_status);
  });

  it("omits the v1 fields when the wire did not carry them — an older gateway is unaffected", async () => {
    const exec = vi.fn(async () => okResp());
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    const d = (await tool.execute("c1", { agent_id: "agent-net", task: "t" }) as any).details;
    expect("task_status" in d).toBe(false);
    expect("truncation" in d).toBe(false);
  });

  it("accepts a name in agent_id and still resolves", async () => {
    const exec = vi.fn(async () => okResp());
    const tool = createDelegateToAgentTool(makeRefs({ delegationRoster: ROSTER, delegateToAgentExecutor: exec as any }));
    await tool.execute("c1", { agent_id: "gpu-agent", task: "check gpu-1" });
    expect(exec).toHaveBeenCalledWith(
      { peerAgentId: "agent-gpu", text: "check gpu-1", peerSessionId: undefined, toolCallId: "c1" },
      expect.any(Function), undefined,
    );
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
    expect(exec).toHaveBeenCalledWith(
      { peerAgentId: "agent-net", text: "x", peerSessionId: undefined, toolCallId: "c1" },
      expect.any(Function), ac.signal,
    );
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
