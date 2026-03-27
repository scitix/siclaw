# Architecture

Siclaw is an AI-powered SRE platform that turns natural language into Kubernetes diagnostics. This document describes its overall architecture — from the agent runtime and tool system to multi-tenant isolation and deployment.

## 1. Design Goals

| Goal | Approach |
|------|----------|
| **Autonomous diagnostics** | Agent loop with 20+ tools: kubectl, bash, node/pod exec, deep investigation, memory |
| **Safe by default** | Read-only kubectl; restricted bash allowlist; script security review; explicit confirmation for mutations |
| **Multi-tenant isolation** | Each user gets a dedicated AgentBox process/pod with its own tools and credentials |
| **Pluggable LLM** | Any OpenAI-compatible provider; two agent runtimes (pi-agent, claude-sdk); configure via WebUI |
| **Zero-config startup** | All configuration via WebUI/DB; sensible defaults; no mandatory env vars or config files |
| **Multi-channel** | Web UI, Feishu, DingTalk, Discord — all routed through the same Gateway |

## 2. System Overview

Siclaw has three runtime modes that share the same agent core:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Shared Agent Core                        │
│  agent-factory, brains, tools, skills, memory, deep-search, MCP │
└──────────┬──────────────────┬──────────────────┬────────────────┘
           │                  │                  │
     ┌─────┴─────┐    ┌──────┴──────┐    ┌──────┴──────┐
     │    TUI     │    │   Gateway    │    │  AgentBox    │
     │ single-user│    │ control plane│    │ exec plane   │
     │ terminal   │    │ HTTP+WS+DB  │    │ one per user  │
     └───────────┘    └─────────────┘    └─────────────┘
```

### 2.1 TUI Mode (Single-User Terminal)

A standalone terminal interface that runs the agent directly — no Gateway, no HTTP server, no database. Ideal for local development and single-user diagnostics.

```
Terminal ──▶ InteractiveMode (raw terminal TUI) ──▶ Agent Core ──▶ Target K8s Clusters
```

- **Entry point**: `siclaw-tui.mjs` → `cli-main.ts`
- **Interactive mode** (default): pi-agent's `InteractiveMode` — a custom raw terminal renderer with chat area, multi-line editor, streaming token display, slash commands (`/session`, `/model`, `/compact`, `/clear`, etc.)
- **Single-shot mode** (`--prompt <text>`): sends the prompt, prints the response, exits
- **Session resume** (`--continue`): continues the most recent session for the current working directory
- **Config**: reads `.siclaw/config/settings.json` directly (zero env vars)
- **Brain**: always pi-agent (PiAgentBrain)
- **Full tool set**: same tools as AgentBox — bash, kubectl, node/pod exec, deep search, skills, memory, MCP

### 2.2 Gateway + AgentBox (Multi-User)

```
  Web UI / IM Channels / Webhooks
              │
              ▼
  ┌───────────────────────┐
  │       Gateway          │  Control plane
  │    (HTTP + WebSocket)  │  Auth, routing, DB, cron, skill management
  └──────────┬────────────┘
             │ K8s API / local process
             ▼
  ┌───────────────────────┐
  │      AgentBox          │  Execution plane (one per user per workspace)
  │  ┌─────────────────┐  │
  │  │  Agent Runtime   │  │  pi-agent or claude-sdk brain
  │  │  ┌───────────┐  │  │
  │  │  │  Tools     │  │  │  kubectl, bash, node_exec, deep_search, ...
  │  │  │  Skills    │  │  │  core/ + global/ + personal/
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

**Gateway** (control plane) — a single HTTP + WebSocket server for authentication, routing, and all shared infrastructure. It does not run agent logic.

**AgentBox** (execution plane) — a per-user, per-workspace runtime that hosts the AI agent. In K8s mode each AgentBox is a separate pod; in local mode a child process.

### 2.3 TUI vs AgentBox

Both TUI and AgentBox run the same `createSiclawSession()` from `agent-factory.ts`. The differences:

| Aspect | TUI | AgentBox |
|--------|-----|----------|
| Interaction | Raw terminal TUI / stdout | HTTP API + SSE streaming (headless) |
| Concurrency | Single session per process | Multiple concurrent sessions |
| Config source | Local `.siclaw/config/settings.json` | Fetched from Gateway, then cached locally |
| Brain type | Always pi-agent | pi-agent or claude-sdk per request |
| Session persistence | `~/.pi/agent/sessions/` (framework default) | `userDataDir/agent/sessions/<sessionId>/` |
| S3 backup | None | Optional session JSONL backup |
| Gateway dependency | None | Fetches config + reports events to Gateway |

