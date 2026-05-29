/**
 * Fold persisted task_event chat-messages into the current plan (design §12/§14,
 * Approach A). The agentbox persists each ledger mutation as a chat_message with
 * metadata.kind === "task_event"; the plan panel rebuilds current state by replaying
 * them in order, so the plan survives a browser refresh (it's just chat history).
 *
 * blockedBy is advisory: we derive ready/blocked here for display only.
 */

import type { PilotMessage } from "../chat/types"

export type PlanStatus = "pending" | "in_progress" | "completed"
export type PlanGroup = "in_progress" | "ready" | "blocked" | "completed"

export interface PlanTask {
  id: string
  subject: string
  description?: string
  status: PlanStatus
  owner?: string
  blockedBy: string[]
  activeForm?: string
}

export interface PlanTaskView extends PlanTask {
  /** blockedBy filtered to still-incomplete blockers. */
  blockedBy: string[]
  blocks: string[]
  ready: boolean
  group: PlanGroup
}

interface TaskEventMeta {
  kind: "task_event"
  action: "upsert" | "delete"
  taskId?: string
  task?: {
    id: string
    subject: string
    description?: string
    status: PlanStatus
    owner?: string
    blockedBy?: string[]
    activeForm?: string
  }
}

function asTaskEvent(metadata: unknown): TaskEventMeta | null {
  const m = metadata as Record<string, unknown> | undefined
  return m && m.kind === "task_event" ? (m as unknown as TaskEventMeta) : null
}

/** Replay task_event messages (in order) into the current set of tasks, then derive views. */
export function foldPlan(messages: PilotMessage[]): PlanTaskView[] {
  const map = new Map<string, PlanTask>()
  for (const msg of messages) {
    const ev = asTaskEvent(msg.metadata)
    if (!ev) continue
    if (ev.action === "delete") {
      if (ev.taskId) map.delete(String(ev.taskId))
      continue
    }
    if (ev.action === "upsert" && ev.task?.id != null) {
      const t = ev.task
      map.set(String(t.id), {
        id: String(t.id),
        subject: t.subject,
        description: t.description,
        status: t.status,
        owner: t.owner,
        blockedBy: (t.blockedBy ?? []).map(String),
        activeForm: t.activeForm,
      })
    }
  }

  const tasks = [...map.values()]
  const isComplete = (id: string): boolean => {
    const t = map.get(id)
    return !t || t.status === "completed"
  }

  return tasks.map((t): PlanTaskView => {
    const incomplete = t.blockedBy.filter((b) => !isComplete(b))
    const blocks = tasks.filter((o) => o.blockedBy.includes(t.id)).map((o) => o.id)
    const ready = t.status === "pending" && incomplete.length === 0
    const group: PlanGroup =
      t.status === "completed" ? "completed"
      : t.status === "in_progress" ? "in_progress"
      : ready ? "ready"
      : "blocked"
    return { ...t, blockedBy: incomplete, blocks, ready, group }
  })
}

/** True when there is any task to show (used to decide whether to surface the plan panel). */
export function hasPlan(messages: PilotMessage[]): boolean {
  return messages.some((m) => asTaskEvent(m.metadata) !== null)
}
