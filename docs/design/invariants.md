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
| Auth | None | JWT | mTLS (cert per pod) + JWT |
| Skills source | Local `./skills/` | DB → shared `./skills/` | DB → pod-local emptyDir |
| MCP source | Local file | DB merge + local file | DB merge |

### 1.2 ⚠️ Critical: LocalSpawner Filesystem Sharing

**Invariant**: In local mode (`LocalSpawner`), every AgentBox instance runs in the same Node.js process as Gateway and shares the same working directory and filesystem.

**Consequences**:
- Any code that writes/deletes files in `./skills/` affects ALL users simultaneously
- `skillsHandler.materialize()` is **NOT safe** in local mode — it wipes `skills/global/`, `skills/skillset/`, and `skills/user/` subdirectories (not `core/`), which in a shared filesystem destroys ALL users' personal skills. This is designed for K8s pods with isolated filesystems.
- Per-user skill sync in local mode must write only to `skills/user/<userId>/` without touching `skills/core/` (global + personal skills from the bundle are both written into the user's directory)
- Local SQLite (via `node:sqlite`) uses WAL mode with a shared process — local mode is single-process by design; production K8s uses MySQL and has no such constraint

**Source**: `src/gateway/agentbox/local-spawner.ts`, `src/agentbox/resource-handlers.ts:82-97`

### 1.3 K8s Pod Isolation

**Invariant**: Each K8s AgentBox pod is fully isolated: its own emptyDir volume for skills, its own mTLS client certificate, its own process. Skills sync via `skillsHandler.materialize()` is safe here because there is no shared filesystem.

**Consequences**:
- The `global/`, `skillset/`, and `user/` skill subdirectories in a pod are managed by resource sync — wiped and rebuilt on every sync. `core/` and `extension/` are baked into the image.
- Core skills ARE baked into the Docker image (`COPY skills/core/ ./skills/core/` in Dockerfile.agentbox). They are NOT delivered via the skill bundle — see §2.1.
- Pod self-destructs after 5 minutes of idle (no SSE connections, no sessions)

**Source**: `src/gateway/agentbox/k8s-spawner.ts`, `src/agentbox/http-server.ts` (IDLE_TIMEOUT_MS)

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
- Env injected: `SICLAW_DEBUG_IMAGE`, `KUBECONFIG`, `SICLAW_CREDENTIALS_DIR`

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
| `mcpHandler.materialize()` | ✅ Yes | ✅ Yes | Merges, does not wipe |
| `skillsHandler.materialize()` | ❌ No | ✅ Yes | Wipes `global/` + `skillset/` + `user/` subdirs (not `core/`) |

For local mode skills sync, write directly to `skills/user/<userId>/` without delegating to `skillsHandler.materialize()`. Global and personal skills from the bundle are both placed under the user's directory.

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

### 8.1 Budget Constants

| Metric | Normal | Quick |
|--------|--------|-------|
| maxContextCalls | 15 | 10 |
| maxHypotheses | 5 | 3 |
| maxCallsPerHypothesis | 10 | 8 |
| maxTotalCalls | 75 | 40 |
| maxParallel | 3 | 3 |
| maxDurationMs | 300,000 (5 min) | 180,000 (3 min) |

**Source**: `src/tools/workflow/deep-search/types.ts`

### 8.2 Early Exit

`EARLY_EXIT_CONFIDENCE = 101` — effectively **disabled** by default (101 > 100% is unreachable). The intended threshold is 80% for "root-cause-first" mode. Do not lower this without testing that sub-agents reliably report calibrated confidence scores.

### 8.3 Sub-Agent Tool Set

Sub-agents get a **minimal tool set** — not the full agent tool inventory:
- `read`, `restricted-bash`, `node_exec` only
- No memory tools, no skill management, no scheduling
- Skills pre-loaded from `skills/core/` and `skills/extension/` as text in prompt (not via `local_script`)

---

## 9. TypeScript & Build Invariants

```
Module system:  ESM only — no CommonJS, no require()
Import syntax:  Always use .js extensions: import { X } from "./x.js"
Strict mode:    TypeScript strict: true
Exports:        Named exports preferred; no default exports in barrel files
Node version:   ≥22.12.0 (required for ESM stability + node:sqlite)
Test runner:    vitest
```

**Barrel files** (`index.ts`) use re-exports (`export { X } from "./x.js"`). Do not introduce CommonJS interop shims.

---

## 10. Agent Brain

**Invariant**: The agent runtime is `@mariozechner/pi-coding-agent` (the "pi-agent" brain). It is the only brain wired into `src/core/brains/`; tools use the TypeBox `ToolDefinition` protocol and register through `src/core/tool-registry.ts`. Memory-dependent features (investigations, `memory_search`) are built against this brain's tool and context APIs.

---

## 11. mTLS Scope

**Invariant**: mTLS is used **only between Gateway and AgentBox in K8s mode**. It is not used in LocalSpawner mode (same-machine, in-process) or TUI mode (no network).

- CA: 10-year, stored in DB (`system_config` table), auto-renewed when fewer than 30 days remain
- Client certs: issued per-pod at spawn time, short-lived
- Identity encoded in certificate CN/OU: `userId`, `workspaceId`, `boxId`
- Protected endpoints: `/api/internal/*` on Gateway HTTPS port (3002)

**Source**: `src/gateway/security/cert-manager.ts`

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
