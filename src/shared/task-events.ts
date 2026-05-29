/**
 * Task ledger events — the bridge between the in-agent task tools (which emit
 * task_event snapshots via the session event emitter) and durable persistence.
 *
 * Approach A (see docs/design/2026-05-29-subagents-background-task-ledger.md §14):
 * each task mutation is persisted as a chat_message with metadata.kind === "task_event",
 * reusing the delegation append channel. The Web UI folds these events into the current
 * plan on load, so the plan survives refresh without a dedicated table or RPC.
 */

import type { DelegationAppendMessagePayload } from "./delegation-persistence.js";
import type { LedgerTask } from "../core/task-ledger.js";

export interface TaskEvent {
  kind: "task_event";
  taskListId: string;
  action: "upsert" | "delete";
  /** Full snapshot for upsert (the UI/agentbox replaces the task by id). */
  task?: LedgerTask;
  /** Target id for delete. */
  taskId?: string;
}

/** Type guard for events flowing through the generic session event emitter. */
export function isTaskEvent(event: Record<string, unknown>): event is TaskEvent & Record<string, unknown> {
  return event?.kind === "task_event";
}

/**
 * Build the chat_message payload that persists a task event. Stored with role "user"
 * and metadata.kind === "task_event" (same shape delegation events use), so the Web UI
 * can filter it out of the timeline and fold it into the plan panel.
 */
export function buildTaskEventChatMessage(
  sessionId: string,
  event: TaskEvent,
): DelegationAppendMessagePayload {
  const content =
    event.action === "delete"
      ? `task #${event.taskId} deleted`
      : `task #${event.task?.id} [${event.task?.status}] ${event.task?.subject}`;
  return {
    sessionId,
    role: "user",
    content,
    // event already carries kind: "task_event"
    metadata: { ...event },
  };
}
