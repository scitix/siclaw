# Subagent review fixes — 2026-09-10

## Scope

Follow-up fixes on `codex/subagent-lifecycle`, rebased onto main `6aadac65`.
The separate worktree and existing session design drafts are preserved. These
changes do not implement cross-runtime handoff storage or modify native read.

## Changes

- Resume opens an explicitly selected native transcript before reserving the child.
  Empty, missing, symlinked or malformed transcripts fail before model execution;
  a damaged newest file never falls back to an older session. Opening the native
  file retains its context and compaction state despite a changed working directory.
  The restored manager is passed into execution, avoiding a second fallback lookup.
- Caller guidance is persisted only when the child emits a consumed native user
  message. Exact steering and batches delivered at prompt boundaries are recognized;
  matching an incidental substring in an earlier assignment is insufficient.
  Rows use the existing `steer` kind, redaction, ordered persistence queue and the
  active delegation/parent/trace identity. Hidden completion-assessment prompts
  are excluded. Persistence failures retain the existing trace-failure handling.
- The SiCore companion preserves later caller instructions and scopes single,
  map and reduce cards to the spawn execution, while the native child session
  itself remains continuous. Later unscoped streaming text cannot leak into an
  older execution. Paging and capped audit-snapshot notices remain available.

No new dependency, endpoint, permission bypass, Helm value or storage backend is
introduced. Native transcript format and ticket integrity, scope and TTL checks
are unchanged. Source and product documentation are updated.

## Validation

- Runtime-focused regression: 119 tests pass across session, lifecycle and real
  native-transcript restoration. Includes consumed live guidance, guidance during
  assessment, hidden internal prompts, invalid-resume rejection before inference,
  changed-cwd recovery, compaction, damaged tails and legacy-file fallback rejection.
- Full runtime suite: 332 test files passed, 7108 tests passed and 2 skipped.
  The restricted run stopped making progress; its own processes were terminated
  and the full suite completed with permission for local HTTP/WebSocket listeners.
  `tsc --noEmit` and the TypeScript build (`tsc`) both passed.
  Log: `/private/tmp/subagent-fix-runtime-full-permitted.log`.
- SiCore regression: 87 tests pass across child history, interactions, group
  rendering, tool identity and child discovery. The broader chat/hooks selection
  has 653 passing tests and one pre-existing analysis-run test failure, reproduced
  in the pre-fix archive. Its 11 TypeScript diagnostics match that archive exactly.

Tests use local fixtures, mocked models and native pi session storage. No live
model, production channel, real user session or deployment was used.
