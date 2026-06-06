# Siclaw — Operating Manual for Claude

> Auto-loaded at session start. Keep concise — deep reference lives in `docs/design/`.

---

## What This Project Is

**Siclaw** is an AI-powered SRE copilot that runs Kubernetes diagnostics via natural language.

**Three runtime modes share one agent core:**
```
TUI (single-user terminal; may pair with a local Portal sidecar — see §1.4)
Gateway + LocalSpawner (multi-user, local dev — all users share one process + filesystem)
Gateway + K8sSpawner  (production — one isolated pod per user)
```

---

## Critical Architecture Invariants

> Full spec: `docs/design/invariants.md`

### 🔴 Local Mode: Shared Filesystem

`LocalSpawner` runs ALL AgentBox instances **in-process**, sharing one filesystem.
- `skillsHandler.materialize()` **must NOT be called in local mode** — wipes all users' skills
- Local skills sync writes only to `skills/user/{userId}/` scoped paths

### 🔴 Skill Bundle Contract

`buildSkillBundle()` packages **only global + skillset (dev only) + personal skills** selected for the current workspace. Core skills are baked into the Docker image. `materialize()` does NOT restore core skills.

### 🔴 TUI + Local Portal: Read-Only Snapshot Contract

When `siclaw` (TUI) starts in a cwd that has a reachable local Portal (`.siclaw/local-secrets.json` present AND `/api/health` responds), Portal becomes the **read-only source of truth** for skills, knowledge, credentials, agents, MCP servers, and LLM providers. Do not add code paths that let the TUI write back to Portal — writes belong in Portal Web UI. The existing `/setup` slash command detects Portal mode and switches to read-only + "Open in Portal →" behaviour; preserve that symmetry in any new command that would mutate configuration.

- Snapshot contract: `GET /api/v1/cli-snapshot?agent=<name>` — see `src/portal/cli-snapshot-api.ts`. Agent-scoped joins via `agent_skills`, `agent_hosts`, `agent_clusters`, `agent_mcp_servers`, `agent_knowledge_repos`.
- Materialization: payload unpacked to `.siclaw/.portal-snapshot/{skills,knowledge,credentials}/`. SIGINT/SIGTERM wipe the dir. These materializers (`src/lib/portal-*-materializer.ts`) are **NOT** the same as `skillsHandler.materialize()` (§1.2) — different code path, scoped ephemeral output, safe in TUI cwd.
- First-run wizard: when Portal is reachable, `src/cli-first-run.ts` redirects user to Portal Web UI for provider setup and exits without writing `settings.json`. This prevents "ghost providers" that desync across workstations.
- Standalone TUI (no Portal): legacy `settings.json` flow unchanged. Do not break that path.

### 🔴 Shell Security: Defense-in-Depth

> Full spec: `docs/design/security.md`; output sanitization: `docs/design/sanitization.md`

Primary defense: **OS-level user isolation** — child processes run as `sandbox` user; `kubectl` has setgid `kubecred` (ADR-010). Secondary: **whitelist-only command validation** (`src/tools/infra/command-sets.ts`). `sed`, `awk`, `nc`, `wget` intentionally excluded. kubectl read-only (13 safe subcommands).

### 🔴 Two Separate Databases

| Database | Engine | Purpose |
|----------|--------|---------|
| Portal/Gateway DB | **MySQL (prod) / node:sqlite (local)** via `DATABASE_URL` scheme | Users, sessions, skills, MCP config, chat history. One unified DDL in `src/portal/migrate.ts`; driver chosen by `src/gateway/db.ts` factory. |
| Memory DB | node:sqlite | Embeddings, chunks, investigations. pi-agent only. Separate file from Portal DB. |

Local mode (`siclaw local`) auto-creates SQLite at `.siclaw/data/portal.db` unless `DATABASE_URL` is overridden. Production K8s uses MySQL via `DATABASE_URL=mysql://...`.

### 🟡 mTLS Scope

mTLS is **K8s mode only**. Do not add mTLS dependencies to local mode code paths.

---

## Change Impact Matrix

