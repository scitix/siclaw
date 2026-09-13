# Remove the interactive terminal interface

Started: 2026-09-10. Local branch: `codex/remove-tui`, initially based on
`647012a4`. Implemented and reviewed in an isolated worktree. The latest
2026-09-12 rebase and integrated Kubernetes acceptance are recorded below;
earlier sections describe their dated builds and validation limits.

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

At this initial follow-up, the repairs had not been redeployed to Kubernetes.
Deployment requires the
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

## 2026-09-12 rebase and integrated Kubernetes acceptance

Rebased onto `main` `3df6ccad1415337e7a981242e43415c5eb498142` in the same
worktree. The tested and deployed implementation is
`d4390b8067c752878e8b5ab19de18ffe3fa4c549`; later completion-record updates
change documentation only.

Conflict resolution preserves the current script-sandbox options, shared Pi
execution session and extension binding, and Planning guidance. The retired
coordinator/peer tools remain removed. The removal decision is ADR-020, avoiding
the new sandbox ADR-019. Portal metadata starts as LONGTEXT without a redundant
intermediate alteration. The rebase adds no new production dependency.

### Automated verification

- Backend: **364 files passed; 7,433 tests passed, 1 skipped**.
- Frontend: **34 files passed; 288 tests passed**.
- Both TypeScript configurations, backend build, and Portal Web build passed.
- Executable smoke passed help/input/provider errors, model-stub prompt and
  continuation, provider-failure exit status, SIGINT 130 / SIGTERM 143, and
  fresh local SQLite/Portal/Web startup.
- A real MySQL server passed the complete Portal migration on a fresh database
  and on rerun. TINYTEXT, TEXT and MEDIUMTEXT widened; existing LONGTEXT/JSON,
  old values and NULL were preserved. Each old-column case round-tripped an
  18 MiB payload. This supersedes the earlier recording-adapter-only limit.
- All five GitHub checks on the implementation commit passed: Test, Portal
  Web Test, Type Check, AgentBox Build Graph, and KBC Box Test.

### Deployed verification

Built fresh Runtime and AgentBox images plus the integrated host platform's
API/Web consumers, then deployed them by immutable digest to an existing test
namespace. Runtime, host API/Web and AgentBox ran in separate Pods. The existing
script-sandbox runner/configuration was retained. No production namespace was
deployed. This run includes the scheduler and full-preview repairs missing
from the September 10 image.

| Check | Result |
| --- | --- |
| Web and effective prompt | Real model conversation and `cluster_list` worked for an agent with no bound infrastructure; the inspected Web prompt had no TUI/setup/terminal-only guidance. No real cluster diagnostics were claimed for this unbound agent. |
| Full skill preview | Real login, model, skill tools, SSE, API, MySQL and deployed Web UI completed the live preview and history path. The model edited SKILL.md; a 106,301-character reference and other package fixtures were pre-seeded by the test. All five files survived. |
| Storage and copy | Metadata contained 121,061 characters while model-facing text remained at 8,000. API history matched the MySQL row exactly. Text/script/reference copies matched exactly; empty text was copyable and binary content had no copy button. Reloaded history retained the complete package. |
| Browser quality | Screenshots were visually checked. Final login/history/copy/reload verification had no page errors or failed HTTP responses. An initial CSS retry problem came from the temporary HTTPS test proxy and disappeared after replacing that proxy; application code was unchanged. |
| Deep Investigation | Entered DP, released the session from AgentBox memory, resumed with DP still active, then explicitly exited to inactive. This was session release/restoration, not a Pod restart test. |
| Cancellation | Aborted after actual model output began, then obtained the exact expected response in the same session. |
| Scheduled tasks | The annual task never fired early. A manual run persisted its exact `task_report`. A minute timer fired once; deleting it during the run did not re-arm it during more than 15 minutes of subsequent checks. |
| Channel mode | Real model response and prompt inspection passed through internal mTLS. No external IM service received a message. |
| Linux CLI | Real model `--prompt` and `--continue` passed using the Runtime image, which includes the CLI. The intentionally smaller AgentBox image does not package that entry point. |

### Known limitation found during CLI acceptance

Standalone CLI credential discovery is **not accepted**: after registering a
temporary kubeconfig, `cluster_list` returned `Credential broker not initialized
for this session`. The CLI currently supplies only `credentialsDir` to the
factory. Source comparison confirms that this wiring and the tool's broker
requirement already exist on the rebased main; removing terminal renderers does
not change that execution branch. Server AgentBox initializes its broker and
passed the deployed discovery check.

This independent credential integration issue remains open. A follow-up should
connect scoped local/snapshot credentials to the broker, preserve per-invocation
cleanup and empty-snapshot authority, and verify cluster/host tools with real
read-only credentials. The CLI model smoke does not establish working CLI
infrastructure diagnostics. No credential-broker implementation was changed in
this rebase.

