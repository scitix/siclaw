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

These tools execute user-provided commands. They share a unified security
pipeline via `security-pipeline.ts`:

```
Step 1: resolveRequiredKubeconfig()            → infra/kubeconfig-resolver.ts
Step 2: prepareExecEnv()                       → infra/exec-utils.ts
Step 3: validateTarget() [node or pod name]    → infra/exec-utils.ts
Step 4: preExecSecurity(cmd, { context, ... }) → infra/security-pipeline.ts  ⚠️ MANDATORY
          ├── validateCommand (6-pass pipeline)
          └── resolveOutputAction (determine sanitizer)
Step 5: checkReady() [node or pod]             → infra/k8s-checks.ts
Step 6: buildCommand() [tool-specific]
Step 7: run() [debug pod / kubectl exec / shell]
Step 8: postExecSecurity(stdout, action, { stderr }) → infra/security-pipeline.ts  ⚠️ MANDATORY
          ├── applySanitizer (stdout only)
          ├── redactSensitiveContent (if hasSensitiveKubectl)
          └── processToolOutput (strip ANSI + truncate)
```

**Steps 4 and 8 are non-negotiable security requirements.** `preExecSecurity`
validates the command and determines the output sanitizer. `postExecSecurity`
sanitizes stdout, combines with stderr, and truncates. Tools MUST NOT call
`processToolOutput` directly — it is only called inside `postExecSecurity`.

**Note**: `restricted_bash` skips steps 1-3, 5 (local execution, no K8s target).

### Variation Points

| Point | node\_exec | pod\_exec | restricted\_bash |
|-------|-----------|----------|-----------------|
| Context | `"node"` | `"pod"` | `"local"` |
| Target validation | `validateNodeName` | `validatePodName` | None |
| Ready check | `checkNodeReady` | `checkPodRunning` | None |
| Command build | nsenter wrap (+ `ip netns exec` when `netns` param set) | kubectl exec args | Shell command (+ sudo in production) |
| Pipeline support | Yes (`analyzeTarget: "last-in-pipeline"`) | No (`blockPipeline: true`) | Full shell (`analyzeTarget: "auto"`) |
| Execution | `runInDebugPod` | `execFileAsync("kubectl")` | `exec()` with `/bin/bash` |
| Post-exec extras | `filterPodNoise(stderr)` | — | `hasSensitiveKubectl` flag |

**Pod network namespace diagnostics**: To run host-level tools in a pod's
network namespace, use `resolve_pod_netns` (in `query/`) to get the netns name,
then call `node_exec` with the `netns` parameter. This replaces the former
`pod_nsenter_exec` tool.

---

## 4. Script Execution Tools (`script-exec/`)

These tools execute pre-approved skill scripts. The orchestration flow
**omits pre-exec security** (scripts are reviewed before deployment) but
still routes output through `postExecSecurity` for truncation:

```
Step 1: resolveRequiredKubeconfig()
Step 2: prepareExecEnv()
Step 3: validateTarget() [node or pod name]
Step 4: checkReady()
Step 5: resolveScript()                            → infra/script-resolver.ts
Step 6: buildCommand() [base64 inject or stdin pipe]
Step 7: run() [debug pod / kubectl exec / spawn]
Step 8: postExecSecurity(stdout, null, { stderr })  → infra/security-pipeline.ts
          └── processToolOutput (strip ANSI + truncate; no sanitization — action is null)
```

**Note**: `local_script` skips steps 1-4 (local execution, no K8s target).

### Script Transmission Methods

| Tool | Method | How |
|------|--------|-----|
| `node_script` | base64 inject | Encode script → echo + base64 -d inside nsenter. Supports `netns` param for pod network namespace. |
| `pod_script` | stdin pipe | `kubectl exec -i` with script piped to stdin |

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

## 7. Registration in `agent-factory.ts`

Tools are registered in the `customTools` array in `src/core/agent-factory.ts`,
grouped by category with section comments:

```typescript
const customTools: ToolDefinition[] = [
  // ── Command execution — full security pipeline (cmd-exec/) ──
  ...
  // ── Script execution — pre-audited scripts (script-exec/) ──
  ...
  // ── Data query (query/) ──
  ...
  // ── Workflow (workflow/) ──
  ...
];
```

### Conditional Registration

Some tools are registered conditionally:

| Tool | Condition | Reason |
|------|-----------|--------|
| `manage_schedule` | `mode !== "cli"` | No UI rendering in TUI |
| `create_skill`, `update_skill`, `fork_skill` | `mode === "web"` | Frontend preview card rendering |
| `memory_search`, `memory_get` | After `memoryIndexer` init | Depends on indexer instance |

### PLATFORM\_TOOLS Exemption

Tools in `PLATFORM_TOOLS` set (`manage_schedule`, `credential_list`,
`cluster_info`, `save_feedback`, `knowledge_search`) are exempt from workspace
allow-list filtering — they must always be available regardless of workspace
configuration.

---

## 8. Roadmap — Planned Refactoring

Remaining work after the Phase 1 directory restructure. Ordered by priority.

### 8.1 Unified Command Security Model (Done)

The current security model mixes two separate concerns in `COMMAND_RULES`:
1. **Command safety constraints** — intrinsic to the command (e.g., `grep -r` is
   dangerous everywhere)
2. **Environment availability** — which commands are available in which execution
   context (e.g., `cat` is blocked locally because a dedicated `read` tool exists)