> Before modifying any file, find it here. Read the required docs and verify cross-cutting concerns **before writing code**.

| If you change... | Must read | Must verify | Cross-cutting concerns |
|---|---|---|---|
| `src/tools/infra/command-sets.ts` | security.md §4, tools.md §6 | `npm test` | Skill scripts still work; sanitization rules still align |
| `src/tools/infra/output-sanitizer.ts` | sanitization.md, tools.md §6.2 | `npm test` | Pipeline fallback in restricted-bash; any tool that emits captured command output |
| `src/tools/infra/command-validator.ts` | security.md §4, tools.md §6.2 | `npm test` | All tools calling `validateCommand()` |
| `src/tools/cmd-exec/restricted-bash.ts` | security.md, tools.md §5, sanitization.md | `npm test` | kubectl validation; skill bypass (`isSkillScript`); 3-layer sanitization |
| `src/tools/cmd-exec/*.ts` | tools.md §3 | `npm test` | Security pipeline via `preExecSecurity` / `postExecSecurity` |
| `src/tools/script-exec/*.ts` | tools.md §4, skills.md | `npm test` | Script transmission; skill resolution |
| `src/tools/infra/ssh-dial.ts` | ssh-jump-host.md | `npm test` (`ssh-dial.test.ts`) | Broker-free; shared by `ssh-client.ts` (broker path) AND Portal `host-api.ts` `/test`. ProxyJump `forwardOut`+`sock` chaining; reverse teardown; shared TOFU verifier. Keep it broker-free (ssh2 + node only) — no Portal-layer inversion |
| `src/tools/infra/ssh-client.ts` | ssh-jump-host.md | `npm test` (`ssh-client.test.ts`) | `acquireSshTarget` recurses on `HostMeta.jump_host` (depth ≤3, cycle guard); single-hop behavior unchanged; reads materialized key/password/passphrase files into inline `DialHop`s |
| `src/portal/adapter.ts` (host credential.get/list, both HTTP + WS mirrors) | ssh-jump-host.md, invariants.md §1.4 | `npm test` (`adapter*.test.ts`) | Resolve `jump_host_id`→name at the boundary (neutral wire ref); transitive jump authorization (`isJumpOfBoundHost`) — binding a target grants transit through its bastion chain; keep the two mirrors in sync via `buildHostSshCredential` / `isJumpOfBoundHost` |
| `src/tools/infra/security-pipeline.ts` | tools.md §8.2, security.md | `npm test` | Facade for all cmd-exec tools; changes affect all 3 tools |
| `src/gateway/skills/` | skills.md, invariants.md §1-2 | `npm test` | Bundle contract; `materialize()` NOT safe in local mode |
| `src/portal/migrate.ts` | invariants.md §5 | `npm test` (runs `migrate-sqlite.test.ts` + `schema-invariants.test.ts`) | Single DDL must stay MySQL + SQLite compatible; index names must match legacy; no `TIMESTAMP(3)` / `ON UPDATE` / `JSON` columns |
| `src/gateway/db.ts`, `db-mysql.ts`, `db-sqlite.ts` | invariants.md §5 | `npm test` — db.test.ts covers both drivers | DML return shape must match mysql2 (`[OkPacket, undefined]`); SQLite transactions serialised by mutex |
| `src/gateway/dialect-helpers.ts` | invariants.md §5 | `dialect-helpers.test.ts` | All 4 dialect differences (upsert, INSERT IGNORE, JSON ops, `safeParseJson`) flow through here; every caller chooses via `db.driver` |
| `src/lib/bootstrap-portal.ts`, `bootstrap-runtime.ts`, `src/cli-local.ts` | invariants.md §1 | manual `siclaw local` smoke test | Portal must `waitForListen` before Runtime boots; secrets persist in `.siclaw/local-secrets.json` |
| `src/portal/cli-snapshot-api.ts` | invariants.md §1.4 | `npm test` — `cli-snapshot-api.test.ts` | Three auth gates in order: `enableCliSnapshot` flag, loopback-origin check, dedicated `cliSnapshotSecret` header (not `jwtSecret`); endpoint MUST stay read-only |
| `src/lib/portal-snapshot-client.ts` | invariants.md §1.4 | `npm test` — `portal-snapshot-client.test.ts` | Cwd-scoped `.siclaw/local-secrets.json` read; sends `X-Siclaw-Cli-Snapshot-Secret` header (never `Authorization: Bearer`); silent fallback on 401 / 403 / missing secret (do not crash the TUI) |
| `src/lib/portal-skill-materializer.ts`, `portal-knowledge-materializer.ts`, `portal-credential-materializer.ts` | invariants.md §1.4, skills.md "Skill Discovery by Agent" | `npm test` — each has a `.test.ts` | Ephemeral write to `.siclaw/.portal-snapshot/*/`; cleanup on SIGINT/SIGTERM; **distinct from** `skillsHandler.materialize()` — do not merge the two |
| `src/cli-first-run.ts` | invariants.md §1.4 | manual smoke: `siclaw` in a cwd with Portal vs without | Portal-reachable branch bypasses `settings.json` write; preserve the interactive Y/n confirm, browser-launch, and opener-failure fallback path |
| `src/cli-agents.ts` | invariants.md §1.4 | manual smoke: `siclaw agents` with/without Portal | Non-interactive agent lister; must exit non-zero + friendly stderr when Portal unreachable |
| `src/core/extensions/ls.ts`, `agent.ts`, `setup.ts` | invariants.md §1.4 | manual smoke: `/ls`, `/ls skills`, `/agent`, `/setup` | TUI slash commands are **read-only observers** of the Portal snapshot; any new mutation path must route to Portal Web UI, not local state |
| `src/core/agent-factory.ts` | tools.md §7, guards.md §4, invariants.md §10 | `npm test` | Tool registration; guard pipeline installation; brain type compatibility; `portalSkillsDir` / `portalKnowledgeDir` / `portalCredentialsDir` opts override `config.paths.*` when a Portal snapshot is active |
| `src/core/guard-pipeline.ts` | guards.md | `npm test` | Guard registry, pipeline installation; all guard stages affected |
| `src/core/guard-log.ts` | guards.md §7 | `npm test` | Structured logging for all guards |
| `src/core/session-tool-result-guard.ts` | guards.md §5 | `npm test` | Persist guard; session history write validation |
| `src/core/tool-result-context-guard.ts` | guards.md §5 | `npm test` | Context guard; context budget enforcement |
| `src/core/stream-wrappers.ts` | guards.md §5 | `npm test` | Output guards; stream event repair |
| `src/core/tool-call-repair.ts` | guards.md §5 | `npm test` | Input guard; malformed tool call sanitization |
| `src/core/prompt.ts` | **⚠️ REQUIRES HUMAN APPROVAL** | — | Describe intent and wait for OK before editing |
| `src/memory/` | invariants.md §7, decisions.md ADR-005 | `npm test` | Requires embedding config; pi-agent only |
| `Dockerfile.agentbox` | security.md §3-5 | `docker build` | Dual-user model; capability set; setgid kubectl |
| `k8s/` or `helm/` | security.md §5, invariants.md §11 | `helm template` | mTLS K8s-only; container hardening |
| `src/agentbox/resource-handlers.ts` | invariants.md §1,6 | `npm test` | `materialize()` safe in K8s, destructive in local mode |
| `src/core/job-registry.ts` | tools.md §9 | `npm test` (`job-registry.test.ts`) | `claimNotification` is the single-fire dedup; a completion notice fires exactly once across the process-exit vs `job_stop` race |
| `src/core/background-bash-runner.ts`, `src/tools/cmd-exec/disk-output.ts` | tools.md §9, sanitization.md §6b | `npm test` (`background-bash-runner.test.ts`) | Sanitize-on-write per LINE (line-safe actions only); output file under `userDataDir`, `O_NOFOLLOW`, written only by node main process; model never reads unsanitized output |
| `src/tools/cmd-exec/restricted-bash.ts` (`run_in_background`) | tools.md §5/§9, sanitization.md §6b | `npm test` | Reject background for non-line-safe (JSON) sanitizers; foreground path unchanged when param/executor absent |
| `src/tools/infra/output-sanitizer.ts` (`OutputAction.lineSafe`) | sanitization.md §6b | `npm test` | Every `OutputAction` MUST set `lineSafe`; structural (JSON) sanitizers are `false` |
| `src/agentbox/session.ts` (`notifyParent`/`runSyntheticPrompt`/`JobRegistry`) | tools.md §9.2 | `npm test` (`notify-parent.test.ts`) | Synthetic prompt acquires the SAME `_promptDone`/`_promptInflight` mutex `/prompt` uses, synchronously — no two concurrent `brain.prompt()`; `_backgroundWorkCount` defers release; after persists settle it emits `background_turn_done` so an idle WebUI refetches (keep the trigger AFTER `Promise.allSettled(pendingPersists)`) |
| `src/portal/chat-gateway.ts` (persistent session SSE) + `portal-web/src/hooks/usePilotChat.ts` (EventSource) | tools.md §9.2 | `npm test` (`chat-gateway-events.test.ts`); portal-web `vitest run` | `GET …/chat/sessions/:sessionId/events` is read-only, query-token auth, MUST NOT close on `prompt_done`; frontend renders the synthetic turn body from a DB **refetch** on `background_turn_done` (NOT from live events — `message_update` deltas aren't emitted on this channel); raw `<task_notification>` bubble hidden via `metadata.kind` in `toPilotMessage` |
| `src/core/tui-background-host.ts`, `src/cli-main.ts` | tools.md §9.2 | `npm test` (`tui-background-host.test.ts`) | Idle → `sendCustomMessage(triggerTurn)`; streaming → `followUp`; `sessionRef` updated on every session swap |
| `src/core/subagent-registry.ts` (`RUN_IN_BACKGROUND_ENABLED`/`BACKGROUND_BASH_ENABLED`) | tools.md §9 | `npm test` | Two independent master switches; flipping off hides the params/tools |
| `src/core/background-bash-runner.ts` (argv mode) | tools.md §9.4 | `npm test` | Generic background exec: `command` (shell, bash) OR `file`+`args` (argv, node/pod); `onComplete` fires once in settle (node_exec unpins debug pod) |
| `src/tools/cmd-exec/node-exec.ts` / `pod-exec.ts` (`run_in_background`) | tools.md §9.4, security.md | `npm test` | node_exec: ensure+PIN debug pod, `timeout`-wrap the host command (leak guard), 600s ceiling; pod_exec: no pin; both reject non-line-safe action; pass full `refs` |
| `src/tools/infra/debug-pod.ts` (refcount/pin + `ensureDebugPodReady`) | tools.md §9.4 | `npm test` (`debug-pod.test.ts`) | `acquire`/`release` refcount; `evict()` skips+re-arms while pinned; `ensureDebugPodReady` extracted from `runInDebugPod` — foreground path must stay identical |

---

## Development Protocol

**Before modifying code**: find the files in the Change Impact Matrix above, read the required docs, and note cross-cutting concerns. After changes: run `npm test`, update docs if behavior changed. If something broke that the matrix didn't predict, add a new row or cross-cutting concern entry — every surprise improves the harness.

**Documentation rule**: Design docs record **contracts and rationale** (what must hold, why it was decided), not implementation steps (which functions are called in which order). Implementation details belong in code comments. This keeps docs stable across refactors — a renamed function shouldn't require a doc update, but a changed security contract must.

---

## Tech Stack

```
Runtime:    Node.js ≥22.12.0  (ESM-only)     Tests:      vitest (npm test)
Language:   TypeScript 5.9    (strict, .js)   Type check: npx tsc --noEmit
Frontend:   React + Vite + Tailwind           Agent:      pi-coding-agent
DB (GW):    mysql2 / node:sqlite (raw SQL)    DB (mem):   node:sqlite + FTS5 + sqlite-vec
```

**Conventions**: ESM-only, named exports, no default exports. `CONTRIBUTING.md` for PR format. `gh` CLI for PR comments.
