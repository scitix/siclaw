# Technology Stack

## Runtime & Language

- **Runtime**: Node.js >=22.12.0 (enforced in `package.json` `engines` field)
- **Language**: TypeScript 5.9, strict mode, ESM-only (`"type": "module"`)
- **Module resolution**: Node16 (`tsconfig.json` `moduleResolution: "Node16"`)
- **Compilation target**: ES2022 (`tsconfig.json` `target: "ES2022"`)
- **Output directory**: `dist/` (backend), `src/gateway/web/dist/` (frontend)

## Frameworks & Libraries

### Backend (Node.js / TypeScript)

- **HTTP server**: Node.js built-in `node:http` / `node:https` — no Express or Fastify
- **WebSockets**: `ws` ^8.18.0 — real-time bidirectional communication between Gateway, AgentBox, and browser clients
- **Agent core (primary)**: `@mariozechner/pi-coding-agent` ^0.55.3 — pi-agent brain with `AgentSession`, `DefaultResourceLoader`, `SessionManager`, tool definitions; entry in `src/core/brains/pi-agent-brain.ts`
- **Agent core (secondary)**: `@anthropic-ai/claude-agent-sdk` ^0.1.58 — Claude SDK brain path; entry in `src/core/brains/claude-sdk-brain.ts`
- **Anthropic API**: `@anthropic-ai/sdk` ^0.71.2 — direct Anthropic API access
- **MCP protocol**: `@modelcontextprotocol/sdk` ^1.27.1 — Model Context Protocol for external tool servers; client manager in `src/core/mcp-client.ts`
- **ORM**: `drizzle-orm` ^0.45.1 — typed SQL for both SQLite and MySQL backends
- **Type validation (pi-agent tools)**: `@sinclair/typebox` ^0.34.0
- **Type validation (SDK tools)**: `zod` ^3.24.0
- **Kubernetes SDK**: `@kubernetes/client-node` ^1.4.0 — K8s spawner and pod operations; used in `src/gateway/agentbox/k8s-spawner.ts`
- **TLS/PKI**: `node-forge` ^1.3.3 — X.509 certificate generation for mTLS (Gateway acts as CA); `src/gateway/security/cert-manager.ts`
- **Metrics**: `prom-client` ^15.1.3 — Prometheus metrics exposition; `src/gateway/metrics-aggregator.ts`
- **YAML**: `js-yaml` ^4.1.1
- **Markdown**: `markdown-it` ^14.1.0
- **Diff**: `diff` ^8.0.3

### Frontend (React SPA — `src/gateway/web/`)

- **Framework**: React 18.3.1 with React DOM
- **Build tool**: Vite ^5.2.13 with `@vitejs/plugin-react`
- **Routing**: `react-router-dom` ^6.23.1
- **Styling**: Tailwind CSS ^3.4.4 + PostCSS + `tailwind-merge`
- **Animations**: `framer-motion` ^11.2.10
- **Icons**: `lucide-react` ^0.395.0
- **Charts**: `recharts` ^3.8.0
- **Markdown rendering**: `react-markdown` ^10.1.0 + `remark-gfm`
- **Code editor**: `react-simple-code-editor` ^0.14.1 with `prismjs` syntax highlighting
- **Utilities**: `clsx`

### Messaging Channels (optional dependencies)

- **Lark / Feishu**: `@larksuiteoapi/node-sdk` ^1.56.1; `src/gateway/channels/lark.ts`
- **Slack**: `@slack/bolt` ^4.6.0 + `@slack/web-api` ^7.14.1; `src/gateway/channels/slack.ts`
- **DingTalk**: `dingtalk-stream-sdk-nodejs` ^2.0.4
- **Discord**: `discord.js` ^14.16.0; `src/gateway/channels/discord.ts`
- **Telegram**: `grammy` ^1.41.1; `src/gateway/channels/telegram.ts`

## Package Manager & Build

- **Package manager**: npm (lockfile: `package-lock.json`)
- **Backend build**: `tsc` (TypeScript compiler) → `dist/`
- **Frontend build**: Vite (`src/gateway/web/`) → `src/gateway/web/dist/` then copied to `dist/gateway/web/dist/`
- **Publish flow**: `prepublishOnly` script runs `build:web` then `build`
- **Dev runner**: `tsx` ^4.21.0 — TypeScript execution without compilation for development
- **Container builds**: Multi-stage Dockerfiles (`Dockerfile.gateway`, `Dockerfile.agentbox`) using `node:22-slim` base image

