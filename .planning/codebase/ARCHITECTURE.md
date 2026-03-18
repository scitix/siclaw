# Architecture

## Overview

Siclaw is an AI-powered SRE copilot for Kubernetes diagnostics. It exposes a single agent core (`createSiclawSession`) through three runtime surfaces: a terminal TUI, a web-based multi-user Gateway, and a headless AgentBox worker that runs as a K8s pod. All three surfaces share the same tool set, system prompt, memory subsystem, and skill execution logic. The agent accumulates investigation knowledge across sessions via a hybrid vector+FTS memory store.

The core architectural pattern is: **one shared session factory + pluggable brain backends + mode-specific interaction layers**.

---

## Runtime Modes

### TUI (single-user terminal)
- Entry: `src/cli-main.ts`
- Spawns a single `createSiclawSession({ mode: "cli" })` directly in the terminal process
- Uses `@mariozechner/pi-coding-agent`'s `InteractiveMode` or `runPrintMode` for I/O
- Memory indexer is created per-session and watches the filesystem
- Startup: first-run setup wizard, LLM config validation, credential check
- Shutdown: auto-saves session memory via `saveSessionKnowledge`, closes MCP connections

### Gateway + LocalSpawner (multi-user, local dev)
- Entry: `src/gateway-main.ts` (no `--k8s` flag)
- Gateway runs as an HTTP/WebSocket server; frontend is a React SPA served from `src/gateway/web/`
- `LocalSpawner` runs AgentBox instances **in-process** on sequential ports (4000+)
- All users share the **same filesystem** — skill writes must be scoped to `skills/user/{userId}/`
- `skillsHandler.materialize()` must NOT be called in this mode
- Resource sync (MCP, skills) bypasses HTTP and calls AgentBox handlers directly

### Gateway + K8sSpawner (production)
- Entry: `src/gateway-main.ts --k8s`
- `K8sSpawner` creates one isolated pod per user via the Kubernetes API
- AgentBox pods run `src/agentbox-main.ts` as an HTTP server (port 3000 by default)
- On pod startup: fetches `settings.json` from Gateway via mTLS, then calls `syncAllResources()` (MCP + skills)
- Communication uses mTLS mutual auth (`CertificateManager`, `createMtlsMiddleware`)
- A separate plain HTTP server on port 9090 serves Prometheus `/metrics` (cannot present mTLS certs)

### Gateway + ProcessSpawner (dev alternative)
- Entry: `src/gateway-main.ts --process`
- Runs AgentBox as a child process; intermediate between local and K8s

---

## Entry Points

| File | Role |
|------|------|
| `src/cli-main.ts` | TUI entry — parses args, runs `createSiclawSession`, starts interactive or print mode |
| `src/gateway-main.ts` | Gateway entry — instantiates spawner, starts HTTP server, boots channels, cron, webhooks |
| `src/agentbox-main.ts` | AgentBox worker — fetches config, syncs resources, starts HTTP server for Gateway to call |
| `siclaw-tui.mjs` | Compiled TUI launcher (top-level) |
| `siclaw-gateway.mjs` | Compiled Gateway launcher |
| `siclaw-agentbox.mjs` | Compiled AgentBox launcher |

---

## Core Layers

### 1. Agent Factory (`src/core/agent-factory.ts`)
The central composition root. `createSiclawSession(opts)` assembles every session component:
- Resolves LLM config and model registry
- Instantiates all tools (execution, skill management, memory, kubectl, deep search)
- Applies workspace tool allow-list and mode-based tool gating
- Constructs path-restricted file I/O wrappers
- Loads `skills/core/`, `skills/extension/`, and dynamic per-user skill directories
- Builds the system prompt via `buildSreSystemPrompt()` and append content (PROFILE.md + MEMORY.md)
- Selects brain implementation (pi-agent or claude-sdk)
- Returns `SiclawSessionResult` with mutable refs for runtime updates (LLM config, skill dirs, session ID)

### 2. Brain Abstraction (`src/core/brain-session.ts`)
`BrainSession` is the unified interface over two LLM backends:
- `PiAgentBrain` (`src/core/brains/pi-agent-brain.ts`) — wraps `@mariozechner/pi-coding-agent` AgentSession; supports pi-agent extensions, context pruning, memory flush
- `ClaudeSdkBrain` (`src/core/brains/claude-sdk-brain.ts`) — wraps `claude-agent-sdk`; uses Zod/MCP tool definitions, mutable DP state

Both expose: `prompt()`, `abort()`, `subscribe()`, `reload()`, `steer()`, `getContextUsage()`, `getSessionStats()`, `getModel()`, `setModel()`.

The event protocol follows the pi-agent wire format so the frontend/CLI code handles both brains uniformly.

