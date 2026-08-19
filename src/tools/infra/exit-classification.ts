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
 * The judgment therefore has to reach the MODEL, not just the trace: `details` is stripped from a
 * tool result before the model sees it (compaction), while `details.error` is what drives the Trace
 * outcome (the SSE consumer). So the class goes in both — `annotation` for the text, `isError` and
 * `reason` for `details` — and neither is derivable from the other.
 */

import { getCommandBinary } from "./command-sets.js";

export type ExitClass =
  | "success"
  | "no_match"
  | "dependency_missing"
  | "not_executable"
  | "target_reported_failure"
  | "interrupted"
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
  /^Error from server/m,
  /^error: unable to use a TTY/m,
  /^error: Internal error occurred: error executing command in container/m,
  /^The connection to the server .* was refused/m,
  /^Unable to connect to the server/m,
  /^error: You must be logged in to the server/m,
  /^error: (pod|container) .*(does not exist|not found)/m,
  /net\/http: TLS handshake timeout/,
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

export interface ExitJudgment {
  /** What the exit code means. */
  exitClass: ExitClass;
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
  const segments = command.split(/\|\|?/).map((s) => s.trim()).filter(Boolean);
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
}): ExitJudgment {
  const { command, exitCode, stdout, stderr = "", signal, context } = opts;

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
        `[exit code: ${exitCode} — dependency_missing: the target reported that the command does not `
        + "exist there (see STDERR). The whitelist admits a command; it cannot make the target have it. "
        + "Do not retry the same command.]",
    };
  }

  // A channel that failed produced no command output, so stdout must be empty for this to be
  // considered at all — otherwise a command of the agent's own that prints "error:" would be
  // misreported as a dead channel.
  if (!stdout.trim() && CHANNEL_ERROR_MARKERS.some((re) => re.test(stderr))) {
    return {
      exitClass: "channel_error",
      isError: true,
      annotation:
        `[channel_error (reported as exit ${exitCode}): the exec channel itself failed — the target `
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
        ? "[exit code: 127 — dependency_missing: the command is whitelisted for this tool but absent "
          + "from the AgentBox image, which is a gap in the image rather than something to work around. "
          + "Report it; retrying will not help.]"
        : "[exit code: 127 — dependency_missing: the command is not on this target's PATH. "
          + "The command whitelist is an admission policy, not a promise that the target has the binary; "
          + "do not retry the same command, use one the target does have.]",
    };
  }

  if (exitCode === 126) {
    return {
      exitClass: "not_executable",
      isError: true,
      annotation:
        "[exit code: 126 — not_executable: the command was found but could not be run "
        + "(permission denied, or not an executable). Retrying will not change this.]",
    };
  }

  if (exitCode === 1 && EXIT_1_MEANS_NOTHING_FOUND.has(lastPipelineCommand(command))) {
    return {
      exitClass: "no_match",
      isError: false,
      annotation: "[exit code: 1 — no_match: the command ran and matched nothing. This is a result, not a failure.]",
    };
  }

  return {
    exitClass: "target_reported_failure",
    isError: true,
    annotation:
      `[exit code: ${exitCode} — target_reported_failure: the command ran on the target and reported `
      + "this status. That is the target's own answer, not a transport or setup problem.]",
  };
}

/**
 * Append the judgment to an already-sanitized, already-truncated tool output.
 *
 * Kept out of the body on purpose. The annotation is OUR statement about the result, not target
 * output, so it must not pass through an output sanitizer — a structural (JSON) sanitizer replaces
 * everything it cannot parse with a suppression notice, and a failed command's output is precisely
 * what it cannot parse. Appending afterwards also puts it past truncation, so the class survives an
 * output large enough to be cut.
 */
export function appendAnnotation(text: string, annotation: string): string {
  if (!annotation) return text;
  return text ? `${text}\n${annotation}` : annotation;
}
