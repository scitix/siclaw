# Concerns & Technical Debt

> Source: Code audit conducted 2026-03-18. Based on `docs/design/invariants.md`,
> `docs/design/security.md`, `docs/design/roadmap.md`, and direct source inspection.

---

## Critical Invariants (from docs)

These invariants are documented and mostly respected, but their enforcement is fragile in
specific ways noted below.

### 1. LocalSpawner Shared Filesystem

**Status: Enforced, but enforcement is in application code only.**

`src/gateway/agentbox/local-spawner.ts` correctly writes to `skills/user/{userId}/` and
does NOT call `skillsHandler.materialize()`. This is correct. However, there is no
compile-time or runtime guard preventing a future contributor from accidentally calling
`skillsHandler.materialize()` in a new local-mode code path. The only protection is
documentation and code review vigilance.

**Risk**: Any future code that calls `skillsHandler.materialize()` from a local spawner
code path will silently delete all users' skills without error. The invariant depends
entirely on reviewer discipline.

### 2. sql.js Single-Process Lock

**Status: Implemented, but PID-based reclaim has a race window.**

The `acquireSqliteLock()` function in `src/gateway/db/index.ts` uses a PID lockfile.
The lock reclaim path—reading the lock file, checking if the PID is alive, then writing
the lock—is not atomic. On systems where PIDs are reused quickly (unlikely in practice),
a legitimate owner could be displaced. The comment in the code acknowledges the "PID
reuse" edge case only for container environments (where every process is PID 1).

More concretely: if the `SICLAW_DATABASE_URL` environment variable is set to the same
SQLite file and two instances are started in close succession, the second may claim a
"stale" lock that is actually held. This is low probability but the error message
provides no mitigation path.

### 3. Memory DB Migrations via Runtime PRAGMA Checks

**Status: Works, but fragile at scale.**

`src/memory/schema.ts` performs migrations by calling `PRAGMA table_info()` at startup
and issuing `ALTER TABLE` statements. There is no versioned migration table. As the
investigations schema accumulates more ad-hoc `ALTER TABLE` migrations (already 4
columns: `remediation_steps`, `feedback_signal`, `feedback_note`, `feedback_at`), the
startup migration code grows linearly. Contrast with the Gateway DB, which at least has
the DDL separated into `migrate-sqlite.ts`.

### 4. Two-Location SQLite DDL Parity

**Status: Documented but has no automated enforcement.**

Every new Gateway DB table must be added to both `src/gateway/db/schema-sqlite.ts` AND
`src/gateway/db/migrate-sqlite.ts`. There is no CI check that detects drift between these
two files. The `sessions` table's `s3_key` column exists in `migrate-sqlite.ts` but a
reviewer would have to manually cross-reference to confirm schema-sqlite.ts parity.

---

## Known Issues & TODOs

### 1. `EARLY_EXIT_CONFIDENCE = 101` — Early Exit Disabled

`src/tools/deep-search/types.ts` line 107 sets `EARLY_EXIT_CONFIDENCE = 101`, which
effectively disables early exit permanently (101% confidence is unreachable). The comment
documents that the intended threshold is 80%. This means every deep investigation always
validates **all** hypotheses even when one is already clearly the root cause, consuming
maximum budget unnecessarily.

**Impact**: Deep investigations always run to full budget. A user investigating a known
clear-cut issue still waits for all hypotheses to be explored.

### 2. Hypothesis Dedup is Text-Only (No Semantic Dedup)

`src/tools/deep-search/engine.ts` line 830 has an explicit note: semantic dedup
(embedding similarity) would catch more hypothesis variants but requires async embedding
calls and was left as a future improvement. The current text normalization (`lowercase +
trim + collapse whitespace`) will miss semantically identical hypotheses stated
differently (e.g., "high memory pressure" vs "OOM condition in pod").

### 3. Tool Execution Events Unreliable for pi-agent

