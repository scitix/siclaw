# Architecture Decision Records (ADR)

> **Format**: Context → Decision → Consequences
>
> These are decisions with non-obvious rationale. Future contributors should read the relevant ADR
> before proposing changes to these areas. If a decision needs revisiting, update this file.

---

## ADR-001: sql.js (WASM SQLite) for Default Local Database

**Status**: Active

**Context**:
The local/TUI deployment needs persistent storage with zero installation requirements. Options considered:
- Native `better-sqlite3`: Requires native compilation, breaks on Node version mismatches
- `node:sqlite` (built-in): Only available in Node.js 22.5+, not available in older LTS
- `sql.js` (WASM): Pure JavaScript, zero native deps, runs anywhere Node.js runs
- MySQL: Requires separate server process, too heavy for single-user local dev

**Decision**:
Use `sql.js` for local/default SQLite deployment. `node:sqlite` (built-in) is used only for the memory database (chunked embeddings) where WAL mode and performance matter more.

**Consequences**:
- ✅ Zero installation friction for local dev and TUI mode
- ✅ Works on any platform without native compilation
- ⚠️ Loads entire database into memory (fine for local scale, not for large deployments)
- ⚠️ Single-process only (lockfile enforcement required)
- ⚠️ Must call `flushSqliteDb()` before exit; 30s auto-flush for crash safety
- ❌ Not suitable for multi-instance Gateway (use MySQL for production)

**Revisit when**: Database size consistently exceeds ~100MB on local installs.

---

## ADR-002: LocalSpawner Runs AgentBox In-Process (Not Child Process)

**Status**: Active

**Context**:
For local development, AgentBox instances need to be spawned per-user. Options:
- **Child process** (ProcessSpawner): Fork a new Node.js process per user, communicate via HTTP. True process isolation but adds startup latency, IPC complexity, and debugging friction.
- **In-process** (LocalSpawner): Create a new HTTP server (on a new port) within the Gateway process. Shares memory, faster startup, easier debugging.
- **K8s Pod** (K8sSpawner): Full isolation but requires a K8s cluster.

**Decision**:
LocalSpawner runs AgentBox HTTP servers in-process, one per user, on ports 4000+. This is explicitly a **development convenience mode**, not a production isolation model.

**Consequences**:
- ✅ Fast spin-up (no process fork overhead)
- ✅ Easy to debug (single process, single debugger session)
- ✅ Shared memory allows direct in-process resource sync (no HTTP round-trips)
- ⚠️ All users share the same filesystem — components designed for K8s pod isolation CANNOT be directly reused (e.g., `skillsHandler.materialize()`)
- ⚠️ A crash in one user's session affects all users
- ❌ Not a multi-tenant production model — use K8sSpawner for that

**ProcessSpawner** exists as a middle ground (true process isolation, local machine) but is not the default. It may be promoted if local dev isolation needs increase.

---

## ADR-003: Skill Bundles Exclude Core Skills

**Status**: Active

**Context**:
The skill bundle API (`/api/internal/skills/bundle`) delivers skills to AgentBox instances. Should it include core (built-in) skills?

Options:
- **Include all**: Bundle contains core + team + personal. Simple for AgentBox (one source of truth). Expensive: Gateway must serialize all core skill files on every request.
- **Exclude core**: Bundle contains only team + personal. Core skills are baked into the Docker image / repo checkout. AgentBox reads them from disk directly.

**Decision**:
Bundles contain **only team + personal skills**. Core skills are baked into the AgentBox Docker image at build time and read from `skills/core/` at runtime.

**Consequences**:
- ✅ Bundle requests are small and fast (no large static skill content)
- ✅ Core skills are versioned with the code, not the database
- ⚠️ `skillsHandler.materialize()` does NOT restore core skills — it only writes what's in the bundle
- ⚠️ In local mode, `materialize()` would wipe core skills from disk — see ADR-002 for why local mode cannot safely call `materialize()`
- ⚠️ If a user disables a core skill, the `disabledBuiltins` list in the bundle tells AgentBox which core skills to skip

---

## ADR-004: Shell Security via Whitelist (Not Blacklist)

**Status**: Active

**Context**:
The agent needs to run shell commands for K8s diagnostics. How do we bound the blast radius?

Options:
- **Blacklist dangerous commands**: Maintain a list of blocked patterns. Simpler but constantly needs updating as new attack vectors emerge.
- **Whitelist allowed commands**: Only explicitly approved binaries can run. Safer by default but requires conscious additions.
- **Full sandbox** (seccomp, gVisor): Maximum safety but high operational complexity and latency.

**Decision**:
Whitelist-only model with 4-pass validation: binary allowlist → per-command validators → kubectl subcommands → per-flag restrictions. Approximately 80+ allowed binaries, each with documented reasoning.

**Consequences**:
- ✅ New binaries cannot be used until consciously reviewed and added
- ✅ Defense-in-depth: even if an attacker controls the command string, unknown binaries are blocked
- ✅ Per-command flag restrictions prevent specific attack vectors (e.g., `curl -d` blocked to prevent POSTing sensitive data)
- ⚠️ Legitimate diagnostic tools may need to be explicitly added (file an issue explaining the use case)
- ❌ `sed`, `awk` are intentionally excluded — use `grep`/`jq`/`yq` instead
- ❌ Skill scripts are exempt from the allowlist — this is intentional (skill review gate is the safety mechanism)

