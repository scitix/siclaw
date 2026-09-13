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
  it("requires an explicit input request capability and event transport", () => {
    const emitter = vi.fn();
    expect(registration.available?.(makeRefs())).toBe(false);
    expect(registration.available?.(makeRefs({ allowInputRequest: true }))).toBe(false);
    expect(registration.available?.(makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }))).toBe(true);
  });

  it("emits input_required without a delegationId for an opted-in top-level turn", async () => {
    const emitter = vi.fn();
    const tool = createRequestInputTool(
      makeRefs({ allowInputRequest: true, sessionEventEmitter: emitter }),
    );
    const r = await tool.execute("call-a2a", { question: " Which cluster? " });

    expect(tool.description).toMatch(/external caller/i);
    expect(emitter).toHaveBeenCalledWith({
      type: "input_required",
      question: "Which cluster?",
    });
    expect((r.details as any).delivered).toBe(true);
  });

  it("does not emit when a caller bypasses registration without either opt-in", async () => {
    const emitter = vi.fn();
    const tool = createRequestInputTool(makeRefs({ sessionEventEmitter: emitter }));
    const r = await tool.execute("call-direct", { question: "Which cluster?" });

    expect(emitter).not.toHaveBeenCalled();
    expect((r.details as any).delivered).toBe(false);
  });

  it("rejects an empty question before emitting", async () => {
    const emitter = vi.fn();
    const tool = createRequestInputTool(
    );
    const r = await tool.execute("call-empty", { question: "  " });
    expect(emitter).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/non-empty question/i);
    expect((r.details as any).delivered).toBe(false);
  });
});
