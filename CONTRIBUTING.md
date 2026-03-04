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
npm run build:web

# Run tests
npm test
```

## Running Locally

```bash
# TUI mode (terminal)
npm run dev

# Gateway mode (web UI)
npm run dev:gateway

# AgentBox mode (worker)
npm run dev:agentbox
```

## Project Architecture

Siclaw has four entry points, each serving a different deployment role:

| Entry Point | File | Role |
|-------------|------|------|
| `siclaw` | `src/cli-main.ts` | Interactive TUI for local diagnostics |
| `siclaw-gateway` | `src/gateway-main.ts` | HTTP + WebSocket control plane |
| `siclaw-agentbox` | `src/agentbox-main.ts` | Isolated worker (one per user) |
| `siclaw-cron` | `src/cron-main.ts` | Scheduled task runner |

Key directories:

- `src/core/` — Agent session factory, LLM adapters, system prompt
- `src/tools/` — 20+ diagnostic tool definitions
- `src/gateway/` — Server, auth, DB, channels, web UI
- `src/memory/` — Vector + keyword search indexer
- `skills/` — Diagnostic playbooks (SKILL.md + scripts)

## Pull Request Guidelines

1. **Fork and branch** — Create a feature branch from `main`
2. **Keep changes focused** — One logical change per PR
3. **Test** — Run `npm test` before submitting
4. **TypeScript** — The project uses strict TypeScript with ESM modules
5. **No default exports** — Use named exports throughout

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
