# Sub-agents / Background / Task-ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the v2 design (`docs/design/2026-05-29-subagents-background-task-ledger.md`):
a Tasks-v2 task ledger (= plan), `spawn_subagent` delegation, a background Job runtime, full sub-agent
transcript persistence, refresh recovery, and the Portal Web UI.

**Architecture:** Three planes — execution (`spawn_subagent` / exec, foreground or background-via-Job),
record (the Task ledger), and persistence (Portal DB as durable source of truth, AgentBox is ephemeral).
Built on pi-coding-agent 0.73's native parallel tool execution. No L4 (teammates/SendMessage).

**Tech Stack:** Node ≥22 (ESM, TS strict, `.js` imports), vitest, `@sinclair/typebox` tool params,
pi-coding-agent `ToolDefinition`, raw-SQL portal DB (mysql2 / node:sqlite), React + Vite + Tailwind UI.

---

## Phased roadmap (each phase = working, tested software; later phases get their own detailed plan)

- **Phase 1 — Task ledger core (detailed below).** Pure in-memory ledger + `task_create/update/list/get`
  tools wired into the registry. Agent can plan; fully unit/tool tested. No persistence/UI yet.
- **Phase 2 — Ledger persistence + read API + refresh.** Mirror `task_*` mutations to the Portal DB
  (new `task_*` persistence events, same channel as delegation); add a read endpoint; rehydrate on load.
- **Phase 3 — `spawn_subagent` (foreground).** Tool + executor (reuse/simplify `runDelegatedAgent`),
  declarative agent-type registry, no-recursion guard, shared ledger via parent `taskListId`. Inline result.
- **Phase 4 — Sub-agent observability.** Reuse `delegation-persistence` for full child transcript;
  guarantee failure/timeout flush + terminal event; portal read for a child transcript by `childSessionId`.
- **Phase 5 — Background Job runtime.** `run_in_background` param + unified Job table + `job_output`/
  `job_stop` + completion-notification injection (gateway event + TUI steering). Job kinds: subagent, command.
- **Phase 6 — Portal Web UI.** Timeline fan-out card + drill-in; plan panel (grouped checklist); Jobs bar;
  full refresh rehydration (fetch-then-subscribe).
- **Phase 7 — Prompt guidance** (`src/core/prompt.ts`, **requires human approval** — describe intent, wait).

> Each later phase will be expanded into its own detailed plan when we reach it (avoids speculative
> placeholders). Phase 1 is fully specified now.

---

## Phase 1 — Task ledger core

**File structure:**
- Create `src/core/task-ledger.ts` — pure ledger store + types + id allocation + ready/blocks derivation.
  No IO, no refs. The single source of truth for ledger logic.
- Create `src/core/task-ledger.test.ts` — unit tests for the store.
- Create `src/tools/workflow/task-tools.ts` — the four `task_*` `ToolDefinition`s + their `ToolEntry`
  registrations, over a per-`taskListId` ledger.
- Create `src/tools/workflow/task-tools.test.ts` — tool-level tests.
- Modify `src/core/tool-registry.ts` — add `taskListId: string` to `ToolRefs`.
- Modify `src/core/agent-factory.ts` — derive a `taskListId` and pass it into the refs literal; add
  `taskListId?` to `CreateSiclawSessionOpts`.
- Modify `src/tools/all-entries.ts` — import + register the four task tools.

---

### Task 1.1: Pure ledger store (`task-ledger.ts`)