These are spread across 4 separate data structures (`ALLOWED_COMMANDS`,
`COMMAND_CATEGORIES`, `COMMAND_RULES`, `CUSTOM_VALIDATORS`) that must be kept in
sync. Adding a command may require changes to 2-4 places. Per-command rules are
inconsistent — some use `allowedFlags`, some use `blockedFlags`, some use custom
validator functions, with no clear principle for when to use which.

**Goal**: Unify into a single `CommandDef` per command that carries all its
information — category, safety constraints, and custom validator (if needed).
Separate environment availability into an independent layer.

```
COMMANDS: Record<string, CommandDef>     ← one definition = one command's everything
  ├── category: string                      what kind of command
  ├── constraints (declarative)             blockedFlags, allowedSubcommands, etc.
  └── validate? (escape hatch)             custom function for complex commands (curl, etc.)

CONTEXT_AVAILABLE: Record<string, string[]>  ← which categories are available per context
  ├── local:  [categories minus file/env]      local has dedicated tools for file ops
  └── remote: [all categories]                 node/pod/nsenter share the same set
```

Key design decisions to resolve:
- `pipeOnly` / `noFilePaths` are currently per-command per-context rules. In the
  new model they become environment-level policies (e.g., "text category commands
  in local context only accept piped input"), not command-level attributes.
- The 12 custom validators (especially `curl` at ~120 lines) remain as `validate`
  escape hatches — their logic is too complex for declarative rules.
- The `contexts` field in COMMAND_RULES is eliminated — safety constraints apply
  everywhere, context filtering is a separate layer.

**Files**: `src/tools/infra/command-sets.ts`, `src/tools/infra/command-validator.ts`

### 8.2 Security Pipeline Unified Entry (Done)

`src/tools/infra/security-pipeline.ts` provides two facade functions:

- `preExecSecurity(command, opts?)` — validates command + determines output sanitizer (cmd-exec only)
- `postExecSecurity(stdout, action, { stderr?, hasSensitiveKubectl? })` — sanitize stdout + combine stderr + truncate (ALL tools)

`postExecSecurity` is the **single output gate** — `processToolOutput` is called
only inside it. No tool should call `processToolOutput` directly. Sanitization
applies to stdout only (not stderr), preserving JSON validity when kubectl
outputs valid JSON to stdout and warnings to stderr.

The `analyzeTarget` option (`"single"` | `"last-in-pipeline"` | `"auto"`) in
`preExecSecurity` controls which command in a pipeline determines the sanitizer.

Also completed in this change:
- Directory restructure: `k8s-exec/` + `k8s-script/` + `shell/` → `cmd-exec/` + `script-exec/` (classified by security model)
- Deprecated exports cleanup: removed `ALLOWED_COMMANDS`, `COMMAND_CATEGORIES`, `CONTEXT_CATEGORIES`; replaced with `getContextAllowedSet()` in `command-sets.ts`
- Removed `formatExecOutput` from `exec-utils.ts` (bundled 5 concerns, only 2 callers — inlined)

**Files**: `src/tools/infra/security-pipeline.ts`, `src/tools/cmd-exec/`, `src/tools/script-exec/`

### 8.3 Execution Template Extraction (Low — Deferred)

Originally planned as high priority. After detailed analysis, the 3 `cmd-exec/`
tools only share ~3 truly identical steps (not 6-7 as initially estimated).
Variation points (`checkReady` return types, `analyzeOutput` input handling,
`buildCommand` complexity, `run` + error handling) differ enough that a forced
template would add abstraction without reducing real complexity.

If 8.1 + 8.2 are done, the security-critical steps are already unified via the
pipeline facade, eliminating the main risk (step omission). What remains is
boilerplate (kubeconfig resolution, error formatting) — tolerable duplication.

Revisit if more than 2 new cmd-exec tools are added.

**Files**: `src/tools/cmd-exec/*.ts`, `src/tools/script-exec/*.ts`

### 8.4 `debug-pod.ts` Decomposition (Medium)

`src/tools/infra/debug-pod.ts` is 767 lines mixing three concerns:
- `DebugPodCache` — pod reuse cache with creation lock and idle eviction
- `runInDebugPod()` — pod creation, command execution, stale-pod detection
- `DebugPodGC` — background garbage collector for orphaned pods

Does not block tool development (consumers only call `runInDebugPod`), but
makes the debug pod subsystem itself harder to maintain.

**Goal**: Split into `debug-pod/cache.ts`, `debug-pod/lifecycle.ts`,
`debug-pod/gc.ts` under `infra/`.

**Files**: `src/tools/infra/debug-pod.ts`

### 8.5 Extract `llmCompleteWithTool` to Shared Location (Done)

Extracted general-purpose LLM utilities from `workflow/deep-search/sub-agent.ts`
to `src/shared/llm-utils.ts`:

- `llmComplete()` — simple text completion via OpenAI-compatible API
- `llmCompleteWithTool<T>()` — structured output via function calling + fallback
- `extractJSON()` — multi-layer JSON extraction (direct parse / code block / brace matching)

All consumers (`memory/`, `deep-search/engine.ts`, `quality-gate.ts`) now import
from `shared/llm-utils.ts`. The reverse dependency `memory/` → `tools/workflow/`
is eliminated.

**Files**: `src/shared/llm-utils.ts`, `src/tools/workflow/deep-search/sub-agent.ts`
