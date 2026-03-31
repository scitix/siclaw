# Siclaw — Operating Manual for Claude

> Auto-loaded at session start. Keep concise — deep reference lives in `docs/design/`.

---

## What This Project Is

**Siclaw** is an AI-powered SRE copilot that runs Kubernetes diagnostics via natural language.

**Three runtime modes share one agent core:**
```
TUI (single-user terminal)
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

### 🔴 Shell Security: Defense-in-Depth

> Full spec: `docs/design/security.md`; output sanitization: `docs/design/sanitization.md`

Primary defense: **OS-level user isolation** — child processes run as `sandbox` user; `kubectl` has setgid `kubecred` (ADR-010). Secondary: **whitelist-only command validation** (`src/tools/infra/command-sets.ts`). `sed`, `awk`, `nc`, `wget` intentionally excluded. kubectl read-only (13 safe subcommands).

### 🔴 Two Separate Databases

| Database | Engine | Purpose |
|----------|--------|---------|
| Gateway DB | sql.js (WASM) | Users, sessions, skills, MCP config. Single-process lock. DDL in both `schema-sqlite.ts` AND `migrate-sqlite.ts`. |
| Memory DB | node:sqlite | Embeddings, chunks, investigations. pi-agent only. |

### 🟡 Brain Type Gap

Memory tools are **pi-agent only**. When adding tools, test both brain types.

### 🟡 mTLS Scope

mTLS is **K8s mode only**. Do not add mTLS dependencies to local mode code paths.

---

## Current Phase

**Active**: KR0 (Qdrant), IM Phase 2 (diagnostic path learning)  |  **Next**: OB0 (Prometheus), PM1 (config cascade)
**Consolidation**: Harness hardening — verifying existing features before next roadmap. Full roadmap: `docs/design/roadmap.md`

---

## Change Impact Matrix

> Before modifying any file, find it here. Read the required docs and verify cross-cutting concerns **before writing code**.

| If you change... | Must read | Must verify | Cross-cutting concerns |
|---|---|---|---|
| `src/tools/infra/command-sets.ts` | security.md §4, tools.md §6 | `npm test` | Skill scripts still work; sanitization rules still align |
| `src/tools/infra/output-sanitizer.ts` | sanitization.md, tools.md §6.2 | `npm test` | Pipeline fallback in restricted-bash; deep-search sub-agent output |
| `src/tools/infra/command-validator.ts` | security.md §4, tools.md §6.2 | `npm test` | All tools calling `validateCommand()` |
| `src/tools/cmd-exec/restricted-bash.ts` | security.md, tools.md §5, sanitization.md | `npm test` | kubectl validation; skill bypass (`isSkillScript`); 3-layer sanitization |
| `src/tools/cmd-exec/*.ts` | tools.md §3 | `npm test` | Security pipeline via `preExecSecurity` / `postExecSecurity` |
| `src/tools/script-exec/*.ts` | tools.md §4, skills.md | `npm test` | Script transmission; skill resolution |
| `src/tools/infra/security-pipeline.ts` | tools.md §8.2, security.md | `npm test` | Facade for all cmd-exec tools; changes affect all 3 tools |
| `src/gateway/skills/` | skills.md, invariants.md §1-2 | `npm test` | Bundle contract; `materialize()` NOT safe in local mode |
| `src/gateway/db/schema-*.ts` | invariants.md §5 | `npm test` | `migrate-sqlite.ts` must also be updated (DDL parity) |
| `src/core/agent-factory.ts` | tools.md §7, invariants.md §10 | `npm test` | Tool registration; brain type compatibility |
| `src/core/prompt.ts` | **⚠️ REQUIRES HUMAN APPROVAL** | — | Describe intent and wait for OK before editing |
| `src/memory/` | invariants.md §7, decisions.md ADR-005 | `npm test` | Requires embedding config; pi-agent only |
| `Dockerfile.agentbox` | security.md §3-5 | `docker build` | Dual-user model; capability set; setgid kubectl |
| `k8s/` or `helm/` | security.md §5, invariants.md §11 | `helm template` | mTLS K8s-only; container hardening |
| `src/agentbox/resource-handlers.ts` | invariants.md §1,6 | `npm test` | `materialize()` safe in K8s, destructive in local mode |

---

## Development Protocol

**Before modifying code**: find the files in the Change Impact Matrix above, read the required docs, and note cross-cutting concerns. After changes: run `npm test`, update docs if behavior changed. If something broke that the matrix didn't predict, add a new row or cross-cutting concern entry — every surprise improves the harness.

**Documentation rule**: Design docs record **contracts and rationale** (what must hold, why it was decided), not implementation steps (which functions are called in which order). Implementation details belong in code comments. This keeps docs stable across refactors — a renamed function shouldn't require a doc update, but a changed security contract must.

---

## Tech Stack

```
Runtime:    Node.js ≥22.12.0  (ESM-only)     Tests:      vitest (npm test)
Language:   TypeScript 5.9    (strict, .js)   Type check: npx tsc --noEmit
Frontend:   React + Vite + Tailwind           Agent:      pi-coding-agent / claude-agent-sdk
DB (GW):    Drizzle → sql.js / MySQL          DB (mem):   node:sqlite + FTS5
```

**Conventions**: ESM-only, named exports, no default exports. `CONTRIBUTING.md` for PR format. `gh` CLI for PR comments.
