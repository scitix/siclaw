# Directory Structure

## Top-Level Layout

```
siclaw_makeup/
├── src/                      # All TypeScript source
├── skills/                   # Built-in skill bundles (baked into Docker image)
├── docs/                     # Documentation site (MDX) + design docs
├── docker/                   # Docker Compose files for local dev
├── helm/                     # Helm chart for K8s deployment
├── k8s/                      # Raw Kubernetes manifests
├── .planning/                # Planning documents (not shipped)
├── Dockerfile.agentbox       # AgentBox pod image
├── Dockerfile.gateway        # Gateway + frontend image
├── siclaw-tui.mjs            # Compiled TUI entry launcher
├── siclaw-gateway.mjs        # Compiled Gateway entry launcher
├── siclaw-agentbox.mjs       # Compiled AgentBox entry launcher
├── siclaw.mjs                # Alias for TUI
├── settings.example.json     # Example LLM provider config
├── package.json              # Workspace root; scripts: build, test, typecheck
├── tsconfig.json             # TypeScript strict, ESM, .js imports required
├── CLAUDE.md                 # Claude operating manual (auto-loaded)
└── CONTRIBUTING.md           # PR/review standards
```

### Design documents (`docs/design/`)
```
docs/design/
├── invariants.md             # Critical architecture invariants (read before touching resource sync)
├── security.md               # Full security model spec
├── roadmap.md                # Phase tracker (IM Phase 0-2, KR0, PM1)
├── decisions.md              # Architecture Decision Records (ADRs)
└── skills.md                 # Skill system design
```

---

## Source Organization (`src/`)

