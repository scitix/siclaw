/**
 * Shared result builders for the `run_in_background` path of the cmd-exec tools
 * (bash / node_exec / pod_exec). The not-line-safe rejection and the "launched" guidance
 * were copy-pasted across all three; centralizing them keeps the security-relevant wording
 * (the structural-redaction guard, and the "task_id/output_file are internal — do NOT show
 * the user" instruction) from drifting between tools.
 */

/** Shared model contract for command and script background execution. */
export const BACKGROUND_EXEC_DESCRIPTION =
  "Start background work and return task_id/output_file immediately. The current request remains active: " +
  "continue independent work now; results are delivered automatically for you to inspect and summarize. " +
  "Do NOT poll, sleep, or spawn a waiter. For a server/listener, immediately run the counterpart client " +
  "instead of waiting for server completion (which would deadlock). Use task_output(task_id) for output " +
  "or a necessary readiness check, and job_stop to stop helpers after dependent work finishes. " +
  "Use progress commentary while work remains; provide the final answer after processing its results. ";

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
 * `json_path` with `run_in_background` is refused rather than ignored.
 *
 * A background command's output is streamed to a file as it arrives; there is no complete document to
 * project, and `task_output` reads that file rather than passing back through this pipeline. Accepting
 * both would silently drop the projection — the agent would ask for one field, get the whole stream,
 * and have no way to tell that its parameter did nothing.
 */
export function backgroundJsonPathError(): BackgroundToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({
      error: true,
      message: "json_path cannot be combined with run_in_background: background output is streamed to a "
        + "file as it arrives, so there is no complete JSON document to project.",
      hint: "Either drop run_in_background and project the result, or keep the background run and read "
        + "the file with task_output(task_id) when it completes.",
    }) }],
    details: { blocked: true, reason: "background_json_path_unsupported" },
  };
}

/**
 * The "launched" success result. `runningWhere` is the short human lead-in (e.g.
 * "Running on the node in the background."); everything after it — the request-continuation
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
        `${runningWhere} ` + BACKGROUND_EXEC_DESCRIPTION +
        "NOTE: task_id and output_file are internal handles for YOUR use only — do NOT show them to the user; " +
        "describe progress and findings in plain language.",
    }, null, 2) }],
    // extraDetails (e.g. a resolved host_label) is persisted to the tool row metadata so the
    // card can render a friendly label even when the model passed an opaque id.
    details: { backgroundTaskId: jobId, outputFile, ...extraDetails },
  };
}
