# Sub-agents, Background Jobs & Task Ledger (v2) — Design Spec

> Status: approved design (pending spec review)
> Date: 2026-05-29
> Reference only (not extended/merged): the `delegate_to_agent(s)` tools on `main` and the
> 69-commit `agentic-sre-long-task-test` branch. This is a fresh implementation modelled on
> Claude Code's **current** design — going straight to its v2 task model rather than re-walking
> the TodoWrite-v1 → Tasks-v2 path.

## 1. Goal & scope

Three primitives, modelled faithfully on Claude Code's latest design:

- **`spawn_subagent`** — delegate a bounded task to an isolated child agent (foreground or background).
- **Background Job runtime** — the unified machinery that tracks in-flight async executions and
  reports their results back to the parent.
- **Task ledger (= plan)** — a persistent work list with ids, dependencies, owners, and status.
  This is Claude Code's **Tasks-v2**, adopted directly. It *is* the plan; there is no separate
  TodoWrite-style list.

**In scope:** L1 (sub-agents) + L2 (background) + L3 (Tasks-v2 ledger).
**Out of scope (L4):** long-lived addressable teammates, `SendMessage` between agents, coordinator
mode, tmux panes. Decision: not built. The L1–L3 stack already delivers parallel + ordered plans
via sub-agent fan-out; L4 is a different "team of persistent collaborators" paradigm that does not
fit siclaw's request/one-pod-per-user model.

## 2. Non-goals

- No TodoWrite-v1 (we go straight to the Tasks-v2 ledger).
- No L4 (teammates / SendMessage / coordinator / tmux).
- No `isolation: "worktree"` — it isolates parallel *code edits*; siclaw sub-agents are read-only
  SRE diagnostics with nothing to isolate. `isolation: "remote"` maps to siclaw's existing
  K8sSpawner, not CCR.
- No plan-driven gating of tool use (the ledger tracks work; it does not block the agent).

## 3. Enabling fact: native parallel tool execution (pi 0.73)

`@mariozechner/pi-coding-agent` was upgraded 0.55.3 → 0.73.1 (commit `eea634b6`). The agent loop now
runs multiple tool calls in one assistant turn concurrently (`executeToolCallsParallel`, `Promise.all`);
`toolExecution` defaults to `"parallel"` and siclaw does not override it. A tool may force a turn serial
via `ToolDefinition.executionMode: "sequential"`. Consequence: sub-agent fan-out parallelism comes from
the model emitting N `spawn_subagent` calls in one turn — no batch-array tool needed.

**Concurrency cap (siclaw-side, since pi has none).** `Promise.all` runs the whole batch unbounded, and
each `spawn_subagent` is a full in-process child agent (own LLM stream + kubectl/bash) sharing one
AgentBox pod. So an N-target fan-out would spin up N child agents + N LLM streams at once → provider 429s
and pod pressure. siclaw therefore wraps the foreground spawn executor in a per-pod
`ConcurrencyLimiter` (`src/core/concurrency-limiter.ts`), bounded by `SICLAW_SUBAGENT_CONCURRENCY`
(default `DEFAULT_SUBAGENT_CONCURRENCY = 5`, see `subagent-registry.ts`). Excess spawns **queue** (FIFO,
slot released even on throw) rather than being rejected — the model still emits N calls and gets N
reports; they just don't all execute simultaneously. The cap is per-AgentBox (shared across a pod's
sessions), applied only to foreground spawns; background launches return immediately and are gated off
anyway (§7).

**The executor is dependency-blind — this shapes the whole orchestration model.** A turn is either
all-parallel or all-serial; there is no partial ordering *within* a turn and no notion of one tool call
depending on another. pi never sees the ledger's `blockedBy`. Therefore **dependencies are not enforced
by pi**; they are enforced by the orchestrating model *across turns* (see §8): only ready (unblocked)
tasks go into a single turn; dependents are dispatched in later turns once their blockers complete.
`blockedBy` is **advisory + observability** (decision: option A) — model-facing state and a UI signal,
**not** an engine constraint. A strictly serial chain (A→B→C) that must not rely on the model splitting
turns should instead be **packed into one sub-agent**, which runs the steps sequentially in its own loop.

