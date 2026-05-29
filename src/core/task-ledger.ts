/**
 * Tasks-v2 ledger — the agent's plan. Pure in-memory store; persistence is layered
 * on in a later phase. One ledger per taskListId (a session and its sub-agents share one).
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface LedgerTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  /** ids this task waits on (authoritative) */
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

/** Read view: blockedBy filtered to still-incomplete blockers; blocks + ready derived. */
export interface TaskView extends LedgerTask {
  blocks: string[];
  ready: boolean;
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskPatch {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  owner?: string;
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export class TaskLedger {
  private tasks = new Map<string, LedgerTask>();
  private seq = 0;

  create(input: CreateTaskInput): LedgerTask {
    const id = String(++this.seq);
    const task: LedgerTask = {
      id,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: "pending",
      owner: input.owner,
      blockedBy: [...(input.blockedBy ?? [])],
      metadata: input.metadata,
    };
    this.tasks.set(id, task);
    return task;
  }

  update(id: string, patch: UpdateTaskPatch): LedgerTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (patch.subject !== undefined) task.subject = patch.subject;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.owner !== undefined) task.owner = patch.owner;
    if (patch.addBlockedBy?.length) {
      for (const b of patch.addBlockedBy) {
        if (b !== id && !task.blockedBy.includes(b)) task.blockedBy.push(b);
      }
    }
    if (patch.metadata) task.metadata = { ...(task.metadata ?? {}), ...patch.metadata };
    return task;
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  get(id: string): LedgerTask | undefined {
    return this.tasks.get(id);
  }

  private isComplete(id: string): boolean {
    const t = this.tasks.get(id);
    // A missing blocker (deleted) no longer blocks.
    return !t || t.status === "completed";
  }

  list(): TaskView[] {
    const out: TaskView[] = [];
    for (const task of this.tasks.values()) {
      const incompleteBlockers = task.blockedBy.filter((b) => !this.isComplete(b));
      const blocks: string[] = [];
      for (const other of this.tasks.values()) {
        if (other.blockedBy.includes(task.id)) blocks.push(other.id);
      }
      out.push({
        ...task,
        blockedBy: incompleteBlockers,
        blocks,
        ready: task.status === "pending" && incompleteBlockers.length === 0,
      });
    }
    return out;
  }
}

const ledgers = new Map<string, TaskLedger>();

/** One ledger per taskListId; a session and its sub-agents share the same id. */
export function getOrCreateLedger(taskListId: string): TaskLedger {
  let l = ledgers.get(taskListId);
  if (!l) {
    l = new TaskLedger();
    ledgers.set(taskListId, l);
  }
  return l;
}

/** Test helper — clears all ledgers. */
export function resetLedgers(): void {
  ledgers.clear();
}
