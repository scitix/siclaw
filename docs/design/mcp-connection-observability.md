---
title: "MCP Connection Observability"
sidebarTitle: "MCP Connection Observability"
description: "How a box reports whether each configured MCP server was actually reached, and how the Runtime dials one config on demand."
---

# MCP Connection Observability

> **Purpose**: A configured MCP server that failed to connect used to leave one
> `console.error` line inside the AgentBox and nothing anywhere else. The control
> plane saw the configured names on `/api/sync-status` and reported them as
> "installed"; a developer whose MCP URL pointed at a web page saw a green tag
> for weeks and an agent that never had the tools. This document fixes the
> contract that closes that gap.

## 1. Two facts, two fields

`/api/sync-status` (`BoxSyncStatus`, schema v4) now carries two different facts
about MCP:

| Field | Says | Source |
|---|---|---|
| `mcp.names` | the server's config was **written into the box** | keys of the materialized `mcpServers` config |
| `mcp.servers[]` | the server was **dialled**, and what happened | `McpClientManager.getServerConnections()` |

`mcp.servers` is **absent** on a box that predates v4 or has not created a
session since it started, and **`[]`** on a box that reported and had nothing
configured. A consumer must not read absence as "all connected" — that is the
exact false green this exists to remove.

Each entry (`ObservedMcpServer`):

```ts
{ name, transport, state: "connected" | "failed", toolCount, toolNames,
  durationMs, observedAt, error?: { kind, httpStatus?, contentType?, message } }
```

## 2. The error vocabulary is owned here

`classifyMcpConnectError` (`src/core/mcp-client.ts`) maps whatever the MCP SDK
throws into a closed set: `invalid_config, dns, connection_refused, timeout,
tls, auth, not_found, not_mcp, http, protocol, unknown`. The external portal stores and
renders the kind; it never re-classifies. `not_found` + `contentType:
"text/html"` is the signature of a page URL pasted as an MCP endpoint, and is
why the HTML case gets its own handling: the message is reduced to `HTML page:
<title>` instead of carrying a 15 KB response body.

## 3. When the box records it

`observedMcpServers` is captured when a session is **created** (after
`getOrCreate`), not when a turn succeeds. A server that fails to connect is the
observation a developer needs, and it must survive the turn that follows also
failing — e.g. the model rejecting an oversized tool list. `/api/sync-status`
prefers the newest live session's manager (an MCP reload invalidates sessions,
so the newest one reflects the current config) and falls back to the snapshot.

## 4. Replica consensus

`agent.syncStatus` includes `{name, state, toolCount, errorKind}` per server in
the replica identity. Two boxes with identical config where one reached a
server and the other did not are serving different toolsets, so they are
`consistent: false` and the flat `mcp.servers` is withheld; per-box outcomes
stay in `observations`. Timing, tool names and message text are evidence, not
identity, and are ignored.

## 5. `mcp.probe` — dial one config from the Runtime

The Runtime exposes an RPC `mcp.probe { server, timeoutMs? }` that builds a
single-server `McpClientManager`, initializes it with a bounded timeout, and
returns the same `McpServerConnection` shape a box reports. It runs on the
Runtime — the network position of the boxes it spawns, and the place
per-runtime address overrides are meaningful — never on the control plane.

`stdio` servers are refused (`invalid_config`): probing one would execute an
arbitrary command in the Runtime process, and a box start already observes them.

## 6. Source-of-truth map

| Question | Where |
|---|---|
| Was a server reached, and why not | `McpClientManager.getServerConnections()` |
| Error classification | `classifyMcpConnectError` |
| Wire shape / normalization | `src/shared/agentbox-sync-status.ts` |
| Box report | `src/agentbox/http-server.ts` `/api/sync-status` |
| Replica consensus, flat aggregate | `src/gateway/server.ts` `agent.syncStatus` |
| On-demand probe | `src/gateway/server.ts` `mcp.probe` |
| Control-plane storage and console | the external portal `internal/siclaw/mcpobs` |
