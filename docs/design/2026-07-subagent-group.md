# spawn_subagent — unified single/batch (map→reduce) fan-out

**Status:** implemented (branch `para-subagent`)
**Date:** 2026-07 (v3 single-tool merge — supersedes the interim two-tool `spawn_subagent_group`)

## Context

`spawn_subagent` lets the model fan out, but originally each target meant a hand-written prompt
in its own call. For "N crashing pods, go into each and find the root cause, then summarize"
with N=50 this is expensive and fragile: ~50 few-hundred-token prompts drift in format; ~50
result capsules (≤1800 chars each) all flow back into the parent context and the model has to
re-organize them itself; and "the model forgot a few targets" or "started summarizing early"
are real determinism risks. Approval is also N separate tool calls.

The fix is a declarative map→reduce: the model writes **one task template + an item list (the
for-loop) + an optional reduce stage**; the runtime deterministically runs each item and pipes
the map outputs straight into the reduce, so the parent context receives only the final summary
plus a one-line-per-item status list.

An interim design shipped this as a *second* tool (`spawn_subagent_group`) alongside
`spawn_subagent`. **v3 merges the two**: batching is now the single `spawn_subagent` tool's only
semantics — a single task is just an `items` list of length 1. The merge happened before first
release, so there is no migration cost.

Non-goals (v1, deliberate): arbitrary multi-stage pipelines / DAGs (chain multiple calls
instead); user-authored plan files; TUI support (executor is agentbox-only); per-item or
reduce-specific subagent type / model (a future optional parameter, not a schema break).

## Decision

**One tool, one schema.** `spawn_subagent` takes `{ description, task_template?, items[1..N],
reduce_prompt?, subagent_type?, run_in_background? }`. There is no `prompt` field — the interim
two-tool split existed to avoid a `prompt` single-send and a `template+items` batch being two
mutually-exclusive semantics on one schema; items-only dissolves that objection, so the tools
merge and the double tool-selection error surface disappears.

The plan enters as **structured tool parameters, validated + rendered at the call layer** (a bad
plan — bad placeholders, mixed item shapes, over the cap, duplicates — bounces back before any
child starts). Not a YAML file the model writes (no file-write tool; validation lags; local mode
shares a filesystem).

Every child runs through the **unchanged `runSpawnedSubagent`** (global limiter, 600s per-child
backstop, transcript persistence, `delegation_event`, audit attribution). The tool layer only
validates/renders; the runtime executor orchestrates, pipes results, and aggregates. Depth is
unchanged: children get no spawn executor, so the tree is strictly one level deep.

```
parent model                     AgentBox runtime (same process)
  │ spawn_subagent({task_template?, items[1..N], reduce_prompt?})
  ▼
one approval ─► tool layer: validateAndRenderGroupPlan (fail-fast) → renderedTasks[]
                    │
        ┌───────────┴───────────────────────────┐
  items.length===1 && no reduce_prompt      items.length>1 OR reduce_prompt
        │  (COLLAPSE)                            │  (BATCH)
        ▼                                        ▼
  runSpawnedSubagent (one child,           runSubagentGroup (orchestrator, holds NO limiter slot)
  bare spawnId, legacy events →              │ worker pool (≤ max(1, concurrency-1) in flight)  ┐ map
  AgentWorkCard; byte-identical to           │   render(template,item) → lazily create child   │
  the pre-v3 single spawn)                   │   → collect capsule + status                     ┘
                                             │   circuit break: first 5 completions all failed
                                             │                  with zero success → stop + abort
                                             │ reduce (optional): reduce_prompt + all item
                                             │   results → one more child
                                             ▼
        └──────────────► uniform result: { status, item_results[], reduce_summary? }
```

## Contracts (what must hold)

### Tool layer (single entry)

- **Uniform model-visible envelope.** Every call — collapse or batch — returns
  `{ status, item_results: [{ item, status, summary? }], reduce_summary? }`. N=1 → one
  `item_results` entry. The key is always `item_results` (never a second `items` shape), so the
  model handles one return shape. When a reduce stage ran the per-item `summary` fields are
  omitted (the reduce summary is the synthesis; keeping N capsules would defeat the reduce's
  context savings). `details` additionally carries per-item `child_session_id`, and — on the
  collapse path — the legacy single-spawn fields the AgentWorkCard renders (`summary`,
  `tool_calls`, `duration_ms`, `full_summary`, `steps`).