**Revisit when**: A legitimate diagnostic binary is frequently blocked and the use case is well-scoped.

---

## ADR-005: Hybrid Memory Search (Vector + FTS5)

**Status**: Active

**Context**:
Memory search needs to handle both semantic similarity ("find memories about OOMKilled pods") and exact keyword matching ("find memories mentioning node-23"). Pure vector search misses exact terms; pure BM25 misses semantic similarity.

**Decision**:
Hybrid scoring: `score = vectorWeight × cosineSimilarity + ftsWeight × BM25`

Default: `vectorWeight = 0.85`, `ftsWeight = 0.15` (architecture.md), code defaults may differ — consult `src/memory/indexer.ts` for current values.

**Consequences**:
- ✅ Handles both "find semantically similar incidents" and "find the exact error message I saw"
- ✅ CJK-aware: Chinese queries use bigram OR matching; Latin queries use AND
- ⚠️ Requires embedding API to be configured — memory search is unavailable without it
- ⚠️ In-memory cosine similarity over all chunks: acceptable for personal-scale (~1000 chunks), not for team-scale (use sqlite-vec extension for that)

**Future**: When chunk count consistently exceeds ~10k, evaluate sqlite-vec GPU-accelerated vector search.

---

## ADR-006: mTLS Only for K8s Mode

**Status**: Active

**Context**:
Gateway needs to authenticate AgentBox requests. Options:
- **Shared secret / API key**: Simple but static, hard to rotate, provides no identity beyond "valid key"
- **JWT from Gateway**: Gateway signs a JWT for each AgentBox. Simpler than mTLS but asymmetric — Gateway authenticates AgentBox but not vice versa.
- **mTLS (mutual TLS)**: Both sides present certificates. Identity is cryptographically bound to the certificate (no secrets in env vars). Industry standard for service mesh.

**Decision**:
mTLS for K8s mode only. LocalSpawner mode uses plain HTTP (same machine, in-process — mTLS would add latency for zero security benefit on loopback).

- CA: 10-year, stored in DB, auto-renewed at 30-day threshold
- Client certs: issued per-pod at spawn time, identity in CN/OU
- Protected: `/api/internal/*` endpoints on Gateway HTTPS port 3002

**Consequences**:
- ✅ Zero-secret identity: no API keys in pod environment variables
- ✅ Certificate rotation is automatic (new cert on each pod spawn)
- ✅ Certificate encodes userId + workspaceId — Gateway can authorize without DB lookup
- ⚠️ Certificate generation adds ~100ms to pod spawn time
- ⚠️ CA must be backed up — losing it requires re-issuing certs for all active pods
- ❌ Local dev (LocalSpawner) has no mTLS — internal APIs on 127.0.0.1 only

---

## ADR-007: Two Brain Implementations (pi-agent and claude-sdk)

**Status**: Active

**Context**:
The agent runtime needs to support different LLM backends. Should there be one unified brain or multiple implementations?

**Decision**:
Maintain two brain implementations behind the `BrainSession` interface:
- **pi-agent** (`@mariozechner/pi-coding-agent`): Primary brain, full feature set including memory indexer
- **claude-sdk** (`@anthropic-ai/claude-agent-sdk`): Secondary brain, uses in-process MCP server for tool exposure, adds LLM proxy for non-Anthropic providers

**Consequences**:
- ✅ Users can switch brain type per-session based on model/provider preference
- ✅ Anthropic SDK features (Claude-specific) available via claude-sdk brain
- ⚠️ Feature parity gap: memory tools, context tracking, and `steer()` mid-run injection only work in pi-agent
- ⚠️ Dual implementation means new features must be considered for both brains
- ❌ Avoid adding brain-specific features unless they are truly backend-specific — prefer the `BrainSession` interface

**Note**: When adding new tools, test with both brain types. Tool protocol differs (TypeBox for pi-agent, Zod/MCP for claude-sdk).

---

## ADR-008: Cron HA via Database Coordination (Not Leader Election)

**Status**: Active

**Context**:
Multiple Gateway instances can run in K8s. Cron jobs must fire exactly once. Options:
- **Single cron pod**: Designate one pod as cron leader. Simple but a SPOF.
- **External scheduler** (k8s CronJob): Offload to K8s. Requires separate Job management complexity.
- **DB-based coordination**: Each instance registers, claims jobs via `assignedTo` field, detects dead instances via heartbeat.

**Decision**:
DB-based coordination with heartbeat. Each cron instance:
1. Registers in `cron_instances` table with heartbeat every 30s
2. Reconciles every 60s: claims unassigned or orphaned jobs (from instances dead > 90s)
3. Runs job, updates `lastRunAt` + `lastResult`
4. Releases jobs on graceful shutdown

**Consequences**:
- ✅ No single point of failure
- ✅ No external dependencies (reuses existing DB)
- ✅ Job ownership is explicit and auditable
- ⚠️ Up to 90s delay in job reassignment after a crash (dead threshold)
- ⚠️ Duplicate firing possible in edge case: instance A marks job "executing" but crashes before updating `lastRunAt`; instance B reclaims and fires again. Acceptable for SRE automation use cases; add idempotency guards in critical skill scripts.