`src/agentbox/session.ts` line 261 notes that `tool_execution_start/end` events depend
on the brain implementation, and pi-agent emits them only if the SDK's event stream
includes them. If not emitted, tool metrics will be zero. This means per-tool latency
metrics in dashboards may be silently missing for pi-agent brain sessions.

### 4. `require("http")` in ESM Module

`src/agentbox/gateway-client.ts` line 104 uses `require("http")` (CommonJS syntax) in an
ESM-only codebase. This works in Node.js's CJS-interop mode for built-in modules but
violates the ESM-only invariant (`docs/design/invariants.md §9`). If this module is ever
bundled or run in a stricter ESM context, it will break. The correct pattern is
`await import("node:http")` or a top-level `import http from "node:http"`.

### 5. `sqlite-vec` Loaded via `require()` in ESM Context

`src/memory/indexer.ts` line 68 uses `require("sqlite-vec")` with an explicit
`// eslint-disable-next-line @typescript-eslint/no-require-imports` comment. This is a
known ESM/CJS interop workaround for a native extension. Non-fatal because it falls back
gracefully, but it is technical debt.

### 6. `cachedSkillsPrompt` Module-Level Singleton in Sub-Agent

`src/tools/deep-search/sub-agent.ts` lines 43-53 cache the skills prompt in a
module-level variable. This means if skill files are updated on disk during a long-running
gateway session, sub-agents continue using stale skill content until the process restarts.
The main agent session reloads skills via `brain.reload()`, but sub-agents do not.

### 7. `sharedModelRegistry` Module-Level Singleton Reads Config Once

`src/tools/deep-search/sub-agent.ts` lines 61-68 create `sharedModelRegistry` at first
call and never refresh it. If the settings.json file changes (new model added, API key
rotated), sub-agents continue using the stale registry until process restart.

### 8. Metrics Cardinality Warning Not Addressed

`src/shared/metrics.ts` line 90 notes: `siclaw_skill_calls_total` uses `skill_name` as a
label, which is unbounded (one label value per personal skill). The comment recommends
dropping the counter if personal skill counts grow large. No action has been taken. This
is a latent cardinality bomb for Prometheus memory if users create many personal skills.

### 9. `LocalBox.lastActiveAt` Always Returns `createdAt`

`src/gateway/agentbox/local-spawner.ts` lines 135 and 151 return `lastActiveAt:
box.createdAt` for both `get()` and `list()`. The actual last-active timestamp is never
updated. Any feature that relies on `lastActiveAt` for local-mode boxes (session expiry,
idle cleanup, metrics) will see incorrect data.

---

## Security Considerations

### 1. Debug Pod Spawned with `privileged: true`, `hostPID: true`, `hostNetwork: true`

`src/tools/exec-utils.ts` lines 215-220 creates debug pods with full host namespace access
and privileged security context. This is required for `node_exec` to perform host-level
diagnostics (e.g., `nsenter`). However, the threat model in `docs/design/security.md`
focuses on restricting the AgentBox container — once the agent can spawn a privileged
debug pod, it has full node access via that pod. This is **by design** but creates a
significant trust boundary: an attacker who can control the agent's `node_exec` tool calls
can own the node. The mitigating factor is that `kubectl create/run` is blocked in the
command validator... but debug pod creation goes through `kubectl run` with `--overrides`,
which is how `node_exec` works. This path needs explicit documentation in the security
doc that it is a known escalation surface guarded by the skill review gate.

### 2. NetworkPolicy Not Deployed (Documented Gap)

`docs/design/security.md` §10.2 has an unchecked item: `[ ] Deploy NetworkPolicy for
egress restriction`. The sandbox user can make arbitrary outbound network connections
(DNS, HTTP) unless a NetworkPolicy is in place. The recommended `agentbox-egress`
NetworkPolicy exists in documentation but is not part of any deployed manifest or Helm
chart. This is the largest unmitigated network-level risk: exfiltration via `curl` POST is
blocked by command validation (Layer 2), but DNS-tunneling or other side channels through
whitelisted commands (like `dig`, `nslookup`) are not blocked at the network layer.