## 3. Agent Runtime

### 3.1 Brain Abstraction

All agent backends implement the `BrainSession` interface:

```typescript
export type BrainType = "pi-agent" | "claude-sdk";

export interface BrainSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
  steer(text: string): Promise<void>;        // inject message mid-run
  getContextUsage(): BrainContextUsage | undefined;
  getModel(): BrainModelInfo | undefined;
  setModel(model: BrainModelInfo): Promise<void>;
  // ...
}
```

Events follow a common format: `agent_start/end`, `turn_start/end`, `message_start/end`, `message_update`, `tool_execution_start/end`, `auto_compaction_start/end`, `auto_retry_start/end`.

### 3.2 PiAgentBrain

A thin delegation wrapper over `@mariozechner/pi-coding-agent`'s `AgentSession`.

- Tools are provided as TypeBox `ToolDefinition` objects (direct)
- `steer()` injects a message mid-run via the framework's native steer mechanism
- Context window tracking available via `session.getContextUsage()`
- Model selection via `session.modelRegistry.find(provider, id)`
- Session persistence via pi-agent's `SessionManager`

### 3.3 ClaudeSdkBrain

A complete reimplementation using `@anthropic-ai/claude-agent-sdk`.

- Tools are exposed through an **in-process MCP server** (`sdk.createSdkMcpServer`) — all built-in SDK tools are disabled
- SDK is lazy-loaded via dynamic import (only resolves when the package is installed)
- `steer()` queues messages; they execute after the current query completes (no mid-run injection)
- Empty response guard: if the LLM returns no content after tool calls, sends a follow-up prompt requesting a summary
- Deep investigation auto-continue: up to 3 nudges when the checklist has pending items
- Session resumption via `resume: sessionId`

| Aspect | PiAgentBrain | ClaudeSdkBrain |
|--------|-------------|----------------|
| Backend | `@mariozechner/pi-coding-agent` | `@anthropic-ai/claude-agent-sdk` |
| Tool protocol | TypeBox ToolDefinition (direct) | In-process MCP server (Zod) |
| steer() | Native mid-run injection | Queued, post-query execution |
| Context tracking | Available | Not available |
| Memory tools | Yes (indexer initialized) | Not available |

### 3.4 LLM Proxy

An in-process HTTP server on `127.0.0.1:<random-port>` that translates Anthropic Messages API → OpenAI Chat Completions API.

```
ClaudeSdkBrain ──Anthropic format──▶ LLM Proxy ──OpenAI format──▶ Qwen / DeepSeek / Kimi / ...
```

**When used**: When the configured provider is `openai-completions` (non-Anthropic), the proxy starts automatically. `ANTHROPIC_BASE_URL` is set to the proxy URL so the SDK subprocess talks Anthropic protocol while the real provider receives OpenAI protocol.

Translation covers:

- System prompts, user/assistant messages, tool calls, tool results, images
- Streaming SSE (OpenAI chunks → Anthropic events via state machine)
- Non-streaming responses
- Per-model quirks via `ModelCompat` (developer role support, max_tokens field names, thinking format)

Thinking blocks from the provider are silently discarded in responses — the SDK gets confused and makes extra API calls when it receives them.

### 3.5 MCP Integration

`McpClientManager` connects to external Model Context Protocol servers and exposes their tools.

Supported transports: `stdio`, `sse`, `streamable-http` (auto-detected from config).

For pi-agent brain: MCP tools are converted to `ToolDefinition` objects (JSON Schema → TypeBox). Tool names are prefixed as `mcp__{serverName}__{toolName}`.

For claude-sdk brain: raw server config is passed to the SDK's native MCP support (transport field mapping: `streamable-http` → `http`).

### 3.6 System Prompt

`buildSreSystemPrompt()` generates the base prompt with sections:

- **Core behavior** — stay focused, conclusion first, use `bash` for all kubectl, skills-first policy, precise queries, no filler questions
- **Safety** — read-only by default, warn before destructive operations
- **Long-term memory** (conditional) — memory directory, search-before-answer rule, writing conventions
- **Skills reference** (appended dynamically) — lists all available skills with their scripts and which execution tool to use (`local_script`, `node_script`, or `pod_script`)
- **MEMORY.md** (appended) — user's persistent memory file injected directly into context

### 3.7 Session Factory

`createSiclawSession()` assembles a complete agent session:

