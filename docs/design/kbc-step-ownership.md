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

The watchdog disconnects the registered worker rather than the persistent client.
Execution ownership is released only after teardown succeeds. If teardown cannot
be confirmed, the step keeps ownership, new messages/commands receive a conflict,
and the session must be recreated. The driver does not start another worker in
that uncertain workspace or normalize its files concurrently with surviving
tools. Periodic/final synchronization, fresh legacy replay, and background
finalization remain closed; already captured checkpoint frames may replay.

## Compatibility and scope

No external command/event schema changes. Model choice, source snapshots, staged
artifact commits, operation generations, retry budgets, and batch planning remain
with their existing owners. Successful internal output remains a step result,
not proof of a committed or published knowledge revision.

This extraction is preparation for independent conversation. Authoring admission,
run-level watchdog bookkeeping, background finalization, and queued owner notes
still use the existing execution lifecycle. It does not enable concurrent chat
on the same `CompileRun` or remove the consumer's busy gate. Independent chat must
use a separate execution context and persisted message correlation.

## Verification

`test_compile_step.py` exercises fixed client identity, isolated replies,
reconstruction after a transport failure, failed results without commit,
cancellation and overlapping starts, watchdog targeting, planner completion,
connection failure, and unconfirmed teardown. It runs in KBC CI alongside the
real SDK adapter suites. Existing HTTP/checkpoint and provenance tests remain in
place, with explicit internal-result routing in their fixtures.
