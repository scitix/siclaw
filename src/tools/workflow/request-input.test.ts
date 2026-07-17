import { describe, it, expect, vi } from "vitest";
import { type ToolRefs } from "../../core/tool-registry.js";
import { createRequestInputTool, registration } from "./request-input.js";

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

const text = (r: any) => (r.content[0] as any).text as string;

describe("request_input tool", () => {
  it("is available ONLY on a delegated turn with an event bus, and is read-only-delegable", () => {
    const emitter = vi.fn();
    expect(registration.available?.(makeRefs())).toBe(false);
    expect(registration.available?.(makeRefs({ delegation: { delegationId: "d1", readOnly: true } }))).toBe(false);
    expect(
      registration.available?.(makeRefs({ delegation: { delegationId: "d1", readOnly: true }, sessionEventEmitter: emitter })),
    ).toBe(true);
    expect(registration.readOnlyDelegable).toBe(true);
  });

  it("emits an input_required event stamped with the delegationId", async () => {
    const emitter = vi.fn();
    const tool = createRequestInputTool(
      makeRefs({ delegation: { delegationId: "deleg-7", readOnly: true }, sessionEventEmitter: emitter }),
    );
    const r = await tool.execute("call-1", { question: "  Which cluster — sh-1 or sh-2?  " });
    expect(emitter).toHaveBeenCalledTimes(1);
    expect(emitter.mock.calls[0][0]).toEqual({
      type: "input_required",
      delegationId: "deleg-7",
      question: "Which cluster — sh-1 or sh-2?",
    });
    expect((r.details as any).delivered).toBe(true);
  });

  it("rejects an empty question before emitting", async () => {
    const emitter = vi.fn();
    const tool = createRequestInputTool(
      makeRefs({ delegation: { delegationId: "d1", readOnly: true }, sessionEventEmitter: emitter }),
    );
    const r = await tool.execute("call-empty", { question: "  " });
    expect(emitter).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/non-empty question/i);
    expect((r.details as any).delivered).toBe(false);
  });
});