**Files:**
- Create: `src/core/task-ledger.ts`
- Test: `src/core/task-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/task-ledger.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TaskLedger, getOrCreateLedger, resetLedgers } from "./task-ledger.js";

describe("TaskLedger", () => {
  it("creates tasks with monotonic numeric ids and pending status", () => {
    const l = new TaskLedger();
    const a = l.create({ subject: "list nodes", description: "kubectl get nodes" });
    const b = l.create({ subject: "check disks", description: "df on each node" });
    expect(a.id).toBe("1");
    expect(b.id).toBe("2");
    expect(a.status).toBe("pending");
    expect(a.blockedBy).toEqual([]);
  });

  it("ids stay monotonic after deletion (no reuse)", () => {
    const l = new TaskLedger();
    l.create({ subject: "a", description: "" });
    l.create({ subject: "b", description: "" });
    l.delete("2");
    const c = l.create({ subject: "c", description: "" });
    expect(c.id).toBe("3");
  });

  it("update changes fields and status; delete removes", () => {
    const l = new TaskLedger();
    l.create({ subject: "a", description: "" });
    const u = l.update("1", { status: "in_progress", owner: "sub-agent-1" });
    expect(u?.status).toBe("in_progress");
    expect(u?.owner).toBe("sub-agent-1");
    expect(l.delete("1")).toBe(true);
    expect(l.get("1")).toBeUndefined();
  });

  it("list computes ready: pending task with no incomplete blockers is ready", () => {
    const l = new TaskLedger();
    l.create({ subject: "n", description: "" });           // #1
    l.create({ subject: "p", description: "" });           // #2
    l.create({ subject: "correlate", description: "", blockedBy: ["1", "2"] }); // #3
    let view = l.list();
    expect(view.find(t => t.id === "1")!.ready).toBe(true);
    expect(view.find(t => t.id === "3")!.ready).toBe(false); // blocked by 1,2
    l.update("1", { status: "completed" });
    l.update("2", { status: "completed" });
    view = l.list();
    const t3 = view.find(t => t.id === "3")!;
    expect(t3.ready).toBe(true);                  // blockers complete -> ready
    expect(t3.blockedBy).toEqual([]);             // completed blockers filtered from view
  });

  it("list derives blocks (reverse of blockedBy)", () => {
    const l = new TaskLedger();
    l.create({ subject: "n", description: "" });           // #1
    l.create({ subject: "c", description: "", blockedBy: ["1"] }); // #2
    const t1 = l.list().find(t => t.id === "1")!;
    expect(t1.blocks).toEqual(["2"]);
  });

  it("getOrCreateLedger returns the same instance per taskListId", () => {
    resetLedgers();
    const a = getOrCreateLedger("sess-1");
    const b = getOrCreateLedger("sess-1");
    const c = getOrCreateLedger("sess-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/task-ledger.test.ts`
Expected: FAIL — `Cannot find module './task-ledger.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/task-ledger.ts`:

```ts
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
      const incompleteBlockers = task.blockedBy.filter(b => !this.isComplete(b));
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/task-ledger.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/task-ledger.ts src/core/task-ledger.test.ts
git commit -m "feat(tasks): add in-memory Tasks-v2 ledger store"
```

---

### Task 1.2: The four `task_*` tools (`task-tools.ts`)

**Files:**
- Create: `src/tools/workflow/task-tools.ts`
- Test: `src/tools/workflow/task-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/workflow/task-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { resetLedgers } from "../../core/task-ledger.js";
import {
  createTaskCreateTool, createTaskUpdateTool, createTaskListTool, createTaskGetTool,
} from "./task-tools.js";

const TLID = "sess-test";
const text = (r: any) => (r.content[0] as any).text as string;

describe("task tools", () => {
  beforeEach(() => resetLedgers());

  it("task_create returns the new id and subject", async () => {
    const t = createTaskCreateTool(TLID);
    const r = await t.execute("c1", { subject: "list nodes", description: "kubectl get nodes" });
    expect(text(r)).toContain("#1");
    expect(text(r)).toContain("list nodes");
  });

  it("task_update marks status and is reflected by task_get", async () => {
    await createTaskCreateTool(TLID).execute("c1", { subject: "a", description: "" });
    await createTaskUpdateTool(TLID).execute("u1", { id: "1", status: "completed" });
    const r = await createTaskGetTool(TLID).execute("g1", { id: "1" });
    expect(text(r)).toContain("completed");
  });

  it("task_update status=deleted removes the task", async () => {
    await createTaskCreateTool(TLID).execute("c1", { subject: "a", description: "" });
    await createTaskUpdateTool(TLID).execute("u1", { id: "1", status: "deleted" });
    const r = await createTaskGetTool(TLID).execute("g1", { id: "1" });
    expect(text(r)).toContain("not found");
  });

  it("task_list shows ready vs blocked with waiting-on ids", async () => {
    const c = createTaskCreateTool(TLID);
    await c.execute("c1", { subject: "n", description: "" });               // #1
    await c.execute("c2", { subject: "correlate", description: "", blockedBy: ["1"] }); // #2
    const r = await createTaskListTool(TLID).execute("l1", {});
    const out = text(r);
    expect(out).toMatch(/#1.*ready/i);
    expect(out).toMatch(/#2.*blocked/i);
    expect(out).toContain("waiting on #1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/workflow/task-tools.test.ts`
Expected: FAIL — `Cannot find module './task-tools.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/tools/workflow/task-tools.ts`:

```ts
/**
 * task_create / task_update / task_list / task_get — the Tasks-v2 ledger tools (the plan).
 * Each operates the per-taskListId ledger. blockedBy is advisory (see design §3): task_list
 * reports ready vs blocked; it never gates tool use.
 */

import type { ToolEntry } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import { getOrCreateLedger, type TaskStatus, type TaskView } from "../../core/task-ledger.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function title(theme: any, name: string) {
  return new Text(theme.fg("toolTitle", theme.bold(name)), 0, 0);
}

export function createTaskCreateTool(taskListId: string): ToolDefinition {
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
      return ok(`Created task #${t.id}: ${t.subject}`);
    },
  };
}

