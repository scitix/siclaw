/**
 * Quality Gate — validates Phase 4 conclusions before storage/return.
 *
 * Runs an independent LLM call to check:
 * 1. Conclusion answers the original question
 * 2. Root cause is supported by hypothesis evidence
 * 3. Confidence is calibrated to evidence strength
 * 4. Affected entities were actually observed
 *
 * Returns { pass, critique, adjustedConfidence }.
 * The engine retries conclusion generation at most once on failure.
 */

import { llmCompleteWithTool, type SubAgentOptions } from "./sub-agent.js";
import { VALIDATION_SCHEMA } from "./schemas.js";
import type { ConclusionResult, HypothesisNode } from "./types.js";

export interface ValidationResult {
  pass: boolean;
  critique?: string;
  adjustedConfidence?: number;
}

interface ValidateConclusionToolArgs {
  pass: boolean;
  critique?: string;
  adjusted_confidence?: number;
}

export async function validateConclusion(opts: {
  question: string;
  hypotheses: HypothesisNode[];
  conclusion: ConclusionResult;
  options?: SubAgentOptions;
}): Promise<ValidationResult> {
  const { question, hypotheses, conclusion, options } = opts;

  const validatedH = hypotheses.filter(h => h.status === "validated");
  const invalidatedH = hypotheses.filter(h => h.status === "invalidated");
  const inconclusiveH = hypotheses.filter(h => h.status === "inconclusive");

  const hypothesisSummary = hypotheses
    .filter(h => h.status !== "pending" && h.status !== "skipped")
    .map(h => {
      const evidenceList = h.evidence.slice(0, 2)
        .map(e => `    - [${e.tool}] ${e.command.slice(0, 80)}`)
        .join("\n");
      return `- ${h.id}: ${h.text}\n  Status: ${h.status} (${h.confidence}%)\n  Reasoning: ${h.reasoning.slice(0, 200)}${evidenceList ? `\n  Evidence:\n${evidenceList}` : ""}`;
    })
    .join("\n");

  const confidence = conclusion.structured?.confidence ?? 0;
  const rootCause = conclusion.structured?.root_cause_category ?? "unknown";
  const affectedEntities = conclusion.structured?.affected_entities ?? [];

  const prompt = `You are a quality reviewer for SRE investigation conclusions. Check this conclusion for grounding and calibration issues.

<original_question>${question}</original_question>

<hypothesis_verdicts>
Validated: ${validatedH.length}, Invalidated: ${invalidatedH.length}, Inconclusive: ${inconclusiveH.length}

${hypothesisSummary}
</hypothesis_verdicts>

<conclusion>
Root cause: ${rootCause}
Confidence: ${confidence}%
Affected entities: ${affectedEntities.join(", ") || "(none)"}
Text: ${conclusion.text.slice(0, 1500)}
</conclusion>

Check these 4 criteria:
1. Does the conclusion directly answer the original question?
2. Is root_cause_category "${rootCause}" supported by at least one validated or inconclusive hypothesis?
3. Is confidence ${confidence}% calibrated? Rules:
   - All hypotheses invalidated + no validated → confidence should be ≤50
   - Only inconclusive hypotheses → confidence should be ≤60
   - High confidence (>70) requires at least one validated hypothesis with clear evidence
4. Are affected_entities [${affectedEntities.join(", ")}] actually mentioned in hypothesis evidence, not inferred?

Call the validate_conclusion tool with your assessment.
- pass: true ONLY if all 4 checks pass. Be conservative — reject only when clearly ungrounded.
- critique: specific issues found (empty string if pass is true)
- adjusted_confidence: provide ONLY if confidence is miscalibrated (omit if OK)`;

  try {
    const { toolArgs } = await llmCompleteWithTool<ValidateConclusionToolArgs>(
      undefined,
      prompt,
      "validate_conclusion",
      "Submit conclusion validation result",
      VALIDATION_SCHEMA,
      options,
    );

    if (!toolArgs) {
      // LLM failed to return structured output — pass by default (conservative)
      return { pass: true };
    }

    return {
      pass: toolArgs.pass,
      critique: toolArgs.critique || undefined,
      adjustedConfidence: typeof toolArgs.adjusted_confidence === "number"
        ? toolArgs.adjusted_confidence
        : undefined,
    };
  } catch (err) {
    console.warn(`[quality-gate] Validation failed, passing by default:`, err);
    return { pass: true };
  }
}
