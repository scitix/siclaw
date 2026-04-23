<div align="center">

<img src="docs/assets/logo.png" alt="Siclaw Logo" width="400" />

# Siclaw

**Read-only investigation copilot for SRE teams**

[![npm](https://img.shields.io/npm/v/siclaw?logo=npm)](https://www.npmjs.com/package/siclaw)
[![CI](https://github.com/scitix/siclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/scitix/siclaw/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Slack](https://img.shields.io/badge/Slack-Join%20Community-4A154B?logo=slack&logoColor=white)](https://join.slack.com/t/siclaw-scitix/shared_invite/zt-3rrsoc2ic-JIfbfvT1_04sqgQorSRfmw)

[Website](https://www.siclaw.ai) | [Documentation](https://docs.siclaw.ai) | [Slack](https://join.slack.com/t/siclaw-scitix/shared_invite/zt-3rrsoc2ic-JIfbfvT1_04sqgQorSRfmw)

</div>

---

Siclaw is an open-source AI agent for DevOps and SRE teams. It is built for **read-only infrastructure diagnostics**: gather evidence, form hypotheses, validate them, and return a clear root-cause analysis without changing your environment directly. Describe a problem in plain language and Siclaw investigates it from the terminal, the web UI, or your team's chat channels.

## Features

- **Deep Investigation** — A 4-phase workflow for evidence gathering, hypothesis testing, and root-cause analysis
- **Investigation Memory** — Learns from past incidents to improve future investigations
- **Read-Only by Default** — Investigates and recommends next steps without changing your environment directly
- **Team Workflows** — Shared web UI, credentials, channels, triggers, and scheduled patrols
- **Reusable Skills** — Turn repeated diagnostic playbooks into reviewable runbooks
- **Extensible** — Connect external tools and data sources through [MCP](https://modelcontextprotocol.io)
- **Multi-Channel Access** — Use Siclaw from the terminal, web UI, or chat channels

## Architecture

![Siclaw System Architecture](docs/assets/architecture.svg)

> Three deployment modes share one agent core: **TUI** (single-user terminal),
> **Local Server** (Gateway + SQLite, multi-user), **Kubernetes** (isolated AgentBox pod per user).
> Every investigation is indexed into a local memory store and surfaced back to the agent,
> so past diagnoses inform future hypotheses.

## Prerequisites

- **Node.js >= 22.12.0** — [Download](https://nodejs.org/)
- **npm** — Comes with Node.js
- **kubectl** — Optional, only needed if you want Siclaw to investigate Kubernetes clusters

## Quick Start

Siclaw supports three deployment profiles. For local usage, start from a dedicated working directory because Siclaw stores most runtime data in `.siclaw/` relative to where you launch it.

```bash
mkdir -p ~/siclaw-work
cd ~/siclaw-work
```

### 1. TUI Mode — Personal, local, lowest barrier

Run the agent directly in your terminal. No server, no database. All operations are read-only by default — safe to run on your workstation.

```bash
# Install globally
npm install -g siclaw

# Run (interactive — prompts for LLM provider on first launch)
siclaw

# Single-shot
siclaw --prompt "Why is pod nginx-abc in CrashLoopBackOff?"

# Continue last session
siclaw --continue
```

**Paired with a local server** (see profile 2 below): when `siclaw local` is running in the same working directory, the TUI automatically pairs with it and treats the Portal Web UI as the source of truth for skills, knowledge, credentials, agents, and LLM providers. Useful slash commands in that mode:

| Command | What it does |
|---|---|
| `/ls` | Summary of the current session's skills / knowledge / MCP / credentials / agents |
| `/ls skills` / `/ls credentials` / `/ls agents` / ... | Full listing for one category |
| `/agent` | Show current Portal agent and all available ones; create / edit happens in Portal Web UI |
| `/setup` | Read-only view of configured resources with "Open in Portal →" links |

Pass `--agent <name>` to scope the session to one Portal-configured agent (its bound skills / credentials / knowledge / MCP / preferred model). `siclaw agents` lists them non-interactively from the shell.

<details>
<summary><b>Build from source</b></summary>

```bash
git clone https://github.com/scitix/siclaw.git && cd siclaw
npm ci && make build-portal-web && npm run build
npm link                 # register `siclaw` command globally

siclaw                   # TUI mode
siclaw --prompt "..."    # single-shot mode

# Uninstall: npm unlink siclaw -g
```

</details>

> **Tip:** Any OpenAI-compatible endpoint works — swap `baseUrl` for DeepSeek, Qwen, Kimi, or a local Ollama server.

### 2. Local Server — VM or laptop, recommended for daily use

A lightweight web UI backed by SQLite. No MySQL, no Docker required.

```bash
npm install -g siclaw

# Start the server
siclaw local

# Open http://localhost:3000
# On first visit: register the first user (becomes admin)
# Configure providers in Models
# Import kubeconfigs in Clusters
```

<details>
<summary><b>Build from source</b></summary>

```bash
git clone https://github.com/scitix/siclaw.git && cd siclaw
npm ci && make build-portal-web && npm run build
npm link                 # register `siclaw` command globally

siclaw local             # start local server

# Uninstall: npm unlink siclaw -g
```

</details>

On first launch, open the web UI and **register the first user** — registration is open for the very first account and that account becomes the admin. Subsequent registrations require admin authentication.

**Data locations (defaults, override with env vars):**
- Database: `.siclaw/data/portal.db` — override with `DATABASE_URL=sqlite:///custom/path.db` or `DATABASE_URL=mysql://...`
- Secrets: `.siclaw/local-secrets.json` — auto-generated JWT / Runtime / Portal secrets, 0600 perms

### 3. Kubernetes — Team / enterprise

Production deployment uses Helm plus three container images: `runtime`, `portal`, and `agentbox`.

Build and push images if you are using your own registry:

```bash
make docker REGISTRY=registry.example.com/myteam TAG=latest
make push  REGISTRY=registry.example.com/myteam TAG=latest
```

Then deploy the chart with a MySQL URL:

```bash
helm upgrade --install siclaw ./helm/siclaw \
  --namespace siclaw \
  --create-namespace \
  --set image.registry=registry.example.com/myteam \
  --set image.tag=latest \
  --set database.url="mysql://user:pass@host:3306/siclaw"
```

The default chart exposes the **Portal** Service on service port `3003` and NodePort `31003`. Runtime and AgentBox run as ClusterIP-only services (internal traffic).

## Configuration

### TUI / CLI

- TUI reads `.siclaw/config/settings.json` in **standalone mode** (no local Portal running in the same cwd)
- The first-run wizard can generate `settings.json` for you — but **if a `siclaw local` server is running in the same cwd, the wizard will redirect you to the Portal Web UI** instead (Portal is the single source of truth in that mode)
- Kubernetes credentials should be imported through `/setup` in standalone TUI; in Portal-paired TUI, `/setup` becomes a read-only view and mutations happen in the Web UI
- Investigation traces are written to `.siclaw/traces/` (relative to where Siclaw was launched)

Minimal example:

```json
{
  "providers": {
    "default": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-YOUR-KEY",
      "api": "openai-completions",
      "models": [{ "id": "gpt-4o", "name": "GPT-4o" }]
    }
  }
}
```

### Local Server / Kubernetes

All configuration happens through the web UI:

- Configure LLM providers in **Models**
- Import kubeconfigs in **Clusters**
- Import SSH hosts and credentials in **Hosts**
- Configure Slack, Lark, Discord, and Telegram in **Channels**
- Configure MCP servers in **MCP**
- Manage users and roles in **Users**
- Schedule recurring investigations in **My Tasks**

## Documentation

- [Getting Started](https://docs.siclaw.ai/start/getting-started)
- [CLI & Local Server](https://docs.siclaw.ai/install/cli)
- [Kubernetes Deployment](https://docs.siclaw.ai/install/kubernetes)
- [LLM Providers](https://docs.siclaw.ai/configuration/providers)
- [MCP Servers](https://docs.siclaw.ai/configuration/mcp)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ (ESM-only) |
| Language | TypeScript 5.9 |
| Agent | [pi-coding-agent](https://github.com/badlogic/pi-mono) |
| Database (portal) | MySQL (prod) or SQLite (local, via [node:sqlite](https://nodejs.org/api/sqlite.html)) — single DDL, driver chosen by `DATABASE_URL` scheme |
| Database (memory) | node:sqlite + FTS5 + bge-m3 embeddings |
| Frontend | React + Vite + Tailwind CSS |
| K8s Client | @kubernetes/client-node |
| MCP | @modelcontextprotocol/sdk |
| Realtime | WebSocket (ws) |

## Community

- [Slack](https://join.slack.com/t/siclaw-scitix/shared_invite/zt-3rrsoc2ic-JIfbfvT1_04sqgQorSRfmw) — Chat with the team and other users
- [GitHub Issues](https://github.com/scitix/siclaw/issues) — Bug reports and feature requests
- [GitHub Discussions](https://github.com/scitix/siclaw/discussions) — Questions, ideas, and general discussion

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture overview, and pull request guidelines.

Looking for a place to start? Check out issues labeled [`good first issue`](https://github.com/scitix/siclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## License

[Apache License 2.0](LICENSE)
