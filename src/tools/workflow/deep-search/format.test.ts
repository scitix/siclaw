import { describe, it, expect } from "vitest";
import { formatResult, formatSummary } from "./format.js";
import type { InvestigationResult, HypothesisNode, Evidence } from "./types.js";

// Note: broader coverage for format.ts lives in deep-search.test.ts.
// This file adds boundary cases specific to formatting.

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  tool: "bash",
  command: "kubectl get pods",
  output: "pod-x Running",
  interpretation: "running",
  ...overrides,
});

const hypothesis = (overrides: Partial<HypothesisNode> = {}): HypothesisNode => ({
  id: "H1",
  text: "OOM Kill",
  confidence: 85,
  status: "validated",
  evidence: [evidence()],
  reasoning: "Found OOMKilled",
  suggestedTools: [],
  estimatedCalls: 3,
  toolCallsUsed: 3,
  ...overrides,
});

const result = (overrides: Partial<InvestigationResult> = {}): InvestigationResult => ({
  question: "Why?",
  contextSummary: "ns default, pod x",
  hypotheses: [hypothesis()],
  conclusion: "OOM",
  totalToolCalls: 10,
  totalDurationMs: 5000,
  timedOut: false,
  ...overrides,
});

describe("formatResult — boundary cases", () => {
  it("truncates very long evidence output in appendix", () => {
    const longOutput = "x".repeat(2000);
    const r = result({
      hypotheses: [hypothesis({
        evidence: [evidence({ output: longOutput })],
      })],
    });
    const out = formatResult(r);
    expect(out).toContain("...[truncated]...");
  });

  it("filters evidence with empty output from appendix", () => {
    const r = result({
      hypotheses: [hypothesis({
        evidence: [evidence({ output: "   " })],
      })],
    });
    const out = formatResult(r);
    expect(out).not.toContain("## Evidence Appendix");
  });

  it("includes debugTracePath in stats when present", () => {
    const r = result({ debugTracePath: "/tmp/trace.md" });
    const out = formatResult(r);
    expect(out).toContain("Debug trace: /tmp/trace.md");
  });

  it("omits debug trace line when absent", () => {
    const r = result({ debugTracePath: undefined });
    const out = formatResult(r);
    expect(out).not.toContain("Debug trace:");
  });

  it("status symbols map correctly for all statuses", () => {
    const r = result({
      hypotheses: [
        hypothesis({ id: "H1", status: "validated" }),
        hypothesis({ id: "H2", status: "invalidated" }),
        hypothesis({ id: "H3", status: "inconclusive" }),
        hypothesis({ id: "H4", status: "skipped" }),
      ],
    });
    const out = formatResult(r);
    expect(out).toContain("VALIDATED");
    expect(out).toContain("INVALIDATED");
    expect(out).toContain("INCONCLUSIVE");
    expect(out).toContain("SKIPPED");
  });
});

describe("formatSummary — concise representation", () => {
  it("does NOT include context or evidence appendix", () => {
    const r = result();
    const out = formatSummary(r);
    expect(out).not.toContain("Environment Context");
    expect(out).not.toContain("Evidence Appendix");
  });

  it("shows 0/N when nothing validated", () => {
    const r = result({
      hypotheses: [
        hypothesis({ id: "H1", status: "invalidated" }),
        hypothesis({ id: "H2", status: "invalidated" }),
      ],
    });
    const out = formatSummary(r);
    expect(out).toContain("0/2 validated");
  });

  it("skips reasoning line when reasoning empty", () => {
    const r = result({
      hypotheses: [hypothesis({ reasoning: "" })],
    });
    const out = formatSummary(r);
    // The verdict line should still be there but no follow-up reasoning
    expect(out).toContain("**H1**: OOM Kill");
  });
});
