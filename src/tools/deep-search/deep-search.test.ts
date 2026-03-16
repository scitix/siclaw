import { describe, it, expect } from "vitest";
import {
  NORMAL_BUDGET,
  QUICK_BUDGET,
  type HypothesisNode,
  type InvestigationResult,
  type Evidence,
} from "./types.js";
import {
  contextGatheringPrompt,
  hypothesisGenerationPrompt,
  hypothesisValidationPrompt,
  conclusionPrompt,
  forceVerdictPrompt,
  forceContextSummaryPrompt,
  type PriorKnowledge,
} from "./prompts.js";
import {
  toolSemantics,
  commonMistakes,
} from "./sre-knowledge.js";
import { formatResult, formatSummary } from "./format.js";
import { HYPOTHESES_SCHEMA, CONCLUSION_SCHEMA, ROOT_CAUSE_CATEGORIES } from "./schemas.js";
import { extractJSON } from "./sub-agent.js";

// ─── types.ts ───

describe("types / budgets", () => {
  it("NORMAL_BUDGET has expected defaults", () => {
    expect(NORMAL_BUDGET.maxContextCalls).toBe(12);
    expect(NORMAL_BUDGET.maxHypotheses).toBe(5);
    expect(NORMAL_BUDGET.maxCallsPerHypothesis).toBe(10);
    expect(NORMAL_BUDGET.maxTotalCalls).toBe(60);
    expect(NORMAL_BUDGET.maxParallel).toBe(3);
  });

  it("QUICK_BUDGET has lower limits", () => {
    expect(QUICK_BUDGET.maxTotalCalls).toBeLessThan(NORMAL_BUDGET.maxTotalCalls);
    expect(QUICK_BUDGET.maxHypotheses).toBeLessThan(NORMAL_BUDGET.maxHypotheses);
    expect(QUICK_BUDGET.maxContextCalls).toBeLessThan(NORMAL_BUDGET.maxContextCalls);
  });

  it("NORMAL_BUDGET has 5 minute maxDurationMs", () => {
    expect(NORMAL_BUDGET.maxDurationMs).toBe(300_000);
  });

  it("QUICK_BUDGET has 3 minute maxDurationMs", () => {
    expect(QUICK_BUDGET.maxDurationMs).toBe(180_000);
  });

  it("QUICK_BUDGET maxDurationMs is less than NORMAL_BUDGET", () => {
    expect(QUICK_BUDGET.maxDurationMs).toBeLessThan(NORMAL_BUDGET.maxDurationMs);
  });
});

// ─── sre-knowledge.ts ───

describe("sre-knowledge (domain-agnostic tool usage)", () => {
  it("toolSemantics explains bash vs node_exec differences", () => {
    const semantics = toolSemantics();
    expect(semantics).toContain("NOT on the host");
    expect(semantics).toContain("NO pipes");
    expect(semantics).toContain("kubectl exec");
    expect(semantics).toContain("skills/");
  });

  it("toolSemantics includes command chaining guidance", () => {
    const semantics = toolSemantics();
    expect(semantics).toContain("Command Chaining");
    expect(semantics).toContain("PREFER chaining");
    expect(semantics).toContain("DO NOT chain when");
  });

  it("toolSemantics does not contain domain-specific knowledge", () => {
    const semantics = toolSemantics();
    expect(semantics).not.toContain("roce-");
    expect(semantics).not.toContain("switchdev");
    expect(semantics).not.toContain("RDMA");
  });

  it("commonMistakes includes generic tool anti-patterns", () => {
    const mistakes = commonMistakes();
    // node_exec for pod interfaces
    expect(mistakes).toContain("don't exist on host");
    // pipes in node_exec
    expect(mistakes).toContain("lsmod | grep");
    // shell globs in node_exec
    expect(mistakes).toContain("glob expansion");
    // prefer skill scripts
    expect(mistakes).toContain("skill script exists");
    // read SKILL.md
    expect(mistakes).toContain("SKILL.md");
  });

  it("commonMistakes does not contain domain-specific knowledge", () => {
    const mistakes = commonMistakes();
    expect(mistakes).not.toContain("roce-");
    expect(mistakes).not.toContain("switchdev");
    expect(mistakes).not.toContain("RDMA");
  });
});