1. Resolves session mode (`web` | `channel` | `cli`) — affects skill directories and available tools
2. Assembles tools: base file I/O tools + all custom tools (bash, kubectl, node/pod exec, deep search, skills, memory, credentials, scheduling)
3. Applies workspace-level tool allowlist filtering (if configured)
4. Loads MCP tools from external servers
5. Initializes the chosen brain (pi-agent or claude-sdk) with the assembled tools and system prompt
6. For pi-agent: initializes memory indexer, loads extensions (context pruning, memory flush, deep investigation)
7. For claude-sdk: adds deep investigation tools (propose_hypotheses, end_investigation), starts LLM proxy if needed

## 4. Tool System

All tools are TypeBox `ToolDefinition` objects with structured input schemas and execute functions.

### 4.1 Execution / Shell Tools

| Tool | File | Description |
|------|------|-------------|
| `bash` | `restricted-bash.ts` | Sandboxed shell with binary allowlist (kubectl, grep, jq, etc.). kubectl restricted to read-only subcommands. Blocks output redirection, command substitution. Skill scripts are exempt from allowlist. Default timeout 60s |
| `node_exec` | `node-exec.ts` | Run a command on a K8s node's host via privileged debug pod + `nsenter`. Extended allowlist: RDMA, GPU, hardware, journalctl, crictl. Default timeout 60s |
| `node_script` | `node-script.ts` | Run a skill script on a K8s node host. Base64-encodes script, pipes via nsenter. Supports .sh and .py. Default timeout 180s |
| `pod_exec` | `pod-exec.ts` | Run a command inside a pod via `kubectl exec`. Same base allowlist as bash. Default timeout 30s |
| `pod_script` | `pod-script.ts` | Run a skill script inside a pod via `kubectl exec -i`. Pipes script via stdin. Default timeout 180s |
| `resolve_pod_netns` | `resolve-pod-netns.ts` | Resolve a pod's network namespace name and node. Returns netns name for use with `node_exec`/`node_script` `netns` param |

### 4.2 Skill Management Tools

| Tool | File | Description |
|------|------|-------------|
| `local_script` | `local-script.ts` | Execute a skill script by name. Resolves path via `resolveSkillScript()`. Default timeout 180s |
| `create_skill` | `create-skill.ts` | Create a new skill (web/cli only). Returns structured JSON for UI preview. Scripts require admin approval |
| `update_skill` | `update-skill.ts` | Update an existing skill (web/cli only). Scripts array is the complete final set — omitted scripts are deleted |

### 4.3 Memory Tools

| Tool | File | Description |
|------|------|-------------|
| `memory_search` | `memory-search.ts` | Hybrid semantic + keyword search over memory files. Returns ranked chunks with file, heading, score, content. Pi-agent only |
| `memory_get` | `memory-get.ts` | Read a specific memory file. Path traversal blocked. Max 100KB for full reads |

### 4.4 Investigation & Admin Tools

| Tool | File | Description |
|------|------|-------------|
| `deep_search` | `deep-search/tool.ts` | Structured hypothesis-driven investigation (see Section 5) |
| `propose_hypotheses` | `dp-tools.ts` | Present hypotheses to user for confirmation (claude-sdk only) |
| `end_investigation` | `dp-tools.ts` | Early termination of investigation (claude-sdk only) |
| `manage_schedule` | `manage-schedule.ts` | CRUD for cron schedules. Queries Gateway's internal API |
| `credential_list` | `credential-list.ts` | List workspace credentials (kubeconfig, SSH keys, tokens) |

### 4.5 File I/O Tools (from pi-agent)

`read`, `edit`, `write`, `grep`, `find`, `ls` — standard file operations. For claude-sdk brain these are also added as custom MCP tools since the SDK has no built-in file access.

## 5. Deep Investigation

A structured 4-phase workflow for complex incidents, powered by parallel sub-agents with budget control.

### 5.1 Budget

```
                          Normal    Quick
maxContextCalls              8        5
maxHypotheses                5        3
maxCallsPerHypothesis       10        8
maxTotalCalls               60       30
maxParallel                  3        3
maxDurationMs           300,000  180,000   (5 min / 3 min)
```

Early exit confidence threshold: 80%. Budget abort timeout: 10s after exhaustion.

### 5.2 Four-Phase Workflow

