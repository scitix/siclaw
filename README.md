# Siclaw

AI-powered SRE platform that turns natural language into Kubernetes diagnostics.

Siclaw gives every engineer an on-call copilot — describe a problem in plain language, and the agent runs kubectl, reads logs, traces network paths, and delivers a root-cause analysis. It works from a terminal, a web UI, or directly inside Feishu / DingTalk / Discord.

## Core Capabilities

### Autonomous Kubernetes Diagnostics

The agent has 20+ built-in tools (restricted bash, kubectl, node/pod exec, network namespace introspection) and follows a **safe-by-default** principle — read-only by default, explicit confirmation before any mutation.

### Deep Investigation

For complex incidents, activate **Deep Investigation** mode. The engine runs a structured 4-phase workflow:

1. **Triage** — Confirm symptoms with quick commands
2. **Hypotheses** — Rank possible root causes (user picks which to explore)
3. **Deep Search** — Spawn parallel sub-agents to validate each hypothesis with budget control
4. **Conclusion** — Synthesize findings into actionable recommendations

### Skill System

Skills are reusable diagnostic playbooks (a SKILL.md spec + shell scripts) that the agent discovers and executes at runtime.

| Tier | Location | Description |
|------|----------|-------------|
| Core | `skills/core/` | Built-in (node logs, network gateway, image pull debug, etc.) |
| Team | `skills/team/` | Shared across all users, admin-managed |
| Personal | `skills/user/` | Per-user, created via the `create_skill` tool |

Skills are hot-reloadable — update on disk or via the web editor, and active sessions pick up changes instantly.

### Multi-User Gateway

A central HTTP + WebSocket server that manages isolated **AgentBox** pods (one per user per workspace) on Kubernetes.

- **Web UI** — React frontend with chat, skill editor, cron scheduler, credential vault
- **IM Channels** — Feishu, DingTalk, Discord (route messages through AgentBox pods)
- **SSO** — OIDC/Dex integration, or local username/password
- **Cron** — Schedule recurring agent tasks with multi-instance HA coordination
- **Triggers** — Webhook endpoints for Prometheus / PagerDuty / custom alerts
- **Workspaces** — Per-project isolation of skills, tools, environments, and credentials

### Pluggable LLM Backend

Siclaw supports two agent runtimes and any OpenAI-compatible LLM provider:

| Brain | Package | Best for |
|-------|---------|----------|
| `pi-agent` | `@mariozechner/pi-coding-agent` | OpenAI-compatible providers (Qwen, DeepSeek, Kimi, etc.) |
| `claude-sdk` | `@anthropic-ai/claude-agent-sdk` | Anthropic Claude with native tool use |

Configure providers from the **Settings** page in the web UI — switch models per session.

### MCP Tool Servers

Extend the agent with external [Model Context Protocol](https://modelcontextprotocol.io) servers. Supports stdio, SSE, and streamable-http transports. Configure in `.siclaw/config/settings.json` (see `settings.example.json`).

### Persistent Memory

The agent maintains a per-user memory store (markdown files + vector embeddings) that survives across sessions. Past investigations, environment quirks, and team conventions are automatically recalled.

## Architecture

```
  Web UI / IM Channel / Webhook
              │
              ▼
  ┌───────────────────────┐
  │       Gateway          │  Control plane: auth, routing, DB, cron
  │    (HTTP + WebSocket)  │
  └──────────┬────────────┘
             │ K8s API
             ▼
  ┌───────────────────────┐
  │      AgentBox Pod      │  Execution plane: one per user per workspace
  │  ┌─────────────────┐  │
  │  │  Agent Runtime   │  │  pi-agent or claude-sdk
  │  │  ┌───────────┐  │  │
  │  │  │  Tools     │  │  │  kubectl, bash, node_exec, deep_search, ...
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

## Quick Start

### CLI Mode (Local Development)

```bash
npm ci
npm run build

# Interactive TUI
node siclaw-tui.mjs

# Single-shot
node siclaw-tui.mjs --prompt "Why is pod nginx-abc in CrashLoopBackOff?"
```

Requires `.siclaw/config/settings.json` with at least one LLM provider and a valid kubeconfig:

```bash
mkdir -p .siclaw/config
cp settings.example.json .siclaw/config/settings.json
# Edit .siclaw/config/settings.json with your LLM provider details
```

### Gateway Mode (Multi-User)

```bash
# Set required env vars
export SICLAW_DATABASE_URL="mysql://user:pass@host:3306/siclaw"
export SICLAW_JWT_SECRET="your-secret"
export SICLAW_LLM_API_KEY="your-api-key"

# Start gateway
node siclaw-gateway.mjs          # local spawner
node siclaw-gateway.mjs --k8s    # K8s pod spawner

# Open http://localhost:3000
```

### Docker (Production)

```bash
# Build all images
make build-docker

# Deploy to K8s
make deploy
```

Three images: `siclaw-gateway`, `siclaw-agentbox`, `siclaw-cron`.

## Configuration

### Files

| File | Purpose |
|------|---------|
| `settings.example.json` | Example config — copy to `.siclaw/config/settings.json` |
| `skills/core/` | Built-in diagnostic skills |
| `k8s/` | Kubernetes deployment manifests |

### Environment Variables

**Gateway:**

| Variable | Description |
|----------|-------------|
| `SICLAW_DATABASE_URL` | MySQL connection string |
| `SICLAW_JWT_SECRET` | JWT signing secret |
| `SICLAW_LLM_API_KEY` | API key for LLM provider |
| `SICLAW_AGENTBOX_IMAGE` | AgentBox container image |
| `SICLAW_K8S_NAMESPACE` | Kubernetes namespace (default: `default`) |
| `SICLAW_SSO_ISSUER` | OIDC issuer URL (enables SSO) |
| `SICLAW_S3_ENDPOINT` | S3-compatible endpoint for skill/session backup |
| `SICLAW_CRON_SERVICE_URL` | Cron worker service URL |

**AgentBox:**

| Variable | Description |
|----------|-------------|
| `SICLAW_LLM_API_KEY` | API key (injected from K8s secret) |
| `SICLAW_GATEWAY_URL` | Internal gateway URL |
| `SICLAW_DEBUG_IMAGE` | Debug pod image (default: `busybox:latest`) |
| `SICLAW_EMBEDDING_BASE_URL` | Embedding API for memory indexing |

SSO, S3, and system URLs can also be configured from the **Settings > System** page in the web UI (admin only, stored in DB).

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
│   ├── rpc-methods.ts       # All RPC handlers
│   ├── auth/                # JWT, SSO, user store
│   ├── agentbox/            # K8s pod spawner + local spawner
│   ├── channels/            # IM platform integrations
│   ├── db/                  # Drizzle ORM schema + repositories
│   └── web/                 # React frontend (Vite + Tailwind)
├── lib/
│   ├── s3-storage.ts        # S3/OSS for skill versions
│   └── s3-backup.ts         # Session JSONL backup
skills/
├── core/                    # Built-in skills (8)
├── team/                    # Team-shared skills
└── extension/               # Optional extension skills
k8s/                         # Kubernetes manifests
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ (ESM-only) |
| Language | TypeScript 5.8 |
| Agent | pi-coding-agent / claude-agent-sdk |
| Database | MySQL + Drizzle ORM |
| Frontend | React + Vite + Tailwind CSS |
| K8s Client | @kubernetes/client-node |
| MCP | @modelcontextprotocol/sdk |
| Realtime | WebSocket (ws) |

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
