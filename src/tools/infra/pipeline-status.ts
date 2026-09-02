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
 * is a different mechanism — and `alignPipelineStages` therefore refuses to name a stage whenever it
 * cannot tell which pipeline of such a chain the statuses came from.
 */

import { extractPipeline, type PipelineSegment } from "./command-validator.js";
import { getCommandBinary } from "./command-sets.js";

/** Unlikely to occur in real output, and checked for before use. */
const SENTINEL = "__siclaw_pipe_status_9f3c__";

/** Does this command have stages whose individual status is not visible in the exit code? */
export function hasPipeline(command: string): boolean {
  // A `|` that is not `||`. Deliberately crude, and safe to be: a `|` inside quotes gives a false
  // positive, whose only cost is one harmless extra line of instrumentation. Nothing here decides a
  // verdict — that is `alignPipelineStages`, which uses the real quote-aware splitter.
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

/**
 * Is stage `i` a SIGPIPE that the pipeline's own shape explains?
 *
 * SIGPIPE reaches a writer only when the READ end closed, so the statuses DOWNSTREAM answer the
 * question without anyone naming a command: if the pipeline ends in a stage that closed early and
 * then finished normally, every 141 above it is that closure, which is exactly how `head`, `grep -q`
 * and `grep -m N` end a pipeline. A non-zero, non-SIGPIPE status down there is the real failure, and
 * the branch that reports it takes precedence.
 *
 * The walk past consecutive 141s is not defensive padding: **SIGPIPE CASCADES.** When the consumer at
 * the end of a long pipeline stops reading, EVERY stage above it is killed, not just the one feeding
 * it — `seq … | cat | head -1` and `seq … | grep -v zzz | head -1` both report [141, 141, 0] in real
 * bash. Looking only at the adjacent stage read the first 141 as an ordinary failure, so
 * `kubectl logs pod | grep -v noise | head -20` — one of the commonest shapes there is — was reported
 * as `pipeline_upstream_failed`, carrying the very sentence this change set exists to delete.
 *
 * This used to consult the next stage's TEXT and check it against a list of early-exit consumers,
 * which made a benign SIGPIPE depend on the stage text lining up with `PIPESTATUS` — the alignment
 * that `alignPipelineStages` cannot always deliver. Deriving it from the statuses alone removes that
 * dependency: the judgment survives even when the text cannot be attributed at all.
 */
export function isBenignSigpipe(statuses: number[], index: number): boolean {
  if (statuses[index] !== 141) return false;
  let i = index + 1;
  while (i < statuses.length && statuses[i] === 141) i++;
  // Running off the end means everything downstream was killed too, so nothing closed the pipe on
  // purpose — that is the truncation case, and it is not this function's to bless.
  return i < statuses.length && statuses[i] === 0;
}

/** One stage's status together with the command that produced it. */
export interface AlignedStage {
  status: number;
  /** The stage's command text, as written. */
  command: string;
  /** Its base binary, lower-cased — `LC_ALL=C /bin/grep -c x` gives `grep`. */
  binary: string;
}

/**
 * Pair each status with the command that produced it, or return null when that cannot be done
 * honestly.
 *
 * `PIPESTATUS` describes ONE pipeline — the last one bash actually executed — while the command text
 * may hold several, joined by `;`, `&`, `&&` or `||`. Splitting the text on `|` and indexing it with
 * a status subscript is how a status came to be attributed to a command that never ran: a real trace
 * reported `stage 1/2 (echo) exited 141` for a pipeline whose stages were `kubectl` and `grep`.
 *
 * Alignment therefore has to answer "which pipeline do these statuses belong to", and it can only
 * ever be sure when one candidate fits:
 *
 *   1. Segments come from `extractPipeline`, which respects quotes, `$'…'`, backslash escapes and
 *      parentheses — so a `|` inside a grep alternation (`'a|b'`) no longer splits anything. That
 *      one splitter is shared with command validation rather than reimplemented here.
 *   2. Segments are grouped into pipelines: a segment that was not preceded by `|` starts a new one.
 *   3. Candidates for "the pipeline that ran last": the final group always is. If a group was
 *      entered through `&&` or `||`, it may have been short-circuited, so the group before it is a
 *      candidate too, transitively. `;`, `&` and the start of the command are unconditional, so the
 *      walk stops there.
 *   4. Exactly one candidate whose length matches the status count wins. Anything else — no match,
 *      or two equally plausible ones — is null.
 *
 * Returning null is not a failure mode to design around; it is the honest answer, and every caller
 * must degrade rather than guess. What must NOT be done is taking the last N segments: for
 * `echo a | grep -q zzz && echo yes` the statuses are `[0, 1]` and the trailing two segments are
 * `grep -q zzz` and `echo yes`, which has the right LENGTH and the wrong MEANING — the length check
 * would then certify a mapping that is entirely wrong.
 */
export function alignPipelineStages(command: string, statuses: number[]): AlignedStage[] | null {
  if (statuses.length === 0) return null;
  const segments = extractPipeline(command);
  if (segments.length === 0) return null;

  // (2) group by pipeline
  const groups: PipelineSegment[][] = [];
  for (const seg of segments) {
    if (!seg.piped || groups.length === 0) groups.push([seg]);
    else groups[groups.length - 1].push(seg);
  }

  // (3) which groups could be the last one executed
  const candidates: PipelineSegment[][] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    candidates.push(groups[g]);
    const enteredBy = groups[g][0]?.sep;
    if (enteredBy !== "&&" && enteredBy !== "||") break;
  }

  // (4) exactly one of them must fit the status count
  const fitting = candidates.filter((g) => g.length === statuses.length);
  if (fitting.length !== 1) return null;

  return fitting[0].map((seg, i) => ({
    status: statuses[i],
    command: seg.command,
    binary: getCommandBinary(seg.command).toLowerCase(),
  }));
}
