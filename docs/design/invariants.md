---
title: "Architecture Invariants"
sidebarTitle: "Invariants"
description: "Constraints and contracts that every contributor and reviewer must understand."
---

# Architecture Invariants & Component Contracts

> **Purpose**: Constraints and contracts that every contributor and reviewer must understand.
> Violating these invariants causes silent bugs, security regressions, or production outages.
>
> Source of truth: this document + referenced source files.

---

## 1. Deployment Mode Isolation Contract

Siclaw runs in three modes that differ fundamentally in process and filesystem topology.

### 1.1 Mode Summary

| Aspect | TUI | Gateway + LocalSpawner | Gateway + K8sSpawner |
|--------|-----|------------------------|----------------------|
| Process | Single monolithic | Gateway + in-process AgentBoxes | Gateway Pod + one Pod per user |
| Filesystem | Shared (single user) | **ALL users share one filesystem** | Each pod has isolated filesystem |
| Database | None (file-based) | SQLite via node:sqlite (default) or MySQL | MySQL (required) |
| Auth | None (standalone) / JWT (with local Portal) | JWT | mTLS (cert per pod) + JWT |
| Skills source | Local `./skills/` (standalone) / Portal snapshot (with local Portal) | DB → `.siclaw/skills/agents/<agentId>/resolved/` | DB → pod-local emptyDir |
| MCP source | Local file (standalone) / Portal snapshot | DB → per-Agent SessionManager state | DB → pod-local config |

TUI has two sub-modes: **standalone** (no Portal in the cwd) and **Portal-paired** (a `siclaw local` Portal is running and `.siclaw/local-secrets.json` exists). The second sub-mode is described in §1.4.

### 1.2 ⚠️ Critical: LocalSpawner Filesystem Sharing

**Invariant**: In local mode (`LocalSpawner`), every AgentBox instance runs in the same Node.js process as Gateway and shares the same working directory and filesystem.

**Consequences**:
- The process-global `skillsHandler.materialize()` is **NOT safe** in local mode because it replaces a shared `resolved/` tree. LocalSpawner uses a factory-bound handler whose target is `.siclaw/skills/agents/<agentId>/`; authoritative unbind may replace only that Agent's subtree.
- LocalSpawner MCP sync writes only `sessionManager.mcpServersState`; it must never merge into process-global `settings.json`, or another Agent's tool descriptions can enter model context.
- Knowledge sync in local mode must materialize and read from an agent-scoped directory (`.siclaw/knowledge/<agentId>/`). Empty and non-empty bundles both replace their target, so pointing the canonical handler at the shared knowledge root would let one agent erase another agent's libraries.
- LocalSpawner awaits Knowledge, Skill, and MCP initial sync concurrently before accepting its first prompt. A failed MCP sync remains empty (never process-global); Knowledge/Skill may retain only that same Agent's last materialized snapshot and recover through the normal reload route. If the Agent-scoped Skill directory does not exist yet, the session starts with no bound skills and never falls back to process-shared `skills/resolved/`.
- Local SQLite (via `node:sqlite`) uses WAL mode with a shared process — local mode is single-process by design; production K8s uses MySQL and has no such constraint

**Source**: `src/gateway/agentbox/local-spawner.ts`, `src/agentbox/sync-handlers.ts`, `src/agentbox/session.ts`, `src/core/agent-factory.ts`

### 1.3 K8s Pod Isolation

**Invariant**: Each K8s AgentBox pod is fully isolated: its own emptyDir volume for skills, its own mTLS client certificate, its own process. Skills sync via `skillsHandler.materialize()` is safe here because there is no shared filesystem.