```
src/
├── cli-main.ts               # TUI entry point
├── gateway-main.ts           # Gateway entry point
├── agentbox-main.ts          # AgentBox worker entry point
│
├── core/                     # Shared agent core (all modes depend on this)
│   ├── agent-factory.ts      # createSiclawSession() — central composition root
│   ├── brain-session.ts      # BrainSession interface + types
│   ├── prompt.ts             # buildSreSystemPrompt() — protected SRE system prompt
│   ├── config.ts             # SiclawConfig loader, getDefaultLlm(), getEmbeddingConfig()
│   ├── mcp-client.ts         # McpClientManager — MCP server lifecycle
│   ├── llm-proxy.ts          # OpenAI-compatible LLM proxy (for non-Anthropic providers)
│   ├── tool-adapter.ts       # Tool definition adaptation utilities
│   ├── provider-presets.ts   # LLM provider preset configurations
│   ├── brains/
│   │   ├── pi-agent-brain.ts # PiAgentBrain — wraps @mariozechner/pi-coding-agent
│   │   └── claude-sdk-brain.ts # ClaudeSdkBrain — wraps claude-agent-sdk
│   └── extensions/           # pi-agent session extensions
│       ├── context-pruning.ts  # Auto-compaction / context window management
│       ├── memory-flush.ts     # Auto-save memory on compaction
│       ├── deep-investigation.ts # Deep investigation workflow extension
│       └── setup.ts            # /setup command extension
│
├── tools/                    # All LLM tool factory functions
│   ├── restricted-bash.ts    # bash tool — whitelist + sudo sandbox + 6-pass validation
│   ├── command-sets.ts       # ALLOWED_COMMANDS whitelist, COMMAND_RULES
│   ├── command-validator.ts  # 6-pass validation pipeline
│   ├── sanitize-env.ts       # Env var sanitization before child process exec
│   ├── kubectl.ts            # SAFE_SUBCOMMANDS set, validateExecCommand
│   ├── kubeconfig-resolver.ts# Resolves kubeconfig by name from credentials dir
│   ├── node-exec.ts          # Node.js eval tool
│   ├── node-script.ts        # Node.js script execution tool
│   ├── pod-exec.ts           # kubectl exec tool
│   ├── pod-nsenter-exec.ts   # nsenter into pod network namespace
│   ├── pod-script.ts         # Copy + run script inside a pod
│   ├── netns-script.ts       # Network namespace script tool
│   ├── run-skill.ts          # run_skill tool — executes skill scripts
│   ├── create-skill.ts       # Skill creation tool (web mode only)
│   ├── update-skill.ts       # Skill update tool (web mode only)
│   ├── fork-skill.ts         # Skill fork tool (web mode only)
│   ├── memory-search.ts      # memory_search tool — hybrid vector+FTS search
│   ├── memory-get.ts         # memory_get tool — reads specific memory file
│   ├── credential-list.ts    # credential_list tool — discovers kubeconfigs
│   ├── manage-schedule.ts    # manage_schedule tool — cron job management
│   ├── investigation-feedback.ts # investigation_feedback tool (pi-agent only)
│   ├── dp-tools.ts           # Deep Protocol tools: checklist, hypotheses, end
│   ├── script-resolver.ts    # Resolves skill script paths
│   ├── tool-render.ts        # Tool output rendering/truncation utilities
│   ├── exec-utils.ts         # Shared execution utilities
│   ├── k8s-checks.ts         # K8s-specific safety checks
│   └── deep-search/          # 4-phase autonomous investigation engine
│       ├── tool.ts           # deep_search tool definition + MemoryRef
│       ├── engine.ts         # Investigation workflow orchestrator
│       ├── sub-agent.ts      # Sub-agent factory (minimal tool set)
│       ├── prompts.ts        # Phase-specific LLM prompts
│       ├── schemas.ts        # TypeBox schemas for structured LLM output
│       ├── quality-gate.ts   # Conclusion validation
│       ├── types.ts          # Budget constants, HypothesisNode, InvestigationResult
│       ├── events.ts         # Progress event emitter
│       ├── format.ts         # Result formatting utilities
│       └── sre-knowledge.ts  # SRE domain knowledge for sub-agents
│
├── memory/                   # Memory subsystem (node:sqlite, separate from Gateway DB)
│   ├── index.ts              # createMemoryIndexer() — public API
│   ├── indexer.ts            # MemoryIndexer class — hybrid search engine
│   ├── schema.ts             # Memory DB schema (chunks, files, investigations, FTS5)
│   ├── chunker.ts            # Markdown chunking by heading
│   ├── embeddings.ts         # Embedding provider + vector blob serialization
│   ├── mmr.ts                # Maximal Marginal Relevance reranking
│   ├── temporal-decay.ts     # Time-weighted scoring decay
│   ├── stop-words.ts         # FTS stop-word filtering
│   ├── session-summarizer.ts # saveSessionKnowledge() — writes per-session memory files
│   ├── topic-consolidator.ts # Merges pending topics across sessions
│   ├── knowledge-extractor.ts# LLM-based structured fact extraction
│   ├── overview-generator.ts # Builds knowledge inventory for system prompt append
│   └── types.ts              # MemoryChunk, InvestigationRecord, InvestigationPattern
│
├── gateway/                  # Multi-user Gateway server
│   ├── server.ts             # startGateway() — HTTP/WS server, React SPA, REST/SSE routes
│   ├── config.ts             # loadGatewayConfig()
│   ├── ws-protocol.ts        # WebSocket wire protocol: req/res/event frames, RPC dispatch
│   ├── rpc-methods.ts        # WebSocket RPC method registry
│   ├── resource-notifier.ts  # Notifies AgentBox pods of resource changes
│   ├── mcp-config-builder.ts # Merges system + user MCP server configs
│   ├── metrics-aggregator.ts # Aggregates metrics across AgentBox pods
│   ├── output-redactor.ts    # Redacts sensitive output before logging
│   ├── skill-labels.ts       # Skill metadata helpers
│   ├── agentbox/             # AgentBox lifecycle management
│   │   ├── spawner.ts        # BoxSpawner interface
│   │   ├── manager.ts        # AgentBoxManager — get-or-create lifecycle
│   │   ├── local-spawner.ts  # In-process spawner (shared filesystem, dev mode)
│   │   ├── k8s-spawner.ts    # K8s Pod spawner (production)
│   │   ├── process-spawner.ts# Child process spawner (--process flag)
│   │   ├── client.ts         # HTTP client: Gateway → AgentBox
│   │   ├── index.ts          # Barrel re-export
│   │   └── types.ts          # AgentBoxConfig, AgentBoxHandle, AgentBoxInfo
│   ├── auth/                 # Authentication
│   │   ├── user-store.ts     # UserStore — user CRUD, password hashing
│   │   ├── jwt.ts            # JWT signing/verification
│   │   ├── login.ts          # Login handler (password + SSO)
│   │   ├── middleware.ts      # Auth middleware for HTTP routes
│   │   ├── oauth2.ts         # OAuth2 / SSO flow
│   │   ├── bind-code-store.ts# One-time codes for chat channel binding
│   │   └── index.ts          # Barrel re-export
│   ├── db/                   # Gateway database (sql.js SQLite or MySQL2)
│   │   ├── index.ts          # createDb() — dialect selection
│   │   ├── schema.ts         # Shared Drizzle schema types
│   │   ├── schema-sqlite.ts  # SQLite-specific Drizzle table definitions
│   │   ├── schema-mysql.ts   # MySQL-specific Drizzle table definitions
│   │   ├── init-schema.ts    # Schema initialization
│   │   ├── migrate-sqlite.ts # DDL_STATEMENTS for SQLite migrations
│   │   └── repositories/     # Data access layer (one file per aggregate)
│   │       ├── user-repo.ts
│   │       ├── chat-repo.ts
│   │       ├── skill-repo.ts
│   │       ├── config-repo.ts
│   │       ├── workspace-repo.ts
│   │       ├── mcp-server-repo.ts
│   │       ├── model-config-repo.ts
│   │       ├── permission-repo.ts
│   │       ├── notification-repo.ts
│   │       ├── credential-repo.ts
│   │       ├── system-config-repo.ts
│   │       └── ... (13 total repositories)
│   ├── channels/             # Chat channel integrations
│   │   ├── channel-manager.ts# Plugin lifecycle (boot/stop/restart)
│   │   ├── channel-store.ts  # Persists channel config to DB
│   │   ├── channel-rpc.ts    # WebSocket RPC methods for channel management
│   │   ├── lark.ts           # Lark/Feishu adapter
│   │   ├── slack.ts          # Slack adapter
│   │   ├── discord.ts        # Discord adapter
│   │   ├── telegram.ts       # Telegram adapter
│   │   └── utils.ts          # Shared channel utilities
│   ├── cron/                 # In-process cron scheduler
│   │   └── cron-service.ts   # CronService — DB-backed, delegates to agent-prompt API
│   ├── skills/               # Server-side skill management
│   │   ├── skill-bundle.ts   # buildSkillBundle() — packages team + personal skills
│   │   ├── script-evaluator.ts # Security review gate for skill scripts
│   │   └── file-writer.ts    # Skill file write utilities
│   ├── security/             # mTLS (K8s mode only)
│   │   ├── cert-manager.ts   # CertificateManager — generates/rotates certs
│   │   └── mtls-middleware.ts# Validates client certs on AgentBox endpoints
│   ├── plugins/              # Plugin system for channel bridges
│   │   ├── api.ts            # ChannelPlugin interface
│   │   ├── channel-bridge.ts # Routes channel messages through AgentBox pods
│   │   ├── loader.ts         # Dynamic plugin loader
│   │   └── runtime.ts        # Plugin runtime utilities
│   └── web/                  # React frontend (Vite + Tailwind)
│       ├── src/
│       │   ├── main.tsx       # React entry
│       │   ├── App.tsx        # Router + layout
│       │   ├── pages/         # Route pages: Pilot, Skills, Cron, Settings, Credentials, ...
│       │   ├── components/    # Shared UI components
│       │   ├── contexts/      # React contexts (auth, session, etc.)
│       │   ├── hooks/         # Custom React hooks
│       │   └── lib/           # API client, utilities
│       └── dist/              # Compiled frontend (served by Gateway)
│
├── agentbox/                 # AgentBox worker (runs in K8s pods or in-process)
│   ├── http-server.ts        # createHttpServer() — routes: /api/prompt, /api/stream, /health, /metrics
│   ├── session.ts            # AgentBoxSessionManager — multi-session lifecycle, ManagedSession
│   ├── gateway-client.ts     # GatewayClient — mTLS HTTP client back to Gateway
│   ├── resource-handlers.ts  # mcpHandler + skillsHandler (fetch + materialize)
│   └── resource-sync.ts      # syncAllResources() — called at pod startup
│
├── shared/                   # Utilities shared between Gateway and AgentBox
│   ├── resource-sync.ts      # ResourceType, ResourceDescriptor, RESOURCE_DESCRIPTORS
│   ├── metrics.ts            # Prometheus metrics registry + collector
│   ├── local-collector.ts    # Local monitoring collector (side-effect registration)
│   ├── diagnostic-events.ts  # emitDiagnostic() for structured internal logging
│   ├── detect-language.ts    # Detects user language from message content
│   ├── path-utils.ts         # resolveUnderDir() — path traversal guard
│   └── metrics-types.ts      # Metrics type definitions
│
└── cron/                     # Shared cron utilities (Gateway + potential future AgentBox)
    ├── cron-scheduler.ts     # CronScheduler — evaluates cron expressions, fires callbacks
    ├── cron-matcher.ts       # Cron expression parsing and matching
    └── cron-limits.ts        # Per-user job and frequency limits
```

