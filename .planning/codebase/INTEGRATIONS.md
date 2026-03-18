# External Integrations

## Databases

### Gateway Database (primary operational store)

- **Engine**: sql.js ^1.12.0 (SQLite WASM, zero native deps) for default/SQLite mode; MySQL 8+ via `mysql2` ^3.16.3 for production multi-node deployments
- **ORM**: Drizzle ORM ^0.45.1 with two schema files: `src/gateway/db/schema-sqlite.ts` and `src/gateway/db/schema-mysql.ts`
- **Selection**: `SICLAW_DATABASE_URL` env var — `sqlite:` or `file:` prefix selects sql.js; `mysql://` prefix selects MySQL; default is `sqlite:.siclaw/data.sqlite`
- **Single-process lock**: sql.js loads the entire DB into memory; a PID lockfile (`.siclaw/data.sqlite.lock`) prevents concurrent multi-process access; implemented in `src/gateway/db/index.ts`
- **Persistence**: sql.js in-memory DB is flushed to disk every 30 seconds and on clean shutdown; `flushSqliteDb()` for immediate flush
- **Tables**: `users`, `user_profiles`, `sessions`, `messages`, `skills`, `skill_contents`, `skill_versions`, `skill_reviews`, `channels`, `cron_jobs`, `cron_job_runs`, `cron_instances`, `skill_votes`, `notifications`, `model_providers`, `model_entries`, `embedding_config`, `workspaces`, `workspace_skills`, `workspace_tools`, `workspace_environments`, `workspace_credentials`, `user_disabled_skills`, `environments`, `user_env_configs`, `triggers`, `credentials`, `user_permissions`, `mcp_servers`, `session_stats`, `system_config`
- **Migration strategy**: DDL statements maintained in `src/gateway/db/migrate-sqlite.ts`; new tables require entries in both `schema-sqlite.ts` and `migrate-sqlite.ts`

### Memory Database (vector + FTS search store)

- **Engine**: `node:sqlite` (Node.js 22 built-in native SQLite) — separate from Gateway DB
- **Vector extension**: `sqlite-vec` ^0.1.7-alpha.2 — loaded as a native extension for ANN vector search; falls back to in-memory cosine similarity if unavailable
- **Schema**: defined in `src/memory/schema.ts` — tables: `meta`, `files`, `chunks`, `embedding_cache`, `investigations`; FTS5 virtual table `chunks_fts` with auto-sync triggers
- **Location**: `.siclaw/user-data/memory/memory.db` per user
- **Search mode**: hybrid — vector similarity (70% weight) + FTS5 BM25 (30% weight) + temporal decay + Maximal Marginal Relevance (MMR) re-ranking; implemented in `src/memory/indexer.ts`
- **Embeddings**: OpenAI-compatible embedding API; default model `BAAI/bge-m3` at 1024 dimensions; configurable via `embedding` section in `settings.json`

## APIs & Services

### LLM Providers

- **Anthropic API** (`https://api.anthropic.com/v1`) — Claude models (claude-sonnet-4, etc.)
- **OpenAI API** (`https://api.openai.com/v1`) — GPT-4o and other models
- **Any OpenAI-compatible API** — Qwen (DashScope), DeepSeek, Ollama, vLLM, etc.; configured via `providers` in `settings.json` with `api: "openai-completions"`
- **LLM proxy**: when an OpenAI-compatible provider is configured with the claude-sdk brain, an in-process proxy translates OpenAI API calls; `src/core/llm-proxy.ts`
- **Provider configuration**: stored in `.siclaw/config/settings.json`; API keys are never in environment variables

### Embedding API

- **Protocol**: OpenAI-compatible `/embeddings` endpoint (POST)
- **Default model**: `BAAI/bge-m3` (1024 dimensions)
- **Batch strategy**: token-bounded batches (max 8,000 tokens or 100 items per request) with exponential backoff retries
- **Client**: `src/memory/embeddings.ts`

### Kubernetes API

- **Client**: `@kubernetes/client-node` ^1.4.0
- **Usage**: K8s spawner (`src/gateway/agentbox/k8s-spawner.ts`) creates/deletes/monitors AgentBox pods; `kubectl` binary is installed in AgentBox container for diagnostic commands
- **kubectl access**: read-only (13 safe subcommands allowed); binary has setgid `kubecred` group for kubeconfig access without exposing credentials to `sandbox` child processes (ADR-010)

### Model Context Protocol (MCP)

- **SDK**: `@modelcontextprotocol/sdk` ^1.27.1
- **Client**: `src/core/mcp-client.ts` — `McpClientManager` connects to user-configured external MCP servers at session initialization
- **Server registry**: MCP server definitions stored in Gateway DB (`mcp_servers` table) and in `settings.json`; synced to AgentBox via resource bundle
- **Transports**: stdio (command-based) and HTTP/SSE (URL-based)

### Metrics / Observability