**Consequences**:
- The `global/`, `skillset/`, and `user/` skill subdirectories in a pod are managed by resource sync — wiped and rebuilt on every sync. `core/` and `extension/` are baked into the image.
- Core skills ARE baked into the Docker image (`COPY skills/core/ ./skills/core/` in Dockerfile.agentbox). They are NOT delivered via the skill bundle — see §2.1.
- Pod self-destructs after an idle window (no SSE connections, no sessions). The window is per-agent and configurable: `agents.idle_timeout_sec` (Portal → agent Basic settings, default 300s) is injected at spawn as `SICLAW_AGENTBOX_IDLE_TIMEOUT` and read into `config.server.idleTimeoutSec`. A value ≤ 0 makes the pod **resident** (never auto-destroys). **Floor: positive windows below `MIN_AGENTBOX_IDLE_SEC` (300s) are raised to 300** via `normalizeIdleTimeoutSec` — applied both at write (`agent-api`) and at consumption (`loadConfig`), so an env var, settings.json, or a legacy sub-300 DB row all resolve safely; `0` is the deliberate escape hatch and is NOT floored. (A shorter window churns pods — cold-start + JSONL session restore — on every brief pause.) Idle teardown routes through the same graceful shutdown as SIGTERM (metrics flush + debug-pod eviction), not a raw `process.exit(0)`.
- **CA-fingerprint self-heal**: each pod (and its `-cert` Secret) is stamped with a `<prefix>/ca-fp` label = a fingerprint of the CA that signed its mTLS cert. The runtime reuses a running pod ONLY if that label matches its current CA fingerprint; a mismatch (or a legacy pod with no label) means the CA rotated and the pod can no longer complete mTLS in either direction, so it is deleted and respawned with a fresh cert. This makes "runtime/agentbox cert mismatch after a CA change" self-healing instead of a stuck 403. The CA itself should still be kept stable (persisted Secret); the fingerprint check is the safety net for when it isn't. **Assumes a single, consistent CA across everything that reconciles the namespace.** Two writers holding different CAs each judge the other's freshly-spawned pods stale and recycle them → respawn thrash. A singleton runtime Deployment (`replicas: 1`, `Recreate`) does NOT establish that there is one writer, and reading it that way is what let §1.5's incident through: **several separate Runtimes share one AgentBox namespace in production**, each with its own configuration. Keeping the CA stable is what actually avoids the thrash. Even in the pathological case the behavior is strictly better than the pre-self-heal stuck 403.

**Source**: `src/gateway/agentbox/k8s-spawner.ts` (env injection, label stamp + stale recycle), `src/gateway/server.ts` (`resolveAgentSpawnEnv`), `src/gateway/agentbox/manager.ts` (`isCertFresh` reuse gate), `src/gateway/security/cert-manager.ts` (`caFingerprint`), `src/agentbox/http-server.ts` (idle timer), `src/agentbox-main.ts` (`onIdleShutdown` → graceful shutdown)

### 1.4 TUI + Local Portal: Read-Only Snapshot Contract

**Invariant**: When `siclaw` (TUI) starts in a cwd where a local Portal is reachable (`.siclaw/local-secrets.json` is present AND `http://127.0.0.1:3000/api/health` responds within the 1.5 s probe budget), Portal is the **read-only source of truth** for the session's skills, knowledge pages, credentials, agents, MCP servers, and LLM providers. The TUI is strictly an observer — it never mutates Portal state from the terminal.

**Consequences**:
- All mutations (create/edit/delete agents, skills, hosts, clusters, providers) happen in Portal Web UI. The TUI's `/setup` slash command detects Portal mode and becomes a read-only list view with "Open in Portal →" links.
- First-run setup flows redirect to Portal. When Portal is reachable and `settings.json` is missing, `src/cli-first-run.ts` prints instructions, offers an interactive Y/n "open browser now?" prompt, and exits without writing `settings.json`. This prevents per-workstation "ghost providers" that never reach Portal and silently desync between machines.
- Standalone TUI (no Portal in cwd) keeps the legacy `settings.json` flow — do not break it.

**Snapshot contract** (`src/portal/cli-snapshot-api.ts`):

```
GET /api/v1/cli-snapshot[?agent=<name>]
X-Siclaw-Cli-Snapshot-Secret: <local-secrets.cliSnapshotSecret>

Response shape (always present):
  providers       { [name]: ProviderConfig }   // LLM provider configs
  default         string | null                // Default provider name
  mcpServers      { [id]: McpServerConfig }    // MCP servers (agent-scoped when ?agent=)
  skills          CliSnapshotSkill[]           // Full specs + scripts; core skills excluded
  knowledge       CliSnapshotKnowledgeRepo[]   // Tarball payloads, base64
  credentials     { clusters[], hosts[] }      // Kubeconfigs + SSH hosts (agent-scoped when ?agent=)
  availableAgents CliSnapshotAgentMeta[]       // Always populated; powers picker UX
  activeAgent     CliSnapshotActiveAgent | null
  generatedAt     ISO 8601 timestamp
```

