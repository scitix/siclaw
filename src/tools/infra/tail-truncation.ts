/**
 * Tell the caller when `kubectl logs --tail=N` returned exactly N lines.
 *
 * "No matching logs in the window" and "the window was truncated at the limit" look identical in the
 * output, and they call for opposite next steps: the first says look elsewhere, the second says look
 * further back. The agent has no way to tell them apart, so it reads a truncated window as a complete
 * answer — which the retro reported twice.
 *
 * Deliberately narrow, because the alternative is a note that lies:
 *
 *   - only when the WHOLE command is one `kubectl logs`. In a pipeline the line count belongs to the
 *     last stage, not to the logs (`kubectl logs --tail=500 | grep ERROR` returning 500 lines would be
 *     an extraordinary coincidence, and returning 3 says nothing about truncation);
 *   - only when `--tail` was given an explicit positive number. `--tail=-1` means "everything", and
 *     kubectl's own default is unbounded for a single container;
 *   - only when the line count EQUALS the limit. Fewer lines means the window was not filled, which is
 *     itself the useful answer.
 *
 * At exactly N lines the window may or may not have been truncated — N lines existing and N+1 existing
 * are indistinguishable from here. The note says that, rather than asserting truncation.
 */

const PIPELINE_OR_CHAIN = /[|;&]|\$\(|`/;

/** Parse an explicit positive `--tail=N` / `--tail N`. Returns null when absent or not positive. */
function parseTailLimit(args: string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let raw: string | undefined;
    if (a === "--tail") raw = args[i + 1];
    else if (a.startsWith("--tail=")) raw = a.slice("--tail=".length);
    else continue;
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * The note to append, or "" when the situation does not warrant one.
 *
 * `command` is the raw command as the caller wrote it; `stdout` is the command's own output BEFORE any
 * of our literals are appended.
 */
export function tailTruncationNote(command: string, stdout: string): string {
  if (PIPELINE_OR_CHAIN.test(command)) return "";

  const args = command.trim().split(/\s+/);
  const bin = args[0]?.split("/").pop()?.toLowerCase();
  if (bin !== "kubectl") return "";
  if (!args.includes("logs")) return "";

  const limit = parseTailLimit(args);
  if (limit === null) return "";

  const body = stdout.replace(/\n+$/, "");
  if (!body) return "";
  const lines = body.split("\n").length;
  if (lines !== limit) return "";

  return `[tail_limit_reached: exactly ${limit} lines came back, which is the --tail limit — older lines `
    + `may exist beyond this window. Raise --tail or add --since to see whether they do. `
    + `(At exactly the limit, a full window and a truncated one are indistinguishable.)]`;
}