// ─── prompts.ts ───

describe("prompts", () => {
  it("contextGatheringPrompt includes question, maxCalls, and structured markers", () => {
    const prompt = contextGatheringPrompt("Why is pod X failing?", 5);
    expect(prompt).toContain("Why is pod X failing?");
    expect(prompt).toContain("5");
    expect(prompt).toContain("CONTEXT_SUMMARY_START");
    expect(prompt).toContain("CONTEXT_SUMMARY_END");
  });

  it("contextGatheringPrompt uses progressive discovery approach", () => {
    const prompt = contextGatheringPrompt("RDMA bandwidth low", 12);
    expect(prompt).toContain("Tool Semantics");
    expect(prompt).toContain("Progressive Discovery");
    expect(prompt).toContain("Confirm the symptom");
    expect(prompt).toContain("Follow the thread");
  });

  it("contextGatheringPrompt includes chaining guidance and allows early impressions", () => {
    const prompt = contextGatheringPrompt("test question", 5);
    expect(prompt).toContain("Chain independent commands");
    expect(prompt).toContain("&&");
    expect(prompt).toContain("Initial leads");
    expect(prompt).toContain("early impressions");
  });

  it("hypothesisGenerationPrompt includes context and maxHypotheses", () => {
    const prompt = hypothesisGenerationPrompt("test question", "some context", 3);
    expect(prompt).toContain("test question");
    expect(prompt).toContain("some context");
    expect(prompt).toContain("3");
    expect(prompt).toContain("submit_hypotheses");
  });

  it("hypothesisGenerationPrompt injects skills and is domain-agnostic", () => {
    const prompt = hypothesisGenerationPrompt("RDMA bandwidth low", "context", 5);
    expect(prompt).toContain("MUST use real skill script paths");
    expect(prompt).toContain("initial leads");
    // Should NOT contain hardcoded domain knowledge
    expect(prompt).not.toContain("Troubleshooting Priority");
    expect(prompt).not.toContain("roce-mtu-compare");
  });

  it("hypothesisGenerationPrompt injects diagnostic_patterns when provided", () => {
    const pk: PriorKnowledge = {
      patterns: "| mtu_mismatch | 9 (45%) | 82% | Set MTU |",
    };
    const prompt = hypothesisGenerationPrompt("test", "ctx", 3, pk);
    expect(prompt).toContain("<diagnostic_patterns>");
    expect(prompt).toContain("mtu_mismatch");
    expect(prompt).toContain("calibrate confidence");
  });

  it("hypothesisGenerationPrompt injects validated_hypotheses when provided", () => {
    const pk: PriorKnowledge = {
      validatedHypotheses: '- "MTU 1500 vs 9000" (validated 4 times, max conf 85%)',
    };
    const prompt = hypothesisGenerationPrompt("test", "ctx", 3, pk);
    expect(prompt).toContain("<validated_hypotheses>");
    expect(prompt).toContain("MTU 1500 vs 9000");
    expect(prompt).toContain("Do NOT blindly copy");
  });

  it("hypothesisGenerationPrompt injects similar_investigations when provided", () => {
    const pk: PriorKnowledge = {
      similarInvestigations: "[Structured] [root_cause: mtu_mismatch] RDMA bandwidth low",
    };
    const prompt = hypothesisGenerationPrompt("test", "ctx", 3, pk);
    expect(prompt).toContain("<similar_investigations>");
    expect(prompt).toContain("mtu_mismatch");
  });

  it("hypothesisGenerationPrompt omits all prior knowledge sections when not provided", () => {
    const prompt = hypothesisGenerationPrompt("test", "ctx", 3);
    expect(prompt).not.toContain("<diagnostic_patterns>");
    expect(prompt).not.toContain("<validated_hypotheses>");
    expect(prompt).not.toContain("<similar_investigations>");
    expect(prompt).not.toContain("calibrate confidence");
  });

  it("hypothesisValidationPrompt includes hypothesis and suggested tools", () => {
    const prompt = hypothesisValidationPrompt(
      "OOM kill",
      ["bash: kubectl logs pod-x", "bash: kubectl describe pod pod-x"],
      "context here",
      8,
    );
    expect(prompt).toContain("OOM kill");
    expect(prompt).toContain("kubectl logs pod-x");
    expect(prompt).toContain("kubectl describe pod pod-x");
    expect(prompt).toContain("VERDICT");
    expect(prompt).toContain("8");
  });

  it("hypothesisValidationPrompt works with empty suggestedTools", () => {
    const prompt = hypothesisValidationPrompt("test", [], "ctx", 5);
    expect(prompt).toContain("test");
    expect(prompt).not.toContain("Suggested commands");
  });

  it("hypothesisValidationPrompt instructs to reserve budget for verdict", () => {
    const prompt = hypothesisValidationPrompt("test", [], "ctx", 5);
    expect(prompt).toContain("RESERVE");
    expect(prompt).toContain("Do NOT end with a tool call");
  });

  it("hypothesisValidationPrompt injects tool semantics and common mistakes", () => {
    const prompt = hypothesisValidationPrompt("MTU mismatch", [], "context", 10);
    expect(prompt).toContain("Tool Semantics");
    expect(prompt).toContain("Common Mistakes");
  });

  it("hypothesisValidationPrompt includes command chaining efficiency rules", () => {
    const prompt = hypothesisValidationPrompt("test", [], "ctx", 5);
    expect(prompt).toContain("Chain independent commands");
  });

  it("hypothesisValidationPrompt injects prior findings when provided", () => {
    const findings = "- H1 (MTU mismatch): VALIDATED (90%) — Found MTU 1500 vs 9000";
    const prompt = hypothesisValidationPrompt("test", [], "ctx", 5, findings);
    expect(prompt).toContain("<prior_findings>");
    expect(prompt).toContain("MTU mismatch");
    expect(prompt).toContain("avoid redundant work");
  });

  it("hypothesisValidationPrompt omits prior_findings section when not provided", () => {
    const prompt = hypothesisValidationPrompt("test", [], "ctx", 5);
    expect(prompt).not.toContain("<prior_findings>");
    expect(prompt).not.toContain("avoid redundant work");
  });

  it("hypothesisValidationPrompt injects past_diagnostic_context when provided", () => {
    const pastCtx = '- "MTU mismatch" (validated, 90%)\n  Remediation: Set MTU to 9000';
    const prompt = hypothesisValidationPrompt("test", [], "ctx", 5, undefined, undefined, pastCtx);
    expect(prompt).toContain("<past_diagnostic_context>");
    expect(prompt).toContain("MTU mismatch");
    expect(prompt).toContain("validate more efficiently");
  });

  it("hypothesisValidationPrompt omits past_diagnostic_context when not provided", () => {
    const prompt = hypothesisValidationPrompt("test", [], "ctx", 5);
    expect(prompt).not.toContain("<past_diagnostic_context>");
    expect(prompt).not.toContain("validate more efficiently");
  });

  it("conclusionPrompt includes question, hypotheses summary, and tool instruction", () => {
    const prompt = conclusionPrompt("Why crashed?", "H1: OOM - validated\nH2: Network - invalidated");
    expect(prompt).toContain("Why crashed?");
    expect(prompt).toContain("H1: OOM - validated");
    expect(prompt).toContain("submit_conclusion");
    expect(prompt).toContain("remediation_steps");
    expect(prompt).not.toContain("STRUCTURED_EXTRACTION_START");
    expect(prompt).not.toContain("STRUCTURED_EXTRACTION_END");
  });

  it("forceVerdictPrompt requires structured output and prohibits tool_call XML", () => {
    const prompt = forceVerdictPrompt();
    expect(prompt).toContain("VERDICT");
    expect(prompt).toContain("CONFIDENCE");
    expect(prompt).toContain("REASONING");
    expect(prompt).toContain("Do NOT output");
    expect(prompt).toContain("<tool_call>");
  });

  it("forceContextSummaryPrompt requires structured output and prohibits tool_call XML", () => {
    const prompt = forceContextSummaryPrompt();
    expect(prompt).toContain("CONTEXT_SUMMARY_START");
    expect(prompt).toContain("CONTEXT_SUMMARY_END");
    expect(prompt).toContain("Do NOT output");
    expect(prompt).toContain("<tool_call>");
  });
});

