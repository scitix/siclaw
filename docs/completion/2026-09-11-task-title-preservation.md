# Preserve task names across status updates

A status-only `task_update` can contain an empty `subject` placeholder. The ledger
previously persisted that value as a rename, leaving both completed and active
plan rows without text.

The ledger now ignores blank title updates while accepting nonblank renames.
Batch and single-item tool schemas document the same behavior. Runtime history
recovery and Portal replay retain the last known title for the same task without
crossing delete/reset boundaries or modifying source events. The Portal displays
`Task #ID` if no title is available in loaded history.

Validation:

- Regression tests failed before the fix for ledger mutation, tool snapshots,
  and history recovery.
- 60 tests across the ledger, task tools, history recovery, task events and task
  coordinator pass.
- Portal plan tests: 3 files / 17 tests pass.
- Runtime TypeScript build and Portal production build pass.
- `git diff --check` passes; no production dependencies were added.

The production Runtime and Portal images built from `9735b22b` were also tested in
an isolated Kubernetes namespace. Executing the compiled task tools inside the
Runtime container preserved titles for single empty-title and batched whitespace
updates, including the emitted snapshots. Historical damaged events were written
through the Portal Runtime RPC into a temporary database. The production Portal
displayed the original completed, active and pending task names before and after
a browser reload.

The temporary namespace and port forwards were removed after acceptance. This
was a tool and persisted-history integration test using synthetic events, not a
live model evaluation. No existing deployment or persisted conversation was
modified. Recovering an old title still requires an earlier valid event in the
loaded history.