### Cleanup and remaining boundaries

Removed the dedicated acceptance agent, its sessions/tasks/runs, temporary
ServiceAccount/Role/RoleBinding/ConfigMap, and both disposable MySQL databases.
Kept the existing test namespace and newly deployed services. Final deployment
generations, replica readiness and API/Web health checks passed; only the three
intended service Deployments changed from the pre-deployment snapshot.

The host platform's 4,533 pre-existing chat rows retained identical content and
metadata hashes across its metadata migration. Its test database used a 64 MiB
packet limit. Production-scale ALTER duration, the maximum escaped preview
payload, HA/load, external IM delivery and CLI cluster/host access remain outside
the passed checks. Test success does not establish zero production rollout
impact: shared prompt behavior, scheduling and metadata storage are part of this
branch. No production rollout or merge was performed.


## Review follow-up: bounded preview history (2026-09-12)

Full packages no longer travel with every chat history page. Portal REST,
internal REST and chat RPC project previews to small availability summaries in
SQL; the panel requests one message with `message_id` through the same session
authorization gate. The full detail path also bounds oversized legacy records.
Ordinary non-preview metadata and legacy text-only previews remain compatible.

Preview metadata has a 1 MiB serialized UTF-8 budget, including JSON escaping
and duplicate compatibility projections. The shared persistence helper checks
before synchronous redaction and again after redaction. Database writers also
account for the actual MySQL packet, other column values, SQL escaping and
statement overhead. Oversized payloads become explicit omission markers and
small timeline metadata. Explicit packet rejections get one summary retry;
uncertain append outcomes (timeouts/disconnects) are not retried. The panel
explains omissions, allows failed reads to be retried, and ignores stale loads.
CLAUDE.md now consistently describes invocation-owned snapshot cleanup.

Validation before the final base refresh:

- Backend: 365 files, 7,439 passed, one existing skip; TypeScript/build passed.
- Portal Web: 35 files, 289 passed; TypeScript and production build passed.
- Real disposable MySQL 8 with a **4 MiB** packet: a 140,082-byte preview
  round-tripped completely while its history response was 192 bytes; a
  2,400,070-byte escaped preview returned an explicit omission marker. Legacy
  JSON-column projection passed as well as LONGTEXT writes. SQLite tests cover
  RPC round trips, old oversized rows, session scoping and metadata preservation.
- Browser component tests exercise lazy load, exact copying, omission, retry and
  stale-request cancellation. This follow-up has not been deployed as a service
  or rerun through a live model; earlier deployment evidence above describes
  the preceding implementation.

Final base refresh: rebased onto `main` `fa8f51e4`. The 650 related backend
checks and the TypeScript build passed after rebase. No runtime implementation
changed during that rebase. The disposable MySQL namespace and local forwarding
process were removed; the temporary password was deleted. Existing test
services were not redeployed by this follow-up.

Upgrade the Web assets before the history API and Runtime. New Web understands
old full responses; already-open old clients must reload to understand the new
availability markers.

Final compatibility check: single-message detail preserves legacy JSON text up
to the same byte budget, so malformed structured metadata can still fall back.
Oversized detail text is suppressed. The 259 affected Portal checks and backend
build passed after this adjustment.

### Remaining boundary: tool budget and storage budget

The tool now checks the shared 1 MiB serialized UTF-8 ceiling before returning
its result to the model or capturing an output artifact. This prevents previews
above that ceiling from claiming they can be viewed or copied. It does **not**
make tool acceptance a guarantee that the host will persist the package.

For MySQL, `preparePreviewWrite` uses this per-message limit, in bytes:

```text
max(1024, min(1048576, floor(max_allowed_packet / 2) - otherBytes - 32768))
otherBytes = utf8Bytes(content) + utf8Bytes(tool_input)
```

With a 1 MiB packet and small content/input, a 600 KiB preview can pass the tool
check and still be omitted by the writer. With a 4 MiB packet and the same small
columns, the shared 1 MiB ceiling is the tighter limit. The earlier 4 MiB
database acceptance did not exercise the first case. The 1/4 MiB packet unit
cases in `src/portal/skill-preview-storage.test.ts` cover both writer outcomes;
they do not establish live-model agreement under the smaller packet limit.

On a late omission, the writer replaces the history metadata and content with
an omission notice, but it cannot retract a success summary already delivered
to the model in the current turn. Metadata added downstream and expansion
during redaction can also cause a late omission. These remain known limits of
the model/panel consistency fix.

Closing the capacity gap requires the host to derive a conservative effective
preview budget and pass it through Runtime configuration to AgentBox, reserving
space for the other columns, envelope metadata and escaping. AgentBox must not
import the database layer to discover that budget. The host still needs its
write-time guard for capacity changes and unexpected expansion. This budget
propagation is follow-up work, not implemented by the shared-ceiling check.
