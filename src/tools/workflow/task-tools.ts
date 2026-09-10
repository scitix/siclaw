/**
 * task_create / task_update / task_list / task_get — the Tasks-v2 ledger tools (the plan).
 * Each operates the per-taskListId ledger. blockedBy is advisory (see design §3): task_list
 * reports ready vs blocked; it never gates tool use.
 */

import type { ToolEntry, SessionEventEmitter, ToolRefs } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getOrCreateLedger, type LedgerTask, type TaskStatus, type TaskView } from "../../core/task-ledger.js";
import type { TaskEvent } from "../../shared/task-events.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: { error: true } });

function emitUpsert(emit: SessionEventEmitter | undefined, taskListId: string, task: LedgerTask): void {
  emit?.({ kind: "task_event", taskListId, action: "upsert", task } satisfies TaskEvent);
}
function emitDelete(emit: SessionEventEmitter | undefined, taskListId: string, taskId: string): void {
  emit?.({ kind: "task_event", taskListId, action: "delete", taskId } satisfies TaskEvent);
}

/**
 * Both ledger-writing tools take an ARRAY, because the cost of a plan is not the ledger write —
 * it is the model round-trip each write used to sit alone in. Measured over a month of production
 * traces: 9841 task_* calls, 96% of them the only tool call in their turn, each paying a full
 * round-trip for a 0.1s write.
 *
 * The single-item shape is still accepted. It is not there for compatibility with a caller — these
 * tools have no non-model caller — but so that a model still emitting the old shape LANDS instead of
 * being bounced, since a validation error costs exactly the round-trip the array form is meant to
 * save.
 */
/**
 * Upper bound on one batch, per tool.
 *
 * Taking an array removes what used to bound this implicitly: N tasks cost N model round-trips, so a
 * runaway plan was self-limiting — nobody spends fifty turns writing one. One call can now create
 * fifty in a single step, and each emits a task_event that is persisted as its own chat_message.
 * Measured plans run 3–5 tasks and the busiest conversation in a month made 37 task_* calls in
 * total, so this is far above anything real and only there to stop one confused call from writing
 * hundreds of rows.
 */
const MAX_BATCH = 50;

const TaskCreateItem = Type.Object({
  subject: Type.String({ description: "Short, concrete outcome or question to resolve" }),
  description: Type.String({ description: "Approach and enough context to carry out the task; include relevant constraints and how to verify the outcome" }),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous form for spinners" })),
  owner: Type.Optional(Type.String({ description: "Who works this (e.g. a sub-agent name)" })),
});

const TaskStatusLiteral = Type.Union([
  Type.Literal("pending"), Type.Literal("in_progress"),
  Type.Literal("completed"), Type.Literal("deleted"),
]);

const TaskUpdateItem = Type.Object({
  id: Type.String({ description: "The task id returned by task_create" }),
  status: Type.Optional(TaskStatusLiteral),
  subject: Type.Optional(Type.String({ description: "Non-empty new title; omitted or blank keeps the current title" })),
  description: Type.Optional(Type.String({ description: "Refined approach, completion criterion, or observed result; preserve the task's intent and relevant evidence" })),
  activeForm: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  addBlockedBy: Type.Optional(Type.Array(Type.String())),
});

type CreateItem = {
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
};
type TaskCreateParams = { tasks?: CreateItem[] } & Partial<CreateItem>;

type UpdateItem = {
  id: string;
  status?: TaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlockedBy?: string[];
};
type TaskUpdateParams = { updates?: UpdateItem[] } & Partial<UpdateItem>;

/** Array form when present and non-empty, else the single-item form, else nothing. */
function normalizeCreateItems(p: TaskCreateParams): CreateItem[] {
  if (Array.isArray(p.tasks) && p.tasks.length > 0) return p.tasks;
  if (p.subject !== undefined || p.description !== undefined) {
    return [{
      subject: p.subject ?? "",
      description: p.description,
      activeForm: p.activeForm,
      owner: p.owner,
    }];
  }
  return [];
}

function normalizeUpdateItems(p: TaskUpdateParams): UpdateItem[] {
  if (Array.isArray(p.updates) && p.updates.length > 0) return p.updates;
  if (p.id !== undefined) {
    return [{
      id: p.id,
      status: p.status,
      subject: p.subject,
      description: p.description,
      activeForm: p.activeForm,
      owner: p.owner,
      addBlockedBy: p.addBlockedBy,
    }];
  }
  return [];
}