- **Conditional foreground/background default.** `run_in_background ?? (items.length > 1)`: a
  single item runs foreground (grab the result and keep reasoning), a multi-item batch runs
  background (a large batch can take 10min+). The harm is asymmetric on both sides, so each side
  gets the fitting default; an explicit `run_in_background` always wins. The tool description
  states both defaults and the override.
- **Collapse is byte-identical to the pre-v3 single spawn.** A single item with no
  `reduce_prompt` is dispatched to `runSpawnedSubagent` (foreground) / `startBackgroundSubagent`
  (background) with the **bare `spawnId`** (the tool-call id, no `#`), so its events,
  `delegation_id`, completion notification, and UI card are unchanged. Only the model-visible
  return shape is unified (above).
- **`SUBAGENT_GROUP_ENABLED` is an ops rollback lever, not tool registration.** Since there is
  one tool, the switch cannot hide a second tool; instead OFF forces the item cap to 1 and
  rejects a `reduce_prompt`, degrading `spawn_subagent` to a pure single-task spawn (pre-batch
  behaviour). This is a behaviour switch, not a compatibility shim.

### Orchestration (batch path)

- **The orchestrator never holds a `subagentLimiter` slot.** It submits children *into* the
  global limiter through a worker pool that keeps at most `getGroupWorkerShare()` =
  `max(1, concurrency-1)` in flight. This is the single resource cap (no second, nested group
  semaphore — that risks deadlock) and it always leaves ≥1 slot for an interactive single spawn
  (no head-of-line starvation). Child sessions are created **lazily inside each worker** — never
  all N at once.
- **Two abort scopes.** An external signal (user Stop / `job_stop`) aborts **both** map and
  reduce. The group-size-scaled timeout and the circuit breaker abort **only the map phase** — a
  map-phase timeout must not kill a still-valuable reduce (which keeps its own 600s backstop).
  Reduce runs when a `reduce_prompt` was given, ≥1 item produced usable output (`done` or
  `partial`), and the user did not cancel.
- **A single failed/timed-out item does NOT abort the batch.** Its status + error summary flow
  into the reduce input. This is a bounded, deliberate exception to fail-fast: a failure is a
  valid diagnostic signal, not dirty data to propagate.
- **Circuit breaker judged by completion order, not submission order** (concurrent children
  finish out of order): the first `window` (5) completions all failed with zero success → trip
  (stop submitting, abort in-flight, remaining items become `skipped`); any `done` releases the
  breaker permanently. `partial` prevents a trip without releasing; `skipped` is not a
  completion.
- **Batch backstop is an OUTER SAFETY NET, not a precise budget.**
  `clamp(ceil(N/workers) × itemBudget + margin, 1800s, 7200s)`. The per-item budget is an
  expected value; if children systematically approach their own 600s ceiling the batch may hit
  this net first and produce a PARTIAL — accepted, not a bug.
- **Reduce summary comes from the FULL reduce report, then the 6000-char budget.** The reduce
  child's `fullSummary` (not its ≤1800 capsule) is fed to `truncateReduceSummary(6000)`; the
  capsule is already ≤1800, so truncating it to 6000 was a no-op and the larger budget never
  took effect (fixed in v3).

### Persistence & lineage

- Each child persists its own session + terminal `delegation_event` with
  `delegation_id = {groupToolCallId}#{index}` (`#` is untouched by delegation-id validation).
  The reduce child uses `#reduce`. The collapse path uses the bare tool-call id (no `#`).
- A batch persists one terminal `delegation_event` with `delegation_id = groupToolCallId`.
  `childSessionId` = the reduce child's session id when a reduce ran, else the empty string (the
  card drills in per-item, not via this field).
- **`skipped` items are never persisted as a child event** (never started; `skipped` is not in
  the delegation status enum) — they exist only in the aggregate report and the batch terminal
  event's item detail.

### Job model & notification

- The background job **reuses `type: "subagent"`** plus an optional `isGroup: true` flag. A new
  `JobType` would punch through the three `type === "subagent"` binary branches (`notifyParent`
  event routing, background-bash concurrency exclusion, `stopJob` wording); reuse keeps all three
  correct. `isGroup` is display/stats-only.
- Completion notification reuses `claimNotification` (fires exactly once across the process-exit
  vs `job_stop` race) and inlines the reduce summary + status digest. Background batches
  participate in `_backgroundWorkCount` accounting: the parent session is held until the batch
  finishes, so `notifyParent` still finds the session.

