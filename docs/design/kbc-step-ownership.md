# KBC internal step ownership

## Contract

Planner, map, reduce, final, and repair sessions use a bounded internal-step
driver. Each step owns its SDK client and accumulated reply until client
teardown completes. The persistent authoring client keeps its identity.

`_execute_compile_step` connects the supplied client, runs its directive, validates
the SDK result, and returns the step's reply. An internal result does not finish
the owner conversation, trigger a conversation self-check, or synchronize an
uncommitted batch. The batch orchestrator still commits artifacts and checkpoint
state together before emitting its existing final `turn_done` event.

The stream caller supplies a `CompileStep` explicitly. There is no run-wide
completion-suppression flag or shared last-step reply. Rebuilding a failed step
discards that step's text without erasing pending conversation text.

## Execution and teardown

The sequential executor registers its active step for watchdog targeting. A
second internal step and injected persistent-session repair are rejected while
that ownership exists. SDK connect failure, execution failure, and cancellation
all enter the same teardown path.

SDK connection, execution and disconnection run in one owned task, including
Claude's task-bound AnyIO scopes. The watchdog cancels that task rather than
disconnecting its client from a different task. The worker's reply remains local
until execution and teardown both succeed.
An interrupt response that arrives after a successor starts cannot reap that
successor; failure handling checks the original client identity.

The interrupt call itself is bounded by `KBC_STALL_INTERRUPT_DEADLINE_S` (120
seconds by default). SDK/tool teardown has a separate 30-second deadline.
Neither deadline waits indefinitely for a coroutine to acknowledge cancellation.
Execution ownership is released only after teardown succeeds. If teardown cannot
be confirmed, the step keeps ownership, new messages/commands receive a conflict,
and a `worker_teardown_failed` error reaches the Runtime. A failed planner does
not fall back to writing a code plan in this workspace. The driver does not start another worker in
that uncertain workspace or normalize its files concurrently with surviving
tools. Periodic/final synchronization, fresh legacy replay, and background
finalization remain closed; already captured checkpoint frames may replay.

Runtime persists and acknowledges the fatal error, then closes the relay without
waiting for an `end` event from the stuck worker. The existing server cleanup
stops the run's box. Later events from that worker cannot write more artifacts.
A lost ACK response after failure persistence does not reopen the failed run.
Recoverable conversational errors retain the session for another turn.

Confirmed watchdog teardown allows the batch driver to rebuild its SDK client
within the existing retry budget. Unconfirmed teardown requires replacement of
the box and rehydration from persisted artifacts. Owner cancellation remains
cancellation; cleanup failure does not turn it into a retryable task failure.
The Claude adapter also closes the exited process's pipes after SDK disconnect,
including unread output left by an aborted tool turn.

## Compatibility and scope

No external command/event schema changes. Model choice, source snapshots, staged
artifact commits, operation generations, retry budgets, and batch planning remain
with their existing owners. Successful internal output remains a step result,
not proof of a committed or published knowledge revision.

Deploy the Runtime and KBC box changes together (Runtime first is compatible).
An older Runtime can persist the error but may keep the box until its stream
ends. Existing boxes retain their original image. A manually configured local
box endpoint is not managed by Runtime's spawner and requires its operator to
replace the process/workspace after unconfirmed teardown.

The control plane owns durable task admission, recovery schedules, cancellation
and completion receipts. This driver hands execution failures back to that
existing machinery; it does not create a persistent ticket-repair queue or
promise automatic retry for operations the control plane does not yet recover.

## Verification

`test_compile_step.py` exercises fixed client identity, isolated replies,
reconstruction after a transport failure, failed results without commit,
cancellation and overlapping starts, watchdog targeting, planner completion,
connection failure, hanging interruption, and unconfirmed or hanging teardown.
Real Pi and Claude SDK tests exercise host-tool writes and cancellation through
the step driver against synthetic model servers. Runtime relay tests verify
failure persistence before ACK and stream closure, including lost ACKs and
rejection of subsequent artifacts. Existing HTTP/checkpoint and provenance tests
remain in place.
