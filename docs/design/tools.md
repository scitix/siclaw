---
title: "Tool Development Guide"
sidebarTitle: "Tools"
description: "How to add, modify, and organize tools in the Siclaw agent."
---

# Tool Development Guide

> **Purpose**: Guide contributors on how tools are organized, how to add new ones,
> and what safety requirements must be followed.
>
> **Audience**: Anyone adding or modifying tools in `src/tools/`.

---

## 1. Directory Structure & Classification

Tools are organized into 6 subdirectories under `src/tools/`, classified by
their **security model** (how they handle user input and output):

```
src/tools/
  ├── cmd-exec/       User-provided commands — full security pipeline
  ├── script-exec/    Pre-audited scripts — no command validation
  ├── query/          Data queries (memory, DB, filesystem)
  ├── workflow/       User-facing workflow operations
  └── infra/          Shared infrastructure (security, execution, output)
```

### Classification Rules

| Directory | When to use | Key traits |
|-----------|-------------|------------|
| `cmd-exec/` | Tool executes a **user-provided command** (remote or local) | Full security pipeline: `preExecSecurity` → execute → `postExecSecurity` |
| `script-exec/` | Tool executes a **pre-approved script file** (remote or local) | No command validation needed (scripts are reviewed); uses `resolveScript()` |
| `query/` | Tool performs **read-only data retrieval** (no process spawn, no K8s interaction) | Pure function over memory indexer, DB, or filesystem |
| `workflow/` | Tool orchestrates a **user-facing workflow** (investigation, skill management, scheduling) | Business logic, often stateful |
| `infra/` | **Not a tool** — shared functions consumed by tools | Security pipeline, K8s execution helpers, output processing |

### Decision Tree: Where Does My New Tool Go?

```
Does it execute a user-provided command string?
├─ Yes → cmd-exec/
├─ No → Does it execute a pre-approved script?
│        ├─ Yes → script-exec/
│        └─ No → Does it query data without side effects?
│                 ├─ Yes → query/
│                 └─ No → workflow/
```

---

## 2. Tool Definition Contract

Every tool is a **factory function** that returns a `ToolDefinition` object:

```typescript
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export function createMyTool(dep: SomeDependency): ToolDefinition {
  return {
    name: "my_tool",              // snake_case, unique across all tools
    label: "My Tool",             // Display name for TUI
    description: "...",           // Markdown — this IS the LLM prompt for tool usage
    parameters: Type.Object({     // TypeBox schema
      param: Type.String({ description: "..." }),
    }),
    async execute(toolCallId, rawParams, signal) {
      // Implementation
      return {
        content: [{ type: "text", text: "result" }],
        details: { exitCode: 0 },
      };
    },
    renderCall(args, theme) { /* TUI call rendering */ },
    renderResult: renderTextResult,
  };
}
```

**Key patterns:**
- Dependencies are injected via factory function parameters and captured in closures
- Mutable refs (`kubeconfigRef`, `llmConfigRef`, `memoryRef`) allow runtime config changes
- Return format is always `{ content: [{ type: "text", text }], details?: {} }`

**⚠️ Description–Code Consistency Rule:**

The `description` field is **the LLM's only understanding of what a tool does
and when to use it**. If execution logic changes but the description does not,
the LLM will operate on a stale mental model — calling the tool at wrong times,
passing wrong parameters, or misinterpreting results. This produces silent bugs
that are extremely hard to diagnose.

**Any PR that modifies a tool's `execute()` logic MUST review and update its
`description` (and parameter descriptions) to stay in sync.** Treat description
as a contract with the LLM, not a comment for humans.

---

## 3. Command Execution Tools (`cmd-exec/`)

These tools execute user-provided commands on remote K8s targets. They **must**
follow this orchestration flow — skipping any step is a security risk:

```
Step  1: resolveRequiredKubeconfig()          → infra/kubeconfig-resolver.ts
Step  2: prepareExecEnv()                     → infra/exec-utils.ts
Step  3: validateTarget() [node or pod name]  → infra/exec-utils.ts
Step  4: validateCommand(cmd, { context })    → infra/command-validator.ts  ⚠️ MANDATORY
Step  5: checkReady() [node or pod]           → infra/k8s-checks.ts
Step  6: analyzeOutput(binary, args)          → infra/output-sanitizer.ts  ⚠️ MANDATORY
Step  7: buildCommand() [tool-specific]
Step  8: run() [debug pod / kubectl exec]
Step  9: applySanitizer(stdout, action)       → infra/output-sanitizer.ts  ⚠️ MANDATORY
Step 10: formatExecOutput() / processToolOutput() → infra/exec-utils.ts / tool-render.ts
```

