# Resumable subagents and inventory coverage

Baseline: `origin/main` at `403395ad`. Source research and its limits are recorded in
[the source audit](2026-09-09-subagent-source-audit.md).

## Contract

Keep `spawn_subagent` as the only execution tool. One free-form string item is a
single assignment; multiple items optionally share a template and a reducer. A
brief should convey the desired outcome, relevant facts, boundaries and useful
report shape. It is not a mandatory investigation script or a model-generated
"prompt optimizer". Bulk queries do not inherently require one child per resource.

The child receives the platform safety contract, the Agent type's contract, the
configured Agent addendum, and a separate child-role addendum. It retains its
inherited resource and tool restrictions. Parent-only planning and delegation
instructions are omitted because the child has neither ledger nor spawn tools.
The main conversation is not copied by default. New children can select parent
context using `fork_turns` (see [context selection](2026-09-09-subagent-context.md)).
A resumed child restores its own pi transcript
and compaction history with current Agent permissions/business policy. A different
Agent's handoff is a separate operation.

## Child identity and execution identity

Each newly launched child gets a random session UUID. One protected artifact per
batch records its child UUIDs, user and role. The model receives opaque
`artifact-id:index` resume handles. This avoids one metadata artifact per target.
The artifact reader enforces the existing parent Agent/session scope, digest,
private-file checks and expiry; the runtime additionally verifies the internal
issuer and user. Arbitrary tool output cannot forge a ticket. No credentials,
provider configuration or parent business prompt are persisted in the ticket.
Tickets use existing output quotas/cleanup and normally expire after 24 hours.

`spawn_subagent` with `resume` requires exactly one message, without a role/tier
change, template, inventory source or reducer. A live run receives guidance;
otherwise the same child session directory must contain a persisted transcript.
A missing transcript is an explicit error, never a silent fresh conversation.
A continuation uses a new tool/delegation ID, trace span and result, while keeping
the child session ID. Completed child transcripts can be reopened after a manager
restart on the same persistent storage. An in-flight run/mailbox is not a durable
job scheduler: a process crash does not promise delivery of pending guidance.
Resume parses and validates every row with bounded memory before native recovery,
and rejects files larger than 64 MiB before either pass. Corrupt or unbounded
retained history therefore cannot mutate or monopolize an AgentBox. Oversized
histories require a new task.

Inventory-backed background groups persist their sanitized final coverage receipt
on the bare group terminal event. This keeps `snapshot_complete`, selected/total,
and the next offset available to a reloaded UI instead of leaving only the launch-
time selection range. The persistence boundary allow-lists the coverage shape.

A manager reserves child IDs before queueing work. Running/queued continuations
cannot instantiate a second brain for the same child. Queued work keeps its mailbox
until a limiter slot is acquired. Active work uses native pi steering; messages
rejected during model repair or left in the native queue at turn end are delivered
at the next prompt boundary. During completion assessment, guidance waits outside
the brain. The assessment uses the assignment plus all accepted guidance. A final
synchronous seal rejects messages arriving after completion has been accepted.
Guidance is bounded to 32 messages per run; existing time/concurrency limits remain.

Map children stay reserved until their group finishes synthesis. Once a map child
is sealed, callers wait for the group result before reopening it. This prevents a
reducer from reading results concurrently with a revision. Later follow-ups produce
new reports; the old group's synthesis remains a historical snapshot. The parent
must integrate revised findings, rather than treating that old synthesis as current.
A steer acknowledgement is a completed message-delivery operation, not a new
background job or a completed child investigation.

## Exhaustive target selection

`items_from` reads a complete JSON tool-result artifact inside the requesting
session. JSON pointers select the target array, source total and per-target fields.
The array must match the source-declared total. All identities are validated for
uniqueness before even the first wave starts. No expressions, scripts or arbitrary
file paths are evaluated by this operation.

Large inventories are immutable snapshots split by explicit `offset`/`limit` under
the existing batch cap. Each response includes the snapshot ID, total, selected
range, stable target IDs and next offset. Runtime reports join terminal outcomes
back to these IDs, including skipped/failed/missing outcomes. `snapshot_complete`
is true only for a full-snapshot report where every target task completed; it says
nothing about whether those targets were healthy.

The source must actually represent the authorized complete inventory. Matching a
source's total cannot prove a query had the correct filters, that inventory did not
change later, or that a source's own total is truthful. Paginated/incomplete results
are rejected, not guessed complete. For multiple waves, the parent must schedule
all returned offsets and reconcile the union of their target IDs; there is no
cross-wave persistent scheduler or automatic retry of failed targets in this change.
This makes the remaining responsibility explicit instead of claiming that a plan
or template alone proves exhaustive coverage.

## Compatibility and verification

No HTTP endpoint, database schema or Helm value change is required. A companion
control-plane UI recognizes snapshot batches and terminal guidance acknowledgements,
and preserves runtime-resolved target labels. Tool
parameters/results are additive; existing single/batch prompts still work. Existing
live/terminal events and child transcript views remain in use. Channels that force
foreground execution still do so. Native `read` behavior is untouched; the internal
full-artifact reader uses the same verified load path as the recovery tools.

Tests cover prompt inheritance, same-session continuation after manager rebuild,
no duplicate brain/job on steer, message arrival during assessment/repair, scoped
and forged/expired tickets, source pagination and duplicate identities, wave
boundaries and failed/missing target accounting. Existing cancellation, tracing,
model-tier, background notification and reducer tests remain regression checks.
