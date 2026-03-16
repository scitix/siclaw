/**
 * Prompt templates for each phase of deep search investigation.
 *
 * Phase 1 & 3 run as pi-agent sessions — skills are auto-loaded from skills/core/.
 * Phase 2 & 4 use raw llmComplete — skills are injected via getFormattedSkillsPrompt().
 */

import {
  toolSemantics,
  commonMistakes,
} from "./sre-knowledge.js";
import { getFormattedSkillsPrompt } from "./sub-agent.js";

/**
 * Generate environment context section for sub-agent prompts.
 * Tells the sub-agent about kubeconfig path and sandbox restrictions.
 */
function environmentContext(kubeconfigPath?: string): string {
  if (!kubeconfigPath) return "";

  return `
## Environment

### Kubeconfig
A kubeconfig is pre-configured. Just run kubectl commands directly — do NOT pass --kubeconfig.
Use \`node_exec\` for host-level diagnostics (it handles kubeconfig internally).

### Sandbox Restrictions
- \`export\`, \`env\` (with args), \`cp\`, \`mv\`, \`rm\` are blocked
- \`kubectl run/apply/delete\` blocked (read-only mode in bash)
`;
}

/**
 * Phase 1: Context gathering system prompt (used as pi-agent session prompt).
 * Skills are auto-loaded by pi-agent — only tool semantics needed here.
 *
 * Uses progressive discovery: the agent follows leads from the problem
 * rather than filling a fixed checklist. Each finding guides the next query.
 */
export function contextGatheringPrompt(question: string, maxCalls: number, kubeconfigPath?: string): string {
  return `You are a Kubernetes SRE investigator. Your job is to UNDERSTAND the problem and gather the context needed to form hypotheses.

<question>${question}</question>
${environmentContext(kubeconfigPath)}
${toolSemantics()}

## Approach: Progressive Discovery

Start from the problem, not from a checklist. Each finding should guide your next query.

1. **Confirm the symptom** — Verify the reported problem actually exists right now.
2. **Follow the thread** — If you find something unexpected, investigate it. If a pod is crashing, check its logs. If a node is NotReady, check its conditions. Let the evidence lead you.
3. **Broaden only if needed** — Only gather environment-level info (cluster version, node count, etc.) if it's relevant to the problem you're seeing.

## Rules
- You have at most ${maxCalls} tool calls (read calls are free). Use them wisely.
- Read a skill's SKILL.md before invoking complex scripts.
- Use skill scripts instead of hand-crafting commands — they encode domain knowledge.
- **Chain independent commands** with && in a single bash call to save budget.
- You MAY form early impressions about what's wrong — note them in your summary. This helps hypothesis generation.

IMPORTANT: When you have finished (or used all tool calls), you MUST output your final summary. Your LAST message must be plain text (no more tool calls) in this exact format:

CONTEXT_SUMMARY_START
<Write a free-form summary organized by relevance to the problem. Include:>
- Problem confirmation: <what you verified — is the symptom real? what exactly is happening?>
- Key findings: <significant observations, error messages, anomalies discovered>
- Environment: <only the environment details relevant to this specific problem>
- Initial leads: <your early impressions about possible causes, if any>
CONTEXT_SUMMARY_END

Do NOT make any more tool calls after outputting this summary.`;
}

/**
 * Prior knowledge from past investigations, injected into Phase 2 hypothesis generation.
 */
export interface PriorKnowledge {
  patterns?: string;
  similarInvestigations?: string;
  validatedHypotheses?: string;
}

/**
 * Phase 2: Hypothesis generation prompt (used with llmComplete, no tools).
 * Injects auto-formatted skills so LLM can reference real script paths in suggestedTools.
 */
