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
import { alignPipelineStages, isBenignSigpipe, hasConditionalChain } from "./pipeline-status.js";

export type ExitClass =
  | "success"
  | "no_match"
  | "dependency_missing"
  | "not_executable"
  | "target_reported_failure"
  | "interrupted"
  | "output_truncated"
  | "pipeline_upstream_failed"
  | "invalid_arguments"
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
    // Statuses paired with their commands, or null when the pairing cannot be made honestly (a
    // `&&`/`||` chain where two pipelines fit the status count equally well). Null is not an error
    // path: everything below still works, it just stops NAMING stages and stops applying the
    // relaxation that depends on knowing which command a status came from.
    const aligned = alignPipelineStages(command, pipeStatuses);
    const last = pipeStatuses[pipeStatuses.length - 1];
    const label = (i: number) => `stage ${i + 1}/${pipeStatuses.length}`
      + (aligned?.[i] ? ` (${aligned[i].binary})` : "");
    const upstream = pipeStatuses
      .map((code, i) => ({ code, i }))
      .filter(({ i }) => i < pipeStatuses.length - 1);

    // A filter that matched nothing is not an upstream failure. `kubectl logs | grep X | tail -20`
    // gives PIPESTATUS [0, 1, 0], and reading the middle 1 as a failure produced the single most
    // reported defect in the review backlog — its annotation told the agent "an empty result means
    // the EARLIER stage failed, not that nothing matched", which is precisely backwards.
    //
    // This is the one judgment that REQUIRES alignment, and requiring it is a safety property, not a
    // nicety: with the old text split, `echo "a | grep -v x" | kubectl get pods | jq .items` put
    // `grep` at subscript 1, so relaxing without alignment would silently downgrade kubectl's real
    // failure to `no_match` — the false success this whole mechanism exists to remove. The binary
    // comes from `getCommandBinary`, so `LC_ALL=C grep` and `/bin/grep` are recognised too.
    const noMatchAt = new Set(
      aligned
        ? upstream.filter(({ code, i }) => code === 1
            && EXIT_1_MEANS_NOTHING_FOUND.has(aligned[i].binary)).map(({ i }) => i)
        : [],
    );

    // (1) An upstream stage really failed while the pipeline as a whole reported success. Seven
    //     high-severity findings are this: `kubectl get x | jq .` where kubectl exits 1 and jq
    //     exits 0, reported success on an empty result.
    const realFailures = upstream.filter(({ code, i }) => code !== 0
      && !isBenignSigpipe(pipeStatuses, i) && !noMatchAt.has(i));
    if (last === 0 && realFailures.length > 0) {
      const who = realFailures.map(({ code, i }) => `${label(i)} exited ${code}`).join(", ");
      return {
        exitClass: "pipeline_upstream_failed",
        isError: true,
        annotation:
          `[pipeline_upstream_failed: ${who}, while the last stage exited 0 — so the pipeline's exit code `
          + "says success and the output above is NOT a complete answer. An empty result here means the "
          + "EARLIER stage failed, not that nothing matched. Fix the failing stage; see STDERR for its "
          + "error."
          + (aligned ? ""
            : hasConditionalChain(command)
              ? " (This command chains pipelines with `&&`/`||`, so which of them these statuses came "
                + "from could not be determined — run the failing pipeline on its own to see it.)"
              : " (Which command this status belongs to could not be determined — run the pipeline on "
                + "its own to see it.)")
          + "]",
      };
    }

    // (2) Nothing failed; a filter simply matched nothing. Reported as the RESULT it is, so the
    //     agent stops re-running a query whose answer it already has.
    if (last === 0 && noMatchAt.size > 0) {
      const who = [...noMatchAt].map((i) => label(i)).join(", ");
      // "every other stage exited 0" is not true when a downstream consumer closed the pipe and
      // SIGPIPE'd the stages above it — `… | cat | head -3 | grep zzz | wc -l` gives [141,141,0,1,0]
      // and lands here. The VERDICT is still right (the closure was deliberate), so only the
      // supporting clause has to change: say no stage FAILED, and name the closure when there was one.
      const closed = upstream.some(({ i }) => isBenignSigpipe(pipeStatuses, i));
      return {
        exitClass: "no_match",
        isError: false,
        annotation:
          `[no_match: ${who} ran and matched nothing, and no other stage failed`
          + (closed ? " (an earlier stage was ended by SIGPIPE because a later one stopped reading on "
            + "purpose, which is how `head` finishes a pipeline)" : "")
          + " — so the empty or zero result above IS the answer, not a failure. Re-running this will "
          + "return the same thing. If you expected matches, widen the pattern or the time window "
          + "rather than repeating the call.]",
      };
    }

    // (3) SIGPIPE that the pipeline's own shape explains: a stage was ended because the NEXT stage
    //     stopped reading and then exited 0, which is how `head` and `grep -m N` finish normally.
    //     Judged from the statuses alone — see `isBenignSigpipe` for why that matters here.
    const benign = upstream.filter(({ i }) => isBenignSigpipe(pipeStatuses, i));
    if (last === 0 && benign.length > 0) {
      const at = label(benign[0].i);
      return {
        exitClass: "success",
        isError: false,
        annotation:
          `[pipeline_sigpipe: ${at} was ended by SIGPIPE because the next stage stopped reading and then `
          + "finished normally — which is how `head` and `grep -m N` end a pipeline, not a failure. The "
          + "output above is what was asked for. (The command's own exit code is 141 only when "
          + "`pipefail` is set.)]",
      };
    }

    // (4) The final stage died on SIGPIPE, or was killed. Nothing downstream of it could have closed
    //     the pipe, so the read is INCOMPLETE and an empty result proves nothing.
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
    // SIGKILL with no exit code is what our own timeout looks like — we set it, so we can say so
    // instead of reporting "exit code: unknown". What we still cannot tell apart is WHERE the time
    // went (the API proxy, an unresponsive kubelet, a stalled log stream), so the annotation names
    // those as the things to check rather than pretending to know.
    if (signal === "SIGKILL") {
      return {
        exitClass: "interrupted",
        isError: true,
        annotation:
          "[interrupted: the command was killed at the tool's timeout, so it produced "
          + (stdout.trim() ? "only the partial output above" : "nothing")
          + ". The tool cannot tell WHERE the time went — the apiserver proxy, an unresponsive kubelet, or "
          + "a log stream that never closed all look the same from here. Narrow the request (a shorter "
          + "--since, one pod instead of a label, a smaller --tail) or raise timeout_seconds; a node that "
          + "is genuinely unreachable will keep timing out at every layer.]",
      };
    }
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

  // The metrics API answering is neither a transport failure nor a missing object, and it was being
  // reported as both. Checked BEFORE every `Error from server` branch below, which is the whole
  // point: `ServiceUnavailable` is in CHANNEL_ERROR_MARKERS with no context guard, so
  // `kubectl top nodes` against a cluster whose metrics-server is down was classified
  // `channel_error` — "the target never ran the command" — while a NotFound from the same API fell
  // through to `no_match`, "this object does not exist". Placing this after either of them makes it
  // dead code.
  //
  // Matched by the `metrics.k8s.io` group rather than by enumerating resource kinds, for the same
  // reason `invalid_arguments` reads the client's own answer instead of a curated flag list: the
  // string appears as `nodemetrics.metrics.k8s.io`, `podmetrics.metrics.k8s.io` AND
  // `nodes.metrics.k8s.io` depending on whether the aggregation layer is registered at all, and
  // enumerating the singular forms missed the plural one — which is the commonest case.
  // Scoped to `kubectl top`, which is the only caller for which the metrics API's answer is the
  // WHOLE answer. `kubectl get apiservice v1beta1.metrics.k8s.io` is how an operator checks whether
  // metrics-server is registered at all, and its NotFound is an ordinary existence answer — reading
  // it here flipped it from `no_match` to a failure and then advised checking a node name that was
  // never in question. Forbidden is excluded for the same reason in the other direction: RBAC is a
  // definite cause, so replacing it with "the object may not exist, or may not be scraped yet" would
  // be a fresh invention in place of the one being removed.
  const metricsAnswer = /\bkubectl\s+top\b/.test(command)
    && !/^Error from server \(Forbidden\)/m.test(stderr)
    && (/metrics\.k8s\.io/i.test(stderr) || /metrics (?:are |API )?not available/i.test(stderr));
  if (metricsAnswer) {
    const apiDown = /Error from server \((?:ServiceUnavailable|Timeout|InternalError|ServerTimeout|GatewayTimeout)\)/m.test(stderr)
      || /metrics (?:are |API )?not available/i.test(stderr);
    return {
      exitClass: "target_reported_failure",
      isError: true,
      annotation: apiDown
        ? "[target_reported_failure: the METRICS API could not answer (see STDERR) — metrics-server is "
          + "not running, or its APIService is not ready. The cluster itself is reachable: ordinary "
          + "`kubectl get` calls will still work, so do not re-resolve the target or retry `top`. Read "
          + "utilisation from another source (node/pod status, cAdvisor, your monitoring stack) or check "
          + "metrics-server in kube-system.]"
        : "[target_reported_failure: the metrics API has NO SAMPLE under this name. Two different things "
          + "produce this one message and it cannot tell them apart: the object may not exist, or it may "
          + "exist and not have been scraped yet (a new node, or metrics-server behind). Run "
          + "`kubectl get node <name>` / `kubectl get pod <name> -n <ns>` to settle which — do NOT repeat "
          + "the same `top` call, it will answer identically.]",
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

  // The client rejected the command before it reached the server. Not the target's answer, and — the
  // part that costs real time — not worth retrying unchanged: a review shows `--until-time` failing
  // twice in a row because the outcome looked like an ordinary error.
  //
  // Deliberately NOT a pre-exec blocklist of flags: kubectl versions differ per image and per cluster,
  // so a curated "these do not exist" list would start refusing commands that work the moment the client
  // is upgraded. Reading the client's own answer is version-proof.
  // `unable to match a printer` belongs here for the same reason: the client refused the OUTPUT FORMAT
  // before contacting the server. Four findings are `kubectl events -o wide` / `-o custom-columns`,
  // where `events` supports neither — and `kubectl get events` supports both, which is what the
  // annotation needs to say. Reported as the target's failure until now.
  const printerRejected = /^error: unable to match a printer/m.test(stderr);
  if (printerRejected) {
    return {
      exitClass: "invalid_arguments",
      isError: true,
      annotation:
        "[invalid_arguments: the CLIENT refused this output format for this subcommand — the request never "
        + "reached the cluster, so this is not the target's answer and retrying it unchanged will fail "
        + "identically. `kubectl events` supports neither `-o wide` nor `-o custom-columns`; "
        + "`kubectl get events` supports both, and `-o json` works for either.]",
    };
  }

  if (/^error: unknown (flag|shorthand flag)/m.test(stderr) || /^Error: unknown flag/m.test(stderr)) {
    return {
      exitClass: "invalid_arguments",
      isError: true,
      annotation:
        "[invalid_arguments: the CLIENT rejected this command — the flag does not exist in the kubectl "
        + "build available here, so the request never reached the cluster. This is not the target's "
        + "answer, and retrying it unchanged will fail identically. Check `--help` for the subcommand, or "
        + "use an equivalent that does exist (e.g. `kubectl get events --sort-by` instead of "
        + "`kubectl events --sort-by`, `--since-time` instead of `--until-time`).]",
    };
  }

  // An API NotFound on a named object is an ANSWER: the query succeeded and the object is not there.
  // Same semantics as grep finding nothing. A review captured the cost of calling it a failure — the
  // identical existence check ran three times, at 18:00, 18:02 and 18:04.
  if (context === "local" && !stdout.trim()
      && /^Error from server \(NotFound\)/m.test(stderr)) {
    return {
      exitClass: "no_match",
      isError: false,
      annotation:
        "[no_match: the API answered that this object does not exist. The query SUCCEEDED — this is the "
        + "result, not a failure, and re-running it will return the same answer. If you expected the "
        + "object, check the namespace and the name rather than repeating the call.]",
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
