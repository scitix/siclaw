/**
 * What a non-zero exit code MEANS, as opposed to the fact that there was one.
 *
 * Every exec tool used to reduce "the command did not exit 0" to one bit — `details.error: true`
 * plus a bare `[exit code: N]` — which merges three situations that call for opposite next steps:
 *
 *   - the binary is not on the target (127): retrying is pointless, and the whitelist that permitted
 *     the command is an admission policy, not a promise that the node has it;
 *   - the command ran and matched nothing (`grep` exiting 1): nothing failed at all, yet the tool
 *     reported an error and the Trace outcome went red;
 *   - the command ran and reported failure: the target's own answer, which is usually the finding
 *     the caller was after.
 *
 * The exit CODE itself is rendered by postExecSecurity (`exitCode`); these annotations carry only the
 * class, so the code is not printed twice.
 *
 * The judgment therefore has to reach the MODEL, not just the trace: `details` is stripped from a
 * tool result before the model sees it (compaction), while `details.error` is what drives the Trace
 * outcome (the SSE consumer). So the class goes in both — `annotation` for the text, `isError` and
 * `reason` for `details` — and neither is derivable from the other.
 */

import { getCommandBinary } from "./command-sets.js";
import { isExpectedSigpipe, pipelineStages } from "./pipeline-status.js";

export type ExitClass =
  | "success"
  | "no_match"
  | "dependency_missing"
  | "not_executable"
  | "target_reported_failure"
  | "interrupted"
  | "output_truncated"
  | "pipeline_upstream_failed"
  | "channel_error";

/**
 * Transport failures that arrive looking like an ordinary non-zero exit.
 *
 * `kubectl exec` reports its OWN failures — the pod is gone, the connection could not be upgraded,
 * the API server refused us — through the same exit status it uses to relay the remote command's, so
 * without reading stderr a dead channel is indistinguishable from a command that ran and failed.
 * `host_exec` has never had this problem: an SSH-level failure throws and is reported separately.
 *
 * Anchored at line start and only consulted when there is NO stdout, because a channel that failed
 * produced no command output. A command of the agent's own that happens to print "error:" therefore
 * cannot be mistaken for one of these.
 *
 * NOT in this list, deliberately: `command terminated with exit code N`. That is kubectl relaying a
 * remote exit — it means the command DID run, i.e. the opposite of a channel failure.
 */
const CHANNEL_ERROR_MARKERS: readonly RegExp[] = [
  /^error: unable to upgrade connection/m,
  /^error dialing backend/m,
  // NOT a bare `/^Error from server/`. That matched every API answer, so `kubectl get pvc missing`
  // returning NotFound was classified `channel_error` — whose annotation says "the target never ran the
  // command". The API server answered; that is the most informative reply a kubectl call can get, and
  // calling it a transport failure is a worse misdiagnosis than the generic error it replaced.
  //
  // Only the reasons that really mean "the request did not reach a decision" stay here. NotFound,
  // Forbidden, AlreadyExists, Conflict, Invalid and BadRequest are the server's ANSWER and fall through
  // to target_reported_failure.
  /^Error from server \((?:Timeout|InternalError|ServiceUnavailable|ServerTimeout|GatewayTimeout)\)/m,
  /^Error from server: etcdserver: request timed out/m,
  /^Error from server: dial tcp/m,
  /^error: unable to use a TTY/m,
  /^error: Internal error occurred: error executing command in container/m,
  /^The connection to the server .* was refused/m,
  /^Unable to connect to the server/m,
  /^error: You must be logged in to the server/m,
  /^error: (pod|container) .*(does not exist|not found)/m,
  /net\/http: TLS handshake timeout/,
];

