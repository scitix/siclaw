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
| Database | SQLite only | SQLite (default) or MySQL | MySQL (required) |
| Auth | None | JWT | mTLS (cert per pod) + JWT |
| Skills source | Local `./skills/` | DB → shared `./skills/` | DB → pod-local emptyDir |
| MCP source | Local file | DB merge + local file | DB merge |

### 1.2 ⚠️ Critical: LocalSpawner Filesystem Sharing

**Invariant**: In local mode (`LocalSpawner`), every AgentBox instance runs in the same Node.js process as Gateway and shares the same working directory and filesystem.

**Consequences**:
- Any code that writes/deletes files in `./skills/` affects ALL users simultaneously
- `skillsHandler.materialize()` is **NOT safe** in local mode — it wipes `skillsDir` before writing. This is designed for K8s pods with isolated filesystems
- Per-user skill sync in local mode must write only to scoped subdirectories (`skills/team/` and `skills/user/<userId>/`) without touching `skills/core/`
- The sql.js SQLite lockfile prevents multi-process access; local mode is single-process by design

**Source**: `src/gateway/agentbox/local-spawner.ts`, `src/agentbox/resource-handlers.ts:90-129`

### 1.3 K8s Pod Isolation

**Invariant**: Each K8s AgentBox pod is fully isolated: its own emptyDir volume for skills, its own mTLS client certificate, its own process. Skills sync via `skillsHandler.materialize()` is safe here because there is no shared filesystem.

**Consequences**:
- The skills directory in a pod is fully managed by resource sync — it is wiped and rebuilt on every sync
- Core skills are NOT in the pod's initial image; they arrive via the skill bundle
- Pod self-destructs after 5 minutes of idle (no SSE connections, no sessions)

**Source**: `src/gateway/agentbox/k8s-spawner.ts`, `src/agentbox/http-server.ts` (IDLE_TIMEOUT_MS)

---

## 2. Skill Bundle Contract

### 2.1 What a Bundle Contains

**Invariant**: `buildSkillBundle()` packages **only team + personal skills** from the database. Core (builtin) skills are NEVER included in bundles.

```
Bundle = team skills (DB, published tag) + personal skills (DB, approved status)
Bundle ≠ core skills (baked into image/repo checkout)
```

**Source**: `src/gateway/skills/skill-bundle.ts:1-10` — explicit comment: "Only includes team + personal skills — builtin skills are baked into the AgentBox Docker image."

### 2.2 Skill Directory Tiers

```
skills/
├── core/          ← Built-in, read-only, baked into image. Never overwritten by sync.
├── team/          ← Admin-managed via WebUI, synced from DB
├── user/{userId}/ ← Personal skills, synced from DB per user
└── extension/     ← Optional overlay builds
```

**Loading priority** (highest wins): `user/<userId>` > `team` > `core`

### 2.3 Skill Activation Gate

Scripts in a skill follow this workflow before execution is permitted:

```
draft → (request review) → pending → (AI + static analysis) → approved/rejected
```

- **Static analysis**: 27 `DANGER_PATTERNS` (Critical/High/Medium severity) in `ScriptEvaluator`
- **AI analysis**: LLM semantic review with mandatory rule — "Skills MUST be strictly read-only"
- **Human gate**: `skill_reviewer` role must approve before `published` status
- Skills with unapproved scripts **cannot** be executed via `run_skill`

**Source**: `src/gateway/skills/script-evaluator.ts`

### 2.4 Skill Script Execution

- Interpreter: `bash` for `.sh`, `python3` for `.py` (detected automatically)
- Timeout: default 180s, max 300s
- Args passed as array to `spawn()` — no shell interpolation (injection-safe)
- Max output: 10 MB combined stdout+stderr
- Env injected: `SICLAW_DEBUG_IMAGE`, `KUBECONFIG`, `SICLAW_CREDENTIALS_DIR`

**Source**: `src/tools/run-skill.ts`

---

