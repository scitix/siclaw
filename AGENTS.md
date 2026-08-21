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
Runtime: Node.js >= 22.19.0, ESM-only
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

## Cursor Cloud specific instructions

Dependencies (`npm ci` at root and in `portal-web/`) are installed by the
startup update script; no manual install is needed.

- **Node version is load-bearing.** The project requires Node `>=22.19.0`
  because the memory DB uses `node:sqlite`'s FTS5 module, which the VM's default
  `/exec-daemon/node` (22.14.0) does NOT include — under it, all `src/memory/**`
  tests fail with `no such module: fts5` and the memory feature is broken. Setup
  added a `~/.bashrc` line preferring nvm's Node 22.22.2 (which has FTS5), so
  interactive agent shells resolve `node` to 22.22.2 automatically. If `node
  --version` ever shows 22.14.0, run `source ~/.bashrc` (or
  `nvm use 22.22.2`). `npm ci` itself works on either version.
- **Build before running the local server.** `siclaw local` (via `siclaw.mjs`)
  imports from `dist/`, so run `npm run build` first, and `npm run build:web`
  (or `make build-portal-web`) so Portal can serve `portal-web/dist/`. The
  update script intentionally does not build.
- **Running the product.** `node siclaw.mjs local` starts Portal + Runtime +
  in-process AgentBox + SQLite in one process (Portal `:3000`, Runtime `:3001`,
  internal `:3002`). Health check: `curl http://127.0.0.1:3000/api/health`. It
  seeds a bootstrap admin `admin` / `admin` and auto-creates the DB at
  `.siclaw/data/portal.db` and secrets at `.siclaw/local-secrets.json`. On Node
  < 24, `node:sqlite` needs `--experimental-sqlite`, which `siclaw.mjs`
  re-execs automatically. `scripts/dev-local.sh` wraps rebuild+restart (add
  `--web` to also rebuild the frontend, `--wipe` to reset DB/secrets).
- **LLM provider is required for actual investigations.** The agent core cannot
  answer without a configured LLM provider (API key). Configuring providers,
  agents, clusters, skills, etc. through the web UI works fully offline, but
  running a chat/investigation needs a real provider key set in the Models page.
- **Lint/test/build commands:** lint == typecheck (`npx tsc --noEmit` or
  `make typecheck`; no ESLint/Prettier). Backend tests: `npm test`. Frontend
  tests: `cd portal-web && npm run test`. Full check: `make test`.