```
Phase 1: Context Gathering
    │  Sub-agent runs triage commands (budget: 8 calls)
    │  Output: CONTEXT_SUMMARY
    ▼
Phase 2: Hypothesis Generation
    │  Single LLM call (no tools), skills injected as context
    │  Output: ranked hypotheses with confidence scores
    ▼
Phase 3: Parallel Validation
    │  Batches of 3 sub-agents, one per hypothesis
    │  Per-hypothesis budget redistributed from remaining total
    │  Early exit if any hypothesis ≥ 80% confidence + validated
    │  Prior findings passed to next batch for context
    ▼
Phase 4: Conclusion
    │  Single LLM call synthesizing all findings
    │  Output: root cause analysis + recommendations
    ▼
Report written to ~/.siclaw/reports/deep-search-{timestamp}.md
Debug trace to ~/.siclaw/traces/deep-search-{timestamp}.md
```

### 5.3 Sub-Agent Architecture

Each sub-agent is a minimal pi-agent session:

- Tools: `read` + `restricted-bash` + `node_exec` only
- Skills pre-loaded from `skills/core/` and `skills/extension/`, injected as text in prompt
- Shared `AuthStorage` and `ModelRegistry` (initialized once, reused)
- Budget enforcement: tool calls counted (reads excluded), steer message on exhaustion, hard abort after 10s timeout
- Evidence collection: every non-read tool call records command, output (truncated to 4000 chars), and interpretation

## 6. Memory System

Per-user persistent memory with hybrid search, stored as markdown files backed by SQLite.

### 6.1 Storage

- Files: `{memoryDir}/*.md` — user-maintained markdown (investigations, conventions, MEMORY.md)
- Database: `{memoryDir}/.memory.db` (SQLite, WAL mode, Node.js built-in `node:sqlite`)
- Tables: `meta` (key-value), `files` (path, mtime, hash), `chunks` (content + embedding BLOB), `chunks_fts` (FTS5 virtual table)

### 6.2 Indexing

The `MemoryIndexer` syncs markdown files to the SQLite database:

1. Detects embedding model changes — clears all embeddings if model changed
2. Scans for `*.md` files recursively (skips dotfiles and symlinks)
3. Chunks markdown on heading boundaries (max 2000 chars per chunk, tracks heading hierarchy as breadcrumb)
4. Batch-embeds all changed chunks in one API call
5. Writes to DB in a single transaction; removes entries for deleted files

Embedding: `BAAI/bge-m3` (1024 dimensions, 8192 max input tokens). Token-bounded batching (max 8000 tokens per API call). Retry with exponential backoff.

### 6.3 Hybrid Search

```
Score = 0.85 × vectorScore + 0.15 × ftsScore
```

- **Vector search**: in-memory cosine similarity over all chunks with embeddings
- **FTS5 keyword search**: BM25 ranking. CJK queries use OR (bigrams); Latin queries use AND
- Results fused (union), filtered by minimum score (default 0.35), sorted descending, sliced to top K (default 10)

## 7. Skill System

Skills are reusable diagnostic playbooks consisting of a `SKILL.md` spec and shell scripts.

### 7.1 Three-Tier Overlay

| Tier | Location | Managed By | Description |
|------|----------|-----------|-------------|
| Core | `skills/core/` | Baked into image | Built-in diagnostics (node logs, network, image pull debug, etc.) |
| Global | `skills/global/` | Contributed from personal, admin-managed | Shared across all users |
| Personal | `skills/user/{userId}/` | User via WebUI or `create_skill` tool | Per-user custom skills |

Loading priority: personal > skillset > global > builtin (same-name skills override).

### 7.2 Skill Structure

```
skill-name/
├── SKILL.md          # Markdown spec: description, usage, parameters
└── scripts/          # Shell/Python scripts
    ├── run.sh
    ├── analyze.py
    └── ...
```

### 7.3 Security Review

When a skill is created or updated, the `ScriptEvaluator` runs:

1. **Static analysis** — regex-based pattern matching for dangerous commands (rm -rf, sudo, kubectl mutations, etc.)
2. **AI analysis** — LLM-powered semantic review using the default configured provider (from DB)

Findings are stored in `skill_reviews` and gate activation of the skill.

## 8. Multi-Tenant Isolation

### 8.1 Gateway (Control Plane)

| Module | Responsibility |
|--------|---------------|
| HTTP/WS Server | Serve React frontend, REST API, WebSocket RPC |
| Auth | JWT tokens, local password, OIDC/SSO |
| User Store | User CRUD, admin seeding |
| AgentBox Manager | Lifecycle management (create, destroy, health check) |
| RPC Methods | All WebSocket RPC handlers (chat, skills, models, cron, triggers, etc.) |
| Channel Bridge | Route IM messages (Feishu/DingTalk/Discord) through AgentBox pods |
| Cron Scheduler | Multi-instance HA coordination for recurring agent tasks |
| Skill Manager | Skill CRUD, file writer, security review |
| Model Config | LLM provider/model management (DB-backed, WebUI-configured) |

