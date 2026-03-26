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
their `execute()` behavior:

```
src/tools/
  ├── k8s-exec/       Remote command execution on K8s targets
  ├── k8s-script/     Remote script execution on K8s targets
  ├── shell/          Local process execution
  ├── query/          Data queries (memory, DB, filesystem)
  ├── workflow/       User-facing workflow operations
  └── infra/          Shared infrastructure (security, execution, output)
```

### Classification Rules

| Directory | When to use | Key traits |
|-----------|-------------|------------|
| `k8s-exec/` | Tool executes a **user-provided command** on a remote K8s target (node, pod, netns) | Requires command validation + output sanitization |
| `k8s-script/` | Tool executes a **pre-approved script file** on a remote K8s target | No command validation needed (scripts are reviewed); uses `resolveScript()` |
| `shell/` | Tool spawns a **local process** on the AgentBox | Each tool has unique execution logic |
| `query/` | Tool performs **read-only data retrieval** (no process spawn, no K8s interaction) | Pure function over memory indexer, DB, or filesystem |
| `workflow/` | Tool orchestrates a **user-facing workflow** (investigation, skill management, scheduling) | Business logic, often stateful |
| `infra/` | **Not a tool** — shared functions consumed by tools | Security pipeline, K8s execution helpers, output processing |

### Decision Tree: Where Does My New Tool Go?

```
Does it execute commands on a remote K8s target?
├─ Yes → Does the user provide the command string?
│        ├─ Yes → k8s-exec/
│        └─ No (pre-approved script) → k8s-script/
├─ No → Does it spawn a local process?
│        ├─ Yes → shell/
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

---

## 3. K8s Command Execution Tools (`k8s-exec/`)

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

| Point | node\_exec | pod\_exec | pod\_nsenter\_exec |
|-------|-----------|----------|-------------------|
| Context | `"node"` | `"pod"` | `"nsenter"` |
| Target validation | `validateNodeName` | `validatePodName` | `validatePodName` |
| Ready check | `checkNodeReady` | `checkPodRunning` | `resolveContainerNetns` |
| Command build | nsenter wrap | kubectl exec args | double nsenter + crictl |
| Execution | `runInDebugPod` | `execFileAsync("kubectl")` | `runInDebugPod` |

---

## 4. K8s Script Execution Tools (`k8s-script/`)

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
| `node_script` | base64 inject | Encode script → echo + base64 -d inside nsenter |
| `pod_script` | stdin pipe | `kubectl exec -i` with script piped to stdin |
| `netns_script` | base64 inject | Same as node\_script but with netns nsenter |

---

## 5. Local Shell Tools (`shell/`)

### `restricted_bash`

The most complex tool. Handles full shell pipelines with:
- 6-pass command validation pipeline (`validateCommand` in `command-validator.ts`)
- Per-command kubectl subcommand validation (`validateKubectlInPipeline`)
- Kubeconfig name resolution via regex (`--kubeconfig=<name>`)
- Production mode: `sudo -E -u sandbox` user isolation
- Skill script detection bypass (`isSkillScript`)

### `local_script`

Executes skill helper scripts locally via `spawn()`. No command validation
(scripts are from trusted `skills/` directory). Uses `resolveSkillScript()`
for path resolution with traversal protection.

---

## 6. Shared Infrastructure (`infra/`)

### Security Pipeline Overview

```
Pre-execution                        Post-execution
┌─────────────────────┐              ┌──────────────────────┐
│ command-validator.ts │              │ output-sanitizer.ts  │
│ 6-pass pipeline:     │              │                      │
│ 1. Shell operators   │              │ analyzeOutput()      │
│ 2. Pipeline split    │              │   → detect sensitive │
│ 3. Whitelist check   │              │     resource type    │
│ 4. Pipeline validate │              │                      │
│ 5. Command rules     │              │ applySanitizer()     │
│ 6. Sensitive paths   │              │   → redact secrets,  │
└─────────────────────┘              │     sanitize env vars│
                                      └──────────────────────┘