**Steps 4, 6, 9 are non-negotiable security requirements.** They ensure:
- Only whitelisted commands execute (Step 4)
- Sensitive data in output is detected pre-execution (Step 6)
- Output is sanitized post-execution before reaching the LLM (Step 9)

### Variation Points

| Point | node\_exec | pod\_exec |
|-------|-----------|----------|
| Context | `"node"` | `"pod"` |
| Target validation | `validateNodeName` | `validatePodName` |
| Ready check | `checkNodeReady` | `checkPodRunning` |
| Command build | nsenter wrap (+ `ip netns exec` when `netns` param set) | kubectl exec args |
| Pipeline support | Yes (pipes, `&&`, `;`) | No (`blockPipeline: true`) |
| Execution | `runInDebugPod` | `execFileAsync("kubectl")` |

**Pod network namespace diagnostics** (host tools against a pod's network — RDMA/RoCE
on a pod that lacks `show_gids`/perftest): enter the pod's **net** namespace while keeping
the host's mount namespace, i.e. `… ip netns exec <netns> <host-tool>`. Two transports,
one mechanism (`src/tools/infra/pod-netns-resolve.ts` resolves pod → netns):

- **One step (preferred)** — pass `pod` (+ `namespace`) directly; the tool resolves the netns
  internally and runs the command inside it:
  - kubectl: `node_exec(pod, namespace, command)` / `node_script(pod, …)` — node is resolved too.
  - ssh: `host_exec(host=<node>, pod, namespace, command)` / `host_script(…)` — `host` is the node;
    its SSH credential must be **root** (crictl + `ip netns exec` need CAP_SYS_ADMIN).
- **Advanced / reuse** — `resolve_pod_netns(pod, namespace)` → `{node, netns}`, then
  `node_exec(node, netns, command)`; lets one resolution serve many commands.

The netns/nsenter/`ip netns exec` prefix is always **tool-constructed** (never raw model input):
the inner command goes through the same whitelist; the netns name (from crictl) is regex-validated.
Assumes the CNI creates `/var/run/netns/<name>`. Replaces the former `pod_nsenter_exec` tool.

---

## 4. Script Execution Tools (`script-exec/`)

These tools execute pre-approved skill scripts. The orchestration flow is
similar but **omits command validation and output sanitization** (scripts are
reviewed before deployment):

```
Step 1: resolveRequiredKubeconfig()
Step 2: prepareExecEnv()
Step 3: validateTarget() [node or pod name]
Step 4: checkReady()
Step 5: resolveScript()                       → infra/script-resolver.ts
Step 6: buildCommand() [base64 inject or stdin pipe]
Step 7: run() [debug pod / kubectl exec]
Step 8: formatExecOutput()
```

### Script Transmission Methods

| Tool | Method | How |
|------|--------|-----|
| `node_script` | stdin pipe | `kubectl exec -i` → `nsenter … sh -c '<reader>'` with the script piped to stdin (`sh -s` / `python3 -`). Supports `netns` param for pod network namespace. |
| `pod_script` | stdin pipe | `kubectl exec -i` with script piped to stdin |
| `host_script` | stdin pipe | ssh2 channel with the script piped to the remote `sh -s` / `python3 -` |
| `local_script` | argv | interpreter + scriptPath (+ args) spawned directly in the AgentBox |

---

## 5. Local Tools (now merged into `cmd-exec/` and `script-exec/`)

### `restricted_bash`

The most complex tool. Handles full shell pipelines with:
- 6-pass command validation pipeline (`validateCommand` in `command-validator.ts`)
- Per-command kubectl subcommand validation (`validateKubectlInPipeline`)
- Kubeconfig name resolution via regex (`--kubeconfig=<name>`)
- Production mode: `sudo -E -u sandbox` user isolation
- Skill script detection bypass (`isSkillScript`)
- 3-layer output sanitization (see §6.2)
- Optional `run_in_background` (see §9) — exposed only when a `backgroundExecExecutor` is injected