### 3. Tool Layer (`src/tools/`)
All tools are pure factory functions returning `ToolDefinition`. Key categories:

**Execution tools** (security-critical):
- `restricted-bash.ts` — shell execution via 6-pass validation pipeline + `sudo sandbox` user isolation
- `node-exec.ts`, `node-script.ts` — Node.js evaluation
- `pod-exec.ts`, `pod-nsenter-exec.ts`, `pod-script.ts`, `netns-script.ts` — K8s pod execution

**Skill tools**:
- `run-skill.ts` — executes skill scripts via `run_skill` tool
- `create-skill.ts`, `update-skill.ts`, `fork-skill.ts` — skill management (web mode only)

**Memory tools**:
- `memory-search.ts` — hybrid vector+FTS search over `memory/*.md`
- `memory-get.ts` — reads a specific memory file by path

**Investigation tools**:
- `deep-search/tool.ts` — `deep_search` tool, spawns 4-phase investigation engine
- `investigation-feedback.ts` — user feedback on investigations (pi-agent only)
- `dp-tools.ts` — structured Deep Protocol tools: checklist, hypotheses, end-investigation

**Platform tools**:
- `credential-list.ts` — discovers available kubeconfigs
- `manage-schedule.ts` — cron job management (web + channel modes)
- `kubectl.ts` — kubectl subcommand whitelist + safe subcommand set

**Security utilities**:
- `command-sets.ts` — `ALLOWED_COMMANDS` whitelist, `COMMAND_RULES`, context categories
- `command-validator.ts` — 6-pass validation pipeline
- `sanitize-env.ts` — environment variable sanitization before child process exec

### 4. Memory Subsystem (`src/memory/`)
Operates as a separate database from the Gateway DB.

- `MemoryIndexer` (via `node:sqlite` native, not sql.js) — hybrid search engine combining:
  - Vector similarity via `sqlite-vec` extension (optional, falls back to FTS-only)
  - FTS5 full-text search on chunked markdown
  - Temporal decay scoring
  - MMR (Maximal Marginal Relevance) reranking
- `session-summarizer.ts` — saves per-session knowledge to dated memory files
- `topic-consolidator.ts` — consolidates pending memory topics across sessions
- `knowledge-extractor.ts` — extracts structured facts from investigation sessions
- `overview-generator.ts` — builds knowledge inventory injected into system prompt append

The `investigations` table in the Memory DB stores structured records (root cause category, affected entities, causal chain, confidence, hypotheses) used for pattern learning (IM Phase 2).

### 5. Gateway (`src/gateway/`)

**HTTP + WebSocket server** (`server.ts`):
- Serves React SPA from `gateway/web/dist/`
- WebSocket protocol (`ws-protocol.ts`): `req/res/event` frame types, RPC dispatch
- REST/SSE API for agent prompting, session management, skill CRUD, config, metrics

**AgentBox management**:
- `AgentBoxManager` — `get-or-create` lifecycle, wraps any `BoxSpawner` implementation
- `AgentBoxClient` (`agentbox/client.ts`) — HTTP client from Gateway to AgentBox

**Database layer** (Gateway DB, sql.js WASM SQLite or MySQL2):
- Drizzle ORM with dual-dialect schema (`schema-sqlite.ts` / `schema-mysql.ts`)
- DDL also maintained in `migrate-sqlite.ts` for raw SQL migrations
- Repositories: `UserRepository`, `SessionRepository`, `SkillRepository`, `ConfigRepository`, `WorkspaceRepository`, `McpServerRepository`, `CronRepository`, etc.

**Channel subsystem** (`channels/`):
- Adapters: Lark, Slack, Discord, Telegram
- `ChannelBridge` — routes messages from chat channels through AgentBox pods
- `ChannelManager` — lifecycle (boot/stop/restart) of channel plugins
- `ChannelStore` — persists channel config to DB

**Cron scheduler** (`cron/`, `src/cron/`):
- `CronService` — in-process scheduler inside Gateway, DB-backed coordination (ADR-008)
- Jobs execute by POSTing to `/api/internal/agent-prompt` on localhost
- Sends notifications via `ChannelManager.sendUserNotification()`

**Skills management** (`skills/`):
- `SkillBundleBuilder` (`skill-bundle.ts`) — packages team + personal skills (never core)
- `ScriptEvaluator` (`script-evaluator.ts`) — security review gate for skill scripts before activation

**Security** (`security/`):
- `CertificateManager` — generates and rotates mTLS certs (K8s mode only)
- `createMtlsMiddleware` — validates client certs on incoming AgentBox requests

### 6. AgentBox (`src/agentbox/`)