- **Prometheus**: `prom-client` ^15.1.3 — AgentBox exposes metrics at configurable port; Gateway aggregates metrics from all pods in K8s mode via 30-second pull loop (`src/gateway/metrics-aggregator.ts`)
- **Grafana**: pre-built dashboard definition at `helm/siclaw/dashboards/siclaw-overview.json` — tracks sessions, prompts, tokens, costs, tool usage, and health
- **Internal metrics endpoint**: `/api/internal/metrics-snapshot` (mTLS-protected in K8s mode) for Gateway → AgentBox metric pull

## Authentication

### Local Username/Password

- **Password storage**: bcrypt-hashed passwords in `users.password_hash` column
- **Session tokens**: custom JWT implementation using Node.js built-in `crypto.createHmac("sha256")` (HS256); 24-hour expiry; `src/gateway/auth/jwt.ts`
- **Token transport**: `Authorization: Bearer <token>` header; verified by `src/gateway/auth/middleware.ts`

### SSO / OAuth2 (OIDC)

- **Protocol**: OAuth2 Authorization Code Flow with OIDC extensions
- **Compatible providers**: Dex (primary target), any OIDC-compliant IdP
- **Configuration**: env vars `SICLAW_SSO_ISSUER`, `SICLAW_SSO_CLIENT_ID`, `SICLAW_SSO_CLIENT_SECRET`, `SICLAW_SSO_REDIRECT_URI`; or DB overrides via `system_config` table keys `sso.issuer`, `sso.clientId`, etc.
- **Scopes requested**: `openid profile email`
- **CSRF protection**: cryptographic random state tokens with 5-minute TTL; `src/gateway/auth/oauth2.ts`
- **Implementation**: `src/gateway/auth/oauth2.ts` — `buildAuthorizeUrl()`, `exchangeCode()`, `fetchUserInfo()`

### Channel Binding

- **6-digit bind codes**: time-limited codes stored in `BindCodeStore` (`src/gateway/auth/bind-code-store.ts`); users enter `/bind <code>` in a messaging channel to link their channel identity to their Siclaw account

### mTLS (K8s mode only)

- **CA**: Gateway generates a self-signed RSA 4096-bit CA certificate at startup; CA cert and key persisted in `system_config` table; `src/gateway/security/cert-manager.ts`
- **Client certs**: each AgentBox pod receives a unique RSA 2048-bit client certificate embedding identity (`userId`, `workspaceId`, `boxId`, environment) in X.509 subject fields; 30-day validity
- **Verification**: Gateway verifies client certs against its CA on every mTLS request; identity extracted from subject CN/OU/serialNumber fields
- **Scope**: mTLS is exclusively for Gateway ↔ AgentBox internal API (port 3002); not used in local/process spawner modes

## Message Queues / Events

### Internal Event Bus

- **Implementation**: in-process diagnostic events (`src/shared/diagnostic-events.ts`) — no external message broker; events include `ws_connected`, `ws_disconnected`, `session_released`
- **Resource notifications**: Gateway pushes reload notifications to AgentBox pods over the same WebSocket connection used for prompts; `src/gateway/resource-notifier.ts`

### WebSocket Protocol

- **Library**: `ws` ^8.18.0
- **Protocol**: custom binary-framed protocol (`src/gateway/ws-protocol.ts`) — bidirectional RPC + streaming over a single WebSocket connection between browser/channel client and Gateway, and between Gateway and AgentBox

### Cron / Scheduling

- **Implementation**: in-process scheduler merged into Gateway (`src/gateway/cron/cron-service.ts`); no external queue
- **Coordination**: DB-based distributed locking via `cron_instances` and `cron_jobs` tables — prevents duplicate execution across multiple Gateway replicas; heartbeat every 30 seconds
- **Persistence**: cron jobs stored in Gateway DB `cron_jobs` and `cron_job_runs` tables

## Monitoring & Observability

### Prometheus

- **Client**: `prom-client` ^15.1.3
- **Metrics exposed**: active sessions, WS connections, prompt counts/errors/duration, token usage (input/output/cache), tool call success/error rates, skill call statistics
- **Scrape endpoint**: configurable port (default separate from app port); optional bearer token auth via `metrics.token` in config
- **Aggregation**: `MetricsAggregator` in `src/gateway/metrics-aggregator.ts` — local mode proxies `LocalCollector`; K8s mode pulls snapshots from all AgentBox pods every 30 seconds

### Grafana

- **Dashboard**: `helm/siclaw/dashboards/siclaw-overview.json` — "Siclaw Overview" dashboard with panels for sessions, prompts, token counts, cost, top tools, and health
- **Data source**: Prometheus (variable `DS_PROMETHEUS`)
- **Deployment**: included in Helm chart at `helm/siclaw/`

### Health Checks

- **Gateway**: `GET /api/health` — HTTP 200 if healthy; used by Docker `HEALTHCHECK` in `Dockerfile.gateway`
- **AgentBox**: `GET /health` — checked over both HTTPS (mTLS) and HTTP fallback in `Dockerfile.agentbox`
- **Kubernetes probes**: liveness/readiness via health endpoints; `k8s/agentbox-headless-service.yaml`, `k8s/agentbox-podmonitor.yaml`