// ─── format.ts ───

describe("formatResult", () => {
  const makeEvidence = (overrides?: Partial<Evidence>): Evidence => ({
    tool: "bash",
    command: "kubectl get pods",
    output: "pod-x Running",
    interpretation: "Pod is running normally",
    ...overrides,
  });

  const makeHypothesis = (overrides?: Partial<HypothesisNode>): HypothesisNode => ({
    id: "H1",
    text: "OOM Kill",
    confidence: 85,
    status: "validated",
    evidence: [makeEvidence()],
    reasoning: "Found OOMKilled in pod events",
    suggestedTools: [],
    toolCallsUsed: 3,
    ...overrides,
  });

  const makeResult = (overrides?: Partial<InvestigationResult>): InvestigationResult => ({
    question: "Why is pod crashing?",
    contextSummary: "Namespace: default, Pod: pod-x",
    hypotheses: [makeHypothesis()],
    conclusion: "The pod is crashing due to OOM.",
    totalToolCalls: 15,
    totalDurationMs: 30000,
    timedOut: false,
    ...overrides,
  });

  it("produces markdown with all sections", () => {
    const output = formatResult(makeResult());
    expect(output).toContain("# Deep Search Investigation Report");
    expect(output).toContain("## Question");
    expect(output).toContain("Why is pod crashing?");
    expect(output).toContain("## Environment Context");
    expect(output).toContain("## Findings");
    expect(output).toContain("H1: OOM Kill");
    expect(output).toContain("VALIDATED");
    expect(output).toContain("85%");
    expect(output).toContain("## Conclusion");
    expect(output).toContain("## Statistics");
  });

  it("shows correct statistics", () => {
    const output = formatResult(makeResult());
    expect(output).toContain("Tool calls: 15");
    expect(output).toContain("Duration: 30.0s");
    expect(output).toContain("1/1 validated");
  });

  it("handles multiple hypotheses with mixed statuses", () => {
    const result = makeResult({
      hypotheses: [
        makeHypothesis({ id: "H1", status: "validated" }),
        makeHypothesis({ id: "H2", status: "invalidated", text: "Network issue", confidence: 20 }),
        makeHypothesis({ id: "H3", status: "inconclusive", text: "Disk full", confidence: 40 }),
      ],
    });
    const output = formatResult(result);
    expect(output).toContain("VALIDATED");
    expect(output).toContain("INVALIDATED");
    expect(output).toContain("INCONCLUSIVE");
    expect(output).toContain("1/3 validated");
  });

  it("truncates long commands in evidence", () => {
    const longCmd = "kubectl get pods -n very-long-namespace --field-selector=metadata.name=extremely-long-pod-name-that-goes-on-and-on";
    const result = makeResult({
      hypotheses: [
        makeHypothesis({
          evidence: [makeEvidence({ command: longCmd })],
        }),
      ],
    });
    const output = formatResult(result);
    expect(output).toContain("...");
  });

  it("handles hypothesis with no evidence", () => {
    const result = makeResult({
      hypotheses: [makeHypothesis({ evidence: [] })],
    });
    const output = formatResult(result);
    expect(output).not.toContain("**Evidence**");
  });

  it("displays skipped hypotheses correctly", () => {
    const result = makeResult({
      hypotheses: [
        makeHypothesis({ id: "H1", status: "validated", confidence: 90 }),
        makeHypothesis({ id: "H2", status: "skipped", text: "Network issue", confidence: 60 }),
        makeHypothesis({ id: "H3", status: "skipped", text: "Disk full", confidence: 40 }),
      ],
    });
    const output = formatResult(result);
    expect(output).toContain("SKIPPED");
    expect(output).toContain("1/3 validated");
    expect(output).toContain("2 skipped");
  });

  it("shows timed out marker in statistics when timedOut is true", () => {
    const result = makeResult({ timedOut: true });
    const output = formatResult(result);
    expect(output).toContain("(timed out)");
  });

  it("does not show timed out marker when timedOut is false", () => {
    const result = makeResult({ timedOut: false });
    const output = formatResult(result);
    expect(output).not.toContain("timed out");
  });

  it("does not show skipped count when no hypotheses are skipped", () => {
    const result = makeResult({
      hypotheses: [
        makeHypothesis({ id: "H1", status: "validated" }),
        makeHypothesis({ id: "H2", status: "invalidated", text: "Network issue" }),
      ],
    });
    const output = formatResult(result);
    expect(output).not.toContain("skipped");
  });
});

