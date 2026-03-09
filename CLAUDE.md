# Siclaw — Operating Manual for Claude

> This file is auto-loaded by Claude Code at the start of every session.
> Keep it concise. Deep reference lives in `docs/design/`.

---

## What This Project Is

**Siclaw** is an AI-powered SRE copilot — a "cyber-twin" that runs Kubernetes diagnostics via natural language. It accumulates investigation experience across sessions, learns from team knowledge, and engages in deep technical discussion rather than just giving commands.

**Three runtime modes share one agent core:**
```
TUI (single-user terminal)
Gateway + LocalSpawner (multi-user, local dev — all users share one process + filesystem)
Gateway + K8sSpawner  (production — one isolated pod per user)
```

---

## Critical Architecture Invariants

> Full spec: `docs/design/invariants.md` — read it before touching resource sync, skills, or security.

### 🔴 Local Mode: Shared Filesystem

`LocalSpawner` runs ALL AgentBox instances **in-process with Gateway**, sharing the same filesystem. This means:

- `skillsHandler.materialize()` **must NOT be called in local mode** — it wipes `skillsDir` entirely, destroying `skills/core/` and other users' data
- Local skills sync must write only to `skills/team/` and `skills/user/{userId}/` scoped paths
- Any component designed for K8s pod isolation is **not directly reusable** in local mode

### 🔴 Skill Bundle Contract

`buildSkillBundle()` packages **only team + personal skills** (never core skills). Core skills are baked into the Docker image / repo checkout. Calling `skillsHandler.materialize()` does NOT restore core skills — it only writes what's in the bundle.

### 🔴 Shell Security: Defense-in-Depth

> Full spec: `docs/design/security.md` — read it before touching execution tools, Dockerfile, or K8s manifests.

Primary defense: **OS-level user isolation** — child processes run as `sandbox` user (cannot read credentials); `kubectl` has setgid `kubecred` group (ADR-010). Secondary defense: **whitelist-only command validation** — binaries must be in `ALLOWED_COMMANDS` (`src/tools/command-sets.ts`). `sed`, `awk`, `nc`, `wget` are **intentionally excluded**. kubectl is **read-only** (13 safe subcommands; all write ops permanently blocked).

### 🔴 sql.js: Single-Process Lock

SQLite via sql.js loads the entire DB into memory. Only **one process** can hold `.siclaw/data.sqlite` at a time (PID lockfile). Local mode is single-process by design.

### 🔴 Two Separate Databases

| Database | Purpose | Engine |
|----------|---------|--------|
| Gateway DB | Users, sessions, skills, channels, MCP config | sql.js (WASM) |
| Memory DB | Embeddings, chunks, investigation records | node:sqlite (native) |

Never confuse them. Adding a table to Gateway DB requires changes in both `schema-sqlite.ts` AND `migrate-sqlite.ts`.

### 🟡 mTLS Scope

mTLS is used **only in K8s mode** (Gateway ↔ AgentBox pods). LocalSpawner uses plain HTTP on 127.0.0.1. Do not add mTLS dependencies to local mode code paths.

### 🟡 Brain Type Feature Gap

Memory tools (`memory_search`, investigation history) are **pi-agent only** — not available in claude-sdk brain. When adding new tools, test both brain types (TypeBox for pi-agent, Zod/MCP for claude-sdk).

---

## Current Development Phase

> Full roadmap: `docs/design/roadmap.md`