### 3. Production/Test Workspace Isolation Not Enforced (ADR-011)

`docs/design/invariants.md §12` explicitly states: "enforcement not yet implemented."
The `workspaces.envType` (`"prod"` | `"test"`) field exists in schema, but credential
scoping, environment binding, and investigation memory isolation across envTypes are all
absent. All workspaces effectively have full credential visibility regardless of their
declared type. Any user with access to a "test" workspace that shares credentials with
prod can reach prod clusters.

### 4. `output-redactor.ts` Applies After DB Write, Not Before

`src/gateway/output-redactor.ts` is described as applying to "WS stream, channel-bridge,
and DB storage." However, review the comment on line 8: it says applied to "outbound text
sent to the user via WebSocket." If redaction is applied at the WS send layer but the
message is written to the `messages` DB table before redaction, then credential leakage
could exist in the `messages` table even if WebSocket output is clean. Verification is
needed that DB writes go through `redactText()` before persistence.

### 5. `sudo -E -u sandbox` Only Active in `NODE_ENV === "production"`

`src/tools/restricted-bash.ts` line 288: OS-level user isolation (the primary credential
defense) is **disabled in development**. In local dev, child processes run as the same
user as the main process and can read credential files. Any developer who runs the
Gateway in dev mode and accidentally exposes it on a network interface has no OS-level
credential isolation. This is documented but easy to forget.

### 6. mTLS Certificate Validity Window Not Tracked

`src/gateway/security/cert-manager.ts` auto-renews the CA when fewer than 30 days remain
(10-year CA). However, short-lived client certificates issued per-pod have no described
expiry — the code issues them but the lifetime is not documented or easily auditable from
the source. If a pod's certificate is issued with a long validity window and the pod is
compromised, the certificate remains valid for that window.

---

## Performance Concerns

### 1. sql.js Loads Entire Database Into RAM

`src/gateway/db/index.ts`: sql.js is WASM SQLite that loads the full `.siclaw/data.sqlite`
file into memory on startup. For a heavily-used multi-user local deployment where sessions,
messages, skill versions, and notifications accumulate, the database file can grow into
tens of megabytes. Every 30-second auto-flush serializes the entire in-memory DB back to
disk with `writeFileSync`. This is synchronous I/O on the event loop. At large DB sizes
this will cause periodic latency spikes. Threshold for concern: ~100MB per ADR-001.

### 2. Memory Indexer `sync()` Runs On Every Agent Turn

`src/core/extensions/memory-flush.ts` line 99 calls `memoryIndexer.sync()` on every
`agent_end` event. For sessions with high tool activity, this triggers a full re-scan of
the memory directory and re-embedding of any changed files after every LLM turn. If the
memory directory is large or embedding calls are slow, this adds latency between turns.

### 3. Module-Level Singleton for Sub-Agent Auth + Model Registry

`src/tools/deep-search/sub-agent.ts`: `sharedAuthStorage` and `sharedModelRegistry` are
initialized once and shared across all concurrent deep investigations. This avoids repeated
initialization but also means all sub-agents share the same API key state. Under high
concurrency (multiple users triggering `deep_search` simultaneously), all sub-agents
compete for the same LLM rate limits under the same auth context.

### 4. `buildAppendSystemPrompt()` Reads Files Synchronously at Session Start

`src/core/agent-factory.ts` lines 157-224: `PROFILE.md` and `MEMORY.md` are read with
`fs.readFileSync` at session creation time. `buildKnowledgeOverview()` is also called
synchronously. For users with large memory files, this adds startup latency before the
first LLM call. The `MEMORY.md` file is truncated to 20,000 chars, which mitigates token
cost but not the synchronous I/O at startup.

### 5. Deep Search Debug Traces Always Written to Disk