export function createTaskCreateTool(taskListId: string, emit?: SessionEventEmitter): ToolDefinition {
  return {
    name: "task_create",
    label: "Create Task",
    description:
      "Create milestones in the per-session task ledger and return their ids. This is a progress " +
      "checklist, not a separate planning or approval mode. Use it when tracking " +
      "outcomes, dependencies, or changing evidence helps carry substantial work to completion.\n\n" +
      "## Ground the plan\n" +
      "- If the relevant procedure, scope, or data source is unknown, read the applicable Skill or do " +
      "a focused discovery check first. Plan once you can choose meaningful next actions; do not defer " +
      "planning until the investigation is over. Already have enough context? Plan immediately.\n" +
      "- Skip the ledger for simple work. There is no minimum task count: two useful milestones are " +
      "better than five generic phases. Do not pad a plan with 'understand / investigate / summarize', " +
      "one task per tool call, or a single task that merely repeats the request.\n\n" +
      "## Write useful milestones\n" +
      "- subject: a short, concrete outcome or question to resolve.\n" +
      "- description: enough context to carry out the step, including the approach, relevant " +
      "constraints, and how to verify the outcome. Keep it concise; put detailed analysis in the " +
      "conversation or requested deliverable. Do not invent targets, findings, or ids.\n" +
      "- State the actual completion criterion, not just which tool to call. If an empty or negative " +
      "result can answer the question, say so: 'Determine whether the window has a usable sample' " +
      "can finish with a documented empty result; 'Find a usable sample' cannot. Avoid a separate " +
      "'summarize/report' step unless producing and checking that artifact is substantial work.\n" +
      "- Plan the work supported by current context. Keep later milestones provisional; refine them " +
      "when evidence arrives rather than guessing every downstream step.\n" +
      "- Include only work you can carry out yourself or through available delegation within the " +
      "authorized scope. Put external remediation recommendations in the answer, not the ledger.\n\n" +
      "## Efficient use\n" +
      "- Pass the currently useful milestones together in the `tasks` array. A single entry is valid " +
      "when adding new work to an existing plan. activeForm and owner are optional.\n" +
      "- Reuse the known plan. Call task_list only when its current state is unclear; do not list " +
      "before every create or update.\n" +
      "- The interface already displays the checklist. Do not repeat it or announce 'plan created'; " +
      "use progress messages for findings, important context, or the next check.\n" +
      "- Dependencies are NOT set here: task_create returns each task's id; order dependent steps " +
      "afterward with task_update addBlockedBy, referencing those returned ids (never guess ids).\n" +
      "- Nothing is created if any entry is invalid, so a rejected call leaves no half-written plan.\n"
      + "- At most 50 tasks per call (a safety limit, not a suggested plan size).\n\n" +
      "## Example after discovering a request-log and trace source\n" +
      "Weak: 'Confirm scope / Analyze trace / Summarize findings'.\n" +
      "Useful: 'Select a slow request with a usable trace / Attribute elapsed time along the critical " +
      "path / Build and verify the request timeline'. The first description can preserve a requested " +
      "30-minute window and a user-authorized 2-hour fallback only when no usable sample exists. " +
      "Refine the next step after reading the trace; do not claim a bottleneck in advance.",
    parameters: Type.Object({
      tasks: Type.Optional(Type.Array(TaskCreateItem, {
        description: "Currently useful milestones, in order, created together in one call.",
      })),
      // Single-task form, kept so a call in the older shape still lands instead of costing a
      // retry round-trip — which is the very thing the array form exists to save.
      subject: Type.Optional(TaskCreateItem.properties.subject),
      description: Type.Optional(TaskCreateItem.properties.description),
      activeForm: Type.Optional(Type.String({ description: "Single-task form: present-continuous form" })),
      owner: Type.Optional(Type.String({ description: "Single-task form: who works this" })),
    }),
    async execute(_id, raw) {
      const p = raw as TaskCreateParams;
      const items = normalizeCreateItems(p);
      if (items.length === 0) {
        return err("task_create requires `tasks`: an array of {subject, description}.");
      }
      if (items.length > MAX_BATCH) {
        return err(
          `task_create takes at most ${MAX_BATCH} tasks per call; got ${items.length}. `
          + "Nothing was created. A plan this large is not a plan — name the phases instead, and "
          + "add detail as each one starts.",
        );
      }
      // Validate every entry BEFORE creating any: a partially written plan is worse than a
      // rejected call, because the model cannot tell which half landed.
      const bad = items.findIndex((t) => !t.subject?.trim());
      if (bad >= 0) {
        return err(
          `task_create requires a non-empty subject; tasks[${bad}] has none. `
          + "Nothing was created — resend the whole array.",
        );
      }
      const ledger = getOrCreateLedger(taskListId);
      const created = items.map((t) => {
        const task = ledger.create({
          subject: t.subject,
          description: t.description ?? "",
          activeForm: t.activeForm,
          owner: t.owner,
        });
        // One event per task, as before: the plan panel still ticks task by task, only the
        // model round-trips are shared.
        emitUpsert(emit, taskListId, task);
        return task;
      });
      return ok(created.map((t) => `Created task #${t.id}: ${t.subject}`).join("\n"));
    },
  };
}

