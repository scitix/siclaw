/**
 * Shared result builders for the `run_in_background` path of the cmd-exec tools
 * (bash / node_exec / pod_exec). The not-line-safe rejection and the "launched" guidance
 * were copy-pasted across all three; centralizing them keeps the security-relevant wording
 * (the structural-redaction guard, and the "task_id/output_file are internal — do NOT show
 * the user" instruction) from drifting between tools.
 */

type BackgroundToolResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
};

/**
 * Rejection returned when a command's output needs structural (JSON) redaction, which the
 * per-line background sanitizer cannot stream. Callers reject BEFORE launching.
 */
export function backgroundNotLineSafeError(): BackgroundToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({
      error: true,
      message: "This command's output needs structural (JSON) redaction, which cannot be streamed in the background.",
      hint: "Run it in the foreground, or use -o wide / -o name / -o jsonpath to background it.",
    }) }],
    details: { blocked: true, reason: "background_not_line_safe" },
  };
}

/**
 * The "launched" success result. `runningWhere` is the short human lead-in (e.g.
 * "Running on the node in the background."); everything after it — the END-YOUR-TURN
 * guidance and the "these are internal handles, don't show the user" instruction — is
 * shared so the three exec tools stay in lockstep.
 */
export function backgroundLaunchedResult(
  jobId: string,
  outputFile: string,
  runningWhere: string,
  extraDetails?: Record<string, unknown>,
): BackgroundToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "launched",
      task_id: jobId,
      output_file: outputFile,
      message:
        `${runningWhere} It runs detached and you are notified automatically when it COMPLETES. ` +
        "Default: END YOUR TURN NOW — do NOT read this file, poll, sleep, or spawn a sub-agent to wait on it. " +
        "EXCEPTION — paired/orchestrated tests: if this is ONE SIDE of a protocol that only makes progress once " +
        "its counterpart runs (a server/listener blocking until its client connects; a packet capture needing " +
        "traffic generated), do NOT wait for completion — immediately run the counterpart (e.g. the client on the peer " +
        "node) and read this output_file once the test finishes. Waiting for such a server's completion FIRST " +
        "deadlocks: it blocks until a client connects, then times out. " +
        "Otherwise read the output_file ONLY after the completion notification. Stop it early with job_stop. " +
        "NOTE: task_id and output_file are internal handles for YOUR use only — do NOT show them to the user; just " +
        "tell the user in plain language what is running and that you'll report back when it finishes.",
    }, null, 2) }],
    // extraDetails (e.g. a resolved host_label) is persisted to the tool row metadata so the
    // card can render a friendly label even when the model passed an opaque id.
    details: { backgroundTaskId: jobId, outputFile, ...extraDetails },
  };
}