`src/tools/deep-search/engine.ts` `writeDebugTrace()` always writes a Markdown debug
trace file to `.siclaw/traces/`. There is no mechanism to disable this or prune old trace
files. Over time, traces accumulate indefinitely. In a production environment with many
investigations, this directory will grow without bound.

---

## Fragile Areas

### 1. Deep Investigation Phase 3 Verdict Parsing Uses Regex on Free Text

`src/tools/deep-search/engine.ts` `parseVerdict()` (line 317) extracts `VERDICT:`,
`CONFIDENCE:`, and `REASONING:` from unstructured sub-agent text output using regex. This
is a brittle contract with the LLM: if the model formats its output differently (e.g.,
uses "Verdict:" with a capital V and different punctuation, or embeds the verdict in a
sentence), the regex fails and the verdict defaults to `"inconclusive"` with 50%
confidence. This degrades investigation quality silently. Phase 1's context summary
(`parseContextSummary()`) has the same fragility with a structured-then-fallback approach.

### 2. CronService Calls `localhost:${gatewayPort}` Self-HTTP

`src/gateway/cron/cron-service.ts` line 116: cron job execution POSTs to
`http://localhost:{gatewayPort}/api/internal/agent-prompt` using `fetch()`. This means
the cron service is coupled to the HTTP server being up and listening on the expected
port. If the server is slow to start, or if the port changes, cron jobs silently fail.
More subtly: this creates a circular dependency (cron is initialized inside the Gateway,
then makes HTTP calls back to the Gateway). An unhandled error in the agent-prompt handler
could cause a cron job to deadlock waiting for a response that never completes within the
`EXECUTION_TIMEOUT_MS + 10_000` window.

### 3. Port Allocation in LocalSpawner is Not Collision-Safe

`src/gateway/agentbox/local-spawner.ts` lines 82-83: ports are allocated sequentially
from `basePort` using `this.nextPort++`. There is no check that the selected port is
actually free before calling `listen()`. On a busy development machine or after a partial
restart (some boxes still running on old ports), port collisions will throw an error from
`httpServer.listen()`. The error bubbles up to the caller but the port counter has already
been incremented, so subsequent allocations skip the failed port.

### 4. `extractPipeline()` and `extractCommands()` Code Duplication

`src/tools/command-validator.ts` contains two nearly-identical functions: `extractCommands()`
(lines 37-106) and `extractPipeline()` (lines 121-191). Both parse shell pipelines with
the same quote/paren tracking logic. The difference is that `extractPipeline()` tracks
pipe-position context for `pipeOnly` rule enforcement. The duplicated parser creates a
maintenance surface: a fix to the parsing logic must be applied in both functions. A bug
in one may not be discovered until a test exercises the other context.

### 5. `resolveKubeconfigByName` Regex in Hot Path

`src/tools/restricted-bash.ts` lines 275-281: the `--kubeconfig=<name>` resolution uses
`command.replace(/--kubeconfig=([^\s/"']+)/g, ...)` on every command execution. This is
fine for typical use, but note that the replacement callback calls
`resolveKubeconfigByName()` which may do filesystem lookups. If many `--kubeconfig`
references exist in a complex pipeline, this could involve multiple filesystem calls per
command.

### 6. `buildSreSystemPrompt()` Cannot Be Safely Modified

`src/core/prompt.ts` is flagged in CLAUDE.md as protected: "must NEVER be modified
without explicit human confirmation." There is no technical enforcement of this
restriction (no CI check, no lint rule). Accidental modification to this file could
silently alter agent behavior. The protection relies entirely on CLAUDE.md being read.

### 7. Channel Integrations Use Pervasive `as any` Casts

`src/gateway/channels/lark.ts` has 20+ uses of `(apiClient as any)` to call Lark SDK
methods. `src/gateway/channels/slack.ts` also has `as any` casts. These are due to the
SDK client lacking TypeScript type declarations. Any breaking API change in the Lark or
Slack SDK will not be caught at compile time, only at runtime.

