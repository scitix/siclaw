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
  "This is an automatic background-job result, NOT a new user request. " +
  "Read the output_file only if you still need this result. " +
  "If it adds nothing the user doesn't already know — e.g. it matches a result or issue you already reported — " +
  "END YOUR TURN WITH NO MESSAGE AT ALL. Do NOT post 'no new info', 'same as above', or a restated summary; silence is the correct response and avoids a noise bubble. " +
  "Produce text ONLY when there is genuinely NEW, actionable information, and then keep it to a brief update — never a re-run of a full report. " +
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
