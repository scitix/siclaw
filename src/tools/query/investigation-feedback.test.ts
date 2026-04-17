import { describe, it, expect, beforeEach } from "vitest";
import { createInvestigationFeedbackTool } from "./investigation-feedback.js";
import { FEEDBACK_SIGNALS } from "../../memory/types.js";

function makeFakeIndexer(overrides: any = {}) {
  return {
    calls: [] as any[],
    record: { id: "inv-1", question: "q" } as any,
    getInvestigationById(id: string) {
      this.calls.push({ method: "get", id });
      return this.record;
    },
    updateInvestigationFeedback(id: string, signal: number, note: string) {
      this.calls.push({ method: "update", id, signal, note });
      return true;
    },
    ...overrides,
  };
}

describe("investigation_feedback tool", () => {
  let indexer: ReturnType<typeof makeFakeIndexer>;

  beforeEach(() => {
    indexer = makeFakeIndexer();
  });

  it("has correct tool metadata", () => {
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    expect(tool.name).toBe("investigation_feedback");
    expect(tool.label).toBe("Investigation Feedback");
  });

  it("returns error when memory indexer not available", async () => {
    const tool = createInvestigationFeedbackTool({ indexer: undefined as any });
    const result = await tool.execute("id", {
      investigationId: "inv-1", status: "confirmed",
    });
    expect(result.content[0].text).toContain("Memory indexer not available");
    expect((result.details as any).error).toBe(true);
  });

  it("returns error when investigation does not exist", async () => {
    indexer.record = null;
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    const result = await tool.execute("id", {
      investigationId: "missing", status: "confirmed",
    });
    expect(result.content[0].text).toContain("Investigation not found: missing");
    expect((result.details as any).error).toBe(true);
  });

  it("confirmed status uses correct signal (1.5x boost)", async () => {
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    await tool.execute("id", { investigationId: "inv-1", status: "confirmed" });
    const updateCall = indexer.calls.find((c: any) => c.method === "update");
    expect(updateCall.signal).toBe(FEEDBACK_SIGNALS.confirmed);
    expect(updateCall.signal).toBe(1.5);
    expect(updateCall.note).toBe("confirmed");
  });

  it("rejected status uses correct signal (0.1x suppress)", async () => {
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    await tool.execute("id", { investigationId: "inv-1", status: "rejected" });
    const updateCall = indexer.calls.find((c: any) => c.method === "update");
    expect(updateCall.signal).toBe(FEEDBACK_SIGNALS.rejected);
    expect(updateCall.signal).toBe(0.1);
  });

  it("corrected status encodes root cause in note", async () => {
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    await tool.execute("id", {
      investigationId: "inv-1",
      status: "corrected",
      correctedRootCause: "MTU mismatch",
    });
    const updateCall = indexer.calls.find((c: any) => c.method === "update");
    expect(updateCall.signal).toBe(FEEDBACK_SIGNALS.corrected);
    expect(updateCall.note).toBe("corrected: MTU mismatch");
  });

  it("appends note when provided", async () => {
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    await tool.execute("id", {
      investigationId: "inv-1",
      status: "confirmed",
      note: "verified with user",
    });
    const updateCall = indexer.calls.find((c: any) => c.method === "update");
    expect(updateCall.note).toBe("confirmed | verified with user");
  });

  it("fails gracefully when update returns false", async () => {
    indexer.updateInvestigationFeedback = () => false;
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    const result = await tool.execute("id", {
      investigationId: "inv-1", status: "confirmed",
    });
    expect(result.content[0].text).toContain("Failed to update");
    expect((result.details as any).error).toBe(true);
  });

  it("reports weight in success message", async () => {
    const tool = createInvestigationFeedbackTool({ indexer: indexer as any });
    const result = await tool.execute("id", {
      investigationId: "inv-1", status: "confirmed",
    });
    expect(result.content[0].text).toContain("1.5x");
    expect((result.details as any).status).toBe("confirmed");
    expect((result.details as any).signal).toBe(1.5);
  });
});
