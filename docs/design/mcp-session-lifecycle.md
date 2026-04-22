---
title: "MCP Session Lifecycle Contract"
sidebarTitle: "MCP Session Lifecycle"
description: "How MCP config changes propagate to running chat sessions, and why the tool-set is immutable within a session."
---

# MCP Session Lifecycle Contract

> **Purpose**: Fix the contract for how Portal-side MCP server changes
> (Create / Update / Delete / Toggle / rebinding) reach a running chat
> session. This document exists so that future contributors and bug
> reporters have a single source of truth for what is a *bug* vs what
> is *by design*.

---

## 1. The contract

**A session's MCP tool-set is immutable for its in-memory lifetime.**

Concretely:

- An `McpClientManager` is built once at session creation
  (`src/core/agent-factory.ts` — per-session MCP init).
- The LLM's tool schema list is sent on every request but mirrors
  `customTools`, which was frozen at session creation.
- A running session never mutates its MCP tool-set mid-flight.

Config changes propagate via **session turnover**, not hot-swap.

---

## 2. Why immutable (and not hot-swap)

MCP is structurally different from Skills and Knowledge, which *do*
hot-reload via `brain.reload()`:

| Dimension | Skills / Knowledge | MCP |
|---|---|---|
| LLM tool-name surface | Fixed (one `Skill` dispatcher) | Per-server `mcp__<name>__*` — adds / removes tool names |
| Effect of reload | Refresh backing content | Change the LLM's capability surface |
| External resources | None | Long-lived transport, auth, stateful server |

Hot-swapping the MCP tool-set mid-session would:

1. **Desync the LLM.** A tool schema that was in the prompt cache and
   prior assistant turns would vanish; recovery is non-deterministic.
2. **Strand in-flight tool calls** on the retired transport.
3. **Break prompt caching** in ways that compound across turns.

The immutable contract is simpler and kinder to cache.

---

## 3. How config changes actually reach the user

There are **three mechanisms**, in order of applied wall-clock latency:

### 3.1 Idle release (normal path)

`SESSION_RELEASE_TTL_MS = 30_000` in `src/agentbox/session.ts`.

Flow:

```
user sends prompt → session active → prompt completes
  → scheduleRelease() starts 30 s timer
  → timer fires → release() shuts down McpClientManager + removes session from map
user sends next prompt → getOrCreate() rebuilds session from JSONL
  → createSiclawSession() reads fresh loadConfig() → new McpClientManager
```

Under typical human typing cadence (>30 s between messages) MCP
changes land on the next user message **without any extra mechanism**.
Conversation history is preserved via JSONL; only the runtime
(`McpClientManager`, tool closures, brain) is rebuilt.

### 3.2 Eager invalidation on reload (security / promptness)

Added by `mcpHandler.postReload` (`src/agentbox/sync-handlers.ts`).
When Upstream / Portal issues an `agent.reload` for `mcp`:

```
Portal mutation → Upstream notify → Gateway notify → AgentBox /api/reload-mcp
  → handler.fetch / materialize   (writes settings.json, reloadConfig())
  → handler.postReload(context)
       └→ for each session: session.invalidate()
             ├── prompt-in-flight? register post-prompt callback → release()
             └── idle?             release() immediately
```

`release()` runs `McpClientManager.shutdown()`, which drops transports
and revokes the ability to call any `mcp__*` tool. The session is
removed from the map; the next user prompt triggers `getOrCreate()`
with fresh config — conversation history intact.

Effect: **Delete / Toggle-off take effect as soon as the current turn
finishes**, not after 30 s idle. For Update (where the server still
exists), the rebuild also happens but carries no security
implication; the extra work is cheap.

### 3.3 Explicit session close

`close(sessionId)` — fired by user-initiated "new chat" or tab close.
Same teardown as release, plus timer cancellation.

---

## 4. What is *not* a bug under this contract

The following behaviors are **by design**, not defects to file:

1. **Mid-turn immunity.** Disabling an MCP while the agent is
   generating a response: the agent finishes the turn with the old
   tool-set. The next turn is clean.
2. **Short window of in-flight staleness.** Between `postReload` and
   the in-flight prompt completing (seconds), the old tool-set is
   still callable. This is the trade-off for not tearing down tool
   execution mid-call.
3. **Reload triggers a fresh session even on benign Updates.** A
   field-rename PUT will force rebuild of running sessions. Cost is
   ~hundreds of ms; acceptable given the simplification.

Reports that hit (1) or (2) and call them bugs should be closed with
a link to this document.

---

## 5. Required behavior on the Portal side

This contract is only honest if the Portal matches it. The coordination
checklist covers: UX copy indicating "applies to the next turn", toast copy
on Toggle-off / Delete, etc.

---

## 6. Source-of-truth map

| Concern | File / Symbol |
|---|---|
| Session TTL | `src/agentbox/session.ts` — `SESSION_RELEASE_TTL_MS`, `scheduleRelease`, `release` |
| Session lifecycle | `src/agentbox/session.ts` — `AgentBoxSessionManager.getOrCreate`, `close` |
| MCP handler | `src/agentbox/sync-handlers.ts` — `mcpHandler` |
| Invalidate plumbing | `src/agentbox/http-server.ts` — reload route builds `invalidate` closure; `src/shared/gateway-sync.ts` — `ReloadContext.sessions[].invalidate` |
| Portal notify trigger | `src/portal/siclaw-api.ts` — PUT / DELETE / toggle of `mcp_servers` call `notifyMcpAgents` |

---

## 7. When this contract must be revisited

Reopen this doc if any of the following becomes true:

- MCP servers support **streaming** server-initiated events that the
  LLM should observe in real time. Current assumption: MCP is
  request-response within a tool call.
- **Per-tool** (vs per-server) revocation becomes a requirement
  (today the granularity is "server is enabled / disabled").
- The LLM vendor gains a stable API for changing tool schemas
  mid-session. Today the tool list is part of the cacheable prefix;
  changing it invalidates caching.