### 8. Memory Flush Extension Uses `(event as any).messages`

`src/core/extensions/memory-flush.ts` lines 86-87 accesses `(event as any).messages` to
strip silent reply tokens. This is a direct dependency on the internal message format of
pi-agent's event objects, which is not part of the typed `BrainSession` interface. If
pi-agent changes its event shape, silent reply stripping silently breaks.

---

## Architectural Debt

### 1. Brain Type Feature Gap

`docs/design/invariants.md §10`: Memory tools (`memory_search`, investigation history,
`investigation_feedback`) are pi-agent only. The claude-sdk brain has no equivalent.
This creates a two-tier user experience depending on brain choice. Any new memory-adjacent
feature must be implemented twice or forever remains pi-agent-only. The `BrainSession`
interface in `src/core/brain-session.ts` provides no hook for memory integration in a
brain-agnostic way.

### 2. Deep Search is pi-agent Only

`src/tools/deep-search/sub-agent.ts` directly imports and uses `@mariozechner/pi-coding-agent`
APIs (`createAgentSession`, `DefaultResourceLoader`, `loadSkillsFromDir`,
`formatSkillsForPrompt`). The `deep_search` tool therefore only works with pi-agent brain.
The agent factory registers it regardless of brain type, but it will fail at runtime for
claude-sdk sessions.

### 3. Dual Database Engines Create Maintenance Overhead

The Gateway DB (sql.js / MySQL) and the Memory DB (node:sqlite) are separate engines with
different migration strategies: Gateway uses `DDL_STATEMENTS` + try/catch ALTER TABLE;
Memory DB uses `PRAGMA table_info()` + conditional ALTER TABLE. Neither uses a versioned
migration table. As both databases accumulate schema changes, the ad-hoc migration
approach becomes harder to audit and reason about. A migration like "does column X exist?"
is O(n) in columns per table across every restart.

### 4. No Integration Tests for Resource Sync

The resource sync pipeline (`fetch → materialize → postReload`) is a critical correctness
surface — a bug here destroys skills or leaves users with stale configurations. There are
unit tests for individual components, but no integration test that exercises the full
`LocalSpawner → syncResources → skillsHandler.materialize path` vs.
`K8sSpawner → resource-notifier → HTTP POST → AgentBox reload` path end-to-end.

### 5. `lastActiveAt` Not Tracked in LocalSpawner Boxes

`src/gateway/agentbox/local-spawner.ts` lines 135 and 151 always return `lastActiveAt:
box.createdAt`. Any box lifecycle feature that relies on this field (idle detection,
metrics, health checks) silently receives wrong data in local mode. The K8sSpawner
presumably uses actual K8s pod status for this, so local mode is the odd one out.

### 6. `ProcessSpawner` is Not the Default and Undertested

`src/gateway/agentbox/process-spawner.ts` exists as a middle-ground spawner (true process
isolation on a local machine). Per ADR-002, it is not the default and "may be promoted if
local dev isolation needs increase." Its test coverage is unclear and it has not been
exercised in the main development path. If it is meant as a fallback, its reliability
relative to `LocalSpawner` is unknown.

### 7. Observability Integration is the Largest Missing Capability

`docs/design/roadmap.md §C` labels OB0 (Prometheus metrics query) as P1 priority and
the "largest capability gap." Without `metrics_query`, `log_query`, and `correlate_events`
tools, the agent cannot do meaningful real-time SRE diagnosis — it can only read what
Kubernetes already exposes via `kubectl`. Every investigation with a metrics component
requires the agent to tell users to check Grafana manually. This is the most significant
feature gap relative to competitive tools (HolmesGPT has full OB integration).

### 8. No Rate Limiting on Agent Prompt Execution

