import { runSubAgent, llmComplete, type SubAgentOptions, type ProgressCallback, type ProgressEvent } from "./sub-agent.js";
import {
  contextGatheringPrompt,
  hypothesisGenerationPrompt,
  hypothesisValidationPrompt,
  conclusionPrompt,
  forceVerdictPrompt,
  forceContextSummaryPrompt,
} from "./prompts.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type {
  DeepSearchBudget,
  HypothesisNode,
  InvestigationResult,
  TraceStep,
} from "./types.js";
import {
  NORMAL_BUDGET,
  EARLY_EXIT_CONFIDENCE,
  TRACE_MAX_OUTPUT,
  TRACE_HEAD_CHARS,
  TRACE_TAIL_CHARS,
} from "./types.js";

interface RawHypothesis {
  text: string;
  confidence: number;
  suggestedTools: string[];
}

/**
 * Write the full investigation report to ~/.siclaw/reports/deep-search-{timestamp}.md
 * Returns the file path for inclusion in the summary.
 */
export async function writeReport(report: string): Promise<string> {
  const reportDir = join(homedir(), ".siclaw", "reports");
  await mkdir(reportDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `deep-search-${timestamp}.md`;
  const filepath = join(reportDir, filename);

  await writeFile(filepath, report, "utf-8");
  return filepath;
}

/**
 * Write a human-readable Markdown trace file for debugging sub-agent behavior.
 * File is written to ~/.siclaw/traces/deep-search-{timestamp}.md
 */
async function writeDebugTrace(
  question: string,
  hypotheses: HypothesisNode[],
  totalCalls: number,
  durationMs: number,
): Promise<string> {
  const traceDir = join(homedir(), ".siclaw", "traces");
  await mkdir(traceDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `deep-search-${timestamp}.md`;
  const filepath = join(traceDir, filename);

  const lines: string[] = [];
  lines.push(`# Deep Search Debug Trace`);
  lines.push(`\n**Question**: ${question}`);
  lines.push(`**Timestamp**: ${new Date().toISOString()}`);
  lines.push(`**Total tool calls**: ${totalCalls} | **Duration**: ${(durationMs / 1000).toFixed(1)}s`);
  lines.push(`**Hypotheses**: ${hypotheses.length} total, ${hypotheses.filter((h) => h.status === "validated").length} validated`);
  lines.push(`\n---\n`);

  for (const h of hypotheses) {
    lines.push(`## ${h.id}: ${h.text}`);
    lines.push(`**Status**: ${h.status} (${h.confidence}%) | **Tool calls**: ${h.toolCallsUsed}`);
    lines.push(`**Suggested tools**: ${h.suggestedTools.join(", ") || "(none)"}`);
    lines.push(`**Reasoning**: ${h.reasoning}`);

    if (h.trace && h.trace.length > 0) {
      lines.push(`\n### Execution Trace\n`);
      let stepNum = 0;
      for (const step of h.trace) {
        stepNum++;
        switch (step.type) {
          case "llm_reasoning":
            lines.push(`#### Step ${stepNum}: LLM Reasoning`);
            lines.push(`> ${step.content.replace(/\n/g, "\n> ")}`);
            lines.push("");
            break;
          case "tool_call":
            lines.push(`#### Step ${stepNum}: Tool Call`);
            lines.push(`\`\`\`\n${step.tool}: ${step.command}\n\`\`\``);
            lines.push("");
            break;
          case "tool_result":
            lines.push(`#### Step ${stepNum}: Tool Result`);
            // Truncate very long outputs in trace
            const output = step.content.length > TRACE_MAX_OUTPUT
              ? step.content.slice(0, TRACE_HEAD_CHARS) + "\n...[truncated]...\n" + step.content.slice(-TRACE_TAIL_CHARS)
              : step.content;
            lines.push(`\`\`\`\n${output}\n\`\`\``);
            lines.push("");
            break;
        }
      }
    } else {
      lines.push(`\n*No trace data available*\n`);
    }

    lines.push(`\n---\n`);
  }

  await writeFile(filepath, lines.join("\n"), "utf-8");
  return filepath;
}

/**
 * Extract JSON from LLM output using multi-layer fallback:
 * 1. Direct JSON.parse
 * 2. Fenced code block (```json ... ```)
 * 3. Balanced brace matching (first complete top-level object)
 */
function extractJSON(text: string): string | null {
  // 1. Direct parse — LLM sometimes returns pure JSON
  try {
    JSON.parse(text);
    return text;
  } catch {
    // continue to next strategy
  }

  // 2. Fenced code block
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      JSON.parse(fenceMatch[1]);
      return fenceMatch[1];
    } catch {
      // fence content wasn't valid JSON, continue
    }
  }

  // 3. Balanced brace extraction — find first complete top-level { ... }
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // Balanced braces but not valid JSON, give up
            return null;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Phase 2: Generate hypotheses using a single LLM call (no tools).
 * Includes robust JSON extraction and a single retry on parse failure.
 */
async function generateHypotheses(
  question: string,
  contextSummary: string,
  maxHypotheses: number,
  options?: SubAgentOptions,
  onProgress?: ProgressCallback,
): Promise<RawHypothesis[]> {
  const prompt = hypothesisGenerationPrompt(question, contextSummary, maxHypotheses);
  const fallback: RawHypothesis[] = [{ text: "Failed to parse hypotheses JSON", confidence: 0, suggestedTools: [] }];

  const MAX_RETRIES = 1;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let text: string;
    try {
      // Only forward onProgress on first attempt to avoid duplicate spinner events
      text = await llmComplete(undefined, prompt, options, attempt === 0 ? onProgress : undefined);
    } catch (err) {
      if (attempt < MAX_RETRIES) continue;
      const msg = err instanceof Error ? err.message : String(err);
      return [{ text: `Hypothesis generation failed: ${msg}`, confidence: 0, suggestedTools: [] }];
    }

    const jsonStr = extractJSON(text);
    if (!jsonStr) {
      if (attempt < MAX_RETRIES) continue;
      return fallback;
    }

    try {
      const parsed = JSON.parse(jsonStr);
      // Accept both { hypotheses: [...] } and bare array [...]
      const hypotheses: RawHypothesis[] | null = Array.isArray(parsed.hypotheses)
        ? parsed.hypotheses
        : Array.isArray(parsed)
          ? parsed
          : null;
      if (!hypotheses?.length || !hypotheses[0].text) {
        if (attempt < MAX_RETRIES) continue;
        return fallback;
      }
      return hypotheses.slice(0, maxHypotheses);
    } catch {
      if (attempt < MAX_RETRIES) continue;
      return fallback;
    }
  }

  return fallback; // unreachable, but satisfies TS
}

