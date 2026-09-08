import { buildReduceInput, type GroupItemOutcome } from "./subagent-group.js";
import { GROUP_REDUCE_INPUT_MAX_CHARS } from "../core/subagent-registry.js";
import { ToolResultArtifactStore, formatToolResultArtifactReference } from "../core/tool-result-artifact.js";

/** All input evidence remains available in the reducer's own scope; no cross-session reads. */
export async function prepareReduceEvidence(
  instruction: string, reports: GroupItemOutcome[], store: ToolResultArtifactStore,
  maxChars = GROUP_REDUCE_INPUT_MAX_CHARS,
): Promise<string> {
  const full = buildReduceInput(instruction, reports, Number.MAX_SAFE_INTEGER);
  if (full.length <= maxChars) return full;
  const references: GroupItemOutcome[] = [];
  for (const [index, report] of reports.entries()) {
    const capture = await store.capture({ text: report.summary, toolCallId: `reduce-input-${index}`, toolName: "subagent_report" });
    if (!("reference" in capture)) throw new Error(`Complete reduce evidence could not be stored: ${capture.failure.reason}`);
    references.push({ ...report, summary: formatToolResultArtifactReference(capture.reference, report.summary, 800) });
  }
  const prompt = buildReduceInput(instruction + "\nRead the complete report artifacts before judging evidence missing or producing conclusions. Previews are not complete reports.", references, Number.MAX_SAFE_INTEGER);
  if (prompt.length > maxChars) throw new Error("Reduce instructions and evidence references exceed the context budget; use a smaller batch");
  return prompt;
}