```

### How to Add a New Command to the Whitelist

1. Add the command name to `ALLOWED_COMMANDS` in `command-sets.ts`
2. Add it to `COMMAND_CATEGORIES` with its functional category
3. If the command needs restrictions (blocked flags, subcommand whitelist, etc.),
   add an entry to `COMMAND_RULES`
4. If the category is new, add it to `CONTEXT_CATEGORIES` for each applicable context

### How to Add a COMMAND\_RULE

Rules are declarative and JSON-serializable:

```typescript
COMMAND_RULES["mycommand"] = {
  command: "mycommand",
  category: "network",
  contexts: ["local"],        // Only apply in local context
  pipeOnly: true,             // Must appear after a pipe
  noFilePaths: true,          // Block path-like positional args
  blockedFlags: ["-w"],       // Explicitly blocked flags
  allowedFlags: ["-r", "-n"], // Flag whitelist (if present, unlisted flags blocked)
  allowedSubcommands: { position: 0, allowed: ["status", "show"] },
  positionals: "block",       // "allow" | "block" | number (max count)
  requiredFlags: ["-b"],      // At least one must be present
  customValidator: "mycommand", // Delegate to CUSTOM_VALIDATORS registry
};
```

### How to Add an Output Sanitization Rule

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
  // ── K8s command execution (k8s-exec/) ──
  ...
  // ── K8s script execution (k8s-script/) ──
  ...
  // ── Local shell (shell/) ──
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

### 8.1 Execution Template Extraction (High)

The 3 `k8s-exec/` tools share a 10-step orchestration flow where 6-7 steps are
identical. The 3 `k8s-script/` tools share the first half of the same flow.
New contributors must manually replicate these steps — missing any security step
(command validation, output sanitization) is a silent vulnerability.

**Goal**: Extract a shared execution template so new tools only define variation
points, not the full pipeline.

- `k8s-exec/` variation points (4): `context`, `validateTarget`, `checkReady`, `buildCommand`
- `k8s-script/` variation points (4): `validateTarget`, `checkReady`, `buildCommand`, `run`
- The two types share the front half (kubeconfig → env → name validate → ready check)
  but diverge in the back half: k8s-exec adds command validation + output sanitization,
  k8s-script adds script resolution + script transmission.

**Files**: `src/tools/k8s-exec/*.ts`, `src/tools/k8s-script/*.ts`

### 8.2 Security Pipeline Unified Entry (High)

Each execution tool manually assembles: `validateCommand` → `analyzeOutput` →
execute → `applySanitizer` → `processToolOutput`. A unified facade would:
- Prevent callers from forgetting a step
- Decouple tools from infra file structure
- Serve `restricted-bash` (which doesn't use the template) as well

**Goal**: A small set of functions in `infra/` that encapsulate the full
pre-exec → post-exec security flow.

**Files**: `src/tools/infra/command-validator.ts`, `src/tools/infra/output-sanitizer.ts`, `src/tools/infra/tool-render.ts`

### 8.3 `debug-pod.ts` Decomposition (Medium)

`src/tools/infra/debug-pod.ts` is 767 lines mixing three concerns:
- `DebugPodCache` — pod reuse cache with creation lock and idle eviction
- `runInDebugPod()` — pod creation, command execution, stale-pod detection
- `DebugPodGC` — background garbage collector for orphaned pods

Does not block tool development (consumers only call `runInDebugPod`), but
makes the debug pod subsystem itself harder to maintain.

**Goal**: Split into `debug-pod/cache.ts`, `debug-pod/lifecycle.ts`,
`debug-pod/gc.ts` under `infra/`.

**Files**: `src/tools/infra/debug-pod.ts`

### 8.4 Extract `llmCompleteWithTool` to Shared Location (Medium)

`llmCompleteWithTool` is a general-purpose "call LLM API to complete a task"
utility, but it lives in `workflow/deep-search/sub-agent.ts` — an internal file
of a specific workflow tool. Two memory module files depend on it:
- `src/memory/topic-consolidator.ts`
- `src/memory/knowledge-extractor.ts`

This creates an architectural smell: a foundational module (`memory/`) depends
on the internals of a higher-level workflow tool.

**Goal**: Move `llmCompleteWithTool` to `src/core/` or `src/shared/`, making
the dependency direction correct (both `memory/` and `workflow/deep-search/`
import from `core/`).

**Files**: `src/tools/workflow/deep-search/sub-agent.ts`, `src/memory/topic-consolidator.ts`, `src/memory/knowledge-extractor.ts`