export function createTaskUpdateTool(taskListId: string): ToolDefinition {
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
      const p = raw as { id: string; status?: TaskStatus | "deleted"; subject?: string; description?: string; activeForm?: string; owner?: string; addBlockedBy?: string[] };
      const ledger = getOrCreateLedger(taskListId);
      if (p.status === "deleted") {
        return ok(ledger.delete(p.id) ? `Deleted task #${p.id}` : `Task #${p.id} not found`);
      }
      const updated = ledger.update(p.id, {
        status: p.status,
        subject: p.subject,
        description: p.description,
        activeForm: p.activeForm,
        owner: p.owner,
        addBlockedBy: p.addBlockedBy,
      });
      return ok(updated ? `Updated task #${p.id} (status: ${updated.status})` : `Task #${p.id} not found`);
    },
  };
}

function formatTask(t: TaskView): string {
  const state = t.status !== "pending" ? t.status : t.ready ? "ready" : "blocked";
  const owner = t.owner ? ` [${t.owner}]` : "";
  const waiting = !t.ready && t.status === "pending" && t.blockedBy.length
    ? ` (waiting on ${t.blockedBy.map(b => `#${b}`).join(" ")})`
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
        t.blockedBy.length && `  blockedBy: ${t.blockedBy.map(b => `#${b}`).join(" ")}`,
      ].filter(Boolean);
      return ok(lines.join("\n"));
    },
  };
}

export const taskCreateRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskCreateTool(refs.taskListId),
  platform: true,
};
export const taskUpdateRegistration: ToolEntry = {
  category: "workflow",
  create: (refs) => createTaskUpdateTool(refs.taskListId),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/workflow/task-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workflow/task-tools.ts src/tools/workflow/task-tools.test.ts
git commit -m "feat(tasks): add task_create/update/list/get tools over the ledger"
```

---

### Task 1.3: Wire `taskListId` into refs and register the tools

**Files:**
- Modify: `src/core/tool-registry.ts` (the `ToolRefs` interface, ~line 138)
- Modify: `src/core/agent-factory.ts` (refs literal ~line 379; `CreateSiclawSessionOpts`)
- Modify: `src/tools/all-entries.ts`

- [ ] **Step 1: Add `taskListId` to `ToolRefs`**

In `src/core/tool-registry.ts`, inside `export interface ToolRefs { ... }`, add after `sessionIdRef`:

```ts
  /** Shared task-ledger id. A session and the sub-agents it spawns share one taskListId. */
  taskListId: string;
```

- [ ] **Step 2: Provide `taskListId` in agent-factory**

In `src/core/agent-factory.ts`:

1. Add the import at the top (with the other `node:` imports):

```ts
import { randomUUID } from "node:crypto";
```

2. In `CreateSiclawSessionOpts` (the options interface), add:

```ts
  /** Shared task-ledger id; sub-agents pass the parent's id to share its ledger. Default: fresh uuid. */
  taskListId?: string;
```

3. Just before the `registry.resolve({ ... refs: { ... } })` call (near line 377), add:

```ts
  const taskListId = opts?.taskListId ?? randomUUID();
```

4. In the `refs: { ... }` literal, add `taskListId` to the first line so it reads:

```ts
      kubeconfigRef, userId, agentId, sessionIdRef, taskListId,
```

- [ ] **Step 3: Register the four tools**

In `src/tools/all-entries.ts`:

1. Add imports (in the `// workflow` import group):

```ts
import {
  taskCreateRegistration, taskUpdateRegistration, taskListRegistration, taskGetRegistration,
} from "./workflow/task-tools.js";
```

2. Add them to the `allToolEntries` array in the `// ── workflow ──` group (after `taskReport`):

```ts
  taskCreateRegistration, taskUpdateRegistration, taskListRegistration, taskGetRegistration,
```

- [ ] **Step 4: Typecheck + full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass (3115 + the new ledger/tool tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-registry.ts src/core/agent-factory.ts src/tools/all-entries.ts
git commit -m "feat(tasks): wire taskListId into ToolRefs and register task tools"
```

---

### Phase 1 self-review checklist (run before moving on)

- [ ] `task_create/update/list/get` appear in the resolved tool list (add a quick log or a registry test).
- [ ] `TaskLedger` method names used in `task-tools.ts` match `task-ledger.ts` (`create`, `update`,
      `delete`, `get`, `list`; `getOrCreateLedger`).
- [ ] `ToolRefs.taskListId` is non-optional and supplied at every refs construction site (only
      `agent-factory.ts`).
- [ ] No placeholders; `npm test` green; `npx tsc --noEmit` clean.

---

## Phases 2–7

Detailed task breakdowns are written per-phase at execution time (each as its own section/plan), to keep
real code accurate against the evolving codebase rather than speculative. Scope per phase is fixed by the
roadmap above and the spec. Phase 2 (ledger persistence + refresh) is the next to detail.
```
