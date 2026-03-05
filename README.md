<div align="center">

<img src="docs/assets/logo.png" alt="Siclaw Logo" width="400" />

# Siclaw

**AI-powered SRE copilot — from plain language to root-cause analysis**

[![CI](https://github.com/scitix/siclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/scitix/siclaw/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)


</div>

---

Siclaw gives every engineer an on-call copilot. Describe a problem in plain language and the agent runs kubectl, reads logs, traces network paths, and delivers a root-cause analysis — from a terminal, a web UI, or directly inside Feishu / DingTalk / Discord.

- **Autonomous K8s Diagnostics** — 20+ built-in tools, safe-by-default (read-only unless you confirm)
- **Deep Investigation** — 4-phase hypothesis-driven sub-agent engine for complex incidents
- **Pluggable LLM** — Any OpenAI-compatible provider (Qwen, DeepSeek, GPT-4o …) + Anthropic Claude
- **Skill System** — Hot-reloadable diagnostic playbooks that the agent discovers at runtime

## Features

| | |
|---|---|
| **Terminal UI** — Interactive TUI for local diagnostics with session history and `--prompt` single-shot mode | **Web UI** — React frontend with chat, skill editor, cron scheduler, and credential vault |
| **IM Channels** — Route diagnostics through Feishu, DingTalk, or Discord | **Deep Investigation** — Parallel sub-agents with adaptive budget and structured 4-phase workflow |
| **Skill System** — Core + Team + Personal skill tiers, hot-reloadable from disk or web editor | **MCP Tool Servers** — Extend the agent with external [Model Context Protocol](https://modelcontextprotocol.io) servers |
| **Persistent Memory** — Per-user memory store (markdown + vector embeddings) across sessions | **Webhook Triggers** — Prometheus / PagerDuty / custom alerts trigger agent investigations |

## Architecture

```
  Web UI / IM Channel / Webhook
              │
              ▼
  ┌───────────────────────┐
  │       Gateway          │  Control plane: auth, routing, DB, cron
  │    (HTTP + WebSocket)  │
  └──────────┬────────────┘
             │ K8s API or Process Spawn
             ▼
  ┌───────────────────────┐
  │      AgentBox          │  Execution plane: one per user per workspace
  │  ┌─────────────────┐  │
  │  │  Agent Runtime   │  │  pi-agent or claude-sdk
  │  │  ┌───────────┐  │  │
  │  │  │  Tools     │  │  │  kubectl, bash, node_exec, deep_search …
  │  │  │  Skills    │  │  │  core/ + team/ + personal/
  │  │  │  MCP       │  │  │  external tool servers
  │  │  │  Memory    │  │  │  vector search + markdown
  │  │  └───────────┘  │  │
  │  └─────────────────┘  │
  └───────────────────────┘
              │
              ▼
      Target K8s Clusters
     (user-provided kubeconfig)
```

## Prerequisites

- **Node.js >= 22.12.0** — [Download](https://nodejs.org/)
- **npm** — Comes with Node.js
- **kubectl** — Required for K8s diagnostics ([Install guide](https://kubernetes.io/docs/tasks/tools/))
- A valid **kubeconfig** pointing to your target cluster

## Quick Start

Siclaw supports three deployment profiles. Pick the one that fits your use case.

### 1. TUI Mode — Personal, local, lowest barrier

Run the agent directly in your terminal. No server, no database.

```bash
# Build
npm ci
npm run build

# Configure LLM provider
mkdir -p .siclaw/config
cp settings.example.json .siclaw/config/settings.json
# Edit .siclaw/config/settings.json with your LLM provider details

# Run (interactive)
node siclaw-tui.mjs

# Single-shot
node siclaw-tui.mjs --prompt "Why is pod nginx-abc in CrashLoopBackOff?"

# Continue last session
node siclaw-tui.mjs --continue
```

> **Tip:** Any OpenAI-compatible endpoint works — swap `baseUrl` for DeepSeek, Qwen, Kimi, or a local Ollama server.

### 2. Personal Server — VM or laptop, recommended for daily use

A lightweight web UI backed by SQLite. No MySQL, no Docker required — just start the server and configure everything in the browser.

```bash
npm ci
npm run build
npm run build:web

# Start the server (SQLite database is created automatically)
node siclaw-gateway.mjs --process

# Open http://localhost:3000
# Login: admin / admin (default credentials)
# Go to Settings to configure your LLM provider
```

The server uses SQLite by default and auto-generates a JWT secret on first run. All configuration — LLM providers, models, credentials — is done through the **Settings** page in the web UI.

### 3. Kubernetes — Team / enterprise

Full multi-user deployment with isolated AgentBox pods, SSO, and IM channels.

```bash
# Build images
make build-docker

# Create namespace and secrets
kubectl create namespace siclaw
kubectl create secret generic siclaw-secrets \
  --namespace=siclaw \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" \
  --from-literal=database-url="mysql://user:pass@host:3306/siclaw" \
  --from-literal=llm-api-key="sk-YOUR-KEY"

# Deploy
kubectl apply -f k8s/gateway-deployment.yaml
kubectl apply -f k8s/cron-deployment.yaml
```

See [`k8s/README.md`](k8s/README.md) for the full deployment guide, resource tuning, and HA setup.

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

### Environment Variables

**Gateway / Personal Server:**

| Variable | Description | Default |
|----------|-------------|---------|
| `SICLAW_DATABASE_URL` | `mysql://…` or `sqlite:path` | `sqlite:.siclaw/data.sqlite` |
| `SICLAW_JWT_SECRET` | JWT signing secret | Auto-generated on first run |
| `SICLAW_LLM_API_KEY` | Default LLM API key | Configure in web UI Settings |
| `SICLAW_ADMIN_PASSWORD` | Initial admin password | `admin` |
| `SICLAW_AGENTBOX_IMAGE` | AgentBox container image (K8s mode) | `siclaw-agentbox:latest` |
| `SICLAW_K8S_NAMESPACE` | K8s namespace for AgentBox pods | `default` |
| `SICLAW_BASE_URL` | Public-facing base URL | `http://localhost:3000` |

**AgentBox:**

| Variable | Description |
|----------|-------------|
| `SICLAW_LLM_API_KEY` | API key (injected from K8s secret) |
| `SICLAW_GATEWAY_URL` | Internal gateway URL |
| `SICLAW_DEBUG_IMAGE` | Debug pod image (`busybox:latest`) |
| `SICLAW_EMBEDDING_BASE_URL` | Embedding API for memory indexing |

<details>
<summary><b>SSO / S3 / Cron — advanced variables</b></summary>

| Variable | Description |
|----------|-------------|
| `SICLAW_SSO_ISSUER` | OIDC issuer URL (enables SSO) |
| `SICLAW_SSO_CLIENT_ID` | OIDC client ID |
| `SICLAW_SSO_CLIENT_SECRET` | OIDC client secret |
| `SICLAW_SSO_REDIRECT_URI` | OIDC redirect URI |
| `SICLAW_S3_ENDPOINT` | S3-compatible endpoint for backups |
| `SICLAW_S3_BUCKET` | S3 bucket name |
| `SICLAW_S3_ACCESS_KEY` | S3 access key |
| `SICLAW_S3_SECRET_KEY` | S3 secret key |
| `SICLAW_CRON_SERVICE_URL` | Internal cron service URL |
| `SICLAW_CRON_API_PORT` | Cron API listen port (`3100`) |

SSO, S3, and cron settings can also be configured from **Settings > System** in the web UI (admin only).

</details>

<details>
<summary><b>IM Channels — Feishu / DingTalk / Discord</b></summary>

### Feishu (Lark)

Configure a Feishu bot in **Settings > Channels** of the web UI. You'll need:
- App ID and App Secret from the [Feishu Open Platform](https://open.feishu.cn/)
- Event subscription URL: `https://your-domain/api/channels/feishu/event`
- Scopes: `im:message`, `im:message.group_at_msg`, `im:resource`

### DingTalk

Configure a DingTalk bot in **Settings > Channels**. You'll need:
- Robot webhook URL and signing secret
- Outgoing callback URL: `https://your-domain/api/channels/dingtalk/event`

### Discord

Configure a Discord bot in **Settings > Channels**. You'll need:
- Bot token from the [Discord Developer Portal](https://discord.com/developers/applications)
- Scopes: `bot`, `messages.read`

</details>

## Project Structure

```
src/
├── cli-main.ts              # TUI entry point
├── gateway-main.ts          # Gateway entry point
├── agentbox-main.ts         # AgentBox entry point
├── cron-main.ts             # Cron worker entry point
├── core/
│   ├── agent-factory.ts     # Session factory (tools + brain + skills)
│   ├── prompt.ts            # SRE system prompt
│   ├── brains/              # pi-agent & claude-sdk adapters
│   ├── llm-proxy.ts         # Anthropic → OpenAI translation proxy
│   └── mcp-client.ts        # MCP server management
├── tools/
│   ├── restricted-bash.ts   # Sandboxed shell
│   ├── kubectl.ts           # Read-only kubectl wrapper
│   ├── deep-search/         # Parallel sub-agent investigation
│   ├── node-exec.ts         # K8s node command execution
│   └── ...                  # 20+ tool definitions
├── memory/                  # Vector + keyword search indexer
├── gateway/
│   ├── server.ts            # HTTP + WebSocket server
│   ├── auth/                # JWT, SSO, user store
│   ├── agentbox/            # K8s pod spawner + process spawner
│   ├── channels/            # Feishu, DingTalk, Discord
│   ├── db/                  # Drizzle ORM (MySQL + SQLite)
│   └── web/                 # React frontend (Vite + Tailwind)
├── lib/
│   ├── s3-storage.ts        # S3/OSS for skill versions
│   └── s3-backup.ts         # Session JSONL backup
skills/
├── core/                    # Built-in skills (10)
├── team/                    # Team-shared skills
├── extension/               # Optional extension skills
└── platform/                # Skill management tools
k8s/                         # Kubernetes manifests
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ (ESM-only) |
| Language | TypeScript 5.8 |
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