export function createTaskUpdateTool(taskListId: string, emit?: SessionEventEmitter): ToolDefinition {
  return {
    name: "task_update",
    label: "Update Task",
    description:
      "Update a task in the plan: set status (pending/in_progress/completed), subject/description/" +
      "activeForm/owner, add a dependency (addBlockedBy), or delete it (status=deleted). " +
      "An unknown id returns an error.\n" +
      "## Update from observed evidence\n" +
      "Mark in_progress when work starts. Mark completed only after the milestone's completion " +
      "criterion has been met using results already observed; a tool call or sub-agent launch alone " +
      "does not complete it. Record a concise result or evidence reference in description when useful. " +
      "The current subject and description must both match the result.\n" +
      "- 'Verify the timeline' stays in_progress if the verifier fails or required spans are missing, " +
      "even though you finished running the check. Describe the gap; do not mark it completed with " +
      "an error in the description, and do not rename it to 'attempt verification' to manufacture success.\n" +
      "- A question such as 'Determine whether a sample exists' can complete with an observed empty " +
      "result. A milestone promising to find a usable sample cannot complete without one.\n" +
      "- If a permitted fallback changes the search window or approach, revise the unfinished title " +
      "and description to reflect that scope before completing it. A result from a larger window " +
      "does not fulfill a title promising a sample from the original window.\n" +
      "Keep your OWN inline work to one task in_progress at a time (you do one thing yourself at a time); but " +
      "when you fan out sub-agents in parallel, mark EACH of their tasks in_progress — several can be " +
      "in_progress at once when sub-agents are running them.\n" +
      "## Revise the approach\n" +
      "Refine an unfinished task's subject/description in place when new evidence changes how to " +
      "reach the same outcome. Add a task only for distinct new work; delete obsolete pending tasks " +
      "instead of letting the plan grow indefinitely. Preserve completed results. Briefly explain " +
      "a material change of direction and its evidence in a progress update.\n" +
      "For a blocker, record what is missing and the next viable check. If no viable check remains " +
      "within scope, report the blocker or insufficient evidence to the user; do not keep looping " +
      "or mark the original goal successful just to close the plan. It is valid to finish the " +
      "response with a blocked milestone still in_progress and its blocker in description. " +
      "All tasks do not need to be completed before answering.\n" +
      "## Batch bookkeeping\n" +
      "Send related updates in one `updates` array, alongside the next independent real tool call " +
      "when possible. Do not mark completed alongside a verification whose result you still need. " +
      "An initial plan or final close-out can stand alone; avoid intermediate status-only turns.\n" +
      "Set ordering with addBlockedBy using the real ids from task_create / task_list, " +
      "e.g. {\"id\":\"2\",\"addBlockedBy\":[\"1\"]}. If unsure of a task's current state, task_get it first.\n" +
      "Remove a task that is no longer relevant or was created in error with status=deleted. " +
      "(A fully-completed plan is auto-cleared after a short delay, so the list stays scoped to current work.)",
    parameters: Type.Object({
      updates: Type.Optional(Type.Array(TaskUpdateItem, {
        description: "Several task updates applied in one call — e.g. closing out the plan at the end.",
      })),
      // Single-update form: the common case, and what rides along with a real tool call.
      id: Type.Optional(Type.String()),
      status: Type.Optional(TaskStatusLiteral),
      subject: Type.Optional(Type.String({ description: "Non-empty new title; omitted or blank keeps the current title" })),
      description: TaskUpdateItem.properties.description,
      activeForm: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      addBlockedBy: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, raw) {
      const p = raw as TaskUpdateParams;
      const items = normalizeUpdateItems(p);
      if (items.length === 0) {
        return err("task_update requires `id` (or `updates`, an array of {id, …}).");
      }
      if (items.length > MAX_BATCH) {
        return err(
          `task_update takes at most ${MAX_BATCH} updates per call; got ${items.length}. `
          + "Nothing was applied.",
        );
      }
      const ledger = getOrCreateLedger(taskListId);
      const lines: string[] = [];
      let applied = 0;
      for (const u of items) {
        if (!u?.id) {
          lines.push("Skipped an entry with no id.");
          continue;
        }
        if (u.status === "deleted") {
          const removed = ledger.delete(u.id);
          if (removed) {
            emitDelete(emit, taskListId, u.id);
            applied++;
            lines.push(`Deleted task #${u.id}`);
          } else {
            lines.push(`Task #${u.id} not found — call task_list to see valid ids.`);
          }
          continue;
        }
        const updated = ledger.update(u.id, {
          status: u.status,
          subject: u.subject,
          description: u.description,
          activeForm: u.activeForm,
          owner: u.owner,
          addBlockedBy: u.addBlockedBy,
        });
        if (!updated) {
          lines.push(`Task #${u.id} not found — call task_list to see valid ids.`);
          continue;
        }
        emitUpsert(emit, taskListId, updated);
        applied++;
        lines.push(`Updated task #${u.id} (status: ${updated.status})`);
      }
      // Errors are reported per entry rather than for the call: one bad id among several good ones
      // is not a failed call, and marking it one would paint the turn red over work that landed.
      // Only a call where NOTHING applied is a failure.
      return applied > 0 ? ok(lines.join("\n")) : err(lines.join("\n"));
    },
  };
}

function formatTask(t: TaskView): string {
  const state = t.status !== "pending" ? t.status : t.ready ? "ready" : "blocked";
  const owner = t.owner ? ` [${t.owner}]` : "";
  const waiting = !t.ready && t.status === "pending" && t.blockedBy.length
    ? ` (waiting on ${t.blockedBy.map((b) => `#${b}`).join(" ")})`
    : "";
  return `#${t.id} [${state}] ${t.subject}${owner}${waiting}`;
}

export function createTaskListTool(taskListId: string): ToolDefinition {
  return {
    name: "task_list",
    label: "List Tasks",
    description: "List the current plan: every task with its status, owner, and ready/blocked state.",
    parameters: Type.Object({}),
    async execute() {
      const tasks = getOrCreateLedger(taskListId).list();
      if (tasks.length === 0) return ok("(plan is empty)");
      return ok(tasks.map(formatTask).join("\n"));
    },
  };
}

export function createTaskGetTool(taskListId: string): ToolDefinition {
  return {
    name: "task_get",
    label: "Get Task",
    description: "Get one task's full detail by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, raw) {
      const p = raw as { id: string };
      const t = getOrCreateLedger(taskListId).get(p.id);
      if (!t) return ok(`Task #${p.id} not found`);
      const lines = [
        `#${t.id} [${t.status}] ${t.subject}`,
        t.description && `  ${t.description}`,
        t.owner && `  owner: ${t.owner}`,
        t.blockedBy.length && `  blockedBy: ${t.blockedBy.map((b) => `#${b}`).join(" ")}`,
      ].filter(Boolean);
      return ok(lines.join("\n"));
    },
  };
}

// The plan/task ledger is hidden:
// - in Deep Investigation mode — DP structures work via hypothesis checkpoints, and a
//   parallel plan conflicts with that (availableModes: ["normal"]);
// - in spawned sub-agents — the plan is owned by the parent; a child has no SSE emitter
//   so its task mutations would never reach the UI (available: !isSubagent).
const plannerOnly = (refs: ToolRefs) => !refs.isSubagent;
export const taskCreateRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskCreateTool(refs.taskListId, refs.sessionEventEmitter),
  availableModes: ["normal"],
  available: plannerOnly,
};
export const taskUpdateRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskUpdateTool(refs.taskListId, refs.sessionEventEmitter),
  availableModes: ["normal"],
  available: plannerOnly,
};
export const taskListRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskListTool(refs.taskListId),
  availableModes: ["normal"],
  available: plannerOnly,
};
export const taskGetRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskGetTool(refs.taskListId),
  availableModes: ["normal"],
  available: plannerOnly,
};
