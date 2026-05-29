/**
 * task_create / task_update / task_list / task_get — the Tasks-v2 ledger tools (the plan).
 * Each operates the per-taskListId ledger. blockedBy is advisory (see design §3): task_list
 * reports ready vs blocked; it never gates tool use.
 */

import type { ToolEntry, SessionEventEmitter } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
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

export function createTaskCreateTool(taskListId: string, emit?: SessionEventEmitter): ToolDefinition {
  return {
    name: "task_create",
    label: "Create Task",
    renderCall: (_a, theme) => title(theme, "task_create"),
    renderResult: renderTextResult,
    description:
      "Add a task to the plan (the per-session task ledger) and return its id. Use it proactively for " +
      "non-trivial work: 3+ distinct steps, the same work across multiple targets, or when the user gives " +
      "several things to do — create the main steps up front. Skip it for a single trivial step (no " +
      "ceremony).\n" +
      "Fields: subject (short imperative title), description (what to do), activeForm (present-continuous " +
      "form shown in the spinner), owner (optional, e.g. a sub-agent name).\n" +
      "Dependencies are NOT set here: task_create returns each task's id; order dependent steps afterward " +
      "with task_update addBlockedBy, referencing those returned ids (never guess ids). Call task_list " +
      "first to avoid creating duplicate tasks.",
    parameters: Type.Object({
      subject: Type.String({ description: "Short imperative title" }),
      description: Type.String({ description: "What needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present-continuous form for spinners" })),
      owner: Type.Optional(Type.String({ description: "Who works this (e.g. a sub-agent name)" })),
    }),
    async execute(_id, raw) {
      const p = raw as { subject: string; description: string; activeForm?: string; owner?: string };
      const t = getOrCreateLedger(taskListId).create(p);
      emitUpsert(emit, taskListId, t);
      return ok(`Created task #${t.id}: ${t.subject}`);
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
      "Status workflow pending -> in_progress -> completed: mark a task in_progress before you start it, " +
      "and completed as soon as it is FULLY done so dependents unblock — do not batch completions. Only " +
      "mark completed when truly finished; if you hit errors, blockers, partial work, or failing checks, " +
      "keep it in_progress (optionally add a new task for the blocker).\n" +
      "Set ordering with addBlockedBy using the real ids from task_create / task_list, " +
      "e.g. {\"id\":\"2\",\"addBlockedBy\":[\"1\"]}. If unsure of a task's current state, task_get it first.\n" +
      "Remove a task that is no longer relevant or was created in error with status=deleted. " +
      "(A fully-completed plan is auto-cleared after a short delay, so the list stays scoped to current work.)",
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Optional(Type.Union([
        Type.Literal("pending"), Type.Literal("in_progress"),
        Type.Literal("completed"), Type.Literal("deleted"),
      ])),
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      activeForm: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      addBlockedBy: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, raw) {
      const p = raw as {
        id: string;
        status?: TaskStatus | "deleted";
        subject?: string;
        description?: string;
        activeForm?: string;
        owner?: string;
        addBlockedBy?: string[];
      };
      const ledger = getOrCreateLedger(taskListId);
      if (p.status === "deleted") {
        const removed = ledger.delete(p.id);
        if (removed) emitDelete(emit, taskListId, p.id);
        return removed ? ok(`Deleted task #${p.id}`) : err(`Task #${p.id} not found — call task_list to see valid ids.`);
      }
      const updated = ledger.update(p.id, {
        status: p.status,
        subject: p.subject,
        description: p.description,
        activeForm: p.activeForm,
        owner: p.owner,
        addBlockedBy: p.addBlockedBy,
      });
      if (!updated) return err(`Task #${p.id} not found — call task_list to see valid ids.`);
      emitUpsert(emit, taskListId, updated);
      return ok(`Updated task #${p.id} (status: ${updated.status})`);
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

export const taskCreateRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskCreateTool(refs.taskListId, refs.sessionEventEmitter),
  platform: true,
};
export const taskUpdateRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskUpdateTool(refs.taskListId, refs.sessionEventEmitter),
  platform: true,
};
export const taskListRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskListTool(refs.taskListId),
  platform: true,
};
export const taskGetRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskGetTool(refs.taskListId),
  platform: true,
};