**kubectl access**: There is no dedicated kubectl tool — all kubectl commands go
through `restricted_bash` with pipeline validation. `validateKubectlInPipeline()`
enforces read-only subcommands (`SAFE_SUBCOMMANDS` in `command-sets.ts`), blocks
`--all-namespaces` on broad queries, and passes exec'd commands through the
binary allowlist. This is by design: kubectl in pipelines (`kubectl get pods | grep Error`)
is the natural SRE workflow, and OS-level isolation (ADR-010) is the primary
credential protection — not a separate tool boundary.

### `local_script`

Executes skill helper scripts locally via `spawn()`. No command validation
(scripts are from trusted `skills/` directory). Uses `resolveSkillScript()`
in `infra/script-resolver.ts` for path resolution with traversal protection.

**Output sanitization exemption**: Skill script output is NOT sanitized by
`output-sanitizer.ts`. This is intentional — skill scripts are pre-reviewed
(static analysis + AI semantic review + human approval) and operate as trusted
code. The security boundary is the skill approval gate, not runtime sanitization.

---

## 6. Shared Infrastructure (`infra/`)

### 6.1 Execution Context System

Commands are validated against context-specific whitelists. Different execution
environments expose different command categories:

| Context | Used by | Unique trait |
|---------|---------|-------------|
| `local` | `restricted_bash` | Most restrictive — no `file` category (cat/ls/find blocked, use agent file tools), no `general-env` (env/printenv blocked, redacted via sanitizer), no `inspection`/`compressed`. Text commands are pipe-only. |
| `node` | `node_exec` | Full remote diagnostic set — file access, env inspection, compression tools all allowed |
| `pod` | `pod_exec` | Same as node — full diagnostic set inside target pod |

Categories missing from `local` but present in remote contexts:

| Category | Examples | Why blocked locally |
|----------|----------|-------------------|
| `file` | cat, ls, find, stat, du | Agent has dedicated file tools (Read, Grep, Glob) with path restrictions |
| `general-env` | env, printenv | Would expose process environment; handled via output sanitizer in pipelines |
| `inspection` | lsof, lsns, strings | Inspection tools not needed in AgentBox container |
| `compressed` | zcat, zgrep, bzcat | Archive tools not needed locally |

The context system has two layers:

1. **`COMMANDS`** — unified command registry (`Record<string, CommandDef>`).
   Each entry carries the command's category and its intrinsic safety constraints
   (global, context-independent). This is the single source of truth for which
   commands exist and how they are constrained.

2. **`CONTEXT_POLICIES`** — per-context environment policies (internal, not exported).
   Defines which categories are available, which categories are pipe-only, and
   which categories have context-specific blocked flags.

**Source**: `COMMANDS` and `CONTEXT_POLICIES` in `src/tools/infra/command-sets.ts`

### 6.2 Security Strategy: Pre-Execution vs Post-Execution

The security pipeline uses two complementary strategies — understanding which
strategy applies is essential when adding new commands or modifying sanitization:

```
┌─────────────────────────────────────────────────────────────────────┐
│ PRE-EXECUTION: Block commands that could LEAK or ESCALATE          │
│                                                                     │
│ command-validator.ts — 6-pass pipeline                              │
│   Pass 1: Shell operators ($(), backticks, redirections)            │
│   Pass 2: Pipeline extraction (| && || ;)                          │
│   Pass 3: Binary whitelist (context-based)                         │
│   Pass 4: Pipeline validators (kubectl subcommands)                │
│   Pass 5: COMMANDS constraints + CONTEXT_POLICIES             │
│   Pass 6: Sensitive path patterns (25+ patterns, see security.md)  │
│                                                                     │
│ Blocks: unknown binaries, write operations, credential path access  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                            command executes
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│ POST-EXECUTION: Redact output from commands SAFE TO RUN            │
│                                                                     │
│ output-sanitizer.ts — 3-layer sanitization                         │
│                                                                     │
│ Layer 1: analyzeOutput(binary, args)                               │
│   → Pre-analysis: detect if command targets sensitive resource type │
│   → Returns OutputAction with sanitize function for Layer 2        │
│                                                                     │
│ Layer 2: applySanitizer(stdout, action)                            │
│   → Apply the registered sanitizer from Layer 1                    │
│   → Redacts: Secret values, ConfigMap data, env vars, credentials  │
│                                                                     │
│ Layer 3: Pipeline fallback (restricted-bash.ts only)               │
│   → If kubectl targets sensitive resource in a MULTI-COMMAND       │
│     pipeline, apply broad line-level redaction to final output     │
│   → Safety net: catches cases where pipeline's last command has    │
│     no registered sanitizer                                        │
│                                                                     │
│ Handles: kubectl get secret (runs, output redacted),               │
│          env/printenv (runs, sensitive vars stripped),              │
│          crictl inspect (runs, env vars in JSON redacted)          │
└─────────────────────────────────────────────────────────────────────┘
```