| Phase | Status | Description |
|-------|--------|-------------|
| IM Phase 0 | ✅ Done | Raw memory loop (write + search + inject) |
| IM Phase 1 | ✅ Done (PR #17) | Structured extraction, SQLite investigations table |
| **KR0** | 🔄 In Progress | Qdrant + knowledge base ingestion |
| **IM Phase 2** | 🔄 In Progress | Diagnostic path learning from history |
| PM1 | ⏳ Next | 4-layer config cascade (System → Team → Personal → Workspace) |

**Open research**: R1 (Contextual vs Late Chunking), R3 (config merge strategy), T1 (KG storage: Kuzu vs SQLite)

---

## PR & Code Review Standards

> Full conventions: `CONTRIBUTING.md`

**Before approving any PR, verify:**

1. **Deployment mode awareness**: Does the change respect local vs K8s isolation? If it touches resource sync, skills materialization, or filesystem writes, re-read `docs/design/invariants.md §1-2`
2. **Security model intact**: No new shell execution paths that bypass `command-sets.ts`. No weakening of the 6-pass pipeline. OS user isolation preserved (ADR-010). Skill scripts still go through review gate. Read `docs/design/security.md` for full model.
3. **PR description complete**: Must have Problem + Solution (not just diff summary). See `CONTRIBUTING.md` for format.
4. **TypeScript conventions**: ESM-only (`.js` imports), strict mode, named exports, no default exports in barrels.
5. **Both brain types**: Tool changes must work with both pi-agent (TypeBox) and claude-sdk (MCP/Zod) if applicable.
6. **SQLite DDL parity**: New tables need entries in both `schema-sqlite.ts` and `migrate-sqlite.ts`.

**Common review pitfalls:**
- Calling `skillsHandler.materialize()` in local mode code paths (ADR-003, ADR-002)
- Missing `migrate-sqlite.ts` DDL for new tables (breaks SQLite/local deployments)
- Path traversal in file writes — validate with `resolvePathUnderDir()` pattern, don't roll your own
- Duplicate helper functions across files — extract to shared utility

---

## Key File Map

```
Entry Points
  src/cli-main.ts              TUI entry
  src/gateway-main.ts          Gateway entry (--k8s flag for K8s mode)
  src/agentbox-main.ts         AgentBox entry (K8s pod)
  src/cron-main.ts             Cron worker entry

Agent Core
  src/core/agent-factory.ts    Session factory — assembles tools + brain + skills
  src/core/brain-session.ts    BrainSession interface
  src/core/prompt.ts           SRE system prompt builder
  src/core/brains/pi-agent-brain.ts
  src/core/brains/claude-sdk-brain.ts

Security (read docs/design/security.md before touching)
  src/tools/command-sets.ts    ALLOWED_COMMANDS + COMMAND_RULES + context categories
  src/tools/command-validator.ts  6-pass validation pipeline
  src/tools/restricted-bash.ts Shell tool (sudo sandbox + command validation)
  src/tools/sanitize-env.ts    Environment variable sanitization
  src/gateway/skills/script-evaluator.ts  Skill script security review

Resource Sync (read before touching)
  src/shared/resource-sync.ts  Types, contracts, RESOURCE_DESCRIPTORS
  src/agentbox/resource-handlers.ts  mcpHandler + skillsHandler
  src/agentbox/resource-sync.ts      syncAllResources() for K8s startup
  src/gateway/agentbox/local-spawner.ts  Local mode (in-process)
  src/gateway/resource-notifier.ts   Gateway → AgentBox reload notifications

Database
  src/gateway/db/index.ts          createDb() — SQLite vs MySQL selection
  src/gateway/db/schema-sqlite.ts  Drizzle SQLite schema (all tables)
  src/gateway/db/migrate-sqlite.ts DDL_STATEMENTS (must stay in sync with schema)
  src/memory/indexer.ts            Hybrid search engine
  src/memory/schema.ts             Memory DB schema

Skills
  src/gateway/skills/skill-bundle.ts  buildSkillBundle() — team + personal only
  src/tools/run-skill.ts              run_skill tool
  src/tools/script-resolver.ts        Skill path resolution
  skills/core/                        Built-in diagnostic skills

Investigation
  src/tools/deep-search/types.ts    Budget constants (Normal/Quick)
  src/tools/deep-search/engine.ts   4-phase workflow engine
  src/tools/deep-search/sub-agent.ts Sub-agent factory (minimal tool set)
```

---

## Tech Stack Quick Reference

```
Runtime:    Node.js ≥22.12.0  (ESM-only, no CommonJS)
Language:   TypeScript 5.9    (strict mode, .js imports required)
Tests:      vitest            (npm test)
Type check: npx tsc --noEmit
Frontend:   React + Vite + Tailwind
Agent:      pi-coding-agent 0.55.3 / claude-agent-sdk 0.1.58
DB (gateway): Drizzle ORM → sql.js SQLite or MySQL2
DB (memory):  node:sqlite + FTS5
```

---

## Collaboration Notes

**When starting a session as reviewer:**
1. This file is already loaded (you're reading it)
2. For architecture-sensitive PRs, load `docs/design/invariants.md`
3. For security-sensitive PRs (execution tools, Dockerfile, K8s manifests), load `docs/design/security.md`
4. For roadmap/planning work, load `docs/design/roadmap.md`
5. For "why was X designed this way", load `docs/design/decisions.md`

**When starting a session as developer:**
1. Check `docs/design/roadmap.md` for current phase priorities
2. Before touching resource sync or skills: re-read invariants §1-3
3. Before touching execution tools or container config: re-read `docs/design/security.md`
4. New architectural decisions should get an ADR in `docs/design/decisions.md`

**PR comments are posted via `gh` CLI as the authenticated GitHub user.**
