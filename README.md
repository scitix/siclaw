<div align="center">

<img src="docs/assets/logo.png" alt="Siclaw Logo" width="400" />

# Siclaw

**Read-only investigation copilot for DevOps and SRE teams**

[![npm](https://img.shields.io/npm/v/siclaw?logo=npm)](https://www.npmjs.com/package/siclaw)
[![CI](https://github.com/scitix/siclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/scitix/siclaw/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Slack](https://img.shields.io/badge/Slack-Join%20Community-4A154B?logo=slack&logoColor=white)](https://join.slack.com/t/siclaw-scitix/shared_invite/zt-3rrsoc2ic-JIfbfvT1_04sqgQorSRfmw)

[Website](https://www.siclaw.ai) | [Live Preview](https://www.siclaw.ai/demo/) | [Documentation](https://docs.siclaw.ai) | [Slack](https://join.slack.com/t/siclaw-scitix/shared_invite/zt-3rrsoc2ic-JIfbfvT1_04sqgQorSRfmw)

</div>

---

Siclaw is an open-source AI agent for DevOps and SRE teams. It is built for **read-only infrastructure diagnostics**: gather evidence, form hypotheses, validate them, and return a clear root-cause analysis without changing your environment directly. Describe a problem in plain language and Siclaw investigates it from the web UI, your team's chat channels, or a non-interactive CLI invocation.

A hosted preview of the Portal UI — 4 specialist agents, recorded investigation sessions, and the built-in diagnostic skill set — is available at **[siclaw.ai/demo](https://www.siclaw.ai/demo/)**.

## Features

- **Deep Investigation** — A 4-phase workflow for evidence gathering, hypothesis testing, and root-cause analysis
- **Investigation Memory** — Learns from past incidents to improve future investigations
- **Read-Only by Default** — Investigates and recommends next steps without changing your environment directly
- **Team Workflows** — Shared web UI, credentials, channels, triggers, and scheduled patrols
- **Reusable Skills** — Turn repeated diagnostic playbooks into reviewable runbooks
- **Extensible** — Connect external tools and data sources through [MCP](https://modelcontextprotocol.io)
- **Multi-Channel Access** — Use Siclaw from the web UI, chat channels, or non-interactive CLI
- **Agent Tracing** — Export agent behavior (LLM calls, tools, tokens) to [Langfuse](https://langfuse.com), [Phoenix](https://phoenix.arize.com), or any OTLP backend; configured in the web UI and hot-reloaded live

## Architecture

![Siclaw System Architecture](docs/assets/architecture.svg)

> **Control plane** (Portal + Gateway + shared DB) stores the curated agents and their
> bound resources — Skills, a versioned Knowledge wiki, MCP servers, and Credentials.
> Sessions use an **AgentBox** (one Pod per user in Kubernetes, or in-process in local dev).
> The headless CLI embeds the same core directly. The
> Agent Brain runs a Deep Investigation Engine against its bound capabilities —
> read-only across every target it touches.

## Prerequisites

- **Node.js >= 22.19.0** — [Download](https://nodejs.org/)
- **npm** — Comes with Node.js
- **kubectl** — Optional, only needed if you want Siclaw to investigate Kubernetes clusters

## Quick Start

Start with the local Web UI, or deploy to Kubernetes for a team. The CLI also supports non-interactive diagnostic runs. For local usage, start from a dedicated working directory because Siclaw stores most runtime data in `.siclaw/` relative to where you launch it.

```bash
mkdir -p ~/siclaw-work
cd ~/siclaw-work
```

### 1. Local Server — VM or laptop, recommended for daily use

A lightweight web UI backed by SQLite. No MySQL, no Docker required.

```bash
npm install -g siclaw

# Start the server
siclaw local

# Open http://localhost:3000
# On a fresh local workspace: sign in with admin / admin
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

A fresh local workspace creates the bootstrap account **admin / admin**. Open the Web UI and change its password in **Account**. Configure a model and select an agent to begin an investigation.

**Data locations (defaults, override with env vars):**
- Database: `.siclaw/data/portal.db` — override with `DATABASE_URL=sqlite:///custom/path.db` or `DATABASE_URL=mysql://...`
- Secrets: `.siclaw/local-secrets.json` — auto-generated JWT / Runtime / Portal secrets, 0600 perms

#### Non-interactive CLI

In another terminal, use the same working directory to run a single investigation with the local Portal's configuration:

```bash
siclaw agents
siclaw --agent sre-oncall --prompt "Why is pod nginx-abc in CrashLoopBackOff?"
siclaw --agent sre-oncall --continue --prompt "Check recent events"
```

Use a name returned by `siclaw agents`. A single configured agent is selected automatically; with multiple agents, `--agent` is required. The invocation prints the final answer and exits. Missing input or model configuration produces an error instead of a setup prompt.

The CLI reads Portal configuration through a local authenticated snapshot API. Each invocation materializes skills, knowledge, and credentials under a private `.siclaw/.portal-snapshot/run-<random>/` root and removes only that root on exit. Web UI changes apply to the next invocation. For custom ports, set `PORTAL_PORT` on the server and `SICLAW_PORTAL_PORT` on the CLI to the same value.

When Portal is unavailable and no agent was selected, the CLI uses `.siclaw/config/settings.json` and local resources. A selected agent must load successfully; snapshot failures stop execution. See [CLI configuration](#headless-cli) below and the [Portal integration guide](https://docs.siclaw.ai/features/portal-cli-integration).

> **Terminal interface migration:** Bare `siclaw` now shows help. Use `siclaw local` for interactive investigations. Terminal slash commands and the setup wizard have been removed; `--continue` requires a new `--prompt`. Existing `--print --prompt "..."` scripts remain supported.

### 2. Kubernetes — Team / enterprise

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

### Headless CLI

- A reachable local Portal supplies providers and agent-bound resources. Configure these in its Web UI.
- Without Portal, prepare `.siclaw/config/settings.json` before running `siclaw --prompt "..."`.
- For cluster and host access, import credentials in the local Web UI and run the CLI from that workspace.
- Investigation traces are written to `.siclaw/traces/` relative to the working directory.

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
- [Agent Tracing](https://docs.siclaw.ai/features/tracing)

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