**The key distinction**:
- Sensitive **paths** (credential files, /proc/environ) → **pre-execution blocking** (Pass 6)
- Sensitive **resource types** (Secret, ConfigMap) → **post-execution redaction** (output sanitizer)
- Dangerous **operations** (write, exec, redirect) → **pre-execution blocking** (Passes 1-5)

**Cross-cutting concern**: When modifying `output-sanitizer.ts`, verify that
existing skill scripts are not affected — skill output bypasses sanitization
(see §5 `local_script`), but ad-hoc commands that skills depend on (e.g.,
`kubectl get configmap`) go through the sanitizer. See `docs/design/sanitization.md`
for the full specification.

**Source**: `src/tools/infra/command-validator.ts`, `src/tools/infra/output-sanitizer.ts`

### 6.3 How to Add a New Command

**Step 1: Security Assessment**

Before adding any command, answer:
- What does this command do? Can it write files, execute code, or exfiltrate data?
- What flags/subcommands are dangerous? (e.g., `-w` for write, `-exec` for code execution)
- Is it safe in all contexts (local + remote), or does it need constraints?

**Step 2: Choose Category**

Pick from existing categories: `text`, `network`, `rdma`, `perftest`, `gpu`,
`hardware`, `kernel`, `process`, `file`, `diagnostic`, `services`, `container`,
`firewall`, `inspection`, `compressed`, `activity`, `stream`, `general`,
`general-env`, `flow`.

If none fit, define a new `CommandCategory` value and add it to
`CONTEXT_POLICIES[*].available` for each context where it should be available.

**Step 3: Register in COMMANDS**

Add one entry to `COMMANDS` in `command-sets.ts`. This single entry handles
whitelist membership, category classification, context availability, and safety
constraints. No other data structures need changing.

```typescript
// No constraints — safe as-is
mycommand: { category: "network" },

// With declarative constraints
mycommand: {
  category: "services",
  allowedSubcommands: { position: 0, allowed: ["status", "show"] },
},

// With custom validator (complex commands only)
mycommand: {
  category: "network",
  validate: validateMyCommand,  // function defined above COMMANDS
},
```

**Step 4: Write Tests**

Add test cases in `command-sets.test.ts`:
- Positive: legitimate uses that MUST pass
- Negative: dangerous uses that MUST be blocked
- Context-specific: if the command's category has pipeOnly rules in local
  (e.g., text category), test that piped usage passes and standalone usage
  is blocked in local context

**Step 5: Update Tool Descriptions**

If this command affects what an execution tool (bash, node\_exec, pod\_exec)
can do, update the tool's `description` field so the LLM knows about it.
See §2 Description–Code Consistency Rule.

### 6.4 CommandDef Constraints Reference

`CommandDef` fields for declaring constraints (all optional, only add what's
needed):

| Field | Type | Effect |
|-------|------|--------|
| `blockedFlags` | `string[]` | These flags are explicitly rejected (globally, all contexts) |
| `allowedFlags` | `string[]` | Only these flags are allowed; unlisted flags rejected |
| `allowedSubcommands` | `{ position, allowed }` | Only these subcommands/actions at the given positional position |
| `positionals` | `"allow" \| "block" \| number` | Control positional arguments: allow all, block all, or limit count |
| `requiredFlags` | `string[]` | At least one of these must be present |
| `validate` | `(args: string[]) => string \| null` | Custom validator for complex commands (return error string or null) |

Context-specific constraints (pipe-only, context-level blocked flags) are in
`CONTEXT_POLICIES`, not in `CommandDef`. Developers normally don't need to
modify `CONTEXT_POLICIES` unless adding a new category or a new execution
context.

### 6.5 How to Add an Output Sanitization Rule

Add a new entry to `OUTPUT_RULES` in `output-sanitizer.ts`:

```typescript
OUTPUT_RULES["mycommand"] = (args: string[]): OutputAction | null => {
  // Return null if no sanitization needed
  // Return { type: "sanitize", sanitize: fn } for post-exec cleanup
  // Return { type: "rewrite", newArgs, sanitize: fn } to modify args + sanitize
};
```

---

## 7. Tool Registry

Tools are registered declaratively via the **Tool Registry** pattern.
Each tool file exports a `registration: ToolEntry` that declares its metadata,
and `agent-factory.ts` resolves the final tool list in one call.

### Architecture

```
src/core/tool-registry.ts    ← ToolEntry interface + ToolRegistry class
src/tools/all-entries.ts      ← ordered list of all tool registrations
src/tools/<dir>/<tool>.ts     ← each exports `registration: ToolEntry`
src/core/agent-factory.ts     ← calls registry.resolve({ mode, refs, allowedTools })
```

### ToolEntry Interface

```typescript
interface ToolEntry {
  category: "cmd-exec" | "script-exec" | "query" | "workflow";
  create: (refs: ToolRefs) => ToolDefinition;
  modes?: SessionMode[];      // omit = all modes
  available?: (refs: ToolRefs) => boolean;  // runtime guard
}
```

### Conditional Registration

Conditions are declared in each tool's `registration`, not in agent-factory:

| Tool | Field | Value | Reason |
|------|-------|-------|--------|
| `manage_schedule` | `modes` | `["web", "channel"]` | No UI rendering in TUI |
| `skill_preview` | `modes` | `["web", "channel"]` | Reads draft files from disk, renders side panel |
| `memory_search`, `memory_get` | `available` | `(refs) => !!refs.memoryIndexer` | Depends on indexer instance |

### allowedTools — Sole Availability Axis

`allowedTools` is the only control over tool availability after mode/`available`
filtering — there are no exemptions. A `null`/omitted `allowedTools` passes every
tool through (the default); a non-null array passes only the tools it names.

**Per-agent source**: `allowedTools` is resolved from the agent's selected
capability groups (`agents.tool_capabilities`) at the Gateway boundary
(`resolveCapabilities`); null/empty selection → `null` = unrestricted. Every tool
in the registry must belong to some `CAPABILITY_GROUPS` entry, otherwise a
restricted agent can never reach it — enforced by `tool-capabilities-coverage.test.ts`.

**Global-whitelist caveat**: when a per-agent selection is null, agent-factory
falls back to the global `config.allowedTools`. With the `platform` exemption
removed, a deployment that set a *non-null* global whitelist no longer gets the
former always-on tools (task/memory/schedule/spawn) for free — they are filtered
unless explicitly listed. The default global is `null`, so existing agents are
unaffected; only a deployment that opted into a global whitelist must revisit it.