---

## Key Directories

### `skills/` (built-in, baked into Docker image)
```
skills/
├── core/                     # Core diagnostic skills — always available, never overridden by bundles
│   ├── cluster-events/
│   ├── deep-investigation/
│   ├── deployment-rollout-debug/
│   ├── dns-debug/
│   ├── find-node/
│   ├── hpa-debug/
│   ├── image-pull-debug/
│   ├── ingress-debug/
│   ├── node-health-check/
│   ├── pod-crash-debug/
│   ├── pod-pending-debug/
│   └── ... (20+ core skills)
├── extension/                # Optional built-in skills (can be disabled per-user)
├── platform/                 # Platform-specific skills
├── team/                     # (runtime) Team-scope skills written by skill bundle API
└── user/                     # (runtime) Per-user personal skills
```

Each skill directory contains:
- `SKILL.md` — agent-readable spec: purpose, parameters, usage instructions
- `scripts/` — executable scripts invoked via `run_skill` tool

### `.siclaw/` (runtime data, gitignored)
```
.siclaw/
├── config/
│   └── settings.json         # LLM provider config, embedding config, paths
├── user-data/
│   └── memory/               # Per-user memory files
│       ├── PROFILE.md        # User profile (name, role, infra, preferences, language)
│       ├── MEMORY.md         # Persistent cross-session memory
│       ├── YYYY-MM-DD.md     # Daily investigation notes
│       └── data.sqlite       # Memory DB (chunks + investigations, node:sqlite)
├── skills/                   # Dynamic skills (team + personal, written by bundle API)
│   └── user/{userId}/        # Per-user skill isolation (local mode)
├── credentials/              # Kubeconfig files, SSH keys, API tokens
│   └── manifest.json         # Credential inventory
├── traces/                   # Deep search debug traces (Markdown)
├── reports/                  # Generated investigation reports
└── data.sqlite               # Gateway DB (users, sessions, skills, channels, sql.js)
```

