<div align="center">

<img src="docs/assets/logo.png" alt="Siclaw Logo" width="400" />

# Siclaw

**AI Agent platform for SRE — the collaborative AI foundation for your team**

[![CI](https://github.com/scitix/siclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/scitix/siclaw/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)


</div>

---

Siclaw is an AI Agent platform for DevOps / SRE, inspired by [OpenClaw](https://github.com/openclaw) and designed to be the collaborative AI foundation for engineering teams. Unlike general-purpose coding agents, Siclaw is built for **read-only infrastructure diagnostics** — the agent observes, analyzes, and reports, but never mutates your environment directly. When remediation is needed, Siclaw integrates with your existing change management systems to execute changes through established, auditable workflows. Describe a problem in plain language and the agent runs kubectl, reads logs, traces network paths, and delivers a root-cause analysis — from a terminal, a web UI, or your team's IM workspace.

## Features

- **Deep Investigation** — Hypothesis-driven 4-phase diagnostic engine (context gathering → hypothesis generation → parallel validation → root-cause conclusion), bringing Deep Research to SRE with cross-system, multi-dimensional fault analysis
- **Security Governance** — Strict permission layer between agent and infrastructure: read-only by default, command whitelist, write operations require per-item approval, credentials isolated by workspace — zero accidental mutations in production
- **Team Collaboration** — Multi-workspace, multi-user management (SSO/OAuth2), isolated AgentBox sandboxes per user, designed for multi-team, multi-environment enterprise scenarios
- **Alert-Driven Operations** — Webhook triggers connect to your existing monitoring stack (Prometheus, PagerDuty, custom), automatically launching agent investigations when alerts fire
- **Scheduled Tasks** — Cron-based recurring jobs for routine health checks, periodic diagnostics, or any agent task — manageable via Web UI or natural language
- **Skill System** — AI-generated diagnostic skills with automated risk-level review, supporting creation, forking, and hot-reload via Web UI or natural language — organize across core / team / personal tiers to codify your team's operational expertise into reusable, shareable runbooks
- **Extensible** — [MCP](https://modelcontextprotocol.io) tool servers and persistent per-user memory (vector + keyword search) across sessions
- **Multi-Channel Access** — Terminal TUI, Web UI, or IM bots (Slack, Discord, Telegram, Lark)

## Architecture

![Siclaw System Architecture](docs/assets/architecture.svg)

> Three deployment modes share one agent core: **TUI** (single-user terminal),
> **Local Server** (Gateway + SQLite, multi-user), **Kubernetes** (isolated AgentBox pod per user).
> The Knowledge System feeds the agent with accumulated investigation experience (IM Phase 0–1 ✓)
> and team-wide knowledge via Qdrant (KR0 — in progress).

## Prerequisites

- **Node.js >= 22.12.0** — [Download](https://nodejs.org/)
- **npm** — Comes with Node.js
- **kubectl** — Required for K8s diagnostics ([Install guide](https://kubernetes.io/docs/tasks/tools/))
- A valid **kubeconfig** pointing to your target cluster

## Quick Start

Siclaw supports three deployment profiles. Pick the one that fits your use case.

### 1. TUI Mode — Personal, local, lowest barrier

Run the agent directly in your terminal. No server, no database. All operations are read-only by default — safe to run on your workstation.

```bash
# Install
npm install siclaw

# Run (interactive — prompts for LLM provider on first launch)
npx siclaw

# Single-shot
npx siclaw --prompt "Why is pod nginx-abc in CrashLoopBackOff?"

# Continue last session
npx siclaw --continue
```

<details>
<summary><b>Build from source</b></summary>

```bash
git clone https://github.com/scitix/siclaw.git && cd siclaw
npm ci && npm run build
npm link                 # register `siclaw` command globally

siclaw                   # TUI mode
siclaw --prompt "..."    # single-shot mode

# Uninstall: npm unlink siclaw -g
```

</details>

> **Tip:** Any OpenAI-compatible endpoint works — swap `baseUrl` for DeepSeek, Qwen, Kimi, or a local Ollama server.

### 2. Local Server — VM or laptop, recommended for daily use

A lightweight web UI backed by SQLite. No MySQL, no Docker required — just start the server and configure everything in the browser. Siclaw enforces strict read-only access by default (command whitelist, no write operations without approval), so you can safely deploy it on your own workstation without worrying about unintended changes to your clusters.

```bash
npm install siclaw

# Start the server (SQLite database is created automatically)
npx siclaw local

# Open http://localhost:3000
# Login: admin / admin (default credentials)
# Go to Settings to configure your LLM provider
```

<details>
<summary><b>Build from source</b></summary>

```bash
git clone https://github.com/scitix/siclaw.git && cd siclaw
npm ci && npm run build && npm run build:web
npm link                 # register `siclaw` command globally

siclaw local             # start local server

# Uninstall: npm unlink siclaw -g
```

</details>

The server uses SQLite by default and auto-generates a JWT secret on first run. All configuration — LLM providers, models, credentials — is done through the **Settings** page in the web UI.

### 3. Kubernetes — Team / enterprise

Full multi-user deployment with isolated AgentBox pods, SSO, and IM channels. Just prepare a MySQL database and deploy with Helm:

```bash
helm upgrade --install siclaw ./helm/siclaw \
  --namespace siclaw --create-namespace \
  --set database.url="mysql://user:pass@host:3306/siclaw"
```

<details>
<summary><b>Using a custom image registry</b></summary>

If you need to build and push images to your own registry:

```bash
# Build and push images
make docker push REGISTRY=registry.example.com/myteam

# Deploy with custom registry
helm upgrade --install siclaw ./helm/siclaw \
  --namespace siclaw --create-namespace \
  --set image.registry="registry.example.com/myteam" \
  --set database.url="mysql://user:pass@host:3306/siclaw"
```

</details>

See [`helm/siclaw/`](helm/siclaw/) for values reference, and [`k8s/README.md`](k8s/README.md) for the full deployment guide.

## Configuration

### settings.json (TUI mode)

Minimal example — copy `settings.example.json` to `.siclaw/config/settings.json`:

```json
{
  "providers": {
    "default": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-YOUR-KEY",
      "models": [{ "id": "gpt-4o", "name": "GPT-4o" }]
    }
  }
}
```

<details>
<summary><b>Full settings.json reference</b></summary>

```json
{
  "providers": {
    "provider-name": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "your-key",
      "api": "openai-completions",
      "authHeader": true,
      "models": [
        {
          "id": "model-id",
          "name": "Display Name",
          "reasoning": false,
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 2.5, "output": 10.0, "cacheRead": 0.5, "cacheWrite": 3.0 }
        }
      ]
    }
  },
  "default": { "provider": "provider-name", "modelId": "model-id" },
  "embedding": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "your-key",
    "model": "BAAI/bge-m3",
    "dimensions": 1024
  },
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"]
    }
  },
  "debugImage": "busybox:latest",
  "debug": false
}
```

</details>

<details>
<summary><b>IM Channels — Slack / Discord / Telegram / Lark</b></summary>

### Slack

Configure a Slack bot in **Settings > Channels**. You'll need:
- Bot token and signing secret from the [Slack API](https://api.slack.com/apps)

### Discord

Configure a Discord bot in **Settings > Channels**. You'll need:
- Bot token from the [Discord Developer Portal](https://discord.com/developers/applications)
- Scopes: `bot`, `messages.read`

### Telegram

Configure a Telegram bot in **Settings > Channels**. You'll need:
- Bot token from [@BotFather](https://t.me/BotFather)

### Lark

Configure a Lark bot in **Settings > Channels** of the web UI. You'll need:
- App ID and App Secret from the [Lark Open Platform](https://open.larksuite.com/)
- Event subscription URL: `https://your-domain/api/channels/feishu/event`
- Scopes: `im:message`, `im:message.group_at_msg`, `im:resource`

</details>

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ (ESM-only) |
| Language | TypeScript 5.9 |
| Agent | [pi-coding-agent](https://github.com/nicholasgriffintn/pi-coding-agent) / [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk) |
| Database | MySQL or SQLite (via [sql.js](https://github.com/sql-js/sql.js)) + Drizzle ORM |
| Frontend | React + Vite + Tailwind CSS |
| K8s Client | @kubernetes/client-node |
| MCP | @modelcontextprotocol/sdk |
| Realtime | WebSocket (ws) |

## Community

- [GitHub Issues](https://github.com/scitix/siclaw/issues) — Bug reports and feature requests
- [GitHub Discussions](https://github.com/scitix/siclaw/discussions) — Questions, ideas, and general discussion

<!-- TODO: Add Discord invite link once server is created -->

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture overview, and pull request guidelines.

Looking for a place to start? Check out issues labeled [`good first issue`](https://github.com/scitix/siclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## License

[Apache License 2.0](LICENSE)