**Initial-fetch failure is fail-open (reviewed policy)**: the per-pod
tool-capabilities fetch (K8s `agentbox-main.ts`, awaited before `listen` with
retries) and the spawn-time DB read (Local `local-spawner.ts`) both start the box
**unrestricted** on unrecoverable error, with a loud warn. Rationale: a fresh box
has no prior whitelist to preserve, and a failed fetch usually signals broader
gateway unreachability (skills/MCP can't sync either), so failing open keeps the
box serviceable rather than bricking it. The reload-PUSH path is *not* fail-open —
it preserves the prior whitelist on failure. Fail-closed hardening (refuse first
turn until resolved) is tracked as a separate follow-up.

### Tools Not in Registry

Both categories are appended after `resolve()` but are still subject to the same
`allowedTools` name-based whitelist (a non-null `allowedTools` filters them; `null`
passes all). They carry no `mode`/`available` metadata, so `allowedTools` is their
sole availability gate.

- **MCP tools**: dynamically discovered at runtime, appended after resolve
- **File I/O tools** (read/edit/write/grep/find/ls): framework tools with
  path-restricted operations injection, appended after resolve

Historical note: the DP refactor (Apr 2026) removed three extension tools
(`propose_hypotheses`, `end_investigation`, `deep_search`) that used to land
here via the pi-agent extension API. DP now runs without dedicated tools —
see `docs/design/2026-04-24-dp-mode-refactor-design.md`.

---

## 8. Deferred Refactoring

Known structural improvements that are not blocking but worth tracking.

### 8.1 `debug-pod.ts` Decomposition

`src/tools/infra/debug-pod.ts` mixes three concerns:
- `DebugPodCache` — pod reuse cache with creation lock and idle eviction
- `runInDebugPod()` — pod creation, command execution, stale-pod detection
- `DebugPodGC` — background garbage collector for orphaned pods

Does not block tool development (consumers only call `runInDebugPod`), but
makes the debug pod subsystem itself harder to maintain.

**Goal**: Split into `debug-pod/cache.ts`, `debug-pod/lifecycle.ts`,
`debug-pod/gc.ts` under `infra/`.

### 8.2 Extract `llmCompleteWithTool` to Shared Location ✓ Done

Previously noted as deferred work. Resolved in the DP refactor (Apr 2026):
`llmCompleteWithTool` now lives in `src/core/llm-tool-call.ts` and is
imported by the memory modules (`knowledge-extractor`, `topic-consolidator`)
directly. The deep-search directory that originally hosted it is gone.

### 8.3 Execution Template Extraction (Low — Revisit Conditionally)

The 3 `cmd-exec/` tools share ~3 truly identical steps. Variation points
(`checkReady` return types, `analyzeOutput` input handling, `buildCommand`
complexity, `run` + error handling) differ enough that a forced template would
add abstraction without reducing real complexity. The security-critical steps
are already unified via the `security-pipeline.ts` facade. Revisit only if more
than 2 new cmd-exec tools are added.

---

## 9. Background Jobs (`run_in_background`)

Two background modes share one core, modeled on Claude Code's `run_in_background`:
**background exec** (a detached command/stream) and **background sub-agent**
(`spawn_subagent run_in_background`). They are peers — background exec does NOT spawn a
sub-agent. Background exec is wired on the whole exec + script family: `bash`, `node_exec`,
`pod_exec`, `host_exec`, and the `local_script` / `node_script` / `pod_script` / `host_script`
tools. Master switches: `BACKGROUND_BASH_ENABLED` (the exec + script family) and
`RUN_IN_BACKGROUND_ENABLED` (sub-agents) (`src/core/subagent-registry.ts`).

### 9.1 Shared pieces

- **`JobRegistry`** (`src/core/job-registry.ts`) — one per runtime; `JobRecord{type:"subagent"|"bash"|"node"|"pod"|"host"|"local"}`.
  `claimNotification(jobId)` is the atomic dedup latch (a completion notice is sent EXACTLY
  once, even when process-exit and `job_stop` race).
- **`buildTaskNotificationText`** (`src/core/task-notification.ts`) — the `<task_notification>`
  XML (task_id / output_file / status / summary) injected back into the parent model.
- **`spawnBackgroundBash`** (`src/core/background-bash-runner.ts`) — runtime-agnostic launcher
  with **three exec modes** (exactly one per request): `command` (detached shell — bash),
  `file`+`args` (detached argv, no shell — node/pod/local/scripts; optional `stdin` carries a
  script body), and `streamFactory` (in-process ssh2 stream — host_exec/host_script: no child
  process, the factory dials ssh and returns live stdout/stderr + a `done` promise and owns
  connection teardown). All three stream sanitized output to disk (`SanitizingLineBuffer`,
  §6b sanitization.md), register the job, and fire `notify` exactly once on settle.
- **`job_stop`** — generalized to cancel either job type (bash → process-group SIGKILL).

### 9.2 The completion-notification injector

Tools have no live brain handle, so background work is launched via injected executors
(`ToolRefs.backgroundExecExecutor`, `spawnSubagentExecutor`) and notified back through the
runtime:

- **Gateway/agentbox** (`AgentBoxSessionManager.notifyParent`): parent run in-flight
  (`!_promptDone`) → `brain.followUp(text)`; parent idle → `runSyntheticPrompt`, which
  acquires the SAME `_promptDone`/`_promptInflight` mutex `/prompt` uses (synchronously,
  no await gap) and calls `brain.prompt(text)`. This closes the TOCTOU vs. an incoming
  HTTP `/prompt` (it either started first → we degrade to `followUp`, or hits the 409 guard).
  `_backgroundWorkCount` keeps the session alive until jobs finish.
- **TUI** (`TuiBackgroundHost`, `src/core/tui-background-host.ts`): idle → `sendCustomMessage(triggerTurn:true)`
  (pi routes a not-streaming triggerTurn through `agent.prompt`, waking a turn — `followUp`
  alone does NOT wake an idle agent); streaming → `sendCustomMessage(deliverAs:"followUp")`.
  TUI wires background **bash + node_exec + pod_exec** (shared `spawnBackgroundBash` executor); only background **sub-agents** are unavailable (no agentbox child-session machinery). Delivery is per-host, not session-scoped — a job finishing after `/new` notifies the current session (the prior one is gone; surfacing beats dropping).

**Live delivery of an idle synthetic turn to the WebUI.** A synthetic turn runs *after* the
`/send` SSE stream closed, so it has no live gateway consumer. Two contracts make it visible:
(1) the synthetic turn's messages are persisted (`persistSyntheticMessage`, tagged
`metadata.kind="task_notification"` for the leading injected prompt so the frontend hides that
raw bubble — the model's human reply stays); (2) once the persists settle, `runSyntheticPrompt`
emits a `delegation.emit_chat_event` of type **`background_turn_done`** on the session's
`chat.event` channel. The frontend keeps a persistent per-session SSE open
(`GET /api/v1/siclaw/agents/:id/chat/sessions/:sessionId/events`, `src/portal/chat-gateway.ts`,
query-token auth, NEVER closes on `prompt_done`) and on `background_turn_done` silently refetches
history from the DB. The body is loaded from DB, not rendered from the live event stream —
`emit_chat_event` deliberately skips `message_update` text deltas (to avoid an HTTP-per-token
storm), and the frontend builds assistant text only from those deltas, so a refetch is the only
faithful render. `background_turn_done` is a dedicated signal (not `prompt_done`) so it never
collides with a normal `/send`.

### 9.3 Reading output

Background bash output streams to `<userDataDir>/agent/tasks/<jobId>.output` (within the
`read` tool's allow-list). The launch returns `{task_id, output_file}`; the model uses the
built-in `read` tool (offset/limit) to inspect progress and is notified on completion — it
must NOT poll. Output is sanitized on write (§6b sanitization.md).

### 9.4 Background on remote & script tools (node_exec / pod_exec / host_exec / scripts)

`run_in_background` also works on `node_exec`, `pod_exec`, `host_exec`, and every script tool
(`local_script` / `node_script` / `pod_script` / `host_script`), gated identically on the
injected executor. This is how long node-/host-side work — e.g. RDMA perftest打流, server on
node A + client on node B — runs, whether issued as a one-off command or a skill script.

The mechanism reuses the same runner in **argv mode**: the agentbox spawns the
`kubectl exec <pod> -- …` (node_exec: into a debug pod, `nsenter` into the host;
pod_exec: into the target pod) as a detached child and streams its output to the same
on-disk file the model reads. Differences from bash background:

- **node_exec** runs in the host namespace via a debug pod. The pod is **pinned**
  (`acquireDebugPod`/`releaseDebugPod` refcount in `debug-pod.ts`) for the job's lifetime
  so the idle-timer can't evict it mid-run; the pin is released by the job's `onComplete`.
  The node command is wrapped in **`timeout <ttl>`** so the host-namespace process
  self-terminates even if the local `kubectl exec` child is killed (kubectl exec does not
  reliably propagate kill to a host-ns process) — **the debug image must provide
  `timeout`**. Hard ceiling: the debug pod's `activeDeadlineSeconds` (`debugPodTTL`, ~600s)
  — longer runs need a shorter perftest duration or a raised `debugPodTTL`.
- **pod_exec** has no debug pod / no pin; the process is bounded by the target pod's
  lifecycle. If stopped early, the in-pod process may keep running until the pod ends.
- **host_exec / host_script** use the **stream mode** (ssh2, no child process). The remote
  command is wrapped in **`timeout <ttl>`** (host_exec default 600s, cap 3600s; host_script
  the same) so a dropped channel cannot orphan the remote process — `job_stop` closes the
  channel and the remote is bounded by `timeout`. The script body (host_script) is piped via
  the ssh channel's stdin. `sshExecStream` (`src/tools/infra/ssh-client.ts`) owns chain teardown.
- **node_script / pod_script / local_script** reuse the argv mode with the script piped via
  `stdin` (no temp files on the target). node_script pins a debug pod and records the remote
  PGID exactly like node_exec; pod/local mirror pod_exec/bash.

The per-session concurrency cap (`getBackgroundBashConcurrency`) counts ALL background
exec jobs (bash + node + pod + host + local) together; over the cap, the tool falls back to foreground.
