# Remove the interactive terminal interface

Date: 2026-09-10. Local branch: `codex/remove-tui`, based on `647012a4`.
Implemented and reviewed in an isolated worktree. The validation images were
built and deployed only to a disposable test namespace.

## Result

- `siclaw` prints help; `siclaw local` provides interactive work through the Web UI.
- `siclaw --prompt "..."` retains non-interactive diagnostics. `--continue` requires
  new input, `--agent` selects a Portal agent, and `--print` stays compatible.
- Removed the TUI launcher, setup wizard, terminal resource commands, DP shortcut
  and command registration, custom terminal tool renderers, and direct terminal
  UI dependencies. Removed helpers used only by the deleted setup interface.
- Preserved Portal snapshot materialization, diagnostic execution, memory,
  output sanitization, and background-command ownership. Signals dispose the
  active session before exiting, and exit hooks clean snapshots and detached jobs.
- Updated README, installation and feature guides, contributor instructions,
  architectural invariants, and the architecture diagram. Earlier dated design
  proposals retain historical content with a pointer to ADR-020.
- Builds clear `dist/` first to keep deleted modules out of subsequent packages.

## Review findings and fixes

The follow-up review found substantive leftovers and corrected them in the same
worktree:

1. **Obsolete prompt branches.** The old binary Web/CLI template selector also
   sent terminal copy instructions to IM and scheduled tasks. Removed built-in
   terminal skill-authoring text and the unused standalone prompt builder. All
   modes now discard terminal-only blocks from persisted custom templates;
   Web blocks retain their read compatibility. The default mode matches the
   factory's Web default, and CLI receives explicit non-interactive guidance.
2. **Guidance for unavailable tools.** CLI/task prompts no longer request skill
   preview or sub-agents; Web/IM retain their supported workflows. Removed CLI
   from `spawn_subagent` registration because no CLI executor exists. Safety,
   Web progress, scheduled `task_report`, and DP activation/restoration remain.
3. **Silent agent fallback.** An explicit agent now loads its scoped snapshot
   directly. If an explicitly or automatically selected agent cannot load, the
   invocation fails before creating a session. Standalone fallback remains for
   invocations without a selected agent when Portal is unavailable.
4. **Shared snapshot directory.** Concurrent CLI invocations previously wrote
   and deleted the same resource directories. Each now owns a private
   `run-<random>` root, registers cleanup before materialization, and removes
   only that root. Empty bindings stay authoritative instead of inheriting
   standalone skills, knowledge, or credentials.
5. **Background lifecycle.** Removed the idle terminal-session wakeup path.
   Completion notifications can join only the active print turn. Shutdown
   closes the host and marks running jobs stopped before aborting, including
   pending SSH connections; late notifications and rebinding cannot revive it.
6. **Dead helpers and documentation.** Removed the remaining setup-only
   credential probe, corrected snapshot/selection documentation, and cleared
   obsolete terminal command references from current code and guidance.

## Validation

Test environment: macOS, Node.js 25.0.0, npm 11.6.2.

- Initial removal review suite: `npm test -- --maxWorkers=2 --minWorkers=1` — **331 files
  passed, 7,110 tests passed, 1 skipped**, no failures. Includes the review fixes
  and signal-disposal regression tests. Earlier prompt/CLI/snapshot/host checks
  passed 133 targeted tests. Snapshot isolation also uses real temporary
  directories and credential/skill materializers.
- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.agentbox.json`, and
  `npm run build:all` passed. Vite reported its existing large-chunk warning.
- Real executable smoke in fresh temporary workspaces passed: no-argument help,
  missing prompt/model failures, model-stub answer and continuation, provider
  failure exit status, SIGINT/SIGTERM cancellation, local SQLite bootstrap,
  Portal health, and serving the built Web UI. No production credentials or
  infrastructure were used.
- AST comparison checked 244 description/schema/execute nodes across 27 tool
  files with removed renderers: no diagnostic contract changed.
- Final dry-run package manifest (997 entries) contained no deleted TUI modules.
  The initial implementation also verified removal of a deliberately staged
  obsolete build artifact by the build cleanup.
- Architecture SVG was rendered and visually checked; local README and
  contributor documentation links and Git whitespace checks passed.

Local verification logs: `/tmp/siclaw-tui-review-{full,targeted,build,smoke,contracts}.log`.

The upstream agent SDK still carries terminal packages transitively. Siclaw
does not expose their interactive interface. Production deployment and hosted
documentation publication remain outside this change's validation scope.

## Disposable Kubernetes validation

Deployed the worktree build to the isolated `siclaw-tui-remove` namespace on
2026-09-10. Runtime, Portal, and AgentBox image digests were checked against the
built artifacts; the CLI Job used the same Runtime image. The source archive
SHA-256 was `0cdfa8f53c9bcdf09b9061a8060e2563af11a2b48562ea304132035fb46afdef`.
All model calls below used a real model. Infrastructure access used a temporary
service account restricted to read-only access in this namespace.

| Check | Result |
| --- | --- |
| Web diagnostics | `cluster_list` and `bash`/`kubectl` read the test ConfigMap and returned the exact case ID and queue depth, 17. |
| Deep Investigation | Activation, a following turn, and explicit exit all matched the server's DP state. |
| Session restoration | Verified the Web session was absent from AgentBox memory, then resumed it from persisted history and recalled both values without calling tools again. This tested session release, not a Pod restart. |
| Effective prompts | Inspected Web and channel prompts at the provider-wire stage through mTLS. Neither contained the removed terminal instructions; channel reply guidance remained present. |
| Channel mode | A separate channel-mode session returned the expected marker through mTLS and real model inference. No external IM service or group was connected. |
| Browser | Chromium login, chat history, tool results, live skill generation, and reopening a small skill's preview panel worked without page errors or failed HTTP responses. |
| Task execution | A daily schedule's manually triggered run completed, called `task_report`, and persisted the expected report. The test task was deleted. |
| Linux CLI | Node.js 22.19.0: real model response, `--continue`, and explicit-agent failure without Portal passed. |
| Concurrent CLI | Two simultaneous invocations owned distinct snapshot roots and cleaned them on normal exit. This used a synthetic local Portal transport with real model inference. |

### Existing defects found during acceptance

These failures prevented describing that deployment acceptance as clean. In
the tested image, the relevant scheduler, artifact-capture, skill tool, and
preview-card code was unchanged from baseline `647012a4`; no TUI-removal
regression was identified in the checks above. The subsequent local repairs
are recorded below and were not included in that image.

1. **Long cron intervals fire early.** An annual schedule exceeded Node's
   `setTimeout` limit of 2,147,483,647 ms (about 24.9 days). Node reduced the delay
   to 1 ms, producing repeated scheduling and extra runs. After deleting the
   task, the cached timer still retried the missing task. Restarting only the
   temporary Runtime container cleared it. Follow-up: bound long timer waits,
   recalculate before firing, and verify cancellation after task deletion.
   See [cron-scheduler.ts](../../src/cron/cron-scheduler.ts).
2. **Large skill previews disappear.** An 8,063-character structured result was
   replaced by an 8,000-character artifact-reference string. The preview card
   expects JSON and silently returns nothing when parsing fails. A smaller
   1,050-character result rendered correctly, including after history reload.
   Follow-up: preserve structured preview data for the UI while budgeting the
   model's textual context separately, and cover both live and restored views.
   See [tool-result-artifact.ts](../../src/core/tool-result-artifact.ts) and
   [SkillCard.tsx](../../portal-web/src/components/chat/SkillCard.tsx).

The standalone Portal also returned existing unknown-method warnings for
`config.getHandoffTargets` and `capability.listActiveRuns`. Those optional
handoff/recovery features were not accepted as validated by this smoke test.

### Environment limits

Worker Pod capacity prevented the standard three-Deployment topology from
starting. This test used separate MySQL, Portal, and Runtime containers in one
temporary Pod, with loopback dependency URLs and startup waits. AgentBox stayed
in a separate Pod with its own filesystem and mTLS. Native AIO was disabled only
for the temporary MySQL instance after the node returned `EAGAIN` during
initialization. No production chart or cluster settings were changed.

This verifies the deployed execution path, not full production topology,
multi-user isolation, load, HA, external IM delivery, or hosted-Portal CLI
integration. Temporary manifests, screenshots, and sanitized results are kept
locally in `/tmp/siclaw-tui-remove-deploy-20260910`; secrets are excluded from
this repository.

### Cleanup

Verified the namespace UID against the ID captured at creation, uninstalled the
Helm release, and deleted the namespace, including the CA Secret retained by
Helm's keep policy. A final API query returned `NotFound`; no PVCs existed.
Stopped the local port-forward and removed temporary credentials, browser
authentication state, configuration files, transfer helpers, the build-host
source directory, and its three temporary image tags. Published image tags
remain in the registry; no test workload remains in the cluster.

## Follow-up repairs from deployment acceptance

The user authorized fixing both existing defects in the same isolated worktree
and branch. These repairs affect scheduled tasks and Web skill previews;
removing TUI affects the interactive terminal entry point and its adapters.
They are separate behavior changes found during the same acceptance exercise.

- **Scheduling:** retain one absolute due time across bounded Node timer waits.
  A cancelled or replaced callback cannot take ownership of another timer.
  Reconciliation now removes tasks even while they are executing without a
  timer; the status precheck cancels missing/paused tasks before they can
  re-arm. Transient RPC failures continue to skip only the current execution.
- **Skill previews:** keep the complete package in `details.skillPreview` so
  live events and persisted chat metadata retain every file. The model's text
  still passes through the existing artifact-capture budget. Cards and panels
  share a validated reader with fallback for older JSON messages. An old row
  that already lost its structured payload shows an unavailable state and a
  regeneration instruction; this does not retroactively reconstruct that data.
- **Storage:** new Portal databases use `LONGTEXT` for chat metadata. An
  idempotent upgrade widens existing MySQL text columns so full previews do not
  hit the 64 KiB `TEXT` limit. Existing MySQL `JSON` columns and SQLite storage
  are preserved. On MySQL this may rebuild the message table once during the
  upgrade; migration timing on a production-sized table was not measured.
- No new dependency or core prompt change was needed.

Targeted regressions cover annual waits across multiple timer limits, an
occurrence exactly on a timer boundary, schedule replacement, cancellation
before and during execution, and deletion during reconciliation. Preview tests
exercise the real skill tool plus artifact capture, full metadata persistence
and redaction, both UI components, legacy rows, and malformed data.

A fresh `siclaw local` process with SQLite, the built Web UI, and a deterministic
local model stub passed a Chromium workflow: generate a 72,115-character
SKILL.md and a script through the real tools, open the live card, compare all
file content, copy the exact SKILL.md, reload the page, and verify the restored
panel and clipboard again. The persisted model-facing text stayed at 8,000
characters. A long schedule remained unfired throughout the check. No page
errors or failed HTTP responses occurred. Evidence is in
`/tmp/siclaw-tui-followup-browser/`, including `result.json` and screenshots.
The disposable server, database, and generated secrets were removed afterwards.

MySQL migration checks use a recording database adapter to verify one-time
widening of text columns and preservation of existing JSON/LONGTEXT columns.
SQLite checks run real migrations and the Portal append/update/read RPCs with
metadata above 64 KiB, including a repeated migration. A live MySQL migration
was not run in this follow-up.

These repairs have not been redeployed to Kubernetes. Deployment requires the
updated Runtime scheduler, AgentBox skill tool, and Portal Web assets. The
previous test namespace remains deleted; the earlier registry tags still refer
to the pre-repair build.

Final follow-up verification:

- Backend: **331 files passed; 7,130 tests passed, 1 skipped**.
- Frontend, including the final publication review: **27 files passed; 261 tests passed**.
- Both TypeScript configurations and `npm run build:all` passed; Vite retains
  its existing large-chunk warning. Git whitespace checks passed.
- An earlier full run hit a fake-timer loop in the unchanged Lark busy-reply
  test. Its isolated 263-test file and subsequent full runs passed without a
  Lark code change. The final full run above includes the metadata migration.
- Logs: `/tmp/siclaw-tui-followup-full-with-migration.log`,
  `/tmp/siclaw-tui-followup-web-full.log`,
  `/tmp/siclaw-tui-followup-migration.log`, and
  `/tmp/siclaw-tui-followup-build-final.log`.

## Publication review

The final review corrected the preview panel's nested expand/copy buttons and
disabled copying binary placeholder text. Empty text files, including legacy
scripts, remain visible and copyable. The new regression covers these cases;
the complete frontend suite and frontend build passed again. Logs:
`/tmp/siclaw-remove-tui-pr-web.log` and
`/tmp/siclaw-remove-tui-pr-web-build.log`.