## 3. Shell Security Model

> **Full specification**: `docs/design/security.md` — read it before modifying execution tools,
> Dockerfile, or K8s manifests.

**Invariant**: AgentBox security is **defense-in-depth with 6 independent layers**. The primary
defense for credential protection is OS-level user isolation (dual-user + setgid kubectl).
Application-level command validation is a secondary defense layer.

### 3.1 OS-Level User Isolation (Primary Defense)

Child processes run as `sandbox` user (via `runuser`), which cannot read credential files.
The `kubectl` binary has setgid `kubecred` group, allowing it to read kubeconfig while other
commands cannot. See ADR-010 and `docs/design/security.md` §3 for full design.

```
agentbox user  → Main Node.js process, owns credentials
sandbox user   → All child processes, no credential access
kubectl setgid → kubecred group membership, reads kubeconfig only
```

### 3.2 The 6-Pass Validation Pipeline (Secondary Defense)

Every command through `bash`, `node_exec`, `pod_exec`, or `pod_nsenter_exec` passes all 6 passes:

```
Pass 1 — Shell Operators      Block: $(), backticks, <(), >(), redirections, newlines
Pass 2 — Pipeline Extraction   Pipe-position tracking (| vs && vs ||)
Pass 3 — Binary Whitelist      Context-based: local | node | pod | nsenter | ssh
Pass 4 — Pipeline Validators   kubectl subcommand + exec checks
Pass 5 — COMMAND_RULES         Per-command: pipeOnly, noFilePaths, blockedFlags, allowedFlags
Pass 6 — Sensitive Paths       Block commands targeting credential/config file paths
```