## 4. Conceptual model — two planes, and the Task/Job distinction

```
EXECUTION plane (how work runs)            RECORD plane (the plan)
  spawn_subagent ─┐                          Task ledger (Tasks-v2, persistent):
  exec command  ──┼ run_in_background?         { id, subject, description, activeForm,
                  │   ├ foreground → inline       status, owner, blocks/blockedBy, metadata }
                  │   └ background  → Job        ├─ parallel = unblocked tasks, different owners, at once
  Job completes → notification → parent         └─ order   = blockedBy dependency graph
```

Two things share the word "task" in Claude Code; siclaw keeps them **distinct** and **names them
differently** (CC's identical naming is a real source of confusion — one pit we do not re-walk):

- **Task ledger entry** (`task_*` tools) — a planned unit of work: what to do, deps, owner, status.
  This is the plan.
- **Background Job** (`job_*` tools) — an in-flight async execution (a sub-agent or a command):
  output file, kill, completion notification.

They are loosely linked: dispatching a sub-agent for ledger task `#3` creates a Job; when the Job
finishes, task `#3` is marked `completed`. Neither structure embeds the other.

## 5. Task ledger (= plan) — Tasks-v2, adopted directly

### Contract
- **Entry:** `{ id, subject, description, activeForm?, status, owner?, blocks[], blockedBy[], metadata? }`.
  `status ∈ {pending, in_progress, completed}`; `deleted` is a hard-delete action.
- **Tools:** `task_create` (`subject` / `description` / `activeForm?` / `owner?`), `task_update`
  (status / owner / addBlocks / addBlockedBy / metadata), `task_list`, `task_get`.
- **Dependencies are set after creation, never at create time (CC-aligned).** `task_create` takes **no**
  `blockedBy` — it returns the new id and the task starts with empty `blocks`/`blockedBy`. The model wires
  ordering with `task_update addBlockedBy`, referencing the **real ids returned by `task_create`**. This
  mirrors Claude Code's `TaskCreate`/`TaskUpdate` split and removes the impossible "predict a sibling id
  during a parallel create" step that otherwise produces dangling `blockedBy` references. `task_update`
  against an unknown id returns an **error** result (not a silent no-op), so a bad id surfaces immediately.
- **Id allocation:** numeric, monotonic per `taskListId`, serialized by the persistence layer (DB
  transaction in gateway modes; a local lock in TUI) — concurrency-safe when parent and sub-agents write
  the same list.
- **Scope & ownership:** one `taskListId` per session, and the **plan is parent-owned**. Sub-agents have
  no `task_*` tools (hidden via the `isSubagent` ref) — they neither read nor write the ledger, so a
  child can never mutate the plan in a way the UI wouldn't see. The parent marks a task `completed` as
  each child reports its findings back. (A task's `owner` may name the sub-agent doing the work; that's
  metadata the parent sets — the child does not touch the ledger.)
- **Persistence — durable home is the Portal DB, not the AgentBox (see §14):** the ledger is persisted
  through the **same durable channel as chat + delegation events** (mirrored to the Portal DB in gateway
  modes via `task_*` persistence events; a local session store in TUI). It is **not** a standalone
  file-locked FS store in the AgentBox — the AgentBox is ephemeral compute (idle sessions release after
  ~30s; pods come and go), so the durable, UI-facing source of truth must be the Portal DB. The AgentBox
  holds a live working copy for the running session and rehydrates it from the durable store on
  (re)start. This replaces the prior `plan-store` and makes the ledger survive web refresh.
- **Parallelism is first-class:** no "one in_progress" rule. Unblocked tasks with different owners run
  concurrently; `blockedBy` orders them. `blockedBy` is **advisory** (option A): it records ordering for
  the orchestrating model and the UI; it is **not** mechanically enforced (pi cannot — see §3). `task_list`
  surfaces which tasks are ready vs. blocked (completed blockers are filtered out) so the model dispatches
  only ready tasks.
- **No gating:** the ledger never blocks tool use or completion; it is a record + an observable (UI panel
  / TUI render).
- **Auto-clear when a plan completes (CC V2 `resetTaskList` parity):** once **every** task is `completed`,
  the ledger is cleared after a short delay (`LEDGER_AUTOCLEAR_MS`, ~5s — matches CC's `HIDE_DELAY_MS`).
  A new pending task before the timer fires cancels the clear. The clear emits a `task_event` with
  `action: "reset"` (persisted + streamed), so the backend ledger, the live SSE consumers, `foldPlan`, and
  refresh all reset together; the id sequence is **preserved** so the next plan's ids never reuse cleared
  ones. This keeps the plan scoped to the current work instead of accumulating completed tasks across
  multiple plans in one session. The model may also remove a task explicitly with `status=deleted`
  (no-longer-relevant / created-in-error), the same per-task curation CC V2's TaskUpdate exposes.

### Why Tasks-v2 instead of TodoWrite
Going straight to v2 avoids building, then discarding, the simpler single-`in_progress` checklist.
Tasks-v2 natively expresses the thing we need — parallel, ordered, owner-attributed work — which
TodoWrite cannot. The cost (ids, file-locking, persistence) is paid once.

## 6. `spawn_subagent` (sub-agents)

> **Superseded by [2026-07-subagent-group.md](./2026-07-subagent-group.md) (v3 single-tool merge).**
> The `prompt`-per-call schema and "emit N calls in one turn to fan out" pattern below were
> replaced by an items-only batch schema: `spawn_subagent({ task_template?, items[1..N],
> reduce_prompt? })`. Fan-out is now ONE call with a list of `items`, not N calls; a single item
> is the degenerate case. The sections below are retained as the original 2026-05 record.

### Contract
- **Input:** `{ description, prompt, subagent_type?, model?, run_in_background? }`. One call = one child.
- **Parallelism:** the model emits N calls in one turn → pi runs them concurrently (native).
- **Isolation:** fresh context (prompt + optional caller context, not the parent transcript); inherits
  kubeconfig / credentials / skills / memory (read); runs the same read-only tools **minus
  `spawn_subagent`** — no recursion (fork-guard).
- **Agent-type registry (declarative, from CC):**
  `{ agentType, whenToUse, tools | disallowedTools, model?, systemPrompt, background?, omitContextFiles? }`.
  `whenToUse` is surfaced to the parent so it picks the right type. Built-in SRE types kept minimal
  (e.g. a general-purpose diagnostic agent; a read-only probe agent). User/agent-defined types load
  from a directory (and/or Portal) — directory loading may land after v1.
- **Result delivery:**
  - **Foreground (default):** the tool call blocks; the child's summary is returned inline as the
    `tool_result`. Use when the parent needs the result to proceed.
  - **Background (`run_in_background: true`):** registers a Job (§7), returns immediately with
    `{status: 'launched', job_id, ...}`; the result arrives later as an injected notification. Use for
    genuinely independent parallel work. Auto-promote a foreground child to background past a time
    threshold (CC's auto-background).
- **Ledger interplay (optional, soft):** a sub-agent may be dispatched to satisfy a ledger task; it (or
  the parent) sets that task's `owner`/`status`. `owner` is an optional string field — neither tool
  requires the other.

## 7. Background Job runtime

- **`run_in_background` is a parameter**, not a standalone tool. It applies to `spawn_subagent` and to
  long-running read-only exec commands. (CC has no standalone background tool; the prior siclaw
  `run-in-background` tool is *not* replicated.)
- **Unified Job table:** `{ id, kind: 'subagent' | 'command', status: running|completed|failed|killed,
  description, outputFile, outputOffset, notified, startTime, endTime, abortController }`. v1 kinds:
  `subagent` and `command` only.
- **Lifecycle:** `registerJob()` → detached `void run(...)` with an **independent** abort controller
  (parent ESC does not kill it) → output appended to `outputFile` → `completeJob()` → completion
  **notification** injected into the parent session, consumed on the parent's next turn.
- **Management tools:** `job_output(id, block?)` (read/stream, optionally wait for completion),
  `job_stop(id)` (kill). `job_list` optional.
- **Rule:** the launch tool_result means "started" — the parent must **not poll**; it will be notified.
- **Notification delivery by mode:**
  - Gateway / AgentBox: reuse the existing completion-event injection (the branch's
    `DELEGATION_BATCH_COMPLETE_EVENT` / `background_tool_job.complete` pattern) into the parent session.
  - TUI (pi `InteractiveMode`): inject the notification as a queued user message / steering at the next
    turn boundary. This is the one genuinely new wiring point.

### ⚠️ Implementation status (v1) — background is BUILT but flag-gated OFF (no completion notification yet)

**Master switch:** `RUN_IN_BACKGROUND_ENABLED` in `src/core/subagent-registry.ts` (currently `false`).
It gates three surfaces at once so the half-feature is never exposed to the model:
- `spawn_subagent` — the `run_in_background` parameter is omitted from the schema and the matching
  description sentence is dropped (`buildDescription()`); `execute` also hard-forces `runInBackground:false`.
- `job_stop` — its `available()` returns `false`, so the tool is never registered (no `job_id` can exist
  while background is off anyway).
- `src/core/prompt.ts` — the "Background work" bullet was removed (no over-promising "you'll be notified").

Flip the flag to `true` (after the notification below lands) and all three return automatically.

**Built and kept intact behind the flag:** background launch (`startBackgroundSubagent` →
`{status:"launched", job_id}`), the in-memory job table (`subagentJobs`), the `job_stop` executor + tool,
the Jobs bar + drill-in to the child session, session-release gating (`_backgroundWorkCount` keeps the
AgentBox alive until jobs finish), and full child-session transcript persistence. None of this is deleted —
only the model-facing entry points are gated.

**Still NOT built (the reason it's gated):** the **completion notification back to the parent model**. On
completion `startBackgroundSubagent` only updates `job.status`; the child's `summary` is **dropped** for
the parent model, and there is **no** queue / steer / injected message. (The old
`notifyParentOfDelegationBatch` + `runSyntheticParentPrompt` path that did this for the legacy delegation
batch was removed with the `delegate_to_agent(s)` cleanup; the `DELEGATION_BATCH_COMPLETE_EVENT` reference
above is stale.) So a background result would reach the **UI** (child session + delegation card) but
**never the orchestrating model**, and `job_output` (CC's `TaskOutput`) is not provided. Exposing it in
this state is a net negative (dropped result, prompt that lies, session held up to the runtime cap), which
is why the flag is OFF rather than the param simply documented as discouraged.

**Why gated rather than shipped:** pi 0.73 **native parallel** foreground `spawn_subagent` covers the common SRE cases
(fan-out the same check across N nodes; multi-step investigation) — the parent waits and synthesizes
inline, which is what the user is waiting for anyway. Genuine async is only needed for **long
(minutes-scale) operations kicked off mid-conversation that the user wants to keep chatting through**
(e.g. a cluster-wide RoCE `ib_write_bw` sweep, packet captures, soak tests), and that niche overlaps the
**cron / scheduled-task** path (`manage_schedule` + `task_report`). Not worth the machinery yet.

**TODO when we do build it (mirror CC):** CC delivers completion as a **user-role message at the next
turn boundary** via a pending-notification queue — `enqueuePendingNotification` (messageQueueManager) on
terminal state + a per-task `notified` flag + drain into the turn (`query.ts`). Our version: on job
completion, deliver the child summary to the parent model (steer if mid-turn, else inject a user-role
notification on the next turn), persist it to the parent session (refresh-safe), and dedup with a
`notified` flag, then flip `RUN_IN_BACKGROUND_ENABLED` to `true`. **Until then: `run_in_background` is
gated OFF entirely (not just discouraged) and long unattended work routes to cron** (`manage_schedule` +
`task_report`) — nothing promises an in-conversation notification.

## 8. Parallel + ordered orchestration (how it all composes)

The parent orchestrates; sub-agents execute; the ledger records.

1. `task_create` each unit of work (bare — no `blockedBy`), then `task_update addBlockedBy` to wire
   ordering using the returned ids (e.g. `correlate` blocked by `nodes`, `pods`, `net`).
2. For each ready (unblocked) task, `spawn_subagent` — emit them **in one turn** to run in parallel
   (or `run_in_background` for independent long work).
3. As each child returns its findings, **the parent** marks that task `completed` (sub-agents have no
   `task_*` tools); dependents unblock.
4. Dispatch the next wave. `task_list` is the live, parallel-capable plan.

This delivers parallel + ordered plans **without L4** — the parent is the sole orchestrator; sub-agents
do not message each other.

**Ordering is model-enforced across turns, not engine-enforced (option A).** pi runs everything in a
turn concurrently and is blind to `blockedBy` (§3). So a "wave" = one turn containing only ready tasks;
the next wave is a later turn after blockers complete. The prompt instructs the model to fan out only
unblocked tasks and never to put a task and its blocker in the same turn; `task_list` (ready vs. blocked)
is its guide. There is deliberately **no dependency guard**. When a chain must be strictly serial and
must not depend on the model splitting turns correctly, pack it into a single sub-agent (§6) instead of
expressing it as separate dependent tasks.

## 9. Relationships

- **Execution plane** (`spawn_subagent` / exec, foreground or background-via-Job) and the **record
  plane** (Task ledger) are independent tools. Their only contact is the optional `owner`/`status`
  bookkeeping a sub-agent does on a ledger task. Each is usable without the other.
- **Job ⟂ ledger:** a Job is in-flight execution; a ledger task is planned work. Linked only by the
  model marking a task done when its dispatched Job completes.
- No tool gates another; parallelism is an execution property, not a ledger-entry property — except the
  ledger now *records* parallel/ordered intent via owners + deps.

## 10. Where this plugs into siclaw

- **Tools** register via `ToolRegistry` / `all-entries.ts`: `spawn_subagent`, `task_create|update|list|get`,
  `job_output|job_stop`. Default (parallel) execution mode.
- **Sub-agent executor** creates child sub-sessions of the same agent core — reuse the proven
  child-session machinery in `src/agentbox/session.ts` (isolated session dir, inherited refs, event
  forwarding, lineage persistence), simplified to the contracts above; drop the async-batch/work-package
  coupling and `update_plan` interlocks of the prior design.
- **Ledger store** is session-scoped + file-locked; reuse the prior `plan-store`'s persistence location
  pattern, restructured to the Tasks-v2 schema.
- **Modes:** sub-agents and the shared ledger run in-process (TUI, Gateway+Local, Gateway+K8s — same
  AgentBox/process). Cross-pod is out of scope.
- **Prompt** (`src/core/prompt.ts`, human-approval-gated): guidance to (a) maintain the task ledger for
  multi-step work, (b) fan out one sub-agent per independent task in a single turn, (c) never poll
  background jobs.

## 11. Naming

To avoid CC's `Task*`-means-two-things collision: **`task_*` tools operate the ledger (the plan);
`job_*` tools operate in-flight background executions.** "Job" = runtime async unit; "task" = planned
work item.

## 12. Web UI (Portal)

Three zones, building on the existing Portal chat (`portal-web/src/components/chat/PilotArea.tsx`
timeline + `statusTone` badges + the `SkillPanel`/`SchedulePanel` slide-in pattern; the prior branch's
`SubagentTranscript` / `ToolMessageCard` are ported for drill-in).

```
┌───────────────────────────┬───────────────────────┐
│  Conversation timeline     │   Plan panel (ledger) │  collapsible
│  (PilotArea)               │   In progress (3) ...  │
│  ┌ fan-out card (folded) ┐ │   Ready / Blocked / Done│
│  │ spawned N · X done ▸  │ │                       │
├───────────────────────────┴───────────────────────┤
│  Background Jobs bar:  ⏳ job (running 0:42) ■stop  │  shown only when jobs exist
└────────────────────────────────────────────────────┘
```

- **Timeline (center):** main-agent narration. A `spawn_subagent` fan-out collapses to **one card**
  ("spawned N sub-agents · X done / Y running"), expandable; clicking a child drills into that
  sub-agent's full transcript (`SubagentTranscript`). Never render N sub-agents inline — it floods the
  timeline.
- **Plan panel (right, collapsible):** the live Task ledger as a **status-grouped checklist** (layout
  option 1):
  - Groups: **In progress** (the tasks running in parallel right now) · **Ready** (pending, unblocked) ·
    **Blocked** (pending, shows `⛓ waiting on #x #y`) · **Done**.
  - Each row shows status + `owner` (which sub-agent / Job) with a **drill-in** link to that owner's
    transcript. Updates live as status/owner/dependencies change.
  - (A wave/lane view may be added later as a toggle; not in v1. No DAG graph.)
- **Background Jobs bar (bottom):** appears only when Jobs exist; per-Job live progress + **stop**
  (`job_stop`); on completion the bar turns green and a completion card is posted to the timeline.

**plan ↔ sub-agent link is display-only:** data stays decoupled; the UI uses the task's optional `owner`
field to link a ledger row to its sub-agent/Job transcript. (This is the soft coupling §9 permits.)

## 13. Sub-agent observability & transcript persistence (hard requirement)

A sub-agent must never be a black box. Its **full execution record** — every message, tool call, tool
input, output/outcome, and reasoning — must be durably persisted and viewable in the UI, **including on
failure or timeout**. Otherwise "what did it do / why did it succeed / why did it fail" is unanswerable,
which is unacceptable for an SRE tool.

### Contract
- **Every sub-agent runs as its own persisted session** with lineage to the parent
  (`parentSessionId`, `delegationId`/spawn id, `agentId`, and the ledger `owner`/task id if any).
- **Stream-and-persist as it runs:** each child message and tool call is forwarded in real time
  (`delegation.append_message` / `update_message` / `update_tool_message`) carrying
  `toolName`, `toolInput`, `outcome: success|error|blocked`, and `durationMs` — so the drill-in shows
  **live** progress and the record survives for later inspection.
- **Terminal event always emitted** (`delegation.append_event`) with `status ∈
  {done, partial, failed, timed_out, cancelled}`, a `capsule` summary, `childSessionId`, `toolCalls`,
  `durationMs`, and — for non-success — `partialSource` / `interruptedTool`. **Failure and timeout paths
  MUST flush the partial transcript and emit this event** (never drop the record on error).
- **The summary returned to the parent is lossy by design; the transcript is the source of truth.** The
  parent sees the capsule; the human can always drill into the full child session.

### Reuse
This is exactly the `src/shared/delegation-persistence.ts` event set already on `main`
(`ensure_session` / `append_message` / `update_message` / `update_tool_message` / `append_event` /
`emit_chat_event`), persisted via `internal-api.ts` with per-identity auth. Reuse it as-is; do **not**
invent a parallel path.

### What must be built / wired
- **Portal read path + UI drill-in:** an endpoint to fetch a child session's full transcript by
  `childSessionId`, and a drill-in view that renders it (port `SubagentTranscript` / `ToolMessageCard`
  from the prior branch). Live during the run via streamed child events; full history after, even once
  the sub-agent/session is released.
- **Terminal-status banner** in the drill-in: `done / partial / failed / timed_out`, plus the failing
  tool call + error and any partial output for non-success — so "why it failed" is visible at a glance.
- **Background Job linkage:** a background sub-agent's transcript persists identically; the Jobs bar
  (§12) and the completion notification both link to its `childSessionId`. For a `command` Job (no agent),
  the "record" is its captured output stream (via `job_output`), not an agent transcript.
- **Drill-in entry points all resolve to the same child session:** the timeline fan-out card, the plan
  panel `owner` link, and the Jobs bar all open the same persisted transcript.

## 14. Session refresh & recovery (hard requirement)

A browser refresh must lose **nothing**: the conversation, the task ledger (plan), every sub-agent
transcript, and the background-jobs state must all come back, and in-flight work must keep streaming.

### Principle
**The Portal DB is the single durable source of truth for the whole session; the AgentBox is ephemeral
compute.** Everything the UI shows is persisted to the Portal DB as it happens, through the same channel
already used for chat history and delegation events. On refresh the UI **fully rehydrates from the Portal
DB, then reconnects to the live SSE stream** for anything still running. (This matches siclaw's invariant
that the Portal/Gateway DB owns sessions and chat history; AgentBox state is disposable.)

### What must survive refresh, and how
- **Conversation:** already persisted; reload from DB. (Existing.)
- **Task ledger (plan):** persisted via `task_*` events to the Portal DB (§5). On refresh, the plan panel
  reloads the current ledger for the session.
- **Sub-agent transcripts:** persisted via delegation-persistence (§13). On refresh, drill-in fetches the
  full child transcript by `childSessionId` — available even after the sub-agent/session is released.
- **Background jobs:** job state (`id, kind, status, description, childSessionId, progress/outputOffset`)
  is persisted too. On refresh, the Jobs bar reloads running + recently-finished jobs and **reattaches to
  live progress** via SSE; `job_output` streams resume from the persisted offset.

### In-flight work across refresh
- A running sub-agent/job keeps executing in the AgentBox during a refresh (the client disconnecting does
  not abort it; background work uses an independent abort controller — §7). A session with live background
  work is **not released** (release is gated on zero in-flight background work), so the compute survives.
- On reconnect the UI does **fetch-then-subscribe**: load persisted state up to now, then subscribe to the
  live event stream; buffered/replayed events close any gap so no update is lost between load and subscribe.
- Once all work is done and the session goes idle and releases, everything remains in the Portal DB — fully
  viewable (just no longer "live").

### TUI
Refresh is a web concern. In TUI the ledger and job state persist to the local session store and are
restored on session resume; the standalone-TUI path keeps working without a Portal DB.

### What must be built / wired
- `task_*` persistence events (mirror of the delegation-persistence pattern) + Portal DB schema for the
  ledger, and a read endpoint to load a session's ledger.
- Job-state persistence + a read endpoint for active/recent jobs, and SSE resume for live job/sub-agent
  progress (event replay or fetch-then-subscribe).
- UI rehydration on mount: conversation + plan panel + jobs bar + (if deep-linked) an open drill-in, then
  reconnect to the live stream.

## 15. Testing

- **Ledger:** id allocation is monotonic under concurrent writes (file lock); `task_list` reports a task
  as ready vs. blocked based on `blockedBy` and filters out completed blockers (advisory only — no engine
  enforcement); `deleted` removes; per-session scoping isolates ledgers; parent + sub-agent share one
  ledger; ledger never emits a gating/blocking signal.
- **Sub-agent:** foreground returns inline; `run_in_background` returns immediately + later notifies;
  children lack `spawn_subagent` (no recursion); child context excludes parent transcript.
- **Observability (§13):** every child message + tool call is persisted with lineage during the run; a
  **failing/timed-out** sub-agent still flushes its partial transcript and emits a terminal event with
  the non-success status + interrupted tool; the full child transcript is retrievable by `childSessionId`
  after the session is released; the three drill-in entry points (timeline card, plan `owner`, Jobs bar)
  resolve to the same persisted transcript.
- **Background Job:** independent abort controller (parent abort does not kill it); `job_stop` kills +
  notifies; `job_output(block=true)` waits for completion; completion notification reaches the parent.
- **Parallel orchestration:** N sub-agents dispatched in one turn run concurrently (native parallel
  execution). Ordering is model-driven, not engine-enforced; tests cover the observable contract
  (`task_list` ready/blocked reporting) rather than mechanical dependency gating.
- **Refresh & recovery (§14):** ledger, sub-agent transcripts, and job state all reload from the Portal
  DB after a simulated client reconnect; a job/sub-agent running at refresh time keeps executing and the
  reconnected client resumes its live stream from the persisted offset with no lost or duplicated events;
  a session with in-flight background work is not released.
- **Regression:** full suite stays green (`npm test`).
```
