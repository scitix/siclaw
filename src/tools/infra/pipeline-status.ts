/**
 * Per-stage exit status for a shell pipeline.
 *
 * A pipeline's exit code is the LAST stage's, which misleads in both directions and the review backlog
 * reports both, repeatedly:
 *
 *   kubectl get x | jq .      kubectl exits 1 (NotFound), jq exits 0 → reported SUCCESS on an empty
 *                             result, and the agent reads "nothing found" instead of "the query failed"
 *   seq … | head -3           under `pipefail` the whole thing exits 141 (SIGPIPE) → a correct command
 *                             reported as failed, retried, failed again
 *
 * Both are answerable from the same fact, and bash already computes it: `PIPESTATUS`. Measured in the
 * shipped image — `seq 1 2000000 | head -3` gives `PIPESTATUS=[141 0]` with an overall exit of 0, and
 * `[141 0]` with an overall 141 under pipefail. The per-stage data exists either way.
 *
 * WHY ONLY restricted_bash. `${PIPESTATUS[@]}` is a bash array. `/bin/sh` in the AgentBox image is dash,
 * where it is a hard `Bad substitution` — not an empty value, an error. node_exec wraps the host command
 * in `setsid sh -c` and host_exec in a remote `sh -c` on a machine whose shell we do not choose, so
 * injecting this there would break commands that work today for the sake of a diagnostic. pod_exec
 * forbids pipelines outright. restricted_bash runs everything through `shell: "/bin/bash"`, so it is the
 * one place the fact is free.
 *
 * WHAT IS NOT COVERED, stated rather than implied: `;` and `&&` chains. PIPESTATUS describes the last
 * pipeline only, so a chain still reports one status. Attributing a chain needs per-command traps, which
 * is a different mechanism.
 */

/** Unlikely to occur in real output, and checked for before use. */
const SENTINEL = "__siclaw_pipe_status_9f3c__";

/** Does this command have stages whose individual status is not visible in the exit code? */
export function hasPipeline(command: string): boolean {
  // A `|` that is not `||`. Deliberately crude: a `|` inside quotes gives a false positive, and the
  // cost of that is one harmless extra line of instrumentation, never a changed result.
  return /(^|[^|])\|([^|]|$)/.test(command);
}

/**
 * Wrap a command so bash reports each stage's status.
 *
 * The observable exit code is preserved: it is taken from the LAST element of PIPESTATUS, which is what
 * `$?` would have been. Capturing PIPESTATUS must be the FIRST thing after the pipeline — any simple
 * command, an assignment included, resets it.
 *
 * If the user's command exits the shell itself, the trailer never runs, no sentinel appears, and the
 * caller falls back to the plain exit code. Degrading to today's behaviour is the right failure mode.
 */
export function instrumentPipeline(command: string): string {
  // Both captured in ONE simple command: every expansion is evaluated before the assignments run, so
  // `$?` is still the pipeline's status even though PIPESTATUS is read in the same line. Splitting them
  // across two lines loses whichever is read second — an assignment is itself a command and resets both.
  //
  // The caller's exit code is preserved rather than replaced by the last stage's. A command that set
  // `pipefail` asked for 141 and gets it; the classification explains what the 141 means instead of the
  // wrapper quietly overriding a shell option the caller chose.
  return `${command}\n__siclaw_ps="\${PIPESTATUS[*]}" __siclaw_rc=$?\n`
    + `printf '\\n${SENTINEL}%s\\n' "$__siclaw_ps"\n`
    + `exit "$__siclaw_rc"`;
}

export interface PipelineStatus {
  /** Output with the sentinel line removed — what the caller must use from here on. */
  stdout: string;
  /** One status per stage, in pipeline order. Empty when no sentinel was found. */
  statuses: number[];
}

/**
 * Strip the sentinel and return the statuses.
 *
 * Removal happens BEFORE sanitization, deliberately: a structural sanitizer parses the whole payload, and
 * a trailing sentinel line makes a JSON document unparseable — it would turn every instrumented
 * `-o json` pipeline into "not JSON". Same reason the exit-code trailer is appended after sanitizing.
 */
export function extractPipelineStatus(stdout: string): PipelineStatus {
  const at = stdout.lastIndexOf(SENTINEL);
  if (at === -1) return { stdout, statuses: [] };
  const lineEnd = stdout.indexOf("\n", at);
  const raw = stdout.slice(at + SENTINEL.length, lineEnd === -1 ? undefined : lineEnd);
  const statuses = raw.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  // The sentinel is printed with a leading newline; drop that too so output is byte-identical to an
  // uninstrumented run.
  let head = stdout.slice(0, at);
  if (head.endsWith("\n")) head = head.slice(0, -1);
  const tail = lineEnd === -1 ? "" : stdout.slice(lineEnd + 1);
  return { stdout: head + tail, statuses };
}

/** Commands that stop reading on purpose, making SIGPIPE upstream the normal end of the pipeline. */
const EARLY_EXIT_CONSUMERS = new Set(["head", "tail"]);

/** Is stage `i` a SIGPIPE caused by the NEXT stage closing the pipe deliberately? */
export function isExpectedSigpipe(statuses: number[], index: number, stageCommands: string[]): boolean {
  if (statuses[index] !== 141) return false;
  const next = stageCommands[index + 1];
  if (!next) return false;
  const bin = next.trim().split(/\s+/)[0]?.split("/").pop()?.toLowerCase() ?? "";
  // `grep -q` and `grep -m N` also stop early; a bare grep reads to the end.
  if (bin.endsWith("grep")) return /\s-\w*q|\s-m\s*\d/.test(next);
  return EARLY_EXIT_CONSUMERS.has(bin);
}

/** Split a command into its pipeline stages. Crude on quoted `|`, and only ever used for labelling. */
export function pipelineStages(command: string): string[] {
  return command.split(/(?<!\|)\|(?!\|)/).map((s) => s.trim()).filter(Boolean);
}
