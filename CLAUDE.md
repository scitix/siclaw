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

- `skillsHandler.materialize()` **must NOT be called in local mode** — it wipes `skills/team/` and `skills/user/` subdirectories, destroying ALL users' personal skills on the shared filesystem
- Local skills sync must write only to `skills/user/{userId}/` scoped paths (team skills are included in the user bundle, not written to a separate `skills/team/` directory)
- Any component designed for K8s pod isolation is **not directly reusable** in local mode

### 🔴 Skill Bundle Contract

`buildSkillBundle()` packages **only team + personal skills** (never core skills). Core skills are baked into the Docker image / repo checkout. Calling `skillsHandler.materialize()` does NOT restore core skills — it only writes what's in the bundle.

### 🔴 Shell Security: Defense-in-Depth

> Full spec: `docs/design/security.md` — read it before touching execution tools, Dockerfile, or K8s manifests.

Primary defense: **OS-level user isolation** — child processes run as `sandbox` user (cannot read credentials); `kubectl` has setgid `kubecred` group (ADR-010). Secondary defense: **whitelist-only command validation** — binaries must be in `ALLOWED_COMMANDS` (`src/tools/infra/command-sets.ts`). `sed`, `awk`, `nc`, `wget` are **intentionally excluded**. kubectl is **read-only** (13 safe subcommands; all write ops permanently blocked).

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

**Active**: KR0 (Qdrant + knowledge ingestion), IM Phase 2 (diagnostic path learning)
**Next**: PM1 (4-layer config cascade), OB0 (Prometheus metrics query)
**Consolidation**: Harness hardening — verifying existing features before next roadmap phase

### 🔴 System Prompt Protection

**`src/core/prompt.ts` (the SRE system prompt) must NEVER be modified without explicit human confirmation.** This file defines the agent's core behavioral rules, safety constraints, and credential handling — unauthorized changes can break security or alter agent behavior in subtle, hard-to-detect ways. Before making any change to this file, describe the intended modification and get approval first.

---

## Change Impact Matrix

> Before modifying any file, find it in this matrix. Read the required docs and verify the cross-cutting concerns **before writing code**.

| If you change... | Must read | Must verify | Cross-cutting concerns |
|---|---|---|---|
| `src/tools/infra/command-sets.ts` | security.md §4, tools.md §6 | `npm test` | Existing skill scripts still work; sanitization rules in `output-sanitizer.ts` still align |
| `src/tools/infra/output-sanitizer.ts` | sanitization.md, tools.md §6.2 | `npm test` | Pipeline fallback in `restricted-bash.ts`; deep-search sub-agent output quality |
| `src/tools/infra/command-validator.ts` | security.md §4, tools.md §6.2 | `npm test` | All tools calling `validateCommand()` |
| `src/tools/shell/restricted-bash.ts` | security.md, tools.md §5, sanitization.md | `npm test` | kubectl pipeline validation; skill script bypass (`isSkillScript`); 3-layer sanitization |
| `src/tools/shell/local-script.ts` | skills.md §6, sanitization.md §5 | `npm test` | Skill execution timeout/limits; output is NOT sanitized (by design) |
| `src/tools/k8s-exec/*.ts` | tools.md §3 | `npm test` | 10-step pipeline — steps 4/6/9 are mandatory security gates |
| `src/tools/k8s-script/*.ts` | tools.md §4, skills.md | `npm test` | Script transmission; skill resolution via `script-resolver.ts` |
| `src/gateway/skills/` | skills.md, invariants.md §1-2 | `npm test` | Bundle contract; `materialize()` NOT safe in local mode |
| `src/gateway/db/schema-*.ts` | invariants.md §5 | `npm test` | `migrate-sqlite.ts` must also be updated (DDL parity) |
| `src/core/agent-factory.ts` | tools.md §7, invariants.md §10 | `npm test` | Tool registration order; brain type compatibility (pi-agent vs claude-sdk) |
| `src/core/prompt.ts` | **⚠️ REQUIRES HUMAN APPROVAL** | — | Agent behavior, safety constraints — describe intent and wait for OK |
| `src/memory/` | invariants.md §7, decisions.md ADR-005 | `npm test` | Requires embedding config; pi-agent only (not available in claude-sdk brain) |
| `Dockerfile.agentbox` | security.md §3-5 | `docker build` | Dual-user model (agentbox/sandbox); capability set; setgid kubectl |
| `k8s/` or `helm/` | security.md §5, invariants.md §11 | `helm template` | mTLS K8s-only; container hardening; `readOnlyRootFilesystem` |
| `src/agentbox/resource-handlers.ts` | invariants.md §1,6 | `npm test` | `materialize()` wipes team+user dirs — safe in K8s, destructive in local mode |

---

## Development Principles