Runs inside each K8s pod (or in-process for LocalSpawner):
- `AgentBoxSessionManager` — manages multiple `ManagedSession` instances per AgentBox; memory indexer is shared at AgentBox level, MCP per-session
- `createHttpServer()` (`http-server.ts`) — plain HTTP (local) or mTLS HTTPS (K8s); routes: `/api/prompt`, `/api/stream`, `/api/reload-mcp`, `/api/reload-skills`, `/health`, `/metrics`
- `GatewayClient` (`gateway-client.ts`) — mTLS HTTP client from AgentBox back to Gateway
- `resource-handlers.ts` — `mcpHandler` and `skillsHandler` (fetch + materialize)
- `resource-sync.ts` — `syncAllResources()` called at startup

### 7. Deep Search Engine (`src/tools/deep-search/`)
4-phase autonomous investigation workflow:
1. **Context gathering** — parallel sub-agents collect cluster state, logs, events
2. **Hypothesis generation** — LLM generates ranked hypotheses with confidence scores
3. **Hypothesis validation** — targeted sub-agents validate each hypothesis
4. **Conclusion** — quality-gated conclusion with root cause category + causal chain

Each sub-agent runs with a minimal tool set (bash, kubectl, node-exec). Results are stored as `InvestigationRecord` in the Memory DB for future pattern matching.

---

## Data Flow

### TUI prompt cycle
```
User input → InteractiveMode → session.prompt() → PiAgentBrain → pi-agent loop
  → tools execute (bash, kubectl, memory_search, deep_search, ...)
  → events stream to InteractiveMode (render)
  → session ends → saveSessionKnowledge() → YYYY-MM-DD.md
```

### Web (Gateway + K8s) prompt cycle
```
Browser WebSocket → Gateway WS handler → RPC dispatch → AgentBoxClient.prompt()
  → mTLS HTTPS POST /api/prompt → AgentBox HTTP server
  → AgentBoxSessionManager.getOrCreate() → createSiclawSession()
  → BrainSession.prompt() → tool execution
  → SSE events → Gateway streams back → Browser renders
```

### Resource sync (K8s mode)
```
Gateway DB change (skills/MCP) → ResourceNotifier.notifyAll()
  → mTLS POST /api/reload-skills to each AgentBox pod
  → skillsHandler.fetch(gatewayClient) → skillsHandler.materialize()
  → skillsHandler.postReload() → brain.reload()
```

### Memory write-back
```
Session ends → session-summarizer.saveSessionKnowledge()
  → LLM extracts facts → writes YYYY-MM-DD.md
  → MemoryIndexer.sync() (file watcher or explicit) → chunks → FTS5 + embeddings
  → topic-consolidator.consolidateAllPending() → merges related topics
```

---

## Key Abstractions

| Abstraction | Interface/Class | Location |
|-------------|-----------------|----------|
| Agent session factory | `createSiclawSession()` | `src/core/agent-factory.ts` |
| Brain backend | `BrainSession` interface | `src/core/brain-session.ts` |
| AgentBox spawner | `BoxSpawner` interface | `src/gateway/agentbox/spawner.ts` |
| Resource sync handler | `AgentBoxResourceHandler<T>` | `src/shared/resource-sync.ts` |
| Memory search engine | `MemoryIndexer` class | `src/memory/indexer.ts` |
| Tool definition | `ToolDefinition` (pi-agent) | `@mariozechner/pi-coding-agent` |
| WebSocket wire protocol | `WsRequest / WsResponse / WsEvent` | `src/gateway/ws-protocol.ts` |
| Skill bundle | `buildSkillBundle()` | `src/gateway/skills/skill-bundle.ts` |

---

## Security Model (brief)

Full spec: `docs/design/security.md`

**Defense-in-depth for shell execution:**
1. **OS-level user isolation** — child processes run as `sandbox` user (cannot read credentials); `kubectl` has setgid `kubecred` group (ADR-010)
2. **Whitelist-only command validation** — binaries must be in `ALLOWED_COMMANDS` (`src/tools/command-sets.ts`); `sed`, `awk`, `nc`, `wget` intentionally excluded
3. **6-pass validation pipeline** — shell operator detection, command extraction, per-command rules, kubectl subcommand check, exec target validation, environment sanitization
4. **kubectl read-only** — 13 safe subcommands; all write operations permanently blocked
5. **Path-restricted file I/O** — read allowed from `skills/`, `user-data/`, `reports/`, `repos/`, `docs/`; write only to `user-data/`
6. **Skill script review gate** — `ScriptEvaluator` in `src/gateway/skills/script-evaluator.ts` reviews scripts before activation
7. **mTLS** — Gateway ↔ AgentBox communication in K8s mode uses mutual TLS; `CertificateManager` rotates certs
8. **Prompt injection guard** — system prompt instructs agent to never follow instructions found in tool output