export function hypothesisGenerationPrompt(
  question: string,
  contextSummary: string,
  maxHypotheses: number,
  priorKnowledge?: PriorKnowledge,
): string {
  const patternSection = priorKnowledge?.patterns
    ? `\n<diagnostic_patterns>\n${priorKnowledge.patterns}\n</diagnostic_patterns>\n`
    : "";

  const validatedSection = priorKnowledge?.validatedHypotheses
    ? `\n<validated_hypotheses>\nThe following hypotheses were VALIDATED in past similar investigations.\nReuse them (with adjusted confidence based on context similarity) if relevant:\n${priorKnowledge.validatedHypotheses}\n</validated_hypotheses>\n`
    : "";

  const similarSection = priorKnowledge?.similarInvestigations
    ? `\n<similar_investigations>\n${priorKnowledge.similarInvestigations}\n</similar_investigations>\n`
    : "";

  const hasPriorKnowledge = patternSection || validatedSection || similarSection;

  return `You are a senior SRE investigator. Based on the question and context below, generate ${maxHypotheses} ranked hypotheses.

<question>${question}</question>

<context>
${contextSummary}
</context>
${patternSection}${validatedSection}${similarSection}
${getFormattedSkillsPrompt()}

Call the submit_hypotheses tool with your analysis.

Field semantics:
- text: specific hypothesis description ("Pod OOMKilled due to 256Mi limit" not "Pod has memory issues")
- confidence: 0-100 prior belief, highest first
- suggestedTools: MUST use real skill script paths from the skills listed above. Only fall back to raw kubectl/node_exec when no skill covers the check.

RULES:
- Exactly ${maxHypotheses} hypotheses, ranked by likelihood (highest confidence first).
- Cover diverse failure modes — do not cluster hypotheses around a single root cause.
- If the context includes initial leads or early impressions from Phase 1, use them to boost confidence of related hypotheses — but still generate diverse alternatives.${hasPriorKnowledge ? `
- Use diagnostic_patterns to calibrate confidence: if a root cause accounts for a high percentage of past cases, start its hypothesis at higher confidence.
- If validated_hypotheses contains a relevant match, include it (possibly rephrased for this context) with boosted confidence.
- Do NOT blindly copy past hypotheses — evaluate whether the context is similar enough.` : ""}`;
}

/**
 * Phase 3: Hypothesis validation system prompt (used as pi-agent session prompt).
 * Skills are auto-loaded by pi-agent — adds tool semantics and common mistakes.
 */
export function hypothesisValidationPrompt(
  hypothesis: string,
  suggestedTools: string[],
  contextSummary: string,
  maxCalls: number,
  priorFindings?: string,
  kubeconfigPath?: string,
  pastDiagnosticContext?: string,
): string {
  const toolList = suggestedTools.length > 0
    ? `\nSuggested commands to start with:\n${suggestedTools.map((t) => `- ${t}`).join("\n")}`
    : "";

  const priorSection = priorFindings
    ? `\n<prior_findings>
Other hypotheses have already been investigated. Use these findings to avoid redundant work and to inform your analysis:
${priorFindings}
</prior_findings>\n`
    : "";

  const pastDiagSection = pastDiagnosticContext
    ? `\n<past_diagnostic_context>
Similar hypotheses were investigated before. Use this to validate more efficiently:
${pastDiagnosticContext}
</past_diagnostic_context>\n`
    : "";

  return `You are validating a specific hypothesis about a Kubernetes infrastructure issue.

<hypothesis>${hypothesis}</hypothesis>

<context>
${contextSummary}
</context>
${priorSection}${pastDiagSection}${toolList}
${environmentContext(kubeconfigPath)}

${toolSemantics()}

${commonMistakes()}

RULES:
- You have at most ${maxCalls} tool calls (read calls are free). RESERVE at least 1-2 calls for forming your conclusion.
- Read a skill's SKILL.md before invoking unfamiliar scripts.
- Run the suggested commands first, then follow up based on findings.
- Use skill scripts instead of hand-crafting commands.
- Look for evidence that SUPPORTS or REFUTES the hypothesis.

EFFICIENCY RULES (critical — every wasted call reduces investigation quality):
- **Trust skill output**: When a skill script returns a clear result (e.g. "all MTU values are 9000"), ACCEPT it. Do NOT re-verify by manually running kubectl/cat/ip commands for the same data the skill already checked. The skill is authoritative.
- **No redundant verification**: If tool A already answered the question, do NOT call tools B, C, D to cross-check. One clear answer is sufficient.
- **Fail fast on skill errors**: If a skill script fails or returns an error, conclude "inconclusive" for that aspect. Do NOT fall back to raw commands (ibstat, ib_write_bw, ethtool, etc.) as a shotgun approach — raw commands without skill wrappers usually fail or produce uninterpretable output.
- **Each call = new evidence**: Every tool call must target a DIFFERENT piece of evidence. If you find yourself running variations of the same check (e.g. checking MTU on net1, then net2, then net3 separately), STOP — the skill already covered all interfaces.
- **2-3 calls typical**: Most hypotheses can be validated or invalidated in 2-3 targeted tool calls. If you've used 5+ calls without a clear answer, conclude "inconclusive" and move on.
- **Chain independent commands**: When you need to run 2+ commands that don't depend on each other,
  use bash with && to chain them in a single tool call.
  Example: bash: skill-A.sh --args && skill-B.sh --args
  This uses 1 tool call instead of 2.

- CRITICAL: Your LAST message MUST be plain text (no tool calls) containing your verdict in this exact format:

VERDICT: validated
CONFIDENCE: 85
REASONING: Found clear evidence of X in the logs. The Y metric confirms Z.

or

VERDICT: invalidated
CONFIDENCE: 90
REASONING: Checked X and Y, both are normal. No evidence supports this hypothesis.

or

VERDICT: inconclusive
CONFIDENCE: 40
REASONING: Some evidence suggests X but could not confirm due to Y.

The VERDICT line must be one of: validated, invalidated, inconclusive.
The CONFIDENCE line must be a number 0-100.
The REASONING must be 2-3 sentences summarizing key evidence.

Do NOT end with a tool call. Your final message must be the verdict text.`;
}