`src/gateway/server.ts` `/api/internal/agent-prompt` endpoint (used by CronService) and
the main WebSocket prompt path have no user-level rate limiting. A misbehaving cron job
or a runaway prompt loop could saturate the LLM API budget and block other users. The
`CRON_LIMITS.MAX_CONCURRENT_EXECUTIONS` check provides a soft limit on concurrent cron
runs but does not protect against rapid sequential runs or WebSocket prompt flooding.

---

## Recommendations

### High Priority (Correctness / Security)

1. **ADR-011 environment isolation**: Implement credential scoping enforcement for
   `envType`. Until this lands, the `is_test` / `env_type` fields on workspaces are
   decorative. Add a guard in the credential materialization path that prevents
   prod-type credentials from being written into test-type workspaces.
   Files: `src/gateway/db/repositories/credential-repo.ts`,
   `src/agentbox/resource-handlers.ts`

2. **Deploy NetworkPolicy**: Add the recommended `agentbox-egress` NetworkPolicy from
   `docs/design/security.md §9.3` to the K8s manifests / Helm chart. Mark the
   `[ ] Deploy NetworkPolicy` checklist item in that document as done once deployed.

3. **Verify output-redactor applies before DB write**: Audit the server-side message
   persistence path in `src/gateway/server.ts` to confirm `redactText()` is called before
   messages are written to the `messages` table.

4. **Fix `require("http")` in ESM module**: `src/agentbox/gateway-client.ts` line 104
   should use `import http from "node:http"` at the top of the file.

5. **Document `node_exec` privilege escalation surface**: Add a section to
   `docs/design/security.md` explicitly noting that `node_exec` creates privileged debug
   pods (`hostPID`, `hostNetwork`, `privileged: true`), that this is the intended design
   for host diagnostics, and what guards exist (skill review gate, kubectl allowlist).

### Medium Priority (Reliability / Maintainability)

6. **Add `lastActiveAt` tracking in LocalSpawner**: Wire session activity events
   back to `LocalBox.lastActiveAt` so that any feature relying on box age works correctly
   in local mode.

7. **Refactor `extractCommands` / `extractPipeline` duplication**: Extract a single
   tokenizer that both functions call, parameterized by whether pipe-position tracking is
   needed. Reduces maintenance surface for future parser fixes.

8. **Add a CI check for schema-sqlite.ts vs migrate-sqlite.ts parity**: A simple script
   that extracts table names from both files and diffs them would catch drift before it
   reaches production.

9. **Enable `EARLY_EXIT_CONFIDENCE = 80`** (or make it configurable per investigation):
   The current `101` value means all hypotheses are always validated. Document and expose
   this as a configuration parameter so teams can tune it once confidence calibration
   is validated.
   File: `src/tools/deep-search/types.ts`

10. **Bound debug trace file accumulation**: Add a trace cleanup policy (e.g., keep last
    100 traces, or purge traces older than 7 days) to the existing `CronService`
    maintenance path.
    Files: `src/gateway/cron/cron-service.ts`, `src/tools/deep-search/engine.ts`

### Low Priority (Debt Reduction)

11. **Migrate Memory DB to versioned migrations**: Replace the `PRAGMA table_info()`
    column-existence checks in `src/memory/schema.ts` with a `schema_version` meta table
    and numbered migrations. Consistency with broader practice reduces cognitive load.

12. **Refresh `sharedModelRegistry` / `cachedSkillsPrompt` in sub-agents**: Add a TTL
    or explicit invalidation hook so that deep investigation sub-agents pick up skill
    and model configuration changes within a running session.
    File: `src/tools/deep-search/sub-agent.ts`

13. **Add typed interfaces for Lark SDK**: Replace `(apiClient as any)` with an explicit
    ambient type declaration or wrapper, so that Lark API breakages are caught at compile
    time.
    File: `src/gateway/channels/lark.ts`

14. **Promote `ProcessSpawner` or document its support status**: Either document it as
    fully supported with tests or mark it as experimental/deprecated to avoid confusion
    about the supported spawner surface.
    File: `src/gateway/agentbox/process-spawner.ts`