### Progress (two paths that must not be confused)

- **Foreground:** the tool's `onUpdate` carries either legacy per-child steps (collapse) or the
  aggregate status array + phase (batch: map x/N → reduce). The executor emits a union of the two
  progress shapes; the tool bridge and the frontend both dispatch by shape.
- **Background:** `onUpdate` goes dead after `launched`, so live per-item progress rides a
  **`group_progress` chat event** (same `emit_chat_event` channel as `subagent_done`, throttled,
  **live-only — never persisted**). It carries `job_id`, `phase`, and `[{index, status}]`.
  Correctness comes from the persisted per-child + terminal events: the card rebuilds from them
  on reload / refetch (per-child grouped by the `{groupId}#` prefix), so a dropped or coalesced
  progress frame costs immediacy, never correctness.
- A batch completion reuses `subagent_done` (the job is `type:"subagent"`) with an additive
  `is_group` flag; the frontend does an authoritative refetch on it (it cannot fold full per-item
  detail from that event alone) rather than the in-place status fold used for a single sub-agent.

### UI (one tool, two rendered forms)

- The frontend dispatches by **form**, not by a separate tool name: a `spawn_subagent` whose
  `items` has >1 entry OR carries a `reduce_prompt` renders as the **batch card**; a single-item,
  no-reduce call renders as the legacy **AgentWorkCard** (its collapse events are legacy-shaped,
  so this path is unchanged). The now-deleted `spawn_subagent_group` tool name is still
  recognised as the batch form so historical sessions keep rendering.
- **Batch card:** progress bar + one status row per item (each row drills into its child
  session) + the reduce summary + a drill-in to the reduce child. Children's `delegation_event`s
  are naturally hidden, so no per-child `AgentWorkCard`. It renders both a foreground batch's
  inline report (`item_results` in the tool result) and a background batch's folded metadata
  (`groupItems` from persisted events, `groupProgress` from the live event, `groupStatus`/reduce
  from the terminal event). The launch args always carry the original items, so item count +
  labels survive before any child completes.
- The Jobs bar surfaces a batch as **one** job (correlated by its bare-id launch + terminal
  event); `{groupId}#…` child/reduce events are never standalone bar entries.
- Audit attribution needs no change: children are ordinary delegation sub-sessions, covered by
  the existing `COALESCE(child, parent)` channel/sender attribution.

## Consequences

- **Steering must teach `items`, not repeated calls.** Every prompt/description that used to say
  "emit several spawn_subagent calls in one turn to fan out" now says "put the targets in one
  call's `items`". Missing one lets the model regress to N single-item calls — losing the single
  approval and the orchestration. (One known residual: `src/core/prompt.ts` still teaches the old
  pattern and requires human approval to edit — tracked separately.)
- **Global concurrency default 2 → 4.** A multi-item batch defaults to background and is the
  primary fan-out path; at concurrency 2 the worker share is 1 and a 50-item batch is effectively
  serial. 4 keeps ≥1 slot for interactive spawn while giving batches a usable pool. This changes
  plain single-spawn fan-out concurrency too; tune back with `SICLAW_SUBAGENT_CONCURRENCY`.
- **Deploy ordering / old frontend.** The `group_progress` event and the batch terminal event
  degrade gracefully on an old frontend (unknown event types ignored; a batch launch an old build
  doesn't special-case renders as a generic tool row). The `is_group` flag is additive — absent →
  treated as a single sub-agent.
- **No task-ledger coupling (v1).** The ledger stays parent-model-owned; the batch card already
  shows per-item progress. `taskListId` rides the request for type symmetry but children do not
  consume it.
- **Process restart.** `JobRegistry` is in-memory, so a batch's aggregate is unrecoverable across
  an agentbox restart (same as any background sub-agent — not a regression); the launch card is
  marked `timed_out` by the stale-launch guard.

## Env knobs

`SICLAW_SUBAGENT_GROUP_MAX_ITEMS` (50), `SICLAW_SUBAGENT_GROUP_ITEM_BUDGET` (300s),
`SICLAW_SUBAGENT_GROUP_MAX_RUNTIME` (7200s), `SICLAW_SUBAGENT_CONCURRENCY` (4), and the
`SUBAGENT_GROUP_ENABLED` rollback lever (OFF → item cap forced to 1 + `reduce_prompt` rejected,
so `spawn_subagent` degrades to a pure single-task spawn).