1. **Understand before building**: Before developing any new feature, thoroughly read existing documentation (`docs/design/`) and related code. Understand the current architecture, existing tools, and design patterns. Never reinvent what already exists.
2. **Docs and code stay in sync**: Every code change MUST include corresponding documentation updates. Outdated docs are worse than no docs — they actively mislead. If you change a tool, update `docs/design/tools.md`. If you change architecture, update `docs/design/invariants.md`. No exceptions.
3. **System prompt is protected**: `src/core/prompt.ts` must NEVER be modified without explicit human confirmation. Describe the intended change and wait for approval before editing.

## PR & Code Review Standards

> Full conventions: `CONTRIBUTING.md`

**Review approach — understand the whole, then judge the diff:**

Reviewing a PR is NOT just reading the diff. Before approving:
1. Read the relevant design docs (`docs/design/`) to understand the architectural context
2. Read the existing code around the changed files to understand the full picture
3. Then evaluate: Is the PR's design sound? Does it fit the architecture? Are there simpler alternatives?
4. Verify documentation is updated to match the code changes

**Checklist:**

1. **Deployment mode awareness**: Does the change respect local vs K8s isolation? If it touches resource sync, skills materialization, or filesystem writes, re-read `docs/design/invariants.md §1-2`
2. **Security model intact**: No new shell execution paths that bypass `command-sets.ts`. No weakening of the 6-pass pipeline. OS user isolation preserved (ADR-010). Skill scripts still go through review gate. Read `docs/design/security.md` for full model.
3. **PR description complete**: Must have Problem + Solution (not just diff summary). See `CONTRIBUTING.md` for format.
4. **TypeScript conventions**: ESM-only (`.js` imports), strict mode, named exports, no default exports in barrels.
5. **Both brain types**: Tool changes must work with both pi-agent (TypeBox) and claude-sdk (MCP/Zod) if applicable.
6. **SQLite DDL parity**: New tables need entries in both `schema-sqlite.ts` and `migrate-sqlite.ts`.
7. **Documentation parity**: Code changes must be accompanied by corresponding doc updates.

**Common review pitfalls:**
- Calling `skillsHandler.materialize()` in local mode code paths (ADR-003, ADR-002)
- Missing `migrate-sqlite.ts` DDL for new tables (breaks SQLite/local deployments)
- Path traversal in file writes — validate with `resolvePathUnderDir()` pattern, don't roll your own
- Duplicate helper functions across files — extract to shared utility
- Docs out of sync with code — check `docs/design/`, `CLAUDE.md`, and skill SKILL.md files

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

## Pre-flight Protocol

> **Mandatory** before any code modification. Do not skip these steps even if
> the task seems simple — most regressions come from "simple" changes that
> violated an invariant the developer didn't know about.

### Developer Pre-flight

1. **Locate in matrix**: Find the files you'll change in the Change Impact Matrix above
2. **Read required docs**: Read every doc listed in the "Must read" column — skim is not enough for security/invariant docs
3. **List cross-cutting concerns**: Write down (in your plan or task list) what else could break
4. **Confirm test strategy**: Know which tests cover your change (`npm test` for unit, manual for integration)
5. **Check current phase**: Verify your work aligns with `docs/design/roadmap.md` priorities

### Reviewer Pre-flight

1. **Load context**: Read the relevant design docs for the PR's domain (see matrix)
2. **Read existing code**: Understand the code around the diff, not just the diff itself
3. **Verify docs updated**: Code changes without corresponding doc updates are incomplete
4. **Check cross-cutting**: Did the author verify the concerns listed in the matrix?

### New Architectural Decisions

Any decision with non-obvious rationale should get an ADR in `docs/design/decisions.md`.

---

## Context Compaction Rules

> When Claude Code compacts context (automatically or via `/compact`), preserve:

1. **Modified files list** — every file changed in this session, with what was changed
2. **Active invariant domain** — which design docs are relevant to current work
3. **Cross-cutting concerns** — any blast radius items identified during pre-flight
4. **Pending verifications** — tests not yet run, docs not yet updated, reviews not yet done
5. **Task progress** — current task status and what remains

---

## Design Documentation Map

| Document | Covers | Read when |
|----------|--------|-----------|
| `docs/design/invariants.md` | Deployment modes, skill bundles, shell security, DB contracts | Touching resource sync, skills, DB schema, security |
| `docs/design/security.md` | 6-layer defense model, OS isolation, container hardening | Touching execution tools, Dockerfile, K8s manifests |
| `docs/design/tools.md` | Tool organization, execution pipelines, context system | Adding or modifying tools |
| `docs/design/sanitization.md` | 3-layer output sanitization, pre/post strategy | Touching output-sanitizer, command-sets, restricted-bash |
| `docs/design/skills.md` | Skill lifecycle, approval workflow, execution model | Touching skill sync, review, execution |
| `docs/design/decisions.md` | ADRs with context and consequences | Wondering "why was X designed this way?" |
| `docs/design/roadmap.md` | Current phase priorities, capability gaps | Planning work, checking priorities |
| `docs/design/harness.md` | Harness design philosophy, AI development standards | Onboarding, understanding our development framework |

**PR comments are posted via `gh` CLI as the authenticated GitHub user.**
