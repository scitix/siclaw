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
      "Add a task to the plan (the task ledger). Use for multi-step or multi-target work. " +
      "Set blockedBy to ids of tasks that must finish first (advisory ordering).",
    parameters: Type.Object({
      subject: Type.String({ description: "Short imperative title" }),
      description: Type.String({ description: "What needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present-continuous form for spinners" })),
      owner: Type.Optional(Type.String({ description: "Who works this (e.g. a sub-agent name)" })),
      blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must complete first" })),
    }),
    async execute(_id, raw) {
      const p = raw as { subject: string; description: string; activeForm?: string; owner?: string; blockedBy?: string[] };
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
      "Update a task: set status (pending/in_progress/completed), owner, add blockers, or delete it " +
      "(status=deleted). Mark a task completed as soon as it is done so dependents unblock.",
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
        return ok(removed ? `Deleted task #${p.id}` : `Task #${p.id} not found`);
      }
      const updated = ledger.update(p.id, {
        status: p.status,
        subject: p.subject,
        description: p.description,
        activeForm: p.activeForm,
        owner: p.owner,
        addBlockedBy: p.addBlockedBy,
      });
      if (updated) emitUpsert(emit, taskListId, updated);
      return ok(updated ? `Updated task #${p.id} (status: ${updated.status})` : `Task #${p.id} not found`);
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