// ─── formatSummary ───

describe("formatSummary", () => {
  const makeEvidence = (overrides?: Partial<Evidence>): Evidence => ({
    tool: "bash",
    command: "kubectl get pods",
    output: "pod-x Running",
    interpretation: "Pod is running normally",
    ...overrides,
  });

  const makeHypothesis = (overrides?: Partial<HypothesisNode>): HypothesisNode => ({
    id: "H1",
    text: "OOM Kill",
    confidence: 85,
    status: "validated",
    evidence: [makeEvidence()],
    reasoning: "Found OOMKilled in pod events",
    suggestedTools: [],
    toolCallsUsed: 3,
    ...overrides,
  });

  const makeResult = (overrides?: Partial<InvestigationResult>): InvestigationResult => ({
    question: "Why is pod crashing?",
    contextSummary: "Namespace: default, Pod: pod-x",
    hypotheses: [makeHypothesis()],
    conclusion: "The pod is crashing due to OOM.",
    totalToolCalls: 15,
    totalDurationMs: 30000,
    timedOut: false,
    ...overrides,
  });

  it("includes conclusion, verdicts, statistics, and report path", () => {
    const result = makeResult();
    const output = formatSummary(result, "/home/user/.siclaw/reports/deep-search-test.md");
    expect(output).toContain("## Deep Search Summary");
    expect(output).toContain("### Conclusion");
    expect(output).toContain("The pod is crashing due to OOM.");
    expect(output).toContain("### Hypothesis Verdicts");
    expect(output).toContain("VALIDATED **H1**: OOM Kill — 85%");
    expect(output).toContain("### Statistics");
    expect(output).toContain("Tool calls: 15");
    expect(output).toContain("Full report: `/home/user/.siclaw/reports/deep-search-test.md`");
  });

  it("shows one-line verdict per hypothesis with truncated reasoning", () => {
    const longReasoning = "This is a very long reasoning string that should be truncated because it exceeds the one hundred and twenty characters limit set for summary display to keep it compact and readable";
    const result = makeResult({
      hypotheses: [
        makeHypothesis({ id: "H1", status: "validated", reasoning: longReasoning }),
        makeHypothesis({ id: "H2", status: "invalidated", text: "Network issue", confidence: 20, reasoning: "No errors" }),
        makeHypothesis({ id: "H3", status: "skipped", text: "Disk full", confidence: 40, reasoning: "" }),
      ],
    });
    const output = formatSummary(result, "/tmp/report.md");
    // Long reasoning is truncated with ...
    expect(output).toContain("...");
    // Short reasoning is kept intact
    expect(output).toContain("No errors");
    // Skipped hypothesis has no reasoning suffix
    expect(output).toContain("SKIPPED **H3**: Disk full — 40%");
    expect(output).not.toContain("SKIPPED **H3**: Disk full — 40% —");
  });

  it("does not include evidence details", () => {
    const result = makeResult();
    const output = formatSummary(result, "/tmp/report.md");
    expect(output).not.toContain("**Evidence**");
    expect(output).not.toContain("kubectl get pods");
  });

  it("is significantly shorter than formatResult", () => {
    const result = makeResult({
      hypotheses: [
        makeHypothesis({ id: "H1", evidence: [makeEvidence(), makeEvidence(), makeEvidence()] }),
        makeHypothesis({ id: "H2", text: "Network issue", evidence: [makeEvidence(), makeEvidence()] }),
        makeHypothesis({ id: "H3", text: "Disk full", evidence: [makeEvidence()] }),
      ],
    });
    const full = formatResult(result);
    const summary = formatSummary(result, "/tmp/report.md");
    expect(summary.length).toBeLessThan(full.length);
  });
});

