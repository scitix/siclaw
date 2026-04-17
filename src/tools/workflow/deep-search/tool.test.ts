import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInvestigate = vi.fn();
vi.mock("./engine.js", () => ({
  investigate: (...args: any[]) => mockInvestigate(...args),
}));

import { createDeepSearchTool } from "./tool.js";
import { createDpState } from "../dp-tools.js";

function makeDpRef(status: string, overrides: any = {}) {
  const s = createDpState();
  s.status = status as any;
  return Object.assign(s, overrides);
}

beforeEach(() => {
  mockInvestigate.mockReset();
});

describe("deep_search tool — DP mode gating", () => {
  it("has correct metadata", () => {
    const tool = createDeepSearchTool();
    expect(tool.name).toBe("deep_search");
    expect(tool.label).toBe("Deep Search");
  });

  it("rejects when not in DP mode (no ref)", async () => {
    const tool = createDeepSearchTool();
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).reason).toBe("not_in_dp_mode");
    expect(res.content[0].text).toContain("not available in normal mode");
  });

  it("rejects when DP status is idle", async () => {
    const dp = makeDpRef("idle");
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).reason).toBe("not_in_dp_mode");
  });

  it("rejects when investigating (before hypotheses confirmed)", async () => {
    const dp = makeDpRef("investigating");
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).reason).toBe("hypotheses_not_confirmed");
  });

  it("rejects when awaiting_confirmation", async () => {
    const dp = makeDpRef("awaiting_confirmation");
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).reason).toBe("hypotheses_not_confirmed");
  });

  it("rejects when status is concluding / completed", async () => {
    const dp = makeDpRef("concluding");
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).reason).toBe("invalid_status");
  });
});

describe("deep_search tool — hypothesis/triage input handling", () => {
  it("rejects when no confirmed hypotheses + no param hypotheses", async () => {
    const dp = makeDpRef("validating");
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).reason).toBe("no_hypotheses");
  });

  it("rejects when no triage context", async () => {
    const dp = makeDpRef("validating");
    dp.confirmedHypotheses = [{ id: "H1", text: "MTU", confidence: 80 }];
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).reason).toBe("no_triage_context");
  });

  it("uses confirmed hypotheses from state (ignores tool params)", async () => {
    const dp = makeDpRef("validating");
    dp.confirmedHypotheses = [{ id: "H1", text: "MTU mismatch", confidence: 85 }];
    dp.triageContextDraft = "ctx from state";
    mockInvestigate.mockResolvedValue({
      question: "q", hypotheses: [], conclusion: "result",
      contextSummary: "ctx", totalToolCalls: 1, totalDurationMs: 1000,
      timedOut: false, investigationId: "inv-1",
    });
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    await tool.execute("id", {
      question: "why?",
      hypotheses: [{ text: "IGNORED", confidence: 10, suggestedTools: [] }],
    });
    const call = mockInvestigate.mock.calls[0];
    expect(call[1].hypotheses[0].text).toBe("MTU mismatch");
    expect(call[1].triageContext).toBe("ctx from state");
  });

  it("parses hypotheses string JSON fallback", async () => {
    const dp = makeDpRef("validating");
    dp.triageContextDraft = "ctx";
    mockInvestigate.mockResolvedValue({
      question: "q", hypotheses: [], conclusion: "c",
      contextSummary: "ctx", totalToolCalls: 0, totalDurationMs: 0, timedOut: false,
    });
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    await tool.execute("id", {
      question: "why?",
      hypotheses: JSON.stringify([{ text: "from string", confidence: 50, suggestedTools: [] }]),
    });
    expect(mockInvestigate.mock.calls[0][1].hypotheses[0].text).toBe("from string");
  });

  it("uses quick budget when budget='quick'", async () => {
    const dp = makeDpRef("validating");
    dp.confirmedHypotheses = [{ id: "H1", text: "x", confidence: 80 }];
    dp.triageContextDraft = "ctx";
    mockInvestigate.mockResolvedValue({
      question: "q", hypotheses: [], conclusion: "c",
      contextSummary: "ctx", totalToolCalls: 0, totalDurationMs: 0, timedOut: false,
    });
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    await tool.execute("id", { question: "why?", budget: "quick" });
    expect(mockInvestigate.mock.calls[0][1].budget.maxTotalCalls).toBeLessThan(75);
  });

  it("returns dpStatus=concluding in result details", async () => {
    const dp = makeDpRef("validating");
    dp.confirmedHypotheses = [{ id: "H1", text: "x", confidence: 80 }];
    dp.triageContextDraft = "ctx";
    mockInvestigate.mockResolvedValue({
      question: "q",
      hypotheses: [
        { id: "H1", text: "x", status: "validated", confidence: 90, reasoning: "r", evidence: [], toolCallsUsed: 3 },
      ],
      conclusion: "done",
      contextSummary: "ctx",
      totalToolCalls: 5,
      totalDurationMs: 2000,
      timedOut: false,
      investigationId: "inv-xyz",
    });
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect((res.details as any).dpStatus).toBe("concluding");
    expect((res.details as any).investigationId).toBe("inv-xyz");
    expect((res.details as any).hypothesesValidated).toBe(1);
    expect((res.details as any).hypothesesTotal).toBe(1);
  });

  it("returns error text when investigate throws", async () => {
    const dp = makeDpRef("validating");
    dp.confirmedHypotheses = [{ id: "H1", text: "x", confidence: 80 }];
    dp.triageContextDraft = "ctx";
    mockInvestigate.mockRejectedValue(new Error("LLM unavailable"));
    const tool = createDeepSearchTool(undefined, undefined, undefined, dp);
    const res = await tool.execute("id", { question: "why?" });
    expect(res.content[0].text).toContain("Deep search failed");
    expect(res.content[0].text).toContain("LLM unavailable");
  });
});