- `?agent=<name>` filters skills / credentials / knowledge / MCP through the `agent_*` join tables. Missing name → `404` with `{ availableAgents: string[] }` so the client can show a friendly "did you mean..." list.
- The endpoint is read-only by design. Any future write operations must go through Portal's existing `/api/v1/*` resource endpoints, never through this URL.

**Defence-in-depth gating** — three independent checks must all pass:

1. `enableCliSnapshot` must be `true` at `startPortal()` time. `cli-local.ts` passes it; `portal-main.ts` (prod K8s) does not. When `false` the route is simply not registered, so no gate beyond this matters.
2. Request origin must be loopback — `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. A rogue Ingress or a misconfigured helm override that ever flips `enableCliSnapshot` on cannot leak through a remote socket.
3. Request must carry `X-Siclaw-Cli-Snapshot-Secret` whose value matches `local-secrets.cliSnapshotSecret`. This is a **dedicated** secret — not `jwtSecret`. Reading the snapshot does NOT also grant the caller the ability to self-sign admin JWTs against every other admin-gated route. The TUI in `portal-snapshot-client.ts` reads `.siclaw/local-secrets.json` once, sends only the header, and never forges a JWT.

The trust boundary remains "whoever can read `.siclaw/local-secrets.json` in the Portal cwd", which matches single-user local mode. A missing `cliSnapshotSecret` in an older secrets file (pre-split) degrades gracefully — the client treats it as no-Portal and falls back to `settings.json`.

**Ephemeral materialization** (`src/lib/portal-{skill,knowledge,credential}-materializer.ts`):

```
.siclaw/.portal-snapshot/
├── skills/<skill-name>/              ← SKILL.md + scripts/* per skill
├── knowledge/<repo-name>/            ← tarball-unpacked files
└── credentials/
    ├── manifest.json                 ← { name, type, metadata }
    ├── <host-name>.ssh_config
    ├── <host-name>.password / .privateKey
    └── <cluster-name>.kubeconfig
```

- The directory is **ephemeral**: TUI wipes it on `SIGINT` / `SIGTERM` / normal exit.
- These materializers are **distinct from** `skillsHandler.materialize()` (§1.2). The canonical handler mutates `skills/{global,skillset,user}/` and is unsafe in LocalSpawner's shared filesystem; the Portal-snapshot materializers write only to `.siclaw/.portal-snapshot/` inside the cwd and are scoped to the TUI process. Do not consolidate the two without redesigning the skill-bundle contract.
- `agent-factory.ts` picks up these paths via new `portalSkillsDir` / `portalKnowledgeDir` / `portalCredentialsDir` opts; when set, they override `config.paths.*` so the agent's Read tool, `local_script`, and kubectl use Portal content.

**Skill filter** (`src/core/agent-factory.ts`):
For any scoped Agent (Portal or Gateway materialization), pi-coding-agent's
auto-discovered user-global skills (for example `~/.pi/agent/skills/`) are
filtered out. `skillsOverride` keeps only roots selected by the compiled Agent
harness: Portal/Gateway materialized bindings, repo-bundled operational skills
when execution is permitted, and platform authoring skills when write/preview
capabilities are permitted. QA, Coordinator, delegated read-only, and unresolved
harnesses therefore cannot inherit ambient SRE skill context. Standalone,
unscoped SRE TUI sessions retain the legacy repo/global skill fallback.

**Source**: `src/portal/cli-snapshot-api.ts`, `src/lib/portal-snapshot-client.ts`, `src/lib/portal-{skill,knowledge,credential}-materializer.ts`, `src/cli-first-run.ts`, `src/cli-main.ts`, `src/core/extensions/{ls,agent,setup}.ts`

### 1.5 ⚠️ Critical: A Shared AgentBox Namespace Has More Than One Writer

**Invariant**: A pod returned by `spawner.list()` is not necessarily this Runtime's. `list()` is scoped to the namespace and the `<prefix>/app=agentbox` label; pods carry `agent`, `boxType`, `instance`, `ca-fp` and `cert-exp` labels but **no runtime identity**, so there is nothing to filter on. Several separate Runtimes share one AgentBox namespace in production, each with its own replica counts, expected image and CA — and all three of those read a healthy sibling's box as stale. Anything that DESTROYS a box must therefore establish ownership first, and the only signal available is the control plane refusing the agent's replica lookup (`agent does not belong to this runtime`).

**Consequences**:
- `lookupReplicas` answers `undefined` for "cannot establish"; only `resolveReplicas` — the serving path — may read that as one box. A request naming the agent is itself evidence that this Runtime serves it, so **ownership gates destruction, not service.**
- `reconcilePoolSizes` checks ownership as the first statement of its loop body, ahead of crash healing, staleness marking, roll advance and shrink. Anywhere later and the destruction has already happened.
- Collapsing unknown into 1 inside the lookup destroyed another Runtime's pods in production: a healthy three-box pool read as two too many, was drained, and was removed at the drain deadline while its boxes were still reporting metrics.
- A failed lookup is **not** cached. A cached unknown would make the serving path hold a multi-replica agent at one box for the whole TTL, sending every new session to instance 0. The two costs this creates are paid separately, and neither is paid by caching the lookup: the log noise that hid the incident is bounded by rate-limiting the LINE, and the repeated RPC by a memo (`UNOWNED_MEMO_MS`) that `reconcilePoolSizes` alone reads. Anything the serving path can see must keep asking.
- A singleton Runtime Deployment (`replicas: 1`) does not make the namespace single-writer — see §1.3's CA-fingerprint bullet, which assumed it did.
- Not yet scoped: `sweepOrphans`' capability-box branch asks this Runtime's `isLive` about a sibling's live kb-compile box. Its chat-box branch removes terminal pods only, which is safe across Runtimes.
- The structural fix — stamp a runtime-identity label and filter `list()` on it — cannot be applied retroactively: pods spawned before the label exists would read as nobody's.

**Source**: `src/gateway/agentbox/manager.ts` (`lookupReplicas`, `resolveReplicas`, `reconcilePoolSizes`), `src/gateway/agentbox/k8s-spawner.ts` (`list`, `sweepOrphans`)

---

## 2. Skill Bundle Contract

### 2.1 What a Bundle Contains

**Invariant**: `buildSkillBundle()` packages **only global + skillset (dev only) + personal skills** from the database. When a workspace composer is present, each scope is filtered to the workspace selection. Core (builtin) skills are NEVER included in bundles.

```
Bundle = selected global skills (DB, published tag) + selected skillset skills (DB, dev only) + selected personal skills (DB)
Bundle ≠ core skills (baked into image/repo checkout)
```

**Source**: `src/gateway/skills/skill-bundle.ts:1-10`

### 2.2 Skill Directory Tiers

```
skills/
├── core/              ← Built-in, read-only, baked into image. Never overwritten by sync.
├── extension/         ← Builtin overlay (inner projects). Baked into image.
├── global/            ← Global skills, synced from DB. Supplements/overrides builtin.
├── skillset/{spaceId}/ ← Skill Space skills, synced from DB. Dev only.
└── user/{userId}/     ← Personal skills, synced from DB per user.
```

**Loading priority** (highest wins): `personal` > `skillset` > `global` > `builtin`

### 2.3 Skill Activation Gate

Scripts in a skill follow this workflow before execution is permitted:

```
draft → (request review) → pending → (AI + static analysis) → approved/rejected
```

- **Static analysis**: 22 `DANGER_PATTERNS` (Critical 8 / High 8 / Medium 6) in `ScriptEvaluator`
- **AI analysis**: LLM semantic review with mandatory rule — "Skills MUST be strictly read-only"
- **Human gate**: `skill_reviewer` role must approve before `published` status
- Skills with unapproved scripts **cannot** be executed via `local_script`

**Source**: `src/gateway/skills/script-evaluator.ts`

### 2.4 Skill Script Execution

- Interpreter: `bash` for `.sh`, `python3` for `.py` (detected automatically)
- Timeout: default 180s, max 300s
- Args passed as array to `spawn()` — no shell interpolation (injection-safe)
- Max output: 10 MB combined stdout+stderr
- Env injected: `SICLAW_DEBUG_IMAGE`, `KUBECONFIG`. NOT `SICLAW_CREDENTIALS_DIR` — it points at the
  credential tree and no child reads it; see the note on `SICLAW_SAFE` in `sanitize-env.ts`.

**Source**: `src/tools/shell/local-script.ts`

---

## 3. Shell Security Model

> **Full specification**: `docs/design/security.md` — read it before modifying execution tools,
> Dockerfile, or K8s manifests.

**Invariant**: AgentBox security is **defense-in-depth with 6 independent layers**. The primary
defense for credential protection is OS-level user isolation (dual-user + setgid kubectl).
Application-level command validation is a secondary defense layer.

### 3.1 OS-Level User Isolation (Primary Defense)

Child processes run as `sandbox` user (via `sudo`), which cannot read credential files.
The `kubectl` binary has setgid `kubecred` group, allowing it to read kubeconfig while other
commands cannot. See ADR-010 and `docs/design/security.md` §3 for full design.

```
agentbox user  → Main Node.js process, owns credentials
sandbox user   → All child processes, no credential access
kubectl setgid → kubecred group membership, reads kubeconfig only
```

### 3.2 The 6-Pass Validation Pipeline (Secondary Defense)

Every command through `bash`, `node_exec`, or `pod_exec` passes all 6 passes:

```
Pass 1 — Shell Operators      Block: $(), backticks, <(), >(), redirections, newlines
Pass 2 — Pipeline Extraction   Pipe-position tracking (| vs && vs ||)
Pass 3 — Binary Whitelist      Context-based: local | node | pod | nsenter | ssh
Pass 4 — Pipeline Validators   kubectl subcommand + exec checks
Pass 5 — COMMAND_RULES         Per-command: pipeOnly, noFilePaths, blockedFlags, allowedFlags
Pass 6 — Sensitive Paths       Block commands targeting credential/config file paths
```

**Source**: `src/tools/infra/command-validator.ts`, `src/tools/infra/command-sets.ts`

### 3.3 Explicitly Excluded Binaries

These are **intentionally NOT in the allowlist** despite being common:

| Command | Reason excluded |
|---------|----------------|
| `sed` | Has `-i` (in-place write), `-e`/`r`/`w` file ops, `e` command execution |
| `awk`/`gawk` | `system()`, `getline`, pipe-to-shell execution capabilities |
| `bc` | `!command` shell escape |
| `nc`/`netcat`/`ncat` | Arbitrary TCP connections, potential exfiltration |
| `wget` | File download with write, recursive crawl |
| `bash`/`sh` (direct) | Unrestricted shell — the restricted-bash tool wraps it with validation |

### 3.4 kubectl Hard Restrictions

Allowed subcommands (read-only):
```
get, describe, logs, top, events, api-resources, api-versions,
cluster-info, config, version, explain, auth
```

**All write operations are permanently blocked**: `apply`, `create`, `delete`, `patch`, `scale`, `drain`, `cordon`, `edit`, `replace`, `label`, `taint`, `rollout undo`.

`kubectl exec` is not allowed as a subcommand — use the dedicated `pod_exec` or `node_exec` tools instead.

### 3.5 Skill Script Exemption

Skill scripts (`skills/` directory) are **exempt from the binary allowlist** for `local_script`. The path is verified via `fs.realpathSync()` to block symlink traversal. This is the only way to run otherwise-blocked binaries in a controlled manner — via the skill review gate.

---

## 4. File I/O Path Restrictions

**Invariant**: Agent file tools (`read`, `edit`, `write`, `grep`, `find`, `ls`) are path-scoped. The agent cannot write to credentials, config, or system directories.

```
Read allowed:  builtin skills, dynamic skills, userDataDir, traces (.siclaw/traces/)
Write allowed: userDataDir ONLY (memory files, PROFILE.md, investigation notes)
Blocked:       credentials dir, config dir, system dirs (/etc, /var, etc.)
```

**Source**: `src/core/agent-factory.ts` — `assertPathAllowed()` wrapper on all file tools

---

## 5. Database Invariants

### 5.1 Two Separate Databases

Siclaw maintains **two independent databases** with completely different schemas and different driver stacks:

| Database | Purpose | Engine | Location |
|----------|---------|--------|----------|
| Portal DB | Users, sessions, skills, channels, tasks, MCP, chat history | **MySQL (prod) or node:sqlite (local)** via `DATABASE_URL` | Local default: `.siclaw/data/portal.db` |
| Memory DB | Embeddings, chunks, investigation records, FTS index | node:sqlite (native) | `<memoryDir>/.memory.db` |

These are never merged. Do not confuse them.

### 5.2 One DDL Two Drivers

The Portal schema is written once (`src/portal/migrate.ts`) using the MySQL + SQLite intersection of SQL syntax. Trade-offs accepted:
- Timestamps are second precision (no `TIMESTAMP(3)`)
- `updated_at` is maintained by the application layer (no `ON UPDATE CURRENT_TIMESTAMP`)
- JSON payloads stored as `TEXT` with application-level `JSON.stringify` / `safeParseJson()`
- No `ENGINE=InnoDB` / `CHARSET` / `COLLATE` clauses (MySQL server defaults apply)

Legacy MySQL production databases are preserved byte-for-byte via `CREATE TABLE IF NOT EXISTS`. Three data states coexist safely: **legacy MySQL with `JSON` + ms precision**, **new MySQL with TEXT + second precision**, **SQLite with TEXT + second precision**. All business reads of JSON columns must go through `safeParseJson()` (`src/gateway/dialect-helpers.ts`).

### 5.3 SQLite Single-Process Design

Local mode (`siclaw local`) is single-process by design. `node:sqlite` is used via `better-sqlite3`-style synchronous API with:
- `PRAGMA journal_mode = WAL` — readers don't block writers
- `PRAGMA busy_timeout = 5000` — graceful contention handling
- `AsyncMutex` around `getConnection()` — serialises transactions on the single underlying connection

Production K8s uses MySQL pools; none of the above SQLite constraints apply there.

### 5.4 Dialect differences behind helpers

Four runtime SQL dialect differences are encapsulated in `src/gateway/dialect-helpers.ts`:
1. `buildUpsert(db, ...)` — MySQL `ON DUPLICATE KEY UPDATE` vs SQLite `ON CONFLICT(...) DO UPDATE`
2. `insertIgnorePrefix(db)` — `INSERT IGNORE` vs `INSERT OR IGNORE`
3. `jsonArrayContains(db, col)` / `jsonArrayFlattenSql(db, ...)` — `JSON_CONTAINS` / `JSON_TABLE` vs `json_each`
4. `safeParseJson(value, fallback)` — defensive JSON read for the three-state problem

MySQL-specific date functions (`NOW()`, `DATE_SUB`, `CURDATE`, `INTERVAL ... DAY`) are **not** wrapped — those 9 call sites compute ISO strings in JavaScript and pass them as bound parameters. `schema-invariants.test.ts` enforces this.

---

## 6. Resource Sync Architecture

### 6.1 The Fetch → Materialize → PostReload Contract

```
fetch(client)       Pull payload from Gateway API
     ↓
materialize(payload) Write payload to local filesystem
     ↓
postReload(context)  Notify active sessions to pick up changes
```

- `fetch` is network I/O with retry (3 attempts, exponential backoff: 1s, 2s, 4s)
- `materialize` is local filesystem write — **idempotent but destructive for skills** (wipes `global/` + `skillset/` + `user/` subdirs then rebuilds)
- `postReload` calls `brain.reload()` on active sessions

### 6.2 When to Use Each Handler

| Handler | Safe in LocalSpawner? | Safe in K8s pod? | Notes |
|---------|----------------------|------------------|-------|
| process-global `mcpHandler.materialize()` | ❌ No | ✅ Yes | Writes settings; Local uses `createMcpHandler()` and per-Agent memory |
| process-global `skillsHandler.materialize()` | ❌ No | ✅ Yes | Replaces shared `resolved/`; Local uses `createSkillsHandler()` with an Agent-scoped target |
| `knowledgeHandler.materialize()` | ✅ With agent-scoped target | ✅ Yes | Replaces its whole target; LocalSpawner binds `.siclaw/knowledge/<agentId>/` |

Local resource handlers are factory-bound to one AgentBox and reused for both
initial sync and reload. Two-Agent isolation plus unbind/reload tests are part
of the contract.

---

## 7. Memory System Invariants

### 7.1 Hybrid Search Formula

```
finalScore = (vectorWeight × cosineSimilarity) + (ftsWeight × bm25Score)
```

Default weights: `vectorWeight = 0.70`, `ftsWeight = 0.30` (see `src/memory/indexer.ts:14-15`; configurable via `searchConfig`)

- Minimum score threshold: `0.35` (results below this are filtered)
- Default top-K: `10` results
- CJK queries use OR for bigrams; Latin queries use AND

### 7.2 Chunking Contract

- Chunks are split on heading boundaries (H1 > H2 > H3 hierarchy)
- Max chunk size: ~400 tokens (~1600 bytes)
- Overlap: ~80 tokens between adjacent chunks
- Each chunk tracks: file path, heading breadcrumb, start/end line

### 7.3 Embedding Dependency

Memory search (`memory_search` tool) is only available when an embedding provider is configured in `settings.json`. If no embedding is configured, the tool is not registered. Check `config.embedding` before assuming memory tools are available.

---

## 8. Deep Investigation Invariants

Post-refactor (Apr 2026): DP mode is reduced to a lightweight flag plus a
system-prompt addendum. No dedicated state machine, no parallel sub-agent
orchestration, no specialized UI cards. See
`docs/design/2026-04-24-dp-mode-refactor-design.md` for rationale and the
Phase 2 work (generic `delegate_to_agent` + permission-gated tool calls).

### 8.1 User-Owned Mode Invariant

DP is a **user-owned mode**: once the user enables it (via
`[Deep Investigation]` prefix marker, `/dp` command, Ctrl+I shortcut, or the
frontend magnifier chip) the flag stays on until the user explicitly exits
with `[DP_EXIT]`. No backend event — including any "completed" / "idle"
signal the live path might emit — may flip it off.

### 8.2 Single Source of Truth

`MutableDpStateRef.active: boolean` is the only authoritative DP state.
Persisted via a `custom: dp-mode` session entry with shape
`{active: boolean}`. Legacy shapes (`{enabled}`, `{dpStatus}`, the pre-
refactor checklist snapshot) are accepted on read for sessions persisted
under the old state machine — all normalize to `{active: boolean}`.

**Source**: `src/core/extensions/deep-investigation.ts`, `src/core/types.ts`

---

## 9. TypeScript & Build Invariants

```
Module system:  ESM only — no CommonJS, no require()
Import syntax:  Always use .js extensions: import { X } from "./x.js"
Strict mode:    TypeScript strict: true
Exports:        Named exports preferred; no default exports in barrel files
Node version:   ≥22.19.0 (required for ESM stability + node:sqlite)
Test runner:    vitest
```

**Barrel files** (`index.ts`) use re-exports (`export { X } from "./x.js"`). Do not introduce CommonJS interop shims.

---

## 10. Agent Brain

**Invariant**: The agent runtime is `@mariozechner/pi-coding-agent` (the "pi-agent" brain). It is the only brain wired into `src/core/brains/`; tools use the TypeBox `ToolDefinition` protocol and register through `src/core/tool-registry.ts`. Memory-dependent features (investigations, `memory_search`) are built against this brain's tool and context APIs.

---

## 10b. Background Jobs

Two background modes (bash command, sub-agent) share one core; see tools.md §9, sanitization.md §6b.

- **Notify exactly once**: `JobRegistry.claimNotification(jobId)` is the single-fire latch. The process-exit handler and `job_stop` race to send a completion `<task_notification>`; exactly one wins. No double-notify, no dropped notify.
- **No concurrent parent prompts**: the idle-notification path (`runSyntheticPrompt`) acquires the SAME `_promptDone`/`_promptInflight` mutex an HTTP `/prompt` uses, set synchronously before any await. An interleaving `/prompt` either started first (synthetic path degrades to `followUp`) or hits the 409 busy guard — two concurrent `brain.prompt()` is unrepresentable.
- **Model never reads unsanitized background output**: background bash output is sanitized per complete line on write (line-safe `OutputAction`s only); structural (JSON) sanitizers are rejected for background mode. The output file is created and written solely by the node main process under `userDataDir`, `O_NOFOLLOW`.
- **Session stays alive while work runs**: `_backgroundWorkCount` defers agentbox session release until all background jobs of that session finish.
- **TUI scope**: the TUI wires background **bash + node_exec + pod_exec** (one shared `spawnBackgroundBash` executor handles both the shell and kubectl-exec argv forms); only background **sub-agents** are unavailable, as they require the agentbox child-session machinery.

---

## 11. mTLS Scope

**Invariant**: mTLS is used **only between Gateway and AgentBox in K8s mode**. It is not used in LocalSpawner mode (same-machine, in-process) or TUI mode (no network).

- CA: 10-year, supplied to the Runtime as configuration (`SICLAW_CA_CERT` / `SICLAW_CA_KEY`, or their `_FILE` forms), falling back to an ephemeral CA for local dev. It is **not** renewed automatically — a 10-year window outlives any deployment, and a CA that rotated itself would invalidate every live box's certificate at a moment nobody chose.
- Client certs: issued **per AGENT, not per pod** — the certificate asserts the agent (`CN` = agentId, `O` = orgId, `serialNumber` = the agent's base pod name), so every box of an agent presents the same one and they share a single Secret. A box additionally uses it to terminate its own HTTPS, so it is both the client and the server credential.
- **No `userId` appears in a certificate.** AgentBox is user-unaware end to end; user attribution is resolved at Runtime boundaries via `sessionId`.
- Protected endpoints: `/api/internal/*` on Gateway HTTPS port (3002)

### Certificate lifetime is a liveness property, not just a security one

A leaf certificate expires, and when it does mTLS fails **in both directions** — the Runtime cannot reach the box and the box cannot reach the Runtime. So the pair (issue, replace) has to be complete, and three things must hold:

- **Re-issue is judged on the LEAF, not only on the CA.** A Secret signed by the current CA can still hold a dead certificate. Judging staleness by CA fingerprint alone meant the Secret was written once and never again.
- **Replacement means recreating the pod.** A box reads its certificate from disk at startup, so re-issuing the Secret underneath a running pod does nothing for it. Consequently a certificate must be judged due for replacement far enough ahead that a drain, a respawn and the drain budget all fit inside the remaining window.
- **A pool comes due all at once**, because every box of an agent mounts the same Secret. "Nearing expiry" must therefore roll boxes one at a time; only an already-dead or wrong-CA certificate justifies dropping a box immediately.

Missing information is never treated as expiry. An unreadable certificate, or a pod predating the expiry label, reads as fresh — the opposite reading recycles healthy boxes on sight, which has happened here before with the CA fingerprint.

**The renewal window is bounded from both sides.** It must be wide enough for a drain plus a respawn, and narrower than half the certificate lifetime — because a window at or above the lifetime makes every certificate due the moment it is signed, so each replacement is born stale and the pool churns until the drain budget stops it. That has been observed on a live cluster, not merely reasoned about. A consequence worth stating: renewal therefore **cannot be forced on demand** by widening the window, since any window that makes a fresh certificate due also makes its replacement due.

A rejected client certificate is invisible by default: Node fails the handshake inside `rejectUnauthorized` before any request handler runs, and the peer sees only `socket hang up`. The Runtime therefore logs `tlsClientError` on its internal server; without it, an expired certificate is indistinguishable from a network fault.

**Source**: `src/gateway/security/cert-manager.ts`, `src/shared/cert-validity.ts`

---

## 12. Production/Test Environment Isolation (ADR-011)

> **Status: Data model only — enforcement not yet implemented.**

The data model supports workspace-level environment isolation:
- `workspaces.envType` (`"prod"` | `"test"`) — exists in schema, default `"prod"`
- `environments.apiServer` — exists in schema, required field

**Not yet implemented**: credential scoping enforcement, environment binding constraints,
kubeconfig upload validation, investigation memory isolation.
Until enforcement lands, treat all workspaces as having full credential visibility.

→ Full target design: `docs/design/decisions.md` ADR-011