## Key Dependencies (with versions)

| Package | Version | Purpose |
|---------|---------|---------|
| `@mariozechner/pi-coding-agent` | ^0.55.3 | Primary agent brain |
| `@anthropic-ai/claude-agent-sdk` | ^0.1.58 | Secondary agent brain (claude-sdk) |
| `@anthropic-ai/sdk` | ^0.71.2 | Anthropic API client |
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP client/server |
| `@kubernetes/client-node` | ^1.4.0 | Kubernetes API |
| `drizzle-orm` | ^0.45.1 | ORM (SQLite + MySQL) |
| `sql.js` | ^1.12.0 | SQLite WASM (Gateway DB) |
| `sqlite-vec` | ^0.1.7-alpha.2 | Vector similarity search extension for node:sqlite |
| `mysql2` | ^3.16.3 | MySQL driver |
| `node-forge` | ^1.3.3 | X.509 / mTLS PKI |
| `prom-client` | ^15.1.3 | Prometheus metrics |
| `ws` | ^8.18.0 | WebSocket server/client |
| `zod` | ^3.24.0 | Schema validation (SDK tools) |
| `@sinclair/typebox` | ^0.34.0 | Schema validation (pi-agent tools) |
| `@clack/prompts` | ^1.1.0 | TUI interactive prompts |
| `vitest` | ^3.0.0 | Test runner |
| `drizzle-kit` | ^0.31.8 | DB schema migrations |
| `typescript` | ^5.9.0 | Compiler |

## Configuration

- **Primary config file**: `.siclaw/config/settings.json` (resolved by `src/core/config.ts`; overridable via `SICLAW_CONFIG_DIR` env var)
- **Example template**: `settings.example.json` in repo root
- **Key config sections**:
  - `providers` — LLM API keys, base URLs, model definitions (OpenAI, Anthropic, or any OpenAI-compatible API)
  - `embedding` — embedding API endpoint + model (default: `BAAI/bge-m3`, 1024 dimensions)
  - `paths` — `userDataDir`, `skillsDir`, `credentialsDir`, `reposDir`, `docsDir`
  - `server` — port and gateway URL
  - `mcpServers` — external MCP server definitions
  - `metrics` — Prometheus scrape port and token
- **Environment variable overrides** (deployment/infra only, not credentials):
  - `SICLAW_CONFIG_DIR`, `SICLAW_AGENTBOX_PORT`, `SICLAW_USER_DATA_DIR`, `SICLAW_SKILLS_DIR`
  - `SICLAW_CREDENTIALS_DIR`, `SICLAW_REPOS_DIR`, `SICLAW_DOCS_DIR`, `SICLAW_GATEWAY_URL`
  - `SICLAW_DATABASE_URL` — selects SQLite (`sqlite:`) or MySQL (`mysql://`) for Gateway DB
  - `SICLAW_SSO_ISSUER`, `SICLAW_SSO_CLIENT_ID`, `SICLAW_SSO_CLIENT_SECRET`, `SICLAW_SSO_REDIRECT_URI`
- **Gateway DB path**: `.siclaw/data.sqlite` (default SQLite); `SICLAW_DATABASE_URL` for MySQL
- **Memory DB path**: `.siclaw/user-data/memory/` — separate `node:sqlite` database per user

## Development Tools

- **Test runner**: `vitest` ^3.0.0 — `npm test` runs all `.test.ts` files
- **Type checking**: `npx tsc --noEmit`
- **Dev server (TUI)**: `npm run dev` → `tsx src/cli-main.ts`
- **Dev server (Gateway)**: `npm run dev:gateway` → `tsx src/gateway-main.ts`
- **Dev server (AgentBox)**: `npm run dev:agentbox` → `tsx src/agentbox-main.ts`
- **DB schema tool**: `drizzle-kit` ^0.31.8
- **Docker build targets**: `npm run docker:build:gateway`, `npm run docker:build:agentbox`
- **Kubernetes deployment**: Helm chart at `helm/siclaw/`, raw manifests at `k8s/`
