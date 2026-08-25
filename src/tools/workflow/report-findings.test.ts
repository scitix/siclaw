import { describe, it, expect, vi } from "vitest";
import { ToolRegistry, type ToolRefs } from "../../core/tool-registry.js";
import { createReportFindingsTool, registration } from "./report-findings.js";

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

describe("report_findings tool", () => {
  it("is available ONLY on a delegated turn with an event bus", () => {
    const emitter = vi.fn();
    expect(registration.available?.(makeRefs())).toBe(false); // no delegation
    expect(registration.available?.(makeRefs({ delegation: { delegationId: "d1", readOnly: true } }))).toBe(false); // no emitter
    expect(
      registration.available?.(makeRefs({ delegation: { delegationId: "d1", readOnly: true }, sessionEventEmitter: emitter })),
    ).toBe(true);
    // tagged readOnlyDelegable so it survives the read-only filter
    expect(registration.readOnlyDelegable).toBe(true);
  });

  it("emits a delegation_artifact event stamped with the delegationId", async () => {
    const emitter = vi.fn();
    const tool = createReportFindingsTool(
      makeRefs({ delegation: { delegationId: "deleg-42", readOnly: true }, sessionEventEmitter: emitter }),
    );

    const r = await tool.execute("call-1", {
      findings: "  kube-system CoreDNS pod OOMKilled x3  ",
      residual_state: "needs memory-limit bump decision",
    });

    expect(emitter).toHaveBeenCalledTimes(1);
    expect(emitter.mock.calls[0][0]).toEqual({
      type: "delegation_artifact",
      delegationId: "deleg-42",
      // A delegated peer runs under its OWN capabilities (not forced read-only), so an
      // omitted actions_taken defaults to a NEUTRAL "not reported" — never the false
      // "none (read-only)", which would hide real mutations from the coordinator.
      findings: "kube-system CoreDNS pod OOMKilled x3",
      actions_taken: "not reported",
      residual_state: "needs memory-limit bump decision",
      // Omitted task_status is "partial", the CAUTIOUS reading. Defaulting to "complete" would
      // make every peer that ignores the field claim a finished task — the over-claim the field
      // exists to stop. Understating a finished one costs a follow-up question and nothing else.
      task_status: "partial",
    });
    expect((r.details as any).delivered).toBe(true);
  });

  it("task_status is SUBMITTED, and only an explicit \"complete\" claims completeness", async () => {
    // Calling this tool proves the peer REPORTED; it does not prove it FINISHED, and only the peer
    // knows which. Inferring completeness from the presence of an artifact is the plan-as-done
    // reading the delegation result contract exists to remove.
    const emitter = vi.fn();
    const tool = createReportFindingsTool(
      makeRefs({ delegation: { delegationId: "d1", readOnly: true }, sessionEventEmitter: emitter }),
    );

    await tool.execute("c1", { findings: "f", task_status: "complete" });
    expect(emitter.mock.calls.at(-1)?.[0]).toMatchObject({ task_status: "complete" });

    await tool.execute("c2", { findings: "f", task_status: "partial" });
    expect(emitter.mock.calls.at(-1)?.[0]).toMatchObject({ task_status: "partial" });

    // Anything unrecognised falls to partial rather than being trusted as a completeness claim.
    await tool.execute("c3", { findings: "f", task_status: "done" as never });
    expect(emitter.mock.calls.at(-1)?.[0]).toMatchObject({ task_status: "partial" });
  });

  it("rejects empty findings before emitting", async () => {
    const emitter = vi.fn();
    const tool = createReportFindingsTool(
      makeRefs({ delegation: { delegationId: "d1", readOnly: true }, sessionEventEmitter: emitter }),
    );
    const r = await tool.execute("call-empty", { findings: "   " });
    expect(emitter).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/non-empty findings/i);
    expect((r.details as any).delivered).toBe(false);
  });

  it("returns not-available when wiring is missing", async () => {
    const tool = createReportFindingsTool(makeRefs()); // no delegation / emitter
    const r = await tool.execute("call-x", { findings: "something" });
    expect(text(r)).toMatch(/not available/i);
    expect((r.details as any).delivered).toBe(false);
  });
});