**Source**: `src/tools/command-validator.ts`, `src/tools/command-sets.ts`

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
cluster-info, config, version, explain, auth, exec
```

**All write operations are permanently blocked**: `apply`, `create`, `delete`, `patch`, `scale`, `drain`, `cordon`, `edit`, `replace`, `label`, `taint`, `rollout undo`.

`kubectl exec` commands pass through the binary allowlist (Pass 3) for the exec'd command.

### 3.5 Skill Script Exemption

Skill scripts (`skills/` directory) are **exempt from the binary allowlist** for `run_skill`. The path is verified via `fs.realpathSync()` to block symlink traversal. This is the only way to run otherwise-blocked binaries in a controlled manner — via the skill review gate.

---

## 4. File I/O Path Restrictions

**Invariant**: Agent file tools (`read`, `edit`, `write`, `grep`, `find`, `ls`) are path-scoped. The agent cannot write to credentials, config, or system directories.

```
Read allowed:  builtin skills, dynamic skills, userDataDir, reports (~/.siclaw/reports/)
Write allowed: userDataDir ONLY (memory files, PROFILE.md, investigation notes)
Blocked:       credentials dir, config dir, system dirs (/etc, /var, etc.)
```

**Source**: `src/core/agent-factory.ts` — `assertPathAllowed()` wrapper on all file tools

---

## 5. Database Invariants

### 5.1 Two Separate Databases

Siclaw maintains **two independent SQLite databases** with completely different schemas:

| Database | Purpose | Engine | Location |
|----------|---------|--------|----------|
| Gateway DB | Users, sessions, skills, channels, cron, MCP config | sql.js (WASM) | `.siclaw/data.sqlite` |
| Memory DB | Embeddings, chunks, investigation records, FTS index | node:sqlite (native) | `<memoryDir>/.memory.db` |

These are never merged. Do not confuse them.

### 5.2 sql.js Single-Process Lock

**Invariant**: sql.js loads the entire SQLite file into memory. **Only one process can hold the database at a time.** A PID-based lockfile (`.siclaw/data.sqlite.lock`) prevents concurrent access.

**Consequences**:
- Local mode is single-process by design — do not attempt to run multiple Gateway instances against the same SQLite file
- `flushSqliteDb()` must be called before process exit to persist in-memory state to disk
- Periodic auto-flush runs every 30 seconds
- In containers (PID 1 always), the lock reclaim logic handles stale locks from previous container instances

**Source**: `src/gateway/db/index.ts`

### 5.3 SQLite DDL in Two Places

When adding a new table, it must be declared in **both**:
1. `src/gateway/db/schema-sqlite.ts` — Drizzle ORM table definition
2. `src/gateway/db/migrate-sqlite.ts` — `DDL_STATEMENTS` array (idempotent `CREATE TABLE IF NOT EXISTS`)

MySQL only needs `src/gateway/db/schema-mysql.ts` and is handled by Drizzle migrations.

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
- `materialize` is local filesystem write — **idempotent but destructive for skills** (wipes then rebuilds)
- `postReload` calls `brain.reload()` on active sessions

### 6.2 When to Use Each Handler

| Handler | Safe in LocalSpawner? | Safe in K8s pod? | Notes |
|---------|----------------------|------------------|-------|
| `mcpHandler.materialize()` | ✅ Yes | ✅ Yes | Merges, does not wipe |
| `skillsHandler.materialize()` | ❌ No | ✅ Yes | Wipes entire skillsDir first |

For local mode skills sync, write directly to `skills/team/` and `skills/user/<userId>/` without delegating to `skillsHandler.materialize()`.

---

## 7. Memory System Invariants

### 7.1 Hybrid Search Formula

```
finalScore = (vectorWeight × cosineSimilarity) + (ftsWeight × bm25Score)
```

Default weights: `vectorWeight = 0.85`, `ftsWeight = 0.15` (architecture.md reference; code default may differ — check `src/memory/indexer.ts`)

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
| maxContextCalls | 8 | 5 |
| maxHypotheses | 5 | 3 |
| maxCallsPerHypothesis | 10 | 8 |
| maxTotalCalls | 60 | 30 |
| maxParallel | 3 | 3 |
| maxDurationMs | 300,000 (5 min) | 180,000 (3 min) |

**Source**: `src/tools/deep-search/types.ts`

### 8.2 Early Exit

`EARLY_EXIT_CONFIDENCE = 101` — effectively **disabled** by default (101 > 100% is unreachable). The intended threshold is 80% for "root-cause-first" mode. Do not lower this without testing that sub-agents reliably report calibrated confidence scores.

### 8.3 Sub-Agent Tool Set

Sub-agents get a **minimal tool set** — not the full agent tool inventory:
- `read`, `restricted-bash`, `node_exec` only
- No memory tools, no skill management, no scheduling
- Skills pre-loaded from `skills/core/` and `skills/extension/` as text in prompt (not via `run_skill`)

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

## 10. Brain Type Differences

| Feature | pi-agent | claude-sdk |
|---------|----------|-----------|
| Backend | `@mariozechner/pi-coding-agent` | `@anthropic-ai/claude-agent-sdk` |
| Memory tools | ✅ Available (hybrid search + investigation history) | ❌ Not integrated |
| Tool protocol | TypeBox ToolDefinition | In-process MCP server (Zod) |
| `steer()` | Native mid-run injection | Queued post-query |
| Context tracking | ✅ Available | ❌ Not available |
| Default | ✅ Yes | Optional (`brainType: "claude-sdk"`) |

Memory-dependent features (investigations, `memory_search`) only work with pi-agent brain.

---

## 11. mTLS Scope

**Invariant**: mTLS is used **only between Gateway and AgentBox in K8s mode**. It is not used in LocalSpawner mode (same-machine, in-process) or TUI mode (no network).

- CA: 10-year, stored in DB (`system_config` table), auto-renewed when fewer than 30 days remain
- Client certs: issued per-pod at spawn time, short-lived
- Identity encoded in certificate CN/OU: `userId`, `workspaceId`, `boxId`
- Protected endpoints: `/api/internal/*` on Gateway HTTPS port (3002)

**Source**: `src/gateway/security/cert-manager.ts`
