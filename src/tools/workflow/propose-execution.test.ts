import { describe, it, expect, vi } from "vitest";
import { type ToolRefs } from "../../core/tool-registry.js";
import { createProposeExecutionTool, registration } from "./propose-execution.js";

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
    });
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