---

## Naming Conventions

### Files
- Entry points use hyphen-case: `cli-main.ts`, `gateway-main.ts`, `agentbox-main.ts`
- Factories/creators: `create-<noun>.ts` for tool factories (e.g. `create-skill.ts`, `restricted-bash.ts`)
- Classes: `PascalCase.ts` when the file primarily exports a class (e.g. `CronService`, `MemoryIndexer`)
- Test files: colocated with source as `<name>.test.ts`
- Barrel re-exports: `index.ts` in each subdirectory

### Exports
- Named exports only; no default exports in barrels (TypeScript ESM convention)
- Tool factories follow `createXxxTool()` pattern returning `ToolDefinition`
- Repository classes follow `XxxRepository` pattern

### TypeScript
- ESM-only; all imports use `.js` extension (compiled output paths)
- Strict mode enabled (`tsconfig.json`)
- TypeBox (`@sinclair/typebox`) for pi-agent tool schemas; Zod for claude-sdk tool schemas
- `type` imports preferred for type-only cross-module references

### Environment variables
- Infrastructure/deployment: `SICLAW_*` prefix (e.g. `SICLAW_K8S_NAMESPACE`, `SICLAW_AGENTBOX_IMAGE`)
- Sensitive credentials (LLM API keys, etc.) go in `settings.json` only, NOT in env vars

---

## Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Workspace root; `main` entry, scripts: `build`, `test`, `typecheck` |
| `tsconfig.json` | TypeScript: `"module": "NodeNext"`, `"strict": true`, `"target": "ES2022"` |
| `settings.example.json` | Template for `.siclaw/config/settings.json`; shows provider config structure |
| `CLAUDE.md` | Claude operating manual, auto-loaded at session start |
| `CONTRIBUTING.md` | PR format requirements, review checklist |
| `Dockerfile.agentbox` | AgentBox image: Node 22, bakes in `skills/core/` and `skills/extension/` |
| `Dockerfile.gateway` | Gateway image: Node 22 + React SPA build |
| `helm/` | Helm chart for production K8s deployment |
| `k8s/` | Raw K8s manifests (alternative to Helm) |
| `docker/` | Docker Compose files for local multi-user dev |
