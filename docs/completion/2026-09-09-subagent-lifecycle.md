# Subagent lifecycle and target coverage implementation

Implemented on `codex/subagent-lifecycle`, based on `origin/main` at `403395ad`.
The isolated checkout is `/private/tmp/siclaw-subagent-lifecycle`; existing checkouts
and their uncommitted changes were preserved. The small control-plane UI companion
uses its own feature branch.

## Delivered

- Preserve the Agent's business addendum in map, single and reduce children; apply
  the child role separately and omit unavailable parent plan/spawn guidance.
- Shorten the spawn tool description, retain free-form assignments and optional
  batch templates/synthesis, and remove instructions that unnecessarily forbid
  independent judgment or insist that simple bulk lookups require fan-out.
- Return scoped resume handles for single and batch children. Running children
  receive native steer guidance with completion-boundary recovery; finished children
  reopen their own transcript. Independent runs have independent delegation/trace
  records. A stale cleanup cannot remove a newer continuation's mailbox.
- Store runtime-issued tickets as one protected artifact per batch, preserving
  scope, user checks, integrity, TTL and quotas. Reject foreign/forged/expired handles
  and absent transcripts. No credentials are stored in tickets.
- Read complete target inventories through the existing protected artifact loader.
  Validate source total and all unique IDs, select bounded ranges without model
  transcription, and join outcomes back to stable target IDs. Include next offsets
  and distinguish full-snapshot completion from a successful partial batch.
- Keep existing channel foreground behavior, concurrency limits, model tier
  resolution, long-output recovery, child acceptance and background delivery.
  Native pi `read` was not changed.
- Document usage in `docs/features/subagents.mdx`, and update bilingual companion
  product documentation in the companion worktree.

## Validation

- Full Siclaw suite: **330 files passed; 7072 tests passed, 2 skipped**.
- Targeted runtime/tool/prompt regression also passed before the full suite.
- `npx tsc --noEmit` and `npm run build`: passed.
- `git diff --check`: passed.
- First full-suite attempt was interrupted after the restricted sandbox rejected
  localhost listeners with `EPERM`. The complete suite passed with local listening
  permitted. No production model, cluster, channel or deployment was exercised.
- Companion UI: 176 focused rendering/state tests passed. Expanded chat/hooks
  regression: 661 passed, one existing analysis-run test failed. An untouched
  `bf9361509` archive reproduces that failure. Its 11 TypeScript diagnostics are
  byte-for-byte identical with and without these changes using the same local
  dependencies. Changed view-model/helper modules passed ESLint.

## Explicit boundaries

Follow-up review confirmed that template-free string items already support different
complete prompts in one batch. Tool descriptions now distinguish independent
assignments from repeated-target templates, state the shared role/model-tier scope,
and explain that synthesis is optional. Runtime and bilingual companion documentation
include this distinction. A regression verifies distinct prompts reach the executor
unchanged without forcing a reducer: all 23 spawn-subagent tool tests passed.
Both worktrees passed `git diff --check` after this clarification.

A handle is not a durable message queue across a process crash. Resume requires the
same parent's retained storage; ticket expiry normally follows the 24-hour artifact
policy. Parent conversation history is independent by default; optional `fork_turns`
selects active history as described in [context selection](2026-09-09-subagent-context.md). Reopened children
produce new results; older batch summaries remain historical and the parent must
integrate revisions. Exhaustive work across several bounded waves still requires
the parent to consume every `next_offset` and reconcile the union of reports. Source
count/identity checks cannot prove the source query used the correct scope.

No HTTP API, database schema or Helm value changed. Deploy the companion UI
with the runtime change so snapshot batches and guidance acknowledgements render
correctly. Prepared for the user-requested local commit; no push, PR/MR creation
or deployment was performed. Unimplemented session synchronization proposals
are excluded from this change.
