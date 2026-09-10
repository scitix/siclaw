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

The change has not been deployed. It does not rewrite existing persisted data;
recovering an old title requires an earlier valid event in the loaded history.
