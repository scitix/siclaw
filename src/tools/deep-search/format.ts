import type { InvestigationResult, HypothesisNode, Evidence } from "./types.js";

const STATUS_ICONS: Record<string, string> = {
  validated: "✅ VALIDATED",
  invalidated: "❌ INVALIDATED",
  inconclusive: "⚠️ INCONCLUSIVE",
  pending: "⏳ PENDING",
  skipped: "⏭️ SKIPPED",
};

const STATUS_PLAIN: Record<string, string> = {
  validated: "VALIDATED",
  invalidated: "INVALIDATED",
  inconclusive: "INCONCLUSIVE",
  pending: "PENDING",
  skipped: "SKIPPED",
};

/**
 * Summarize tool output to first few meaningful lines (for evidence display).
 */
function summarizeOutput(output: string, maxLen = 200): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("...[truncated]"));
  if (lines.length === 0) return "";
  const result = lines.slice(0, 3).join(" | ");
  return result.length > maxLen ? result.slice(0, maxLen - 3) + "..." : result;
}

/**
 * Format a single hypothesis for the full report.
 * Structure: status + finding (reasoning) + key evidence with actual outputs.
 */
function formatHypothesis(h: HypothesisNode): string {
  const status = STATUS_ICONS[h.status] ?? h.status.toUpperCase();
  const lines: string[] = [];

  lines.push(`#### ${h.id}: ${h.text}`);
  lines.push(`**Status**: ${status} | **Confidence**: ${h.confidence}%`);

  // Reasoning is the sub-agent's synthesized conclusion — show prominently
  if (h.reasoning) {
    lines.push("");
    lines.push(`**Finding**: ${h.reasoning}`);
  }

  // Show key evidence — only entries with meaningful output, summarized
  const meaningful = h.evidence.filter((e) => e.output?.trim());
  if (meaningful.length > 0) {
    lines.push("");
    lines.push("**Key Evidence**:");
    for (const e of meaningful) {
      const cmdDisplay =
        e.command.length > 80 ? e.command.slice(0, 77) + "..." : e.command;
      const outputLine = summarizeOutput(e.output);
      if (outputLine) {
        lines.push(`- \`${e.tool}: ${cmdDisplay}\``);
        lines.push(`  → ${outputLine}`);
      } else {
        lines.push(`- \`${e.tool}: ${cmdDisplay}\``);
      }
    }
  }

  lines.push("");
  lines.push(`*Tool calls: ${h.toolCallsUsed}*`);
  return lines.join("\n");
}

/**
 * Compact summary for PL agent context. Full report is written to a file separately.
 * Keeps conclusion + one-line verdict per hypothesis + statistics + file path.
 */
export function formatSummary(
  result: InvestigationResult,
  reportPath: string,
): string {
  const sections: string[] = [];

  sections.push("## Deep Search Summary");
  sections.push(`### Conclusion\n${result.conclusion}`);

  sections.push("### Hypothesis Verdicts");
  for (const h of result.hypotheses) {
    const icon = STATUS_ICONS[h.status] ?? h.status.toUpperCase();
    sections.push(`- ${icon} **${h.id}**: ${h.text} — ${h.confidence}%`);
    if (h.reasoning) {
      const r = h.reasoning.length > 150
        ? h.reasoning.slice(0, 147) + "..."
        : h.reasoning;
      sections.push(`  ${r}`);
    }
  }

  const validated = result.hypotheses.filter(
    (h) => h.status === "validated",
  ).length;
  const skipped = result.hypotheses.filter(
    (h) => h.status === "skipped",
  ).length;
  const durationSuffix = result.timedOut ? " (timed out)"
    : result.circuitBroken ? " (circuit breaker tripped — LLM API unavailable)"
    : "";
  const duration = `${(result.totalDurationMs / 1000).toFixed(1)}s${durationSuffix}`;
  const hypoStat = `${validated}/${result.hypotheses.length} validated` +
    (skipped > 0 ? `, ${skipped} skipped` : "");
  sections.push(
    `### Statistics\n` +
    `- Tool calls: ${result.totalToolCalls} | Duration: ${duration} | Hypotheses: ${hypoStat}`,
  );

  sections.push(`Full report: \`${reportPath}\``);

  return sections.join("\n\n");
}

/**
 * Full investigation report written to file.
 * Structure: conclusion first → per-hypothesis findings → evidence appendix → stats.
 */
export function formatResult(result: InvestigationResult): string {
  const sections: string[] = [];

  sections.push("# Deep Search Investigation Report");
  sections.push(`## Question\n${result.question}`);

  // Conclusion first — most important information at the top
  sections.push(`## Conclusion\n${result.conclusion}`);

  // Per-hypothesis findings with key evidence
  sections.push("## Findings");
  for (const h of result.hypotheses) {
    sections.push(formatHypothesis(h));
  }

  // Context at the bottom (reference)
  sections.push(`## Environment Context\n${result.contextSummary}`);

  // Evidence appendix — full tool outputs for reference
  const allEvidence = result.hypotheses.flatMap((h) =>
    h.evidence
      .filter((e) => e.output?.trim())
      .map((e) => ({ hypothesisId: h.id, ...e })),
  );
  if (allEvidence.length > 0) {
    sections.push("## Evidence Appendix");
    sections.push(
      "*Full tool outputs for reference. See debug trace for complete execution log.*\n",
    );
    for (const e of allEvidence) {
      const cmdDisplay =
        e.command.length > 120 ? e.command.slice(0, 117) + "..." : e.command;
      sections.push(`#### [${e.hypothesisId}] ${e.tool}: ${cmdDisplay}`);
      // Truncate very long outputs
      const output =
        e.output.length > 1500
          ? e.output.slice(0, 1000) + "\n...[truncated]...\n" + e.output.slice(-400)
          : e.output;
      sections.push("```\n" + output + "\n```");
    }
  }

  // Statistics
  const validated = result.hypotheses.filter(
    (h) => h.status === "validated",
  ).length;
  const skipped = result.hypotheses.filter(
    (h) => h.status === "skipped",
  ).length;
  let stats =
    `## Statistics\n` +
    `- Tool calls: ${result.totalToolCalls}\n` +
    `- Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s` +
    (result.timedOut ? " (timed out)" : result.circuitBroken ? " (circuit breaker — LLM API unavailable)" : "") +
    `\n` +
    `- Hypotheses: ${validated}/${result.hypotheses.length} validated` +
    (skipped > 0 ? `, ${skipped} skipped` : "");

  if (result.debugTracePath) {
    stats += `\n- Debug trace: ${result.debugTracePath}`;
  }

  sections.push(stats);

  return sections.join("\n\n");
}
