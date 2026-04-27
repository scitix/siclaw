# Contributing to Siclaw

Thanks for your interest in contributing! This guide covers the essentials for getting started.

## Development Setup

```bash
# Prerequisites: Node.js >= 22, npm
node --version   # v22.x or higher

# Install dependencies
npm ci

# Build TypeScript
npm run build

# Build web frontend (needed for gateway mode)
make build-portal-web

# Run tests
npm test
```

## Running Locally

```bash
# TUI mode (terminal)
npm run dev

# Runtime (control plane)
npm run dev:runtime

# Portal (web UI + DB)
npm run dev:portal

# AgentBox mode (worker)
npm run dev:agentbox
```

## Design Documents

Before making significant changes, read the relevant design doc:

| Document | When to read |
|----------|-------------|
| [`docs/design/invariants.md`](docs/design/invariants.md) | Touching resource sync, skills, security, or DB schema |
| [`docs/design/decisions.md`](docs/design/decisions.md) | Wondering "why was X designed this way?" |
| [`docs/design/security.md`](docs/design/security.md) | Modifying execution tools, Dockerfile, or K8s manifests |
| [`docs/design/tools.md`](docs/design/tools.md) | Adding or modifying a diagnostic tool |

New architectural decisions should get an ADR entry in `docs/design/decisions.md`.

---

## Project Architecture

Siclaw has three entry points, each serving a different deployment role:

| How to launch | Source | Role |
|---------------|--------|------|
| `siclaw` | `src/cli-main.ts` | Interactive TUI for local diagnostics |
| `siclaw local` | `src/cli-local.ts` | Single-process Portal + Runtime for local web UI |
| `node siclaw-gateway.mjs` (or `npm run start:runtime`) | `src/gateway-main.ts` | Runtime control plane (channels, cron, AgentBox spawner) |
| `npm run start:portal` | `src/portal-main.ts` | Portal: Web UI + REST API + DB + auth + skill/MCP/knowledge admin |
| `node siclaw-agentbox.mjs` (or `npm run start:agentbox`) | `src/agentbox-main.ts` | Isolated worker (one per user) |

Key directories:

- `src/core/` — Agent session factory, brain, guard pipeline, tool registry
- `src/tools/` — 20+ diagnostic tool definitions
- `src/gateway/` — Runtime server, channels, DB, skills bundle builder
- `src/portal/` — Portal: auth, REST API, admin resources
- `src/agentbox/` — AgentBox HTTP server, credential broker, resource sync
- `src/memory/` — Vector + keyword investigation indexer
- `src/cron/` — Task scheduling
- `portal-web/` — React + Vite web UI
- `skills/` — Diagnostic playbooks (SKILL.md + scripts)

## Commit Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `perf`, `ci`

**Scope** (optional): the module affected — e.g. `gateway`, `agentbox`, `tui`, `tools`, `memory`, `skills`, `portal-web`

**Rules:**
- Subject line: imperative mood, lowercase, no period, ≤72 characters
- Body: explain **why**, not what (the diff shows what). Wrap at 72 characters
- Reference issues with `Closes #123` or `Fixes #123` in the body

**Examples:**

```
feat(portal-web): add Pause/Activate button to task run-history page

fix(gateway): prevent session leak on WebSocket disconnect

refactor(core): collapse DP state machine into a single mode flag

The old state machine (investigating / awaiting_confirmation / validating
/ concluding) coupled four layers — prompt markers, tools, SSE events,
and UI cards. Reducing to a boolean eliminates the coupling surface.
```

## Pull Request Guidelines

1. **Fork and branch** — Create a feature branch from `main`
2. **Keep changes focused** — One logical change per PR
3. **Test** — Run `npm test` before submitting
4. **TypeScript** — The project uses strict TypeScript with ESM modules
5. **No default exports** — Use named exports throughout

### PR Description Format

Keep it concise — let the code speak. Focus on **why** (the problem) and **what** (the solution), not restating the diff.

```markdown
## Summary

1-3 sentences: what problem does this solve and how.

### Problem (if not obvious)

Brief description of the issue, with symptoms or user-facing impact.

### Solution

What changed and why this approach was chosen over alternatives.

## Test Plan

- [x] Automated tests that cover the change
- [ ] Manual verification steps
```

**Do:**
- Lead with the problem, not the implementation
- Call out breaking changes or migration steps explicitly
- Link related issues (`Closes #123`)

**Don't:**
- Restate every file change — reviewers can read the diff
- Add filler sections with no content
- Write paragraphs when bullets suffice

## Code Style

- **TypeScript ESM** — All source uses ES module syntax (`import`/`export`)
- **Named exports** — No default exports
- **Strict mode** — TypeScript strict is enabled
- **Formatting** — Follow existing patterns in the codebase

## Reporting Issues

Found a bug or have a feature request? Please [open an issue](../../issues) with:

- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