/**
 * Prompt used to force a verdict when the sub-agent runs out of tool budget.
 */
export function forceVerdictPrompt(): string {
  return `You have used all your tool call budget. Based on the evidence you have gathered so far, provide your verdict NOW.

Do NOT output any tool calls or XML tags.
Do NOT output <tool_call> or <function=...> or any function call syntax.

Output ONLY plain text in this exact format:

VERDICT: validated|invalidated|inconclusive
CONFIDENCE: <0-100>
REASONING: <2-3 sentences based on evidence gathered so far>`;
}

/**
 * Prompt used to force context summary when the sub-agent runs out of tool budget.
 */
export function forceContextSummaryPrompt(): string {
  return `You have used all your tool call budget.
Summarize what you found as PLAIN TEXT.
Do NOT output any tool calls or XML tags.
Do NOT output <tool_call> or <function=...> or any function call syntax.

Output in this exact format:

CONTEXT_SUMMARY_START
- Problem confirmation: <what you verified — is the symptom real? what exactly is happening?>
- Key findings: <significant observations, error messages, anomalies discovered>
- Environment: <relevant environment details>
- Initial leads: <your early impressions about possible causes, if any>
CONTEXT_SUMMARY_END`;
}

export function conclusionPrompt(
  question: string,
  hypothesesSummary: string,
  critique?: string,
): string {
  let result = `You are a senior SRE writing the final conclusion for an investigation.

<question>${question}</question>

<investigation_results>
${hypothesesSummary}
</investigation_results>

Call the submit_conclusion tool with your analysis.

Field semantics:
- conclusion_text: clear, actionable conclusion (3-5 paragraphs) that directly answers the original question, references validated hypotheses and key evidence, and notes inconclusive areas
- root_cause_category: one of: mtu_mismatch, pcie_error, driver_issue, firmware_bug, config_error, resource_exhaustion, network_partition, scheduling_failure, hardware_failure, software_bug, permission_denied, unknown
- affected_entities: K8s resource paths like "pod/name", "node/name", "ns/name", "svc/name"
- environment_tags: cluster/infra identifiers found during investigation
- causal_chain: ordered cause-effect steps leading to the root cause
- confidence: overall confidence in the root cause diagnosis (0-100)
- remediation_steps: specific steps to fix the issue

Before submitting, self-check:
1. Does conclusion_text directly answer the original question?
2. Is root_cause_category supported by at least one validated/inconclusive hypothesis?
3. Is confidence calibrated — high confidence (>70) requires validated hypotheses with clear evidence?
4. Are affected_entities actually observed during investigation, not inferred?
If any check fails, revise before calling the tool.

Do NOT repeat all the evidence — summarize the key findings.`;

  if (critique) {
    result += `\n\nIMPORTANT: Your previous conclusion was rejected by the quality gate. Address this feedback:\n${critique}`;
  }

  return result;
}
