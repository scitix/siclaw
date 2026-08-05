import { describe, expect, it, vi } from "vitest";
import type { ToolRefs } from "../../core/tool-registry.js";
import { createTicketIntakeDraftTool, registration } from "./ticket-intake-draft.js";

function refs(executor: ToolRefs["ticketIntakeDraftExecutor"]): ToolRefs {
  return {
    kubeconfigRef: {} as any, userId: "user-1", agentId: "agent-1",
    sessionIdRef: { current: "session-1" }, taskListId: "tasks-1",
    memoryRef: {} as any, dpStateRef: {} as any, ticketIntakeDraftExecutor: executor,
  };
}

describe("ticket_intake_draft tool", () => {
  it("is channel-only, executor-gated, and unavailable to delegated workers", () => {
    expect(registration.modes).toEqual(["channel"]);
    expect(registration.available?.(refs(undefined))).toBe(false);
    expect(registration.available?.(refs(vi.fn() as any))).toBe(true);
    expect(registration.available?.({ ...refs(vi.fn() as any), delegation: { delegationId: "d1", readOnly: true } })).toBe(false);
  });

  it("updates only an opaque intake id and expected revision; it has no submit action", async () => {
    const executor = vi.fn().mockResolvedValue({ accepted: true, message: "saved" });
    const tool = createTicketIntakeDraftTool(refs(executor));
    const result = await tool.execute("call-1", {
      intake_id: "intake-1", expected_revision: 4,
      classification: "incident_candidate", summary: "Login fails", impact: "Tenant A",
      actual_behavior: "500", expected_behavior: "Login succeeds",
      attempted_actions: ["retry"], source_refs: [], open_questions: [], ready_for_review: true,
    });
    expect(executor).toHaveBeenCalledWith({
      sessionId: "session-1", intakeId: "intake-1", expectedRevision: 4,
      draft: expect.objectContaining({ summary: "Login fails", ready_for_review: true }),
    });
    expect((result.content[0] as any).text).toBe("saved");
    expect(JSON.stringify(tool.parameters)).not.toContain("submit");
    expect(JSON.stringify(tool.parameters)).not.toContain("confirm");
  });
});