/**
 * The namespace-entry leg failing, as opposed to the transport.
 *
 * Both are unambiguous: `nsenter` is in NO context's whitelist and `ip netns exec` is refused by the
 * validator, so neither string can come from a command the agent asked for — only from the wrapper
 * node_exec and host_exec put around it. Captured from a real privileged pod rather than written from
 * memory:
 *
 *   nsenter: cannot open /proc/999999/ns/ipc: No such file or directory
 *   nsenter: cannot open /proc/1/ns/mnt: Permission denied
 *   Cannot open network namespace "no-such-netns": No such file or directory
 *
 * Before this, all three were classified `target_reported_failure` — "the target's own answer" — for a
 * command the target never saw. A vanished `pod=` netns is the common case and read as the pod
 * answering.
 */
const NAMESPACE_ENTRY_MARKERS: readonly RegExp[] = [
  /^nsenter: /m,
  /^Cannot open network namespace /m,
];

/**
 * A missing binary, as reported by the CONTAINER RUNTIME rather than by a shell.
 *
 * `sh -c` gives 127, but `kubectl exec` without a shell surfaces it as
 * "error: Internal error occurred: error executing command in container: failed to exec: …
 * executable file not found in $PATH" — which also matches a channel marker above. This is checked
 * FIRST so the more specific reading wins: the channel was fine, the binary is not there.
 */
const MISSING_BINARY_MARKER = /executable file not found|: not found$|: command not found/im;

/**
 * WHICH leg of the path to the target broke. Separate from `exitClass` on purpose: "was this the
 * target's own answer" and "where did it break" are independent questions, and folding the second into
 * the first would need a class per combination.
 *
 *   transport        — the exec channel: kubectl exec / the SSH connection. Named by kubectl's own
 *                      diagnostics, which is why classification needs UNFILTERED stderr.
 *   namespace_entry  — the channel opened, then `nsenter` / `ip netns exec` failed. The target never
 *                      ran the command either, but the cause is on our side (debug-pod privileges, or
 *                      a netns that disappeared between resolution and exec — the ordinary outcome of
 *                      a `pod=` target dying mid-call), not the transport's.
 */
export type ChannelLeg = "transport" | "namespace_entry";

export interface ExitJudgment {
  /** What the exit code means. */
  exitClass: ExitClass;
  /** For `channel_error` only: which leg broke. Absent for every other class. */
  channelLeg?: ChannelLeg;
  /** Whether this should count as a failed tool call (drives `details.error` → Trace outcome). */
  isError: boolean;
  /** Text appended to the tool output, since `details` never reaches the model. Empty for success. */
  annotation: string;
}

/**
 * Commands whose exit 1 means "found nothing" or "false" rather than "failed".
 *
 * `diff` and `cmp` are deliberately NOT here: their exit 1 means "differences were found", which is
 * a finding the caller reads out of the body, and labelling that "no match" would be more wrong than
 * leaving it generic.
 */
const EXIT_1_MEANS_NOTHING_FOUND = new Set([
  "grep", "egrep", "fgrep", "zgrep", "bzgrep", "xzgrep",
  "pgrep", "pidof",
  "test", "[",
  // `ps -p <pid>` exits 1 when no such process, `findmnt <path>` when nothing is mounted there. Both are
  // the negative half of an existence check, which is what the caller asked.
  //
  // Deliberately NOT extended to `nvidia-smi` or `curl`, which two reviews also asked for: those exit
  // non-zero because the TARGET reported a problem — an ECC error, a failed TLS verification — and that
  // is a finding, not an empty result. `target_reported_failure` already tells the agent it is the
  // target's own answer rather than a transport fault, which is the distinction those reviews wanted;
  // calling a GPU fault "no match" would be the new untruth.
  "ps", "findmnt",
]);

/**
 * The base command whose exit code we actually observe.
 *
 * In a pipeline the exit status is the LAST segment's, so that is the segment to name. Splitting on
 * `|` is deliberately crude — a `|` inside a quoted argument would mis-split — so the result is only
 * ever used to RELAX a judgment (recognising a no-match exit), never to tighten one: a wrong guess
 * falls through to the generic class, which is the behaviour this replaces.
 */