### 8.2 AgentBox (Execution Plane)

| Module | Responsibility |
|--------|---------------|
| Agent Runtime | pi-agent or claude-sdk brain |
| Tools | kubectl, restricted bash, node exec, deep search, create_skill, etc. |
| Skills | Four-tier overlay: builtin (read-only) + global (read-only) + skillset (dev-only) + personal (read-write) |
| MCP Client | Connect to external Model Context Protocol servers |
| Memory | Per-user vector + keyword search across sessions |

### 8.3 Why This Split

```
Gateway (shared infrastructure)          AgentBox (user-dedicated runtime)
────────────────────────────             ────────────────────────────────
• Ingress — channel-agnostic             • Execution — acts on behalf of a user
• Stateless — can restart/scale freely   • Stateful — holds session context
• No sensitive operations                • Holds kubeconfig, runs kubectl
• Shared by all users                    • Strictly isolated per user
```

### 8.4 AgentBox Lifecycle

```
     ┌─────────┐
     │  NONE   │  (first request for this user)
     └────┬────┘
          │ getOrCreate(userId)
          ▼
     ┌──────────┐
     │ STARTING │  (spawning pod/process)
     └────┬─────┘
          │ health check passes
          ▼
     ┌─────────┐
     │ RUNNING │ ◀── health check OK ──┐
     └────┬────┘                       │
          │                            │
          ├── health check fail ─▶ UNHEALTHY ──┘ (auto-restart)
          │
          ├── idle timeout ──────▶ STOPPED (resources released)
          │
          └── explicit stop ─────▶ STOPPED
```

### 8.5 Core Flows

**Chat Message Flow (WebSocket)**

```
Browser        Gateway              AgentBox           LLM API
  │              │                     │                  │
  │  WS: rpc     │                     │                  │
  │  chat.send   │                     │                  │
  │─────────────▶│                     │                  │
  │              │── get/create box ──▶│                  │
  │              │── POST /chat/send ─▶│                  │
  │              │                     │── LLM request ──▶│
  │              │                     │◀── stream ───────│
  │              │◀── SSE events ──────│                  │
  │◀── WS events─│                     │                  │
  │              │                     │── tool calls ────│
  │◀── WS events─│◀── tool events ────│                  │
  │              │◀── agent.end ───────│                  │
  │◀── done ─────│                     │                  │
```

**IM Channel Flow**

```
IM Platform        Gateway                  AgentBox
  │                  │                         │
  │  webhook/WS      │                         │
  │  message event   │                         │
  │─────────────────▶│                         │
  │                  │── resolve userId ────────│
  │                  │── get/create box ───────▶│
  │                  │── chat.send ────────────▶│
  │                  │                         │── process...
  │                  │◀── stream events ───────│
  │◀── reply card ───│                         │
```

Supported channels: Feishu (WebSocket), DingTalk (WebSocket), Discord (Bot API).

## 9. Data Model

### 9.1 Database

- **Engine**: MySQL (via Drizzle ORM)
- **Schema init**: `init-schema.ts` — idempotent `CREATE TABLE IF NOT EXISTS` on startup
- **No seed data** — all configuration (providers, models, SSO, etc.) is done via WebUI after first launch

Key tables:

| Table | Purpose |
|-------|---------|
| `users` | User accounts (admin seeded on first boot with default password) |
| `sessions` / `messages` | Chat history |
| `skills` / `skill_versions` / `skill_reviews` | Skill registry, versioning, security reviews |
| `model_providers` / `model_entries` | LLM provider and model configuration |
| `embedding_config` | Embedding model configuration |
| `system_config` | Key-value store for SSO, system settings |
| `workspaces` / `workspace_*` | Per-project isolation of skills, tools, environments, credentials |
| `credentials` | Credential vault (kubeconfig, SSH keys, tokens, etc.) |
| `cron_jobs` / `cron_instances` | Scheduled tasks with HA coordination |
| `triggers` | Webhook endpoints for alerts |
| `channels` | IM channel configurations |
| `notifications` | User notification queue |

### 9.2 Optional External Storage

| Service | Purpose | Required? |
|---------|---------|-----------|
| S3/OSS | Session JSONL backup, skill version snapshots | No — operates without it |

## 10. Configuration

### 10.1 Zero-Config Principle