// ─── schemas.ts ───

describe("schemas", () => {
  it("HYPOTHESES_SCHEMA has required array", () => {
    expect(HYPOTHESES_SCHEMA.required).toContain("hypotheses");
    expect(HYPOTHESES_SCHEMA.properties.hypotheses.items.required).toContain("text");
    expect(HYPOTHESES_SCHEMA.properties.hypotheses.items.required).toContain("confidence");
    expect(HYPOTHESES_SCHEMA.properties.hypotheses.items.required).toContain("suggestedTools");
  });

  it("CONCLUSION_SCHEMA has required fields", () => {
    expect(CONCLUSION_SCHEMA.required).toContain("conclusion_text");
    expect(CONCLUSION_SCHEMA.required).toContain("root_cause_category");
    expect(CONCLUSION_SCHEMA.required).toContain("confidence");
  });

  it("CONCLUSION_SCHEMA includes remediation_steps", () => {
    expect(CONCLUSION_SCHEMA.properties.remediation_steps).toBeDefined();
    expect(CONCLUSION_SCHEMA.properties.remediation_steps.type).toBe("array");
  });

  it("ROOT_CAUSE_CATEGORIES is non-empty and includes common categories", () => {
    expect(ROOT_CAUSE_CATEGORIES.length).toBeGreaterThan(0);
    expect(ROOT_CAUSE_CATEGORIES).toContain("mtu_mismatch");
    expect(ROOT_CAUSE_CATEGORIES).toContain("unknown");
  });

  it("CONCLUSION_SCHEMA root_cause_category enum matches ROOT_CAUSE_CATEGORIES", () => {
    expect(CONCLUSION_SCHEMA.properties.root_cause_category.enum).toEqual([...ROOT_CAUSE_CATEGORIES]);
  });
});

// ─── extractJSON ───

describe("extractJSON", () => {
  it("parses pure JSON string", () => {
    const json = '{"hypotheses":[{"text":"test","confidence":50,"suggestedTools":[]}]}';
    expect(extractJSON(json)).toBe(json);
  });

  it("extracts JSON from fenced code block", () => {
    const text = 'Some text\n```json\n{"key":"value"}\n```\nMore text';
    expect(extractJSON(text)).toBe('{"key":"value"}');
  });

  it("extracts JSON from balanced braces in mixed text", () => {
    const text = 'Here is the result: {"root_cause":"mtu_mismatch","confidence":85} end of response';
    expect(extractJSON(text)).toBe('{"root_cause":"mtu_mismatch","confidence":85}');
  });

  it("returns null for text without JSON", () => {
    expect(extractJSON("No JSON here at all")).toBeNull();
  });

  it("handles strings with escaped quotes inside JSON", () => {
    const json = '{"text":"He said \\"hello\\""}';
    expect(extractJSON(json)).toBe(json);
  });
});
