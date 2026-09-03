import { describe, it, expect, vi } from "vitest";
import { type ToolRefs } from "../../core/tool-registry.js";
import { createProposeExecutionTool, registration } from "./propose-execution.js";
import { actionDigest } from "../../shared/action-digest.js";

function makeRefs(overrides: Partial<ToolRefs> = {}): ToolRefs {
  return {
    kubeconfigRef: {} as any,
    userId: "user-1",
    agentId: "agent-1",
    sessionIdRef: { current: "sess-1" },
    taskListId: "tl-1",
    memoryRef: {} as any,
    dpStateRef: {} as any,
    ...overrides,
  };
}

const validParams = {
  tool_name: "bash",
  tool_args: { command: "kubectl scale deploy/payments --replicas=12" },
  effect: "external_write",
  resources: ["deployment://production-a/payments"],
  diff: { replicas: { from: 10, to: 12 } },
  reason: "scale for the incident",
  risk: "medium",
  rollback: "restore replicas=10",
};

describe("propose_execution tool", () => {
  it("is available ONLY on governed turns — never on legacy delegated turns", () => {
    const emitter = vi.fn();
    expect(registration.available?.(makeRefs())).toBe(false);
    expect(registration.available?.(makeRefs({ allowInputRequest: true }))).toBe(false);
    expect(registration.available?.(makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }))).toBe(true);
    // A legacy delegated turn has no consumer for auth_required: offering the
    // tool there would submit proposals into the void.
    expect(
      registration.available?.(makeRefs({ delegation: { delegationId: "d1", readOnly: true }, sessionEventEmitter: emitter })),
    ).toBe(false);
    expect(registration.readOnlyDelegable).toBe(true);
  });

  it("emits a reliable auth_required event with the full proposal", async () => {
    const emitter = vi.fn();
    const tool = createProposeExecutionTool(makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }));
    const r = await tool.execute("call-1", { ...validParams });
    expect((r.details as any).delivered).toBe(true);
    expect(emitter).toHaveBeenCalledWith({
      type: "auth_required",
      effect: "external_write",
      resources: ["deployment://production-a/payments"],
      diff: { replicas: { from: 10, to: 12 } },
      reason: "scale for the incident",
      risk: "medium",
      rollback: "restore replicas=10",
      toolName: "bash",
      toolArgs: { command: "kubectl scale deploy/payments --replicas=12" },
      actionDigest: actionDigest("bash", { command: "kubectl scale deploy/payments --replicas=12" }),
    });
  });

  it("binds the proposal to the EXACT call, computing the digest locally", async () => {
    // The runtime is the only party that computes a digest; the management plane
    // stores this value opaquely. A different intended call ⇒ a different digest,
    // which is what stops an approval for one action being spent on another.
    const emitter = vi.fn();
    const tool = createProposeExecutionTool(makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }));
    await tool.execute("call-1", { ...validParams });
    await tool.execute("call-2", { ...validParams, tool_args: { command: "kubectl delete ns payments" } });
    const [first, second] = emitter.mock.calls.map((c) => (c[0] as any).actionDigest);
    expect(first).not.toBe(second);
    expect(second).toBe(actionDigest("bash", { command: "kubectl delete ns payments" }));
    // No token of any kind is minted or emitted.
    for (const call of emitter.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("receipt");
    }
  });

  it("refuses a proposal that does not state the exact call", async () => {
    // An approval that is not bound to an action is the bearer token this design
    // removes, so the proposal cannot be issued against an intention.
    const emitter = vi.fn();
    const tool = createProposeExecutionTool(makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }));
    for (const broken of [
      { ...validParams, tool_name: "  " },
      { ...validParams, tool_name: undefined },
      { ...validParams, tool_args: undefined },
    ]) {
      const r = await tool.execute("call-z", broken as any);
      expect((r.details as any).delivered).toBe(false);
    }
    expect(emitter).not.toHaveBeenCalled();
  });

  it("carries optional evidence_refs so the approver can check the basis", async () => {
    const emitter = vi.fn();
    const tool = createProposeExecutionTool(makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }));
    await tool.execute("call-e", { ...validParams, evidence_refs: ["trace://t1", "metric://m2"] });
    expect((emitter.mock.calls[0][0] as any).evidenceRefs).toEqual(["trace://t1", "metric://m2"]);
    // Absent when not supplied, rather than an empty array.
    emitter.mockClear();
    await tool.execute("call-f", { ...validParams });
    expect((emitter.mock.calls[0][0] as any).evidenceRefs).toBeUndefined();
  });

  it("rejects a proposal without its specifics — approvers decide on exact diffs", async () => {
    const emitter = vi.fn();
    const tool = createProposeExecutionTool(makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }));
    for (const broken of [
      { ...validParams, rollback: "  " },
      { ...validParams, resources: [] },
      { ...validParams, reason: "" },
      { ...validParams, diff: undefined },
      { ...validParams, effect: "observe" },
    ]) {
      const r = await tool.execute("call-x", broken as any);
      expect((r.details as any).delivered).toBe(false);
    }
    expect(emitter).not.toHaveBeenCalled();
  });

  it("is unavailable without the opt-in even when invoked directly", async () => {
    const emitter = vi.fn();
    const tool = createProposeExecutionTool(makeRefs({ sessionEventEmitter: emitter }));
    const r = await tool.execute("call-y", { ...validParams });
    expect((r.details as any).delivered).toBe(false);
    expect(emitter).not.toHaveBeenCalled();
  });
});
