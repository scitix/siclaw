/**
 * Prompt templates for each phase of deep search investigation.
 *
 * Phase 1 & 3 run as pi-agent sessions — skills are auto-loaded from skills/core/.
 * Phase 2 & 4 use raw llmComplete — skills are injected via getFormattedSkillsPrompt().
 */

import {
  toolSemantics,
  commonMistakes,
  rdmaTroubleshootingPriority,
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
kubeconfig file: \`${kubeconfigPath}\`
MUST add \`--kubeconfig=${kubeconfigPath}\` to EVERY kubectl command.
Do NOT use \`export KUBECONFIG=...\` — blocked by sandbox.

### Sandbox Restrictions
- \`export\`, \`env\` (with args), \`cp\`, \`mv\`, \`rm\` are blocked
- \`kubectl run/apply/delete\` blocked (read-only mode in bash)
- Use \`node_exec\` for host-level diagnostics (it handles kubeconfig internally)
`;
}

/**
 * Phase 1: Context gathering system prompt (used as pi-agent session prompt).
 * Skills are auto-loaded by pi-agent — only tool semantics needed here.
 */
export function contextGatheringPrompt(question: string, maxCalls: number, kubeconfigPath?: string): string {
  return `You are a Kubernetes SRE assistant. Gather the MINIMUM necessary context about the environment related to this question:

<question>${question}</question>
${environmentContext(kubeconfigPath)}
${toolSemantics()}

RULES:
- You have at most ${maxCalls} tool calls (read calls are free). Use them wisely.
- For RDMA/RoCE questions, ALWAYS run roce-show-node-mode FIRST to determine the mode.
- Read a skill's SKILL.md before invoking complex scripts.
- Use skill scripts instead of hand-crafting commands — they encode domain knowledge.
- Focus on: what resources exist, what namespace, what's running, what mode/versions.
- **Chain environment checks**: Combine independent info-gathering commands with && in a single bash call.
  Example: bash: kubectl get nodes -o wide && kubectl get pods -n <ns> -o wide
  This saves tool calls for more important checks.
- Do NOT diagnose or fix anything yet. Just gather context.

IMPORTANT: When you have finished gathering context (or used all tool calls), you MUST output your final summary. Your LAST message must be plain text (no more tool calls) in this exact format:

CONTEXT_SUMMARY_START
- Cluster: <cluster info>
- Namespaces: <relevant namespaces>
- Key resources: <pods, services, devices found>
- Mode: <switchdev/legacy/shared/exclusive if applicable>
- Versions: <firmware, driver, software versions found>
- Anomalies: <anything unusual noticed>
CONTEXT_SUMMARY_END

Do NOT make any more tool calls after outputting this summary.`;
}

/**
 * Phase 2: Hypothesis generation prompt (used with llmComplete, no tools).
 * Injects auto-formatted skills so LLM can reference real script paths in suggestedTools.
 */
export function hypothesisGenerationPrompt(
  question: string,
  contextSummary: string,
  maxHypotheses: number,
): string {
  return `You are a senior SRE investigator. Based on the question and context below, generate ${maxHypotheses} ranked hypotheses.

<question>${question}</question>

<context>
${contextSummary}
</context>

${getFormattedSkillsPrompt()}

${rdmaTroubleshootingPriority()}

Output ONLY valid JSON (no markdown fences, no extra text before or after) in this exact format:
{"hypotheses":[{"text":"Specific hypothesis description","confidence":70,"suggestedTools":["bash: skills/core/roce-mtu-compare/scripts/mtu-compare.sh --pod-a X --ns-a Y --pod-b Z --ns-b W","bash: skills/core/roce-port-counters/scripts/port-counters.sh --pod X --ns Y"]}]}

RULES:
- Exactly ${maxHypotheses} hypotheses, ranked by likelihood (highest confidence first).
- confidence: 0-100 prior belief.
- suggestedTools: MUST use real skill script paths from the skills listed above.
  GOOD: "bash: skills/core/roce-mtu-compare/scripts/mtu-compare.sh --pod-a X --ns-a Y --pod-b Z --ns-b W"
  BAD: "bash: cat /sys/class/net/net1/mtu" or "bash: ethtool -S eth0"
  Only fall back to raw kubectl/node_exec when no skill covers the check.
- Cover diverse failure modes — do not cluster hypotheses around a single root cause.
- Be specific: "Pod OOMKilled due to 256Mi limit" > "Pod has memory issues".
- For RDMA/RoCE: follow the troubleshooting priority order above.`;
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

  return `You are validating a specific hypothesis about a Kubernetes infrastructure issue.

<hypothesis>${hypothesis}</hypothesis>

<context>
${contextSummary}
</context>
${priorSection}${toolList}
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
Summarize the context you gathered as PLAIN TEXT.
Do NOT output any tool calls or XML tags.
Do NOT output <tool_call> or <function=...> or any function call syntax.

Output in this exact format:

CONTEXT_SUMMARY_START
- Cluster: <info>
- Namespaces: <relevant namespaces>
- Key resources: <pods, services, devices>
- Mode: <switchdev/legacy/shared/exclusive if applicable>
- Versions: <firmware, driver, software>
- Anomalies: <anything unusual>
CONTEXT_SUMMARY_END`;
}

export function conclusionPrompt(
  question: string,
  hypothesesSummary: string,
): string {
  return `You are a senior SRE writing the final conclusion for an investigation.

<question>${question}</question>

<investigation_results>
${hypothesesSummary}
</investigation_results>

Write a clear, actionable conclusion that:
1. Directly answers the original question.
2. References the validated hypotheses and key evidence.
3. Provides specific remediation steps if applicable.
4. Notes any inconclusive areas that need further investigation.

Keep it concise (3-5 paragraphs max). Do NOT repeat all the evidence — summarize the key findings.`;
}
