import { getOrCreateLedger, type LedgerTask } from "../core/task-ledger.js";

/** Replay the control-plane event stream, including resets, into this session only. */
export function restoreTaskLedgerFromHistory(sessionId: string, messages: Array<{ metadata?: unknown }>): boolean {
  const tasks = new Map<string, LedgerTask>();
  let found = false;
  let highWater = 0;
  for (const message of messages) {
    let event = message.metadata;
    if (typeof event === "string") { try { event = JSON.parse(event); } catch { continue; } }
    if (!event || typeof event !== "object") continue;
    const e = event as Record<string, any>;
    if (e.kind !== "task_event" || e.taskListId !== sessionId) continue;
    if (e.action === "reset") { tasks.clear(); found = true; }
    else if (e.action === "delete" && typeof e.taskId === "string") { tasks.delete(e.taskId); found = true; }
    else if (e.action === "upsert" && e.task && typeof e.task.id === "string" &&
      typeof e.task.subject === "string" && typeof e.task.description === "string" &&
      ["pending", "in_progress", "completed"].includes(e.task.status) && Array.isArray(e.task.blockedBy)) {
      tasks.set(e.task.id, e.task);
      highWater = Math.max(highWater, Number(e.task.id) || 0);
      found = true;
    }
  }
  if (found) getOrCreateLedger(sessionId).hydrate([...tasks.values()], highWater);
  return found;
}
