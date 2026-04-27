# Siclaw Project Instructions

This file is the project-level Codex guide for `siclaw_dp_cleanup`. Keep it
limited to stable Siclaw facts and constraints. General collaboration style
belongs in `~/.codex/AGENTS.md`; `CLAUDE.md` is the larger legacy reference when
deeper background is needed.

## Project Shape

Siclaw is an AI-powered SRE copilot for Kubernetes diagnostics.

One agent core supports three runtime shapes:

```text
TUI: single-user terminal, optionally paired with local Portal
Gateway + LocalSpawner: local multi-user dev, one process/shared filesystem
Gateway + K8sSpawner: production, one isolated pod per user
```

## Before Risky Edits

- Preserve user changes and unrelated dirty work.
- For security, tool execution, database, Portal snapshot, guards, memory,
  Docker, Helm, or K8s behavior, read the nearby code plus relevant
  `docs/design/*` or `CLAUDE.md` before editing.
- Ask before editing `src/core/prompt.ts`; it affects core agent behavior and
  product tone.
- Do not add production dependencies unless explicitly requested.

## Verification

Use targeted checks first, then broaden when touching shared behavior:

```bash
npm test
npx tsc --noEmit
npm run build
```

Broaden verification for database schema, tool execution, guards, Portal
snapshot, K8s/Docker/Helm, or user-facing workflows.

## Stable Boundaries

- `LocalSpawner` runs all local AgentBox instances in one process with a shared
  filesystem. Local skill sync must stay user-scoped and must not wipe shared
  skill directories such as global/skillset/user trees.
- Core skills are baked into the Docker image. Workspace skill bundles should
  include only selected global/dev/personal skills.
- TUI plus local Portal uses Portal as a read-only snapshot source. TUI startup
  must tolerate missing or unauthorized Portal snapshot access.
- Shell execution security is layered: OS-level isolation first, whitelist-only
  command validation second, plus pre/post execution sanitization.
- Portal/Gateway DB and Memory DB are separate persistence domains. Do not mix
  user/session config with embedding/chunk/investigation storage.
- AgentBox and Runtime are separate processes in K8s mode. Code under
  `src/agentbox/**` must not import Gateway or Portal persistence modules such
  as `src/gateway/chat-repo.ts`; LocalSpawner's shared process can hide this.
  AgentBox background work should call Runtime internal APIs through
  `GatewayClient`, with Runtime owning Portal RPC and database persistence.
- `src/portal/migrate.ts` must stay compatible with both MySQL and SQLite.
- mTLS is for K8s mode only; do not pull mTLS requirements into local mode.

## Stack And Local Conventions

```text
Runtime: Node.js >= 22.12.0, ESM-only
Language: TypeScript 5.9 strict, .js imports
Tests: vitest
Frontend: React + Vite + Tailwind
Agent: @mariozechner/pi-coding-agent
Gateway DB: mysql2 / node:sqlite raw SQL
Memory DB: node:sqlite + FTS5 + sqlite-vec
```

- Use named exports; avoid default exports.
- Siclaw is English-first and open-source-oriented. User-facing UI labels,
  prompts, docs, and PR text should default to clear English unless localization
  is explicitly requested.
- Follow `CONTRIBUTING.md` for PR format.

## Commit Notes

Commit messages should explain why. Add trailers only when they carry useful
context:

```text
Constraint: <external constraint>
Rejected: <alternative> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <future warning>
Tested: <what was verified>
Not-tested: <known gaps>
```