/**
 * Phase 4: Generate final conclusion using a single LLM call (no tools).
 */
async function generateConclusion(
  question: string,
  hypotheses: HypothesisNode[],
  options?: SubAgentOptions,
): Promise<string> {
  const hypothesesSummary = hypotheses
    .map((h) => {
      const evidenceText = h.evidence
        .map((e) => `  - [${e.tool}] ${e.command}\n    Output: ${e.output.slice(0, 200)}`)
        .join("\n");
      return `${h.id}: ${h.text}\nStatus: ${h.status} (${h.confidence}%)\nReasoning: ${h.reasoning}\nEvidence:\n${evidenceText}`;
    })
    .join("\n\n");

  const prompt = conclusionPrompt(question, hypothesesSummary);
  // No onProgress here — Phase 4 conclusion text should NOT leak into spinner
  try {
    return await llmComplete(undefined, prompt, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Conclusion generation failed: ${msg}`;
  }
}

/**
 * Parse the verdict output from a Phase 3 sub-agent.
 */
function parseVerdict(text: string): { status: HypothesisNode["status"]; confidence: number; reasoning: string } {
  const verdictMatch = text.match(/VERDICT:\s*(validated|invalidated|inconclusive)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*(\d+)/i);
  const reasoningMatch = text.match(/REASONING:\s*([\s\S]*?)(?:$)/i);

  return {
    status: (verdictMatch?.[1]?.toLowerCase() as HypothesisNode["status"]) ?? "inconclusive",
    confidence: confidenceMatch ? parseInt(confidenceMatch[1], 10) : 50,
    reasoning: reasoningMatch?.[1]?.trim() ?? text.slice(-300),
  };
}

/**
 * Extract context summary from Phase 1 output.
 * Tries structured markers first, falls back to full text.
 */
function parseContextSummary(text: string): string {
  // Try new structured format
  const structuredMatch = text.match(/CONTEXT_SUMMARY_START\s*([\s\S]*?)\s*CONTEXT_SUMMARY_END/i);
  if (structuredMatch) return structuredMatch[1].trim();

  // Fallback: old format
  const oldMatch = text.match(/CONTEXT_SUMMARY:\s*([\s\S]*?)$/i);
  if (oldMatch) return oldMatch[1].trim();

  // Last resort: use the entire text (better than empty)
  return text.trim() || "(No context gathered)";
}

/**
 * Pre-gathered hypothesis from PL agent triage.
 * When provided, Phase 2 (hypothesis generation) is skipped.
 */
export interface TriageHypothesis {
  text: string;
  confidence: number;
  suggestedTools: string[];
}

export interface InvestigateOptions extends SubAgentOptions {
  budget?: DeepSearchBudget;
  onProgress?: ProgressCallback;
  /** Pre-gathered context from PL agent triage. Skips Phase 1 when provided. */
  triageContext?: string;
  /** Pre-confirmed hypotheses from PL agent. Skips Phase 2 when provided. */
  hypotheses?: TriageHypothesis[];
}

/**
 * Main investigation engine. Orchestrates up to 4 phases:
 * 1. Context gathering (sub-agent with tools) — SKIPPED if triageContext provided
 * 2. Hypothesis generation (single LLM call) — SKIPPED if hypotheses provided
 * 3. Parallel hypothesis validation (sub-agents with tools)
 * 4. Conclusion generation (single LLM call)
 *
 * When PL agent provides triageContext and/or hypotheses from interactive triage,
 * the skipped phases' budget is redistributed to Phase 3 validation.
 */
export async function investigate(
  question: string,
  options?: InvestigateOptions,
): Promise<InvestigationResult> {
  const budget = options?.budget ?? NORMAL_BUDGET;
  const onProgress = options?.onProgress;
  const startTime = Date.now();
  let globalCallsUsed = 0;

  // --- Phase 1: Context Gathering (skip if triageContext provided) ---
  let contextSummary: string;
  if (options?.triageContext) {
    onProgress?.({ type: "phase", phase: "Phase 1/4", detail: "Using pre-gathered triage context (skipped)" });
    contextSummary = options.triageContext;
  } else {
    onProgress?.({ type: "phase", phase: "Phase 1/4", detail: "Gathering context..." });
    const contextPrompt = contextGatheringPrompt(question, budget.maxContextCalls);
    const contextResult = await runSubAgent(
      contextPrompt,
      question,
      budget.maxContextCalls,
      options,
      onProgress,
      forceContextSummaryPrompt(),
    );
    globalCallsUsed += contextResult.callsUsed;
    contextSummary = parseContextSummary(contextResult.textOutput);
  }

  // --- Phase 2: Hypothesis Generation (skip if hypotheses provided) ---
  let hypotheses: HypothesisNode[];
  if (options?.hypotheses && options.hypotheses.length > 0) {
    onProgress?.({ type: "phase", phase: "Phase 2/4", detail: `Using ${options.hypotheses.length} pre-confirmed hypotheses (skipped)` });
    hypotheses = options.hypotheses.map((h, i) => ({
      id: `H${i + 1}`,
      text: h.text,
      confidence: h.confidence,
      status: "pending" as const,
      evidence: [],
      reasoning: "",
      suggestedTools: h.suggestedTools,
      toolCallsUsed: 0,
    }));
  } else {
    onProgress?.({ type: "phase", phase: "Phase 2/4", detail: "Generating hypotheses..." });
    const rawHypotheses = await generateHypotheses(
      question,
      contextSummary,
      budget.maxHypotheses,
      options,
      onProgress,
    );
    hypotheses = rawHypotheses.map((h, i) => ({
      id: `H${i + 1}`,
      text: h.text,
      confidence: h.confidence,
      status: "pending" as const,
      evidence: [],
      reasoning: "",
      suggestedTools: h.suggestedTools,
      toolCallsUsed: 0,
    }));
  }

  for (const h of hypotheses) {
    onProgress?.({ type: "hypothesis", id: h.id, status: "pending", confidence: h.confidence, text: h.text });
  }

  // --- Phase 3: Parallel Hypothesis Validation ---
  // Sort hypotheses by confidence DESC so most likely root cause is validated first
  hypotheses.sort((a, b) => b.confidence - a.confidence);

  // When phases are skipped, their budget is redistributed to validation
  const validationBudget = budget.maxTotalCalls - globalCallsUsed;
  onProgress?.({ type: "phase", phase: "Phase 3/4", detail: `Validating ${hypotheses.length} hypotheses (budget: ${validationBudget} calls)...` });

  let rootCauseFound = false;
  let priorFindings: string | undefined;
  let timedOut = false;

  for (let batchStart = 0; batchStart < hypotheses.length; batchStart += budget.maxParallel) {
    // Early exit: skip remaining batches if a hypothesis was validated with high confidence
    if (rootCauseFound) break;

    // Global timeout check: break out of Phase 3 if exceeded
    const elapsed = Date.now() - startTime;
    if (elapsed > budget.maxDurationMs) {
      timedOut = true;
      onProgress?.({ type: "phase", phase: "Phase 3/4", detail: `Global timeout (${(budget.maxDurationMs / 1000).toFixed(0)}s) exceeded, skipping remaining hypotheses...` });
      break;
    }

    const remainingBudget = budget.maxTotalCalls - globalCallsUsed;
    if (remainingBudget <= 0) break;

    const batch = hypotheses.slice(batchStart, batchStart + budget.maxParallel);
    const perHypothesisBudget = Math.min(
      budget.maxCallsPerHypothesis,
      Math.floor(remainingBudget / batch.length),
    );

    if (perHypothesisBudget <= 0) break;

    const validationPromises = batch.map(async (hypothesis) => {
      const prompt = hypothesisValidationPrompt(
        hypothesis.text,
        hypothesis.suggestedTools,
        contextSummary,
        perHypothesisBudget,
        priorFindings,
      );

      // Wrap onProgress to tag every sub-agent event with its hypothesisId
      const taggedProgress: ProgressCallback | undefined = onProgress
        ? (event: ProgressEvent) => onProgress({ ...event, hypothesisId: hypothesis.id } as ProgressEvent)
        : undefined;

      const result = await runSubAgent(
        prompt,
        `Validate hypothesis: ${hypothesis.text}`,
        perHypothesisBudget,
        options,
        taggedProgress,
        forceVerdictPrompt(),
      );

      const verdict = parseVerdict(result.textOutput);

      hypothesis.status = verdict.status;
      hypothesis.confidence = verdict.confidence;
      hypothesis.reasoning = verdict.reasoning;
      hypothesis.evidence = result.evidence;
      hypothesis.toolCallsUsed = result.callsUsed;
      hypothesis.trace = result.trace;

      onProgress?.({
        type: "hypothesis",
        id: hypothesis.id,
        status: hypothesis.status,
        confidence: hypothesis.confidence,
      });

      return result.callsUsed;
    });

    const settledResults = await Promise.allSettled(validationPromises);

    // Process results: fulfilled → count calls, rejected → collect for retry
    const failedInBatch: HypothesisNode[] = [];
    for (let i = 0; i < settledResults.length; i++) {
      const result = settledResults[i];
      if (result.status === "fulfilled") {
        globalCallsUsed += result.value;
      } else {
        // Sub-agent crashed — mark as inconclusive initially, collect for retry
        const failedH = batch[i];
        failedH.status = "inconclusive";
        failedH.confidence = 0;
        failedH.reasoning = `Sub-agent error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
        onProgress?.({ type: "hypothesis", id: failedH.id, status: "inconclusive", confidence: 0 });
        failedInBatch.push(failedH);
      }
    }

    // Single retry for transient failures (sequential to avoid burst)
    for (const hypothesis of failedInBatch) {
      if (rootCauseFound) break;
      const retryBudget = Math.min(
        budget.maxCallsPerHypothesis,
        budget.maxTotalCalls - globalCallsUsed,
      );
      if (retryBudget <= 0) break;

      const retryPrompt = hypothesisValidationPrompt(
        hypothesis.text,
        hypothesis.suggestedTools,
        contextSummary,
        retryBudget,
        priorFindings,
      );
      const taggedProgress: ProgressCallback | undefined = onProgress
        ? (event: ProgressEvent) => onProgress({ ...event, hypothesisId: hypothesis.id } as ProgressEvent)
        : undefined;

      try {
        const result = await runSubAgent(
          retryPrompt,
          `Validate hypothesis (retry): ${hypothesis.text}`,
          retryBudget,
          options,
          taggedProgress,
          forceVerdictPrompt(),
        );

        const verdict = parseVerdict(result.textOutput);
        hypothesis.status = verdict.status;
        hypothesis.confidence = verdict.confidence;
        hypothesis.reasoning = verdict.reasoning;
        hypothesis.evidence = result.evidence;
        hypothesis.toolCallsUsed = result.callsUsed;
        hypothesis.trace = result.trace;
        globalCallsUsed += result.callsUsed;

        onProgress?.({
          type: "hypothesis",
          id: hypothesis.id,
          status: hypothesis.status,
          confidence: hypothesis.confidence,
        });
      } catch {
        // Both attempts failed — leave as inconclusive (already marked above)
      }
    }

    // Check if any hypothesis in this batch was validated with high confidence
    if (batch.some((h) => h.status === "validated" && h.confidence >= EARLY_EXIT_CONFIDENCE)) {
      rootCauseFound = true;
    }

    // Collect findings from completed hypotheses for the next batch
    const completed = hypotheses.filter((h) => h.status !== "pending" && h.status !== "skipped");
    if (completed.length > 0) {
      priorFindings = completed
        .map((h) => {
          const status = h.status.toUpperCase();
          const reasoning = h.reasoning.length > 100
            ? h.reasoning.slice(0, 100) + "..."
            : (h.reasoning || "(no details)");
          return `- ${h.id} (${h.text}): ${status} (${h.confidence}%) — ${reasoning}`;
        })
        .join("\n");
    }
  }

  // Mark remaining pending hypotheses as skipped
  for (const h of hypotheses) {
    if (h.status === "pending") {
      h.status = "skipped";
      onProgress?.({ type: "hypothesis", id: h.id, status: "skipped", confidence: h.confidence });
    }
  }

  // --- Phase 4: Conclusion ---
  onProgress?.({ type: "phase", phase: "Phase 4/4", detail: "Generating conclusion..." });
  const conclusion = await generateConclusion(question, hypotheses, options);

  const totalDurationMs = Date.now() - startTime;

  // Write debug trace file (best-effort, don't fail investigation on trace errors)
  let debugTracePath: string | undefined;
  try {
    debugTracePath = await writeDebugTrace(question, hypotheses, globalCallsUsed, totalDurationMs);
  } catch {
    // Trace writing is non-critical
  }

  return {
    question,
    contextSummary,
    hypotheses,
    conclusion,
    totalToolCalls: globalCallsUsed,
    totalDurationMs,
    timedOut,
    debugTracePath,
  };
}
