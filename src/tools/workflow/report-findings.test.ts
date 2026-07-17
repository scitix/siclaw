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
    });
    expect((r.details as any).delivered).toBe(true);
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
