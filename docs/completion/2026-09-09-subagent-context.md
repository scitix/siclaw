# Subagent parent-context selection

Implemented in the existing `codex/subagent-lifecycle` worktree based on Siclaw
`403395ad`; all earlier lifecycle changes are preserved.

## Result

- Added optional `fork_turns`: none by default, positive N user-message turns,
  or all active parent context. Already-compacted history remains summarized.
- Capture before dispatch yields; all map children and the reducer receive one
  snapshot. Resume rejects a new selection and uses the child's own transcript.
- Preserve known historical text, images, completed diagnostic evidence and
  summaries as native custom-message reference data. Omit private reasoning,
  system instructions, runtime controls and live coordination capabilities.
- Copy referenced complete tool artifacts into each child's existing scoped store,
  retaining access/integrity checks, redaction, quotas and TTL cleanup. Nested
  references are remapped and deduplicated; internal tickets are not copied.
- Reject unavailable evidence, graph cycles, quota failures and oversized model
  input explicitly. Do not clip context, replay tools or grant parent-directory access.
- Added design/runtime documentation and bilingual companion product documentation.
  This increment changes no control-plane runtime code, HTTP API, DB schema or Helm value.

## Validation

Targeted checks cover selection boundaries, dispatch snapshot immutability, common
map/reducer context, source user isolation, images, reasoning/control filtering,
full nested artifacts, cross-Agent/session rejection, missing evidence, quota
failure, graph cycles, native context persistence and model-window rejection.

TypeScript, build and both worktrees' whitespace checks passed. The final full suite
passed **331 files, 7086 tests, with 2 skipped** (`npm test -- --maxWorkers=2`).
The first full run passed 7084 tests and failed one A2A cancel callback's 50ms timing
assertion. That untouched transport test passed separately (28 tests); the successful
final full run limited workers to two to reduce timing contention.

No real model or production session/channel was exercised. Prepared for the
user-requested local commit; no push, deployment or PR/MR creation was performed.
Unimplemented session synchronization proposals are excluded from this change.
