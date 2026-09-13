# Subagent review fixes — 2026-09-10

## Scope

Follow-up fixes on `codex/subagent-lifecycle`, rebased onto main `b144c9a47`.
The separate worktree and existing session design drafts are preserved. These
changes do not implement cross-runtime handoff storage or modify native read.

## Changes

- Resume opens an explicitly selected native transcript before reserving the child.
  Empty, missing, symlinked or malformed transcripts fail before model execution;
  a damaged newest file never falls back to an older session. Opening the native
  file retains its context and compaction state despite a changed working directory.
  The restored manager is passed into execution, avoiding a second fallback lookup.
  Validation now parses every JSONL row with bounded memory and rejects transcripts
  above 64 MiB, without retaining an extra full entry graph before the native load.
  The accepted file is then parsed once more by the native session manager.
- Caller guidance is persisted only when the child emits a consumed native user
  message. Exact steering and batches delivered at prompt boundaries are recognized;
  matching an incidental substring in an earlier assignment is insufficient.
  Rows use the existing `steer` kind, redaction, ordered persistence queue and the
  active delegation/parent/trace identity. Hidden completion-assessment prompts
  are excluded. Persistence failures retain the existing trace-failure handling.
- Parent-context artifact rebinding now enforces a 64 MiB aggregate byte budget in
  addition to the existing 256-ID graph limit and destination store quotas. It
  fails before copying the artifact that would cross the budget.
- Background inventory batches persist the sanitized terminal coverage receipt on
  the group event, so a refreshed UI can distinguish full coverage from a completed
  partial page. Both direct and RPC persistence paths use the same allow-list.
- The companion UI preserves later caller instructions and scopes single,
  map and reduce cards to the spawn execution, while the native child session
  itself remains continuous. Later unscoped streaming text cannot leak into an
  older execution. Paging and capped audit-snapshot notices remain available.

No new dependency, endpoint, permission bypass, Helm value or storage backend is
introduced. Native transcript format and ticket integrity, scope and TTL checks
are unchanged. Source and product documentation are updated.

## Validation

- Runtime-focused regression: **7 files, 245 tests passed** across group execution,
  target selection, native transcript restoration, inherited evidence and both
  delegation-event persistence paths.
- Full runtime suite: **369 files passed, 7486 tests passed and 1 skipped**.
  `tsc --noEmit` and the TypeScript build (`tsc`) both passed.
- Companion UI regression: **4 files, 170 tests passed** for history isolation,
  coverage folding and group rendering. The broader chat/hooks selection passed
  **59 files and 748 tests**. TypeScript reports only the existing missing `canvas`
  declaration in an untouched chart-rendering module; targeted ESLint has no errors.

Tests use local fixtures, mocked models and native pi session storage. No live
model, production channel, real user session or deployment was used.