Gateway starts with **zero environment variables and zero config files**. All defaults are hardcoded:

| Setting | Default | How to Change |
|---------|---------|---------------|
| Port / host | `3000` / `0.0.0.0` | Hardcoded in `config.ts` |
| Database | None (runs without DB) | Set `SICLAW_DATABASE_URL` env var |
| JWT secret | `"dev-secret-change-in-production"` | Set `SICLAW_JWT_SECRET` env var |
| Admin password | `"admin"` | Change via WebUI after first login |
| LLM providers | None | Configure via **Settings > Models** in WebUI |
| SSO | Disabled | Configure via **Settings > SSO** in WebUI |
| Skills directory | `./skills` | Set `SICLAW_SKILLS_DIR` env var |

### 10.2 TUI / AgentBox Configuration

Both TUI and AgentBox read `.siclaw/config/settings.json`:

```json
{
  "providers": {
    "default": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "LLM_API_KEY",
      "models": [{ "id": "gpt-4o", "name": "GPT-4o" }]
    }
  }
}
```

- **TUI**: reads the file directly from local disk (zero env vars, zero remote dependencies)
- **AgentBox in K8s mode**: Gateway injects resolved LLM/embedding config into pods via environment variables (read from DB at spawn time)
- **AgentBox in local mode**: reads the file from local disk, same as TUI

### 10.3 Config Files

| File | Purpose | Required? |
|------|---------|-----------|
| `settings.example.json` | Example config — copy to `.siclaw/config/settings.json` for TUI / AgentBox | Yes for TUI; No for AgentBox in K8s mode (env vars injected by Gateway) |
| `config/seed-labels-extension.json` | Skill label extensions for overlay builds | No (open-source mode ignores) |

## 11. Security

Siclaw enforces **read-only by default** across every execution path. The agent cannot modify Kubernetes resources, write files to disk, or run arbitrary binaries — unless explicitly exempted (skill scripts with human review).

### 11.1 Shell Command Validation (4-Pass Pipeline)

Every command — whether via `bash`, `node_exec`, or `pod_exec` — passes through the same validation pipeline before execution.

**Pass 1 — Shell Operator Scan** (`validateShellOperators`)

Character-by-character scan of the raw command string:

| Pattern | Disposition |
|---------|------------|
| `` ` `` (backtick) | Blocked everywhere |
| `$(` | Blocked everywhere |
| `<(` / `>(` | Blocked outside quotes |
| `<` (input redirection) | Blocked outside quotes |
| `> file` / `>> file` | Blocked (except `>/dev/null` and `>&N` fd duplication) |

**Pass 2 — Binary Allowlist** (`ALLOWED_COMMANDS`)

The command pipeline is split (respects quotes, splits on `|`, `&&`, `;`, `||`, `&`), and each segment's binary is checked against an allowlist:

- Text processing: `grep`, `sort`, `uniq`, `wc`, `head`, `tail`, `cut`, `tr`, `jq`, `yq`, `column`
- Network diagnostics: `ip`, `ping`, `traceroute`, `ss`, `netstat`, `dig`, `curl`, `mtr`, `ethtool`, `conntrack`
- RDMA/RoCE: `ibstat`, `ibv_devinfo`, `rdma`, `show_gids`, etc.
- GPU: `nvidia-smi`, `gpustat`, `nvtopo`
- Hardware: `lspci`, `lscpu`, `dmidecode`, `lsblk`, `lsmem`
- System: `uname`, `hostname`, `uptime`, `dmesg`, `sysctl` (read-only), `journalctl` (read-only)
- Container runtime: `crictl` (read-only), `ctr` (read-only)
- File inspection: `cat`, `ls`, `stat`, `file`, `find` (no `-exec`/`-delete`), `diff`, `md5sum`
- Kubernetes: `kubectl` (handled separately — see Pass 3)

Notably excluded: `sed` (has `w`/`e` escape hatches), `bc` (has `!command` shell escape), `awk` (checked separately for `system()` calls).

**Skill Script Exemption**: Commands invoking scripts under `skills/` are exempt from the allowlist. The path is resolved via `fs.realpathSync()` to block symlink-based traversal.

**Pass 3 — kubectl Subcommand Whitelist** (`SAFE_SUBCOMMANDS`)

Every `kubectl` invocation is restricted to read-only subcommands:

```
get, describe, logs, top, events, api-resources, api-versions,
cluster-info, config, version, explain, auth, exec
```

All write operations — `apply`, `delete`, `patch`, `create`, `scale`, `drain`, `cordon`, `edit`, `replace`, `label`, `taint`, `rollout undo` — are rejected. For `kubectl exec`, the command after `--` goes through the same binary allowlist (Pass 2).

**Pass 4 — Per-Command Flag Restrictions** (`validateCommandRestrictions`)

Even allowed binaries have flag-level validation (~25 commands). Examples:

| Command | Restriction |
|---------|------------|
| `find` | Blocks `-exec`, `-execdir`, `-delete`, `-fprint` |
| `sysctl` | Blocks `-w`/`--write`, `-p`/`--load`, `key=value` (read-only only) |
| `systemctl` | Only `status`, `show`, `list-units`, `is-active`, `cat` |
| `crictl` | Only `ps`, `images`, `inspect`, `logs`, `stats`, `info`, `pods` |
| `iptables` | Only `-L`/`--list`, `-S`/`--list-rules` (listing mode) |
| `curl` | Blocks `-o`, `-O`, `-T` (file output/upload), `@file` upload |
| `journalctl` | Blocks `-f`/`--follow` (would block agent), `--vacuum-*`, `--rotate` |
| `ip` / `tc` / `bridge` | Only `show`, `list`, `ls` actions |
| `conntrack` | Blocks `-D`/`--delete`, `-F`/`--flush`, `-U`/`--update` |
| `tee` | Only `tee /dev/null` (no file writes) |
| `top` | Must have `-b`/`--batch` (interactive mode blocked) |

### 11.2 Skill Script Security Review

When a skill with scripts is submitted for publish, the `ScriptEvaluator` runs two-phase analysis:

**Phase 1 — Static Regex Analysis** (20+ patterns)

| Severity | Category | Example Patterns |
|----------|---------|-----------------|
| Critical | Destructive | `rm -rf`, `mkfs`, `dd of=` |
| Critical | Network modification | `iptables`, `ip route add/del` |
| Critical | Privilege escalation | `sudo`, `nsenter`, `chroot` |
| High | K8s write ops | `kubectl create/apply/patch/delete/scale/drain/...` |
| High | System modification | `systemctl stop/restart`, `mount/umount`, `chmod` |
| High | Data exfiltration | `curl --data`, `nc`/`netcat`/`ncat` |
| Medium | Database writes | `mysql ... INSERT/UPDATE/DELETE/DROP` |
| Medium | File writes | `> /path`, `tee`, `sed -i` |
| Medium | Package management | `apt install`, `pip install`, `npm install` |

**Phase 2 — AI Semantic Analysis**

The LLM receives all script content, the SKILL.md spec, and static findings. It returns a risk level, findings with line references, and a summary. The system prompt enforces: "Skills MUST be read-only."

**Activation Gate**: Scripts require human review by a `skill_reviewer` role. The workflow: `draft` → `pending` (review requested) → reviewer approves/rejects → `published` (deployed to all AgentBox pods). Optimistic concurrency prevents approving a superseded version.

### 11.3 Execution Isolation

- Each user runs in a separate AgentBox (process or pod)
- AgentBox holds user's kubeconfig — never shared across users
- `automountServiceAccountToken: false` — AgentBox pods have no K8s service account; can only access clusters via explicitly provided kubeconfigs
- Skills directory: core/global are read-only mounts; only personal skills are writable
- Credential directory: mounted read-only at `/home/agentbox/.credentials`
- Node/pod name injection blocked: strict regex validation (`[a-zA-Z0-9][a-zA-Z0-9.\-]*`)

### 11.4 Authentication & Authorization

- JWT-based session tokens
- OIDC/SSO integration (configurable via WebUI)
- Admin role for skill review, user management, system configuration
- Per-workspace credential isolation

### 11.5 Defense-in-Depth Summary

```
Layer 1: Shell operators       Blocks $(), backticks, <(), >(), redirections
Layer 2: Binary allowlist      Only known-safe binaries can execute
Layer 3: kubectl subcommands   Read-only subcommands only (get, describe, logs, ...)
Layer 4: Per-command flags     Flag-level restrictions on ~25 commands
Layer 5: Skill script review   Static regex + AI analysis + human approval gate
Layer 6: Execution isolation   Per-user pod, no service account, RO mounts, credential vault
Layer 7: Auth                  JWT + OIDC/SSO + role-based access
```

## 12. Deployment

### 12.1 Local Development

```bash
npm ci && npm run build

# TUI mode (single user)
node siclaw-tui.mjs

# Gateway mode (multi-user, local spawner)
export SICLAW_DATABASE_URL="mysql://user:pass@host:3306/siclaw"
node siclaw-gateway.mjs
```

### 12.2 Kubernetes Production

Two container images:

| Image | Entry Point | Role |
|-------|-------------|------|
| `siclaw-gateway` | `node dist/gateway-main.js --k8s` | Control plane (includes cron scheduler) |
| `siclaw-agentbox` | `node dist/agentbox-main.js` | Execution plane (dynamic pods) |

```bash
# Build
npm run docker:build:gateway
npm run docker:build:agentbox

# Deploy
kubectl apply -f k8s/
```

### 12.3 AgentBox Spawner Modes

| Mode | Flag | How It Works |
|------|------|-------------|
| Local | (default) | Spawns AgentBox as child processes on ports 4000+ |
| K8s | `--k8s` | Creates AgentBox pods via K8s API (one pod per user) |

## 13. Project Structure

```
src/
├── cli-main.ts              # TUI entry point
├── gateway-main.ts          # Gateway entry point (includes cron scheduler)
├── agentbox-main.ts         # AgentBox entry point
├── core/
│   ├── config.ts            # Unified config loader (.siclaw/config/settings.json)
│   ├── agent-factory.ts     # Session factory (tools + brain + skills)
│   ├── brain-session.ts     # BrainSession interface
│   ├── prompt.ts            # SRE system prompt
│   ├── brains/
│   │   ├── pi-agent-brain.ts    # pi-agent adapter
│   │   └── claude-sdk-brain.ts  # claude-sdk adapter
│   ├── llm-proxy.ts         # Anthropic → OpenAI translation proxy
│   └── mcp-client.ts        # MCP server management
├── tools/
│   ├── restricted-bash.ts   # Sandboxed shell
│   ├── node-exec.ts         # K8s node command execution
│   ├── node-script.ts       # K8s node script execution
│   ├── pod-exec.ts          # Pod command execution
│   ├── pod-script.ts        # Pod script execution
│   ├── pod-nsenter-exec.ts  # Pod network namespace execution
│   ├── netns-script.ts      # Pod network namespace script
│   ├── local-script.ts         # Skill script runner
│   ├── create-skill.ts      # Skill creation
│   ├── update-skill.ts      # Skill update
│   ├── memory-search.ts     # Hybrid memory search
│   ├── memory-get.ts        # Memory file reader
│   ├── manage-schedule.ts   # Cron schedule management
│   ├── credential-list.ts   # Credential listing
│   ├── dp-tools.ts          # Deep investigation tools (SDK brain)
│   └── deep-search/
│       ├── tool.ts          # deep_search tool definition
│       ├── engine.ts        # 4-phase workflow engine
│       ├── sub-agent.ts     # Sub-agent session factory
│       └── types.ts         # Budget constants and types
├── memory/
│   ├── indexer.ts           # File sync + hybrid search
│   ├── chunker.ts           # Markdown heading-based chunker
│   ├── embeddings.ts        # Embedding API client
│   └── schema.ts            # SQLite schema (chunks, FTS5)
├── gateway/
│   ├── server.ts            # HTTP + WebSocket server
│   ├── config.ts            # Gateway config (hardcoded defaults)
│   ├── rpc-methods.ts       # All RPC handlers
│   ├── auth/                # JWT, SSO, user store
│   ├── agentbox/            # K8s pod spawner + local spawner
│   ├── channels/            # IM platform integrations
│   ├── cron/                # Cron notification + HA coordination
│   ├── skills/              # Script evaluator, file writer
│   ├── db/
│   │   ├── init-schema.ts   # Idempotent DDL + index creation
│   │   ├── schema.ts        # Drizzle table definitions
│   │   └── repositories/    # Data access layer
│   └── web/                 # React frontend (Vite + Tailwind)
├── lib/
│   ├── s3-storage.ts        # S3/OSS for skill versions
│   └── s3-backup.ts         # Session JSONL backup
skills/
├── core/                    # Built-in skills
├── global/                  # Global shared skills
└── extension/               # Optional extension skills
k8s/                         # Kubernetes manifests
```

## 14. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ (ESM-only) |
| Language | TypeScript 5.8 |
| Agent | pi-coding-agent / claude-agent-sdk |
| Database | MySQL + Drizzle ORM |
| Memory DB | SQLite (node:sqlite) + FTS5 |
| Frontend | React + Vite + Tailwind CSS |
| K8s Client | @kubernetes/client-node |
| MCP | @modelcontextprotocol/sdk |
| Realtime | WebSocket (ws) |
