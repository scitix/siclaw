import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunSubAgent = vi.fn();
const mockLlmComplete = vi.fn();
const mockLlmCompleteWithTool = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock("./sub-agent.js", async () => {
  const actual = await vi.importActual<typeof import("./sub-agent.js")>("./sub-agent.js");
  return {
    ...actual,
    runSubAgent: (...args: any[]) => mockRunSubAgent(...args),
    llmComplete: (...args: any[]) => mockLlmComplete(...args),
    llmCompleteWithTool: (...args: any[]) => mockLlmCompleteWithTool(...args),
  };
});

vi.mock("./quality-gate.js", () => ({
  validateConclusion: vi.fn().mockResolvedValue({ pass: true }),
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
  };
});

import { investigate } from "./engine.js";
import { QUICK_BUDGET } from "./types.js";

beforeEach(() => {
  mockRunSubAgent.mockReset();
  mockLlmComplete.mockReset();
  mockLlmCompleteWithTool.mockReset();
  mockWriteFile.mockReset().mockResolvedValue(undefined);
  mockMkdir.mockReset().mockResolvedValue(undefined);
});

describe("investigate — skip logic when triageContext + hypotheses provided", () => {
  it("skips Phase 1 and Phase 2 when both are provided", async () => {
    // Phase 3 sub-agent — returns a verdict line
    mockRunSubAgent.mockResolvedValue({
      textOutput: "VERDICT: validated\nCONFIDENCE: 90\nREASONING: found mismatch",
      evidence: [],
      callsUsed: 3,
      trace: [],
    });

    // Phase 4 conclusion (tool_use)
    mockLlmCompleteWithTool.mockResolvedValue({
      toolArgs: {
        conclusion_text: "MTU mismatch caused packet drops",
        root_cause_category: "mtu_mismatch",
        affected_entities: ["pod/x"],
        environment_tags: [],
        causal_chain: ["MTU misconfigured"],
        confidence: 90,
      },
      textContent: "",
    });

    const result = await investigate("why crash?", {
      budget: QUICK_BUDGET,
      triageContext: "pod X in ns Y is crashing",
      hypotheses: [
        { text: "MTU mismatch", confidence: 70, suggestedTools: [] },
      ],
    });

    // Phase 1 + 2 skipped — so runSubAgent called only once (Phase 3)
    expect(mockRunSubAgent).toHaveBeenCalledTimes(1);
    // Phase 4 conclusion was called
    expect(mockLlmCompleteWithTool).toHaveBeenCalledTimes(1);
    expect(result.contextSummary).toBe("pod X in ns Y is crashing");
    expect(result.hypotheses[0].status).toBe("validated");
    expect(result.conclusion).toContain("MTU mismatch");
    expect(result.investigationId).toBeUndefined(); // no memoryIndexer → no persistence
  });

  it("falls back when conclusion generation returns no tool args", async () => {
    mockRunSubAgent.mockResolvedValue({
      textOutput: "VERDICT: validated\nCONFIDENCE: 90\nREASONING: found",
      evidence: [], callsUsed: 2, trace: [],
    });
    mockLlmCompleteWithTool.mockResolvedValue({
      toolArgs: null,
      textContent: "This is the conclusion text.",
    });

    const result = await investigate("why?", {
      budget: QUICK_BUDGET,
      triageContext: "ctx",
      hypotheses: [{ text: "h1", confidence: 70, suggestedTools: [] }],
    });

    expect(result.conclusion).toContain("This is the conclusion text");
    expect(result.hypotheses[0].status).toBe("validated");
  });

  it("sorts hypotheses by confidence desc before validation", async () => {
    mockRunSubAgent.mockResolvedValue({
      textOutput: "VERDICT: validated\nCONFIDENCE: 90\nREASONING: ok",
      evidence: [], callsUsed: 1, trace: [],
    });
    mockLlmCompleteWithTool.mockResolvedValue({
      toolArgs: {
        conclusion_text: "done",
        root_cause_category: "unknown",
        confidence: 50,
      },
      textContent: "",
    });

    const result = await investigate("why?", {
      budget: QUICK_BUDGET,
      triageContext: "ctx",
      hypotheses: [
        { text: "low-confidence", confidence: 20, suggestedTools: [] },
        { text: "high-confidence", confidence: 90, suggestedTools: [] },
        { text: "mid-confidence", confidence: 55, suggestedTools: [] },
      ],
    });

    // Highest confidence is sorted first in resulting hypotheses
    expect(result.hypotheses[0].text).toBe("high-confidence");
    expect(result.hypotheses[1].text).toBe("mid-confidence");
    expect(result.hypotheses[2].text).toBe("low-confidence");
  });

  it("handles sub-agent errors gracefully (marks inconclusive)", async () => {
    // First call throws — will be marked inconclusive then retried.
    mockRunSubAgent
      .mockRejectedValueOnce(new Error("sub-agent timed out"))
      .mockRejectedValueOnce(new Error("sub-agent timed out again"));

    mockLlmCompleteWithTool.mockResolvedValue({
      toolArgs: { conclusion_text: "inconclusive", root_cause_category: "unknown", confidence: 0 },
      textContent: "",
    });

    const result = await investigate("why?", {
      budget: QUICK_BUDGET,
      triageContext: "ctx",
      hypotheses: [{ text: "h1", confidence: 50, suggestedTools: [] }],
    });

    expect(result.hypotheses[0].status).toBe("inconclusive");
    expect(result.hypotheses[0].reasoning).toContain("Sub-agent error");
  });
});

describe("investigate — progress events", () => {
  it("emits phase events", async () => {
    mockRunSubAgent.mockResolvedValue({
      textOutput: "VERDICT: validated\nCONFIDENCE: 90\nREASONING: ok",
      evidence: [], callsUsed: 1, trace: [],
    });
    mockLlmCompleteWithTool.mockResolvedValue({
      toolArgs: { conclusion_text: "done", root_cause_category: "unknown", confidence: 50 },
      textContent: "",
    });

    const events: any[] = [];
    await investigate("why?", {
      budget: QUICK_BUDGET,
      triageContext: "ctx",
      hypotheses: [{ text: "h1", confidence: 50, suggestedTools: [] }],
      onProgress: (e) => events.push(e),
    });

    const phaseEvents = events.filter((e) => e.type === "phase");
    expect(phaseEvents.length).toBeGreaterThan(0);
    // Phase 1 noted as skipped
    expect(phaseEvents.find((e) => e.phase === "Phase 1/4")?.detail).toMatch(/skipped/i);
  });
});
