---
title: "Guard Pipeline Guide"
sidebarTitle: "Guards"
description: "How the guard pipeline intercepts and repairs messages across the agent lifecycle."
---

# Guard Pipeline Guide

> **Purpose**: Document the guard pipeline architecture — how guards are
> organized, how they intercept data at each stage, and how to add new guards.
>
> **Audience**: Anyone modifying guard behavior or adding new message
> interception logic in `src/core/`.

---

## 1. Overview

Guards are interceptors that validate and repair messages flowing through
the agent. They exist because pi-agent doesn't handle all edge cases
(multi-model support, large tool outputs, stream interruptions).

All guards are registered in a single **`GuardRegistry`** and installed
via one call to **`installGuardPipeline`**. Internally, the pipeline wraps
each of pi-agent's three hook points exactly once:

```
┌───────────────────────────────────────────────────────────────────┐
│                      Agent Loop (one cycle)                       │
│                                                                   │
│  context.messages ──▶ ┌─────────────┐                            │
│                       │ INPUT guards │ fix malformed history      │
│                       └──────┬──────┘                            │
│                              ▼                                    │
│                    ┌──────────────────┐                           │
│                    │ CONTEXT guards   │ enforce token budget      │
│                    └────────┬─────────┘                           │
│                             ▼                                     │
│                       ═══ LLM API ═══                             │
│                             ▼                                     │
│                    ┌──────────────────┐                           │
│                    │ OUTPUT guards    │ repair stream events      │
│                    └────────┬─────────┘                           │
│                             ▼                                     │
│                    ┌──────────────────┐                           │
│                    │ PERSIST guards   │ validate before write     │
│                    └────────┬─────────┘                           │
│                             ▼                                     │
│                       session history                             │
└───────────────────────────────────────────────────────────────────┘
```

**Hook mechanism**: The pipeline wraps `agent.streamFn` once (input + output),
`sessionManager.appendMessage` once (persist), and `agent.transformContext`
once (context). Guards never touch hooks directly.

---

## 2. Four Guard Types

Each stage has its own guard type. Guards are pure data transforms — they
don't know how they're hooked into pi-agent.

### InputGuard

```typescript
type InputGuard = (messages: AgentMessage[]) => AgentMessage[];
```

Transforms the message array before sending to LLM.

**Contract**: MUST return the original reference when no changes are made.
The pipeline uses `result !== messages` to detect whether the guard triggered.

### OutputGuard

```typescript
interface OutputGuard {
  processEvent(event: unknown): void;
  processResult(message: unknown): void;
  reset(): void;
}
```

Intercepts LLM response stream events for in-place repair. `reset()` is
called before each new stream to clear any accumulated state.

### PersistGuard

```typescript
type PersistGuard = (message: AgentMessage) => AgentMessage[];
```

Intercepts each message before writing to session history. Returns:
- `[]` — drop the message
- `[message]` — pass through (possibly modified)
- `[syntheticResult, message]` — fan-out (insert messages before)

### ContextGuard

```typescript
type ContextGuard = (messages: AgentMessage[]) => void;
```

In-place modification of the context message array. Called after pi-agent's
internal `transformContext`, before the final LLM API call.

---

## 3. Guard Registry

All guards are registered in `createGuardRegistry()` in `src/core/guard-pipeline.ts`.
Array order = execution order within each stage.

```typescript
export function createGuardRegistry(contextWindowTokens: number): GuardRegistry {
  return {
    input: [
      { name: "sanitize-tool-calls",     guard: sanitizeToolCallInputs },
      { name: "repair-tool-use-pairing", guard: repairToolUsePairingGuard },
    ],
    output: [
      { name: "trim-tool-call-names",    guard: createTrimToolCallNamesGuard() },
      { name: "repair-malformed-args",   guard: createRepairMalformedArgsGuard() },
    ],
    persist: [
      { name: "session-tool-result-guard", guard: createSessionToolResultGuard() },
    ],
    context: [
      { name: "context-budget-guard",    guard: createContextBudgetGuard(contextWindowTokens) },
    ],
  };
}
```

---

## 4. Pipeline Installation

The pipeline is installed once in `agent-factory.ts` after `createAgentSession`:

```typescript
const contextWindow = configuredModel?.contextWindow ?? 128_000;
const guardRegistry = createGuardRegistry(contextWindow);
installGuardPipeline(guardRegistry, { agent: session.agent, sessionManager });
```

Internally, `installGuardPipeline` makes three hook installations:

| Hook | What it wraps | Guards it runs |
|------|---------------|----------------|
| `agent.streamFn` | Single wrap | Input guards (before API call) + Output guards (after API call) |
| `sessionManager.appendMessage` | Single wrap | Persist guards (`flatMap` chain) |
| `agent.transformContext` | Single wrap | Context guards (after pi-agent's internal transform) |

No onion model — each hook is wrapped exactly once.

---

## 5. Existing Guards

### Input: sanitize-tool-calls

**File**: `src/core/tool-call-repair.ts` (`sanitizeToolCallInputs`)

Drops tool call blocks missing `id`, `name`, or `input` from assistant
messages. Prevents LLM API 400 errors from malformed history.

### Input: repair-tool-use-pairing

**File**: `src/core/compaction.ts` (`repairToolUsePairingGuard`)

Ensures every `toolCall` has a matching `toolResult`. Inserts synthetic
error results for missing pairs, drops orphaned results. Required because
Anthropic API rejects unpaired tool calls/results.

### Output: trim-tool-call-names

**File**: `src/core/stream-wrappers.ts` (`createTrimToolCallNamesGuard`)

Trims whitespace from tool call names and assigns fallback IDs for
missing/duplicate tool call IDs. Stateless.

### Output: repair-malformed-args

**File**: `src/core/stream-wrappers.ts` (`createRepairMalformedArgsGuard`)

Accumulates partial JSON from `toolcall_delta` events. When a closing
brace appears, extracts balanced JSON prefix and tolerates up to 3
trailing garbage characters. Stateful — maintains `partialJsonByIndex`
and related maps across events, cleared on `reset()`.

### Persist: session-tool-result-guard

**File**: `src/core/session-tool-result-guard.ts` (`createSessionToolResultGuard`)

Write-time validation for session history. Sanitizes malformed tool call
blocks, tracks pending call/result pairing across messages, inserts
synthetic error results for orphaned calls, truncates results exceeding
400KB. Stateful — maintains `pending` Map and `droppedToolCallIds` Set.

### Context: context-budget-guard

**File**: `src/core/tool-result-context-guard.ts` (`createContextBudgetGuard`)

Enforces context window budget. Three-tier strategy:
1. Truncate any single result exceeding 50% of context window
2. Compact oldest results when total exceeds 75% of window
3. Throw `PREEMPTIVE_CONTEXT_OVERFLOW` when still exceeding 90%

---

## 6. How to Add a New Guard

### Step 1: Choose the stage

```
Does it modify messages BEFORE sending to LLM?
├─ Yes → Does it operate on the full message array?
│        ├─ Yes → InputGuard
│        └─ No (stream events) → not this stage
├─ No → Does it modify LLM response stream events?
│        ├─ Yes → OutputGuard
│        └─ No → Does it intercept messages being written to history?
│                 ├─ Yes → PersistGuard
│                 └─ No → Does it enforce context window constraints?
│                          ├─ Yes → ContextGuard
│                          └─ No → This may not be a guard
```

### Step 2: Implement the guard

Place it in the same file as related logic, or create a new file in `src/core/`.

**InputGuard example**:
```typescript
// Return original reference if no changes (REQUIRED)
export function myInputGuard(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const result = messages.map(msg => {
    const fixed = maybeFixMessage(msg);
    if (fixed !== msg) changed = true;
    return fixed;
  });
  return changed ? result : messages;
}
```

**OutputGuard example**:
```typescript
export function createMyOutputGuard(): OutputGuard {
  let state = new Map();
  return {
    processEvent(event) { /* mutate event in-place */ },
    processResult(message) { /* mutate final message in-place */ },
    reset() { state = new Map(); },
  };
}
```

**PersistGuard example**:
```typescript
export function createMyPersistGuard(): PersistGuard {
  return (message: AgentMessage): AgentMessage[] => {
    if (shouldDrop(message)) return [];
    return [transform(message)];
  };
}
```

**ContextGuard example**:
```typescript
export function createMyContextGuard(param: number): ContextGuard {
  return (messages: AgentMessage[]): void => {
    // Mutate messages array in-place
  };
}
```

### Step 3: Register in the pipeline

Add your guard to `createGuardRegistry()` in `src/core/guard-pipeline.ts`:

```typescript
input: [
  ...existing,
  { name: "my-guard", guard: myInputGuard },  // order matters
],
```

### Step 4: Add structured logging

Use `guardLog` from `src/core/guard-log.ts` when the guard triggers a repair:

```typescript
import { guardLog } from "./guard-log.js";

// Only log when actually modifying data
if (changed) {
  guardLog("my-guard", "repaired", { count: fixedCount });
}
```

### Step 5: Update this document

Add your guard to the "Existing Guards" section above.

---

## 7. Structured Logging

All guards report triggering through `guardLog`:

```typescript
guardLog(guardName: string, action: string, details?: Record<string, unknown>): void
```

Outputs JSON to `console.warn`:
```json
{"type":"guard","guard":"sanitize-tool-calls","action":"transformed","ts":1711900000000}
```

**When to log**: Only when the guard actually modifies data. Do not log
on every invocation — guards run on every LLM call, logging no-ops would
be noisy.

**Log level**: `console.warn` — guard triggering indicates an abnormal
condition (malformed data, oversized output, broken pairing).