function lastPipelineCommand(command: string): string {
  // A single `|` only. `/\|\|?/` also split on `||`, so `grep foo || false` became two segments and the
  // grep — which is what the exit code came from — stopped being the last one. Harmless in the common
  // case (when the right-hand side succeeds the exit is 0 and classification never runs) but it turned a
  // no_match into a generic failure whenever both sides exited 1. The lookarounds keep `||` intact.
  const segments = command.split(/(?<!\|)\|(?!\|)/).map((s) => s.trim()).filter(Boolean);
  const last = segments[segments.length - 1] ?? command;
  return getCommandBinary(last).toLowerCase();
}

export function classifyExit(opts: {
  command: string;
  /**
   * The observed status. A NUMBER is the process's exit code. `null`/`undefined` means it was
   * signalled. A STRING is a spawn-level failure code (`ENOENT`, `ABORT_ERR`) — the process never
   * ran, which is our problem and not the target's answer, so it must not be reported as one.
   */
  exitCode: number | string | null | undefined;
  stdout: string;
  /**
   * The target's stderr. Required to tell a dead channel from a command that ran and failed, since
   * `kubectl exec` reports both through the exit status.
   */
  stderr?: string;
  signal?: string | null;
  /**
   * Where the command ran. Only 127 depends on it: in the AgentBox the whitelist IS an availability
   * promise (agentboxRequiredCommands, enforced at build time), so a missing binary there is a bug in
   * our image — advice to "use a different command" would send the agent chasing its own tail.
   */
  context?: string;
  /**
   * Per-stage statuses from PIPESTATUS, in pipeline order, when the caller could obtain them
   * (restricted_bash only — see pipeline-status.ts for why nowhere else). Absent means "not known",
   * never "all fine": the judgment below must degrade to the exit-code-only reading, not assume success.
   */
  pipeStatuses?: number[];
}): ExitJudgment {
  const { command, exitCode, stdout, stderr = "", signal, context, pipeStatuses } = opts;

  // ── Per-stage reading, when we have it ───────────────────────────────────
  // Placed FIRST because it can overturn the exit code in both directions, which is the whole point:
  // the exit code is the last stage's, and the last stage is often not the one that matters.
  if (pipeStatuses && pipeStatuses.length > 1) {
    const stages = pipelineStages(command);
    const last = pipeStatuses[pipeStatuses.length - 1];
    const label = (i: number) => `stage ${i + 1}/${pipeStatuses.length}`
      + (stages[i] ? ` (${stages[i].split(/\s+/)[0]})` : "");

    // (1) An upstream stage failed while the pipeline as a whole reported success. Seven high-severity
    //     findings are this: `kubectl get x | jq .` where kubectl exits 1 and jq exits 0, reported
    //     success on an empty result — so the agent reads "nothing found" rather than "the query failed".
    const upstreamFailures = pipeStatuses
      .map((code, i) => ({ code, i }))
      .filter(({ code, i }) => i < pipeStatuses.length - 1 && code !== 0
        && !isExpectedSigpipe(pipeStatuses, i, stages));
    if (last === 0 && upstreamFailures.length > 0) {
      const who = upstreamFailures.map(({ code, i }) => `${label(i)} exited ${code}`).join(", ");
      return {
        exitClass: "pipeline_upstream_failed",
        isError: true,
        annotation:
          `[pipeline_upstream_failed: ${who}, while the last stage exited 0 — so the pipeline's exit code `
          + "says success and the output above is NOT a complete answer. An empty result here means the "
          + "EARLIER stage failed, not that nothing matched. Fix the failing stage; see STDERR for its "
          + "error.]",
      };
    }

    // (2) SIGPIPE is benign ONLY when it happened UPSTREAM of a stage that stopped reading on purpose.
    //     `seq … | head -3` is that case: stage 1 gets 141, `head` exits 0, and under `pipefail` the
    //     shell reports 141 for a command that did exactly what was asked.
    //
    //     A 141 on the LAST stage is the opposite and must never be called benign: nothing is downstream
    //     of it, so no consumer could have closed the pipe — it was killed. Read from a real trace
    //     (ce1bd949): `kubectl logs --tail=-1 | grep -c '…'` returned exit 141 with `(no output)` after
    //     83 seconds, while the same shape that completed took 11 seconds and printed `0`. A `grep -c`
    //     that ran to the end always prints a number, so no output means it never got there. Classifying
    //     that as success would have told the agent an empty result was the answer — the exact false
    //     success this whole change set exists to remove. My first version of this rule did that.
    const expectedSigpipes = pipeStatuses
      .map((code, i) => ({ code, i }))
      .filter(({ i }) => i < pipeStatuses.length - 1 && isExpectedSigpipe(pipeStatuses, i, stages));
    if (last === 0 && expectedSigpipes.length > 0) {
      const at = label(expectedSigpipes[0].i);
      return {
        exitClass: "success",
        isError: false,
        annotation:
          `[pipeline_sigpipe: ${at} was ended by SIGPIPE because a later stage stopped reading — which is `
          + "how `head` and `grep -q` finish a pipeline normally, not a failure. The output above is what "
          + "was asked for. (The command's own exit code is 141 only when `pipefail` is set.)]",
      };
    }

    // (3) The final stage died on SIGPIPE, or was killed. Nothing downstream of it could have closed the
    //     pipe, so the read is INCOMPLETE and an empty result proves nothing.
    if (last === 141) {
      return {
        exitClass: "output_truncated",
        isError: true,
        annotation:
          `[output_truncated: ${label(pipeStatuses.length - 1)} was killed by SIGPIPE, and nothing `
          + "downstream of it could have closed the pipe — so the pipeline was cut short (a timeout, or "
          + "the writer going away), NOT finished. Output above is incomplete: a count of zero or an empty "
          + "result here is not evidence of absence. Narrow the read (a shorter --since, one pod instead "
          + "of a label, a tighter filter) rather than retrying it unchanged.]",
      };
    }
  }

  if (exitCode === 0) return { exitClass: "success", isError: false, annotation: "" };

  // No exit code means the process was signalled — a timeout kill, or the abort reap. Partial output
  // is still the answer to the question that was asked, so it is not reported as a failure; that
  // matches the pre-existing judgment and is why the signal is named instead.
  if (exitCode === null || exitCode === undefined) {
    const detail = signal ? ` (signal: ${signal})` : "";
    return stdout.trim()
      ? { exitClass: "interrupted", isError: false, annotation: `[interrupted${detail}; output above is partial]` }
      : { exitClass: "interrupted", isError: true, annotation: `[interrupted before producing output${detail}]` };
  }

  // maxBuffer is NOT a channel failure, though a string `code` made it look like one: the command RAN,
  // produced more than the capture limit, and was killed — and `err.stdout` holds the prefix that was
  // captured. Classifying it `channel_error` told the agent "the command could not be started, so the
  // target never ran it", which is the opposite of what happened, and left a truncated prefix looking
  // like a complete result: a review reported exactly that false negative ("No matches found" over
  // output that had been cut at the limit).
  if (exitCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer length exceeded/i.test(stderr)) {
    return {
      exitClass: "output_truncated",
      isError: true,
      annotation:
        "[output_truncated: the command RAN and produced more output than the capture limit, so it was "
        + "stopped and the text above is only the beginning. It is NOT a complete result — a search over "
        + "it that finds nothing proves nothing. Narrow the command (a tighter filter, fewer objects, a "
        + "smaller window) rather than retrying it unchanged.]",
    };
  }

  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    return {
      exitClass: "channel_error",
      isError: true,
      annotation:
        `[channel_error (${String(exitCode)}): the command could not be started, so the target never `
        + "ran it. This is a failure of the exec path itself — not of the command, and not the target's answer.]",
    };
  }

  // Checked before the channel markers: the runtime's "executable file not found" also matches one of
  // them, and the specific reading is the useful one — the channel worked, the binary is absent.
  if (MISSING_BINARY_MARKER.test(stderr)) {
    return {
      exitClass: "dependency_missing",
      isError: true,
      annotation:
        `[dependency_missing: the target reported that the command does not `
        + "exist there (see STDERR). The whitelist admits a command; it cannot make the target have it. "
        + "Do not retry the same command.]",
    };
  }

  // A channel that failed produced no command output, so stdout must be empty for this to be
  // considered at all — otherwise a command of the agent's own that prints "error:" would be
  // misreported as a dead channel.
  // Context matters for an API NotFound. Running kubectl AS the command (`local`), a NotFound is the
  // server's answer about a resource. Running kubectl as the TRANSPORT (pod/node/host exec), the same
  // string means the pod we tried to enter is gone — the command never ran, which is a channel failure.
  // One string, two meanings, and only the context separates them.
  if (context !== "local" && !stdout.trim()
      && /^Error from server \((?:NotFound|Forbidden)\)/m.test(stderr)) {
    return {
      exitClass: "channel_error",
      channelLeg: "transport",
      isError: true,
      annotation:
        "[channel_error: the exec target could not be reached — the API refused or could not find it, so "
        + "the command never ran and this status is NOT its answer. Re-resolve the target rather than "
        + "retrying the same command.]",
    };
  }

  if (!stdout.trim() && NAMESPACE_ENTRY_MARKERS.some((re) => re.test(stderr))) {
    return {
      exitClass: "channel_error",
      channelLeg: "namespace_entry",
      isError: true,
      annotation:
        "[channel_error: the exec channel opened, then entering the target namespace failed — so the "
        + "target never ran the command and this status is NOT its answer. See STDERR. A namespace that "
        + "no longer exists usually means the pod behind a `pod=` target has gone: re-resolve it rather "
        + "than retrying this command. A permission failure is a setup problem on the debug-pod side and "
        + "will not fix itself.]",
    };
  }

  if (!stdout.trim() && CHANNEL_ERROR_MARKERS.some((re) => re.test(stderr))) {
    return {
      exitClass: "channel_error",
      channelLeg: "transport",
      isError: true,
      annotation:
        "[channel_error: the exec channel itself failed — the target "
        + "never ran the command, so this status is NOT its answer. See STDERR for the transport error. "
        + "Retrying the same command may work if the cause was transient; a missing pod or container "
        + "will not fix itself.]",
    };
  }

  if (exitCode === 127) {
    return {
      exitClass: "dependency_missing",
      isError: true,
      annotation: context === "local"
        ? "[dependency_missing: the command is whitelisted for this tool but absent "
          + "from the AgentBox image, which is a gap in the image rather than something to work around. "
          + "Report it; retrying will not help.]"
        : "[dependency_missing: the command is not on this target's PATH. "
          + "The command whitelist is an admission policy, not a promise that the target has the binary; "
          + "do not retry the same command, use one the target does have.]",
    };
  }

  if (exitCode === 126) {
    return {
      exitClass: "not_executable",
      isError: true,
      annotation:
        "[not_executable: the command was found but could not be run "
        + "(permission denied, or not an executable). Retrying will not change this.]",
    };
  }

  if (exitCode === 1 && EXIT_1_MEANS_NOTHING_FOUND.has(lastPipelineCommand(command))) {
    return {
      exitClass: "no_match",
      isError: false,
      annotation: "[no_match: the command ran and matched nothing. This is a result, not a failure.]",
    };
  }

  return {
    exitClass: "target_reported_failure",
    isError: true,
    annotation:
      "[target_reported_failure: the command ran on the target and reported this status. That is the "
      + "target's own answer, not a transport or setup problem.]",
  };
}
