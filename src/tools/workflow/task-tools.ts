/**
 * task_create / task_update / task_list / task_get — the Tasks-v2 ledger tools (the plan).
 * Each operates the per-taskListId ledger. blockedBy is advisory (see design §3): task_list
 * reports ready vs blocked; it never gates tool use.
 */

import type { ToolEntry, SessionEventEmitter, ToolRefs } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
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

function title(theme: any, name: string) {
  return new Text(theme.fg("toolTitle", theme.bold(name)), 0, 0);
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
  subject: Type.String({ description: "Short imperative title" }),
  description: Type.String({ description: "What needs to be done" }),
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
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
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
    renderCall: (_a, theme) => title(theme, "task_create"),
    renderResult: renderTextResult,
    description:
      "Create a task in the plan (the per-session task ledger) and return its id. A live plan tracks your " +
      "progress, organizes a complex investigation, and shows the user where you are.\n\n" +
      "## When to use (proactively)\n" +
      "- The request needs 3+ distinct steps, or the same check across several targets (e.g. several nodes).\n" +
      "- The user gives several things to do (a numbered or comma-separated list).\n" +
      "- A single question turns out to need a real investigation — create the main steps up front, as " +
      "soon as you see it is multi-step, BEFORE diving into tool calls. Don't wait until you're deep in.\n\n" +
      "## When NOT to use\n" +
      "- A single, straightforward, or purely informational request — just answer it, no ceremony.\n" +
      "- Fewer than 3 trivial steps.\n" +
      "- NEVER open a one-task plan whose single task just restates the request (e.g. a lone " +
      "\"investigate why X is slow\"). A single-item plan tracks nothing and is pure ceremony — it is " +
      "always wrong. Either you can name 3+ real steps up front (then create those), or you cannot yet — " +
      "in which case skip the plan and start working, narrating as you go; create the plan later if it " +
      "turns out to be genuinely multi-step.\n\n" +
      "## What belongs in the ledger\n" +
      "Create tasks ONLY for steps you will carry out yourself — read-only diagnosis and verification. Do " +
      "NOT add remediation, physical hardware work, or anything that needs the user or another team (you " +
      "can't execute them, so the plan would never complete); put those in your recommendation instead.\n\n" +
      "## Fields\n" +
      "`tasks` is an ARRAY — pass the whole plan in ONE call. Each entry: subject (short imperative " +
      "title), description (what to do), activeForm (present-continuous form shown in the spinner), " +
      "owner (optional, e.g. a sub-agent name).\n" +
      "One call per task is the same plan for N times the model round-trips, and a plan is worth making " +
      "precisely because you can already name its steps — so name them together. A single task may be " +
      "passed as a one-element array.\n\n" +
      "## Tips\n" +
      "- Call task_list first to avoid creating duplicate tasks.\n" +
      "- Dependencies are NOT set here: task_create returns each task's id; order dependent steps " +
      "afterward with task_update addBlockedBy, referencing those returned ids (never guess ids).\n" +
      "- Nothing is created if any entry is invalid, so a rejected call leaves no half-written plan.\n"
      + "- At most 50 tasks per call, which is far more than a real plan needs.\n\n" +
      "## Example\n" +
      "User: \"why has GPU training been failing on the cluster lately?\" — one question, but answering it " +
      "well needs several checks. Up front, ONE call creating all five: (1) check node/pod status & recent " +
      "events, (2) check GPU health, (3) check RDMA/network, (4) check storage, (5) correlate evidence into " +
      "a root cause. Then work them, sending each task_update along with the tool call that does the work " +
      "rather than as a turn of its own. The fix goes in your final answer, not as a task.",
    parameters: Type.Object({
      tasks: Type.Optional(Type.Array(TaskCreateItem, {
        description: "The tasks to create, in order. Pass the WHOLE plan here in one call.",
      })),
      // Single-task form, kept so a call in the older shape still lands instead of costing a
      // retry round-trip — which is the very thing the array form exists to save.
      subject: Type.Optional(Type.String({ description: "Single-task form: short imperative title" })),
      description: Type.Optional(Type.String({ description: "Single-task form: what needs to be done" })),
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
    renderCall: (_a, theme) => title(theme, "task_update"),
    renderResult: renderTextResult,
    description:
      "Update a task in the plan: set status (pending/in_progress/completed), subject/description/" +
      "activeForm/owner, add a dependency (addBlockedBy), or delete it (status=deleted). " +
      "An unknown id returns an error.\n" +
      "## Never spend a turn on bookkeeping alone\n" +
      "A plan update carries no evidence, so a turn containing ONLY task_update costs a full model " +
      "round-trip and returns nothing. Emit the update in the SAME message as the next real tool call — " +
      "the one that actually looks at something — so the two share one round-trip. Marking a task " +
      "completed and starting the next check is one message, not two.\n" +
      "A bookkeeping-only turn is justified in exactly two places: the plan's first draft, and the final " +
      "close-out when there is no next call to ride along with. If you are about to send task_update by " +
      "itself anywhere else, attach it to the call you were going to make next instead.\n" +
      "Status workflow pending -> in_progress -> completed: mark a task in_progress when work on it actually " +
      "starts, and completed once it is FULLY done so dependents unblock. Do not sit on a finished task — " +
      "report it with your next call rather than saving it up for a status-only turn later.\n" +
      "Keep your OWN inline work to one task in_progress at a time (you do one thing yourself at a time); but " +
      "when you fan out sub-agents in parallel, mark EACH of their tasks in_progress — several can be " +
      "in_progress at once when sub-agents are running them. Only mark completed when truly finished; if you " +
      "hit errors, blockers, partial work, or failing checks, keep it in_progress.\n" +
      "Keep the plan a living mirror of the work: when the investigation reveals a new thread or root-cause " +
      "lead (e.g. you set out to check RDMA but the evidence points at the GPU driver), task_create a NEW " +
      "task for it — do NOT repurpose or re-label an existing task to cram in the new finding. The plan " +
      "should grow to match what you are actually doing.\n" +
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
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
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
    renderCall: (_a, theme) => title(theme, "task_list"),
    renderResult: renderTextResult,
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
    renderCall: (_a, theme) => title(theme, "task_get"),
    renderResult: renderTextResult,
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
