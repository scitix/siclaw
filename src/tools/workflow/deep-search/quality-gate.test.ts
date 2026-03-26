import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateConclusion } from "./quality-gate.js";
import type { HypothesisNode } from "./types.js";

// Mock llmCompleteWithTool from sub-agent
vi.mock("./sub-agent.js", () => ({
  llmCompleteWithTool: vi.fn(),
}));

import { llmCompleteWithTool } from "./sub-agent.js";
const mockLlmComplete = vi.mocked(llmCompleteWithTool);

function makeHypothesis(overrides: Partial<HypothesisNode> = {}): HypothesisNode {
  return {
    id: "H1",
    text: "MTU mismatch between pods",
    confidence: 85,
    status: "validated",
    evidence: [{ tool: "bash", command: "mtu-compare.sh", output: "MTU mismatch found", interpretation: "MTU mismatch" }],
    reasoning: "Clear MTU mismatch found across pods",
    suggestedTools: [],
    estimatedCalls: 3,
    toolCallsUsed: 2,
    ...overrides,
  };
}

const baseConclusionResult = {
  text: "Investigation found MTU mismatch between pods.",
  structured: {
    root_cause_category: "mtu_mismatch",
    affected_entities: ["pod/test-pod"],
    environment_tags: ["gpu-east-1"],
    causal_chain: ["MTU misconfigured", "Packet drop", "Connection timeout"],
    confidence: 85,
  },
};

describe("quality-gate / validateConclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns pass when LLM validates conclusion", async () => {
    mockLlmComplete.mockResolvedValue({
      toolArgs: { pass: true, critique: "", adjusted_confidence: undefined },
      textContent: "",
    });

    const result = await validateConclusion({
      question: "Why are pods timing out?",
      hypotheses: [makeHypothesis()],
      conclusion: baseConclusionResult,
    });

    expect(result.pass).toBe(true);
    expect(result.critique).toBeUndefined();
    expect(result.adjustedConfidence).toBeUndefined();
  });

  it("returns fail with critique when conclusion is ungrounded", async () => {
    mockLlmComplete.mockResolvedValue({
      toolArgs: {
        pass: false,
        critique: "Root cause not supported by any validated hypothesis",
        adjusted_confidence: 30,
      },
      textContent: "",
    });

    const result = await validateConclusion({
      question: "Why are pods timing out?",
      hypotheses: [makeHypothesis({ status: "invalidated" })],
      conclusion: baseConclusionResult,
    });

    expect(result.pass).toBe(false);
    expect(result.critique).toBe("Root cause not supported by any validated hypothesis");
    expect(result.adjustedConfidence).toBe(30);
  });

  it("adjusts confidence when all hypotheses invalidated", async () => {
    mockLlmComplete.mockResolvedValue({
      toolArgs: {
        pass: false,
        critique: "All hypotheses were invalidated but confidence is 85%",
        adjusted_confidence: 25,
      },
      textContent: "",
    });

    const result = await validateConclusion({
      question: "Why are pods timing out?",
      hypotheses: [
        makeHypothesis({ id: "H1", status: "invalidated", confidence: 90 }),
        makeHypothesis({ id: "H2", status: "invalidated", confidence: 80 }),
      ],
      conclusion: {
        ...baseConclusionResult,
        structured: { ...baseConclusionResult.structured!, confidence: 85 },
      },
    });

    expect(result.pass).toBe(false);
    expect(result.adjustedConfidence).toBe(25);
  });

  it("passes by default when LLM returns no tool args", async () => {
    mockLlmComplete.mockResolvedValue({
      toolArgs: null,
      textContent: "Some text without tool call",
    });

    const result = await validateConclusion({
      question: "Why are pods timing out?",
      hypotheses: [makeHypothesis()],
      conclusion: baseConclusionResult,
    });

    expect(result.pass).toBe(true);
  });

  it("passes by default when LLM call throws", async () => {
    mockLlmComplete.mockRejectedValue(new Error("API error 500"));

    const result = await validateConclusion({
      question: "Why are pods timing out?",
      hypotheses: [makeHypothesis()],
      conclusion: baseConclusionResult,
    });

    expect(result.pass).toBe(true);
  });

  it("handles conclusion without structured data", async () => {
    mockLlmComplete.mockResolvedValue({
      toolArgs: { pass: true },
      textContent: "",
    });

    const result = await validateConclusion({
      question: "Why are pods timing out?",
      hypotheses: [makeHypothesis()],
      conclusion: { text: "Investigation conclusion text" },
    });

    expect(result.pass).toBe(true);
  });

  it("includes hypothesis summary in validation prompt", async () => {
    mockLlmComplete.mockResolvedValue({
      toolArgs: { pass: true },
      textContent: "",
    });

    await validateConclusion({
      question: "Why are pods timing out?",
      hypotheses: [
        makeHypothesis({ id: "H1", status: "validated", confidence: 85 }),
        makeHypothesis({ id: "H2", status: "invalidated", confidence: 20, text: "Driver issue" }),
      ],
      conclusion: baseConclusionResult,
    });

    // Verify the prompt includes hypothesis details
    const callArgs = mockLlmComplete.mock.calls[0];
    const prompt = callArgs[1]; // userMessage
    expect(prompt).toContain("Validated: 1");
    expect(prompt).toContain("Invalidated: 1");
    expect(prompt).toContain("H1");
    expect(prompt).toContain("H2");
  });
});
