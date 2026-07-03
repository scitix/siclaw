/**
 * Builds the `<task_notification>` message that a completed background job injects
 * back into the parent model's conversation.
 *
 * The XML shape mirrors Claude Code's LocalShellTask notification (Task.ts /
 * LocalShellTask.tsx) so the model sees a familiar, structured signal:
 *
 *   <task_notification>
 *   <task_id>b1a2c3…</task_id>
 *   <output_file>/…/agent/tasks/b1a2c3.output</output_file>   (bash only)
 *   <status>completed</status>
 *   <summary>Background command "kubectl logs …" completed (exit 0)</summary>
 *   </task_notification>
 *
 * For sub-agents the `output_file` line is omitted (the result is a summary capsule;
 * drill-in is via the Portal transcript, not a flat file).
 */

import type { JobStatus } from "./job-registry.js";
import type { GroupItemStatus, SubagentGroupReport } from "./tool-registry.js";

export interface TaskNotification {
  taskId: string;
  /** Present for background bash; the model reads it with the built-in `read` tool. */
  outputFile?: string;
  status: JobStatus;
  /** One-line human/model-facing summary, e.g. 'Background command "…" completed (exit 0)'. */
  summary: string;
}

/** Minimal XML escaping for text placed inside notification tags. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Guidance appended to every notification. Without it the model treats each
 * completing background job as a fresh user request and re-emits a full report —
 * so N background jobs produce N redundant summaries. This tells it to react
 * minimally: incorporate only genuinely-new information, never repeat a report
 * it already gave, and stay terse (or silent) when the result is already covered.
 */
const NOTIFICATION_INSTRUCTIONS =
  "This is an automatic background-job result, NOT a new user request. The job has ALREADY FINISHED and its " +
  "result is FINAL — the <summary> below IS that result. Do NOT re-launch, " +
  "re-run, or re-dispatch this work, and do NOT spawn another sub-agent or call another tool to redo, verify, " +
  "wait for, or 'get' a result you have just been handed — simply relay it. " +
  "For a shell job, if you still need the full output, call task_output(task_id) (it returns the final output and exit code) — do not read the raw output_file. " +
  "If it adds nothing the user doesn't already know — e.g. it matches a result or issue you already reported — " +
  "END YOUR TURN WITH NO MESSAGE AT ALL. Do NOT post 'no new info', 'same as above', or a restated summary; silence is the correct response and avoids a noise bubble. " +
  "Produce text ONLY when there is genuinely NEW, actionable information (e.g. the answer the user was waiting for), and then keep it to a brief update — never a re-run of a full report. " +
  "If several jobs finish together, fold them into ONE concise update.";

/** One `<task_notification>` block (no instructions — those are appended once per message). */
function buildNotificationBlock(n: TaskNotification): string {
  const outputFileLine = n.outputFile
    ? `\n<output_file>${escapeXml(n.outputFile)}</output_file>`
    : "";
  return (
    `<task_notification>\n` +
    `<task_id>${escapeXml(n.taskId)}</task_id>${outputFileLine}\n` +
    `<status>${escapeXml(n.status)}</status>\n` +
    `<summary>${escapeXml(n.summary)}</summary>\n` +
    `</task_notification>`
  );
}

/** Single-job notification: one block + the shared response instructions. */
export function buildTaskNotificationText(n: TaskNotification): string {
  return `${buildNotificationBlock(n)}\n<instructions>${NOTIFICATION_INSTRUCTIONS}</instructions>`;
}

/**
 * Coalesced notification for several jobs that finished close together: ALL their blocks
 * followed by ONE shared instructions element — so the model addresses them in a single
 * reply instead of re-summarizing once per completion. Falls back to the single form for
 * one job.
 */
export function buildNotificationBatch(notifications: TaskNotification[]): string {
  if (notifications.length <= 1) return buildTaskNotificationText(notifications[0]);
  const blocks = notifications.map(buildNotificationBlock).join("\n");
  return (
    `${blocks}\n` +
    `<instructions>${notifications.length} background jobs finished — address them together in ONE reply. ${NOTIFICATION_INSTRUCTIONS}</instructions>`
  );
}

// ── spawn_subagent batch notification text (design §"Job model & notification") ────────────────

/** Compact per-status digest for a group, e.g. "5 item(s): 3 done, 1 failed, 1 skipped". */
export function summarizeItemStatuses(items: Array<{ status: GroupItemStatus }>): string {
  const counts = new Map<GroupItemStatus, number>();
  for (const it of items) counts.set(it.status, (counts.get(it.status) ?? 0) + 1);
  const order: GroupItemStatus[] = ["done", "partial", "failed", "timed_out", "skipped"];
  const parts = order.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`);
  return `${items.length} item(s): ${parts.join(", ")}`;
}

/**
 * Group completion notification summary: a one-line status/count digest with the reduce
 * summary (when present) inlined beneath it. Distinct from a single sub-agent's summary in
 * that it carries the map→reduce synthesis, so the model relays ONE combined result instead
 * of N per-item reports. Fed to {@link TaskNotification.summary} (no output_file — the result
 * is inline, same as a single sub-agent).
 */
export function buildGroupNotificationSummary(description: string, report: SubagentGroupReport): string {
  const head = `Sub-agent group "${description}" ${report.status} — ${summarizeItemStatuses(report.itemResults)}.`;
  return report.reduceSummary ? `${head}\n\n${report.reduceSummary}` : head;
}
