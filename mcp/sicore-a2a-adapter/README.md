# Sicore A2A MCP Adapter

A minimal local stdio MCP server that lets Codex or Claude Code drive one or more
existing Siclaw agents through Sicore's A2A API.

The adapter is intentionally thin:

```text
Codex / Claude Code --stdio MCP--> this adapter --HTTPS A2A--> Sicore --> Siclaw Runtime --> the agent's existing AgentBox
```

It does not hold cluster credentials, choose what a Siclaw agent does, or execute
infrastructure tools.

## Multiple agents, one adapter

Each Sicore A2A key is bound to exactly one Siclaw agent. Historically one adapter
process meant one key meant one agent, so switching agents meant editing config and
restarting.

This adapter can hold several **named keys** at once. You give each key a short
alias in configuration; the model selects an agent by passing that alias as the
`agent` tool argument. The alias is the only agent selector that ever crosses the
model boundary.

### Design

- **Keys live only in configuration.** `SICLAW_A2A_KEYS` is a JSON object of
  `{alias: key}`. The key material never appears in a tool schema, a tool
  argument, a log line, or an error message. Errors name the *alias* and the
  resolved *agent id*, never the key.
- **The model selects by alias, never by key.** Every tool takes an optional
  `agent` argument constrained to the alias pattern `^[a-z0-9][a-z0-9_-]{0,31}$`.
  This is the fix for the failure mode where a credential would otherwise have to
  be pasted into the chat to change which agent answers.
- **Fail fast at startup.** Each configured key is self-resolved once at boot via
  `GET /api/v1/a2a/self` (the same mechanism the single-key form already used). If
  any key fails to resolve, the process exits with an error that names the failing
  alias — no key is ever partially usable and silent.
- **No guessing.** With a single configured agent, `agent` may be omitted. With
  several, a create/list call that omits `agent` returns an explicit error listing
  the available aliases rather than picking one.
- **Task ownership is tracked, so follow-ups auto-route.** `task_id` and
  `context_id` are per-key server-side resources. The adapter records which alias
  created each `task_id` (in process memory, for the server's lifetime).
  `siclaw_wait_task` / `siclaw_get_task` / `siclaw_cancel_task` therefore route to
  the creating key automatically — you usually only pass `agent` on
  `siclaw_investigate`. If a task op passes an `agent` that disagrees with the
  recorded creator, the recorded creator wins and the result carries a
  `routing_note` recording the override.
- **Aggregated recovery.** `siclaw_list_tasks` without `agent` (and with several
  agents configured) queries every key and tags each task with its owning alias,
  re-establishing the `task_id -> alias` map after a client restart. Passing
  `agent` scopes the listing to that one agent and supports paging.

### Backward compatibility

The original single-key environment variables keep working unchanged and map to
the reserved alias `default`:

- `SICLAW_A2A_KEY` / `SICLAW_A2A_KEY_FILE` alone → one agent named `default`.
- `SICLAW_AGENT_ID` still pins the `default` agent (for an older Sicore without
  `/self`, or as a cross-check). It applies only to the single-key form; combining
  it with `SICLAW_A2A_KEYS` is a configuration error, because each named key
  resolves its own agent.
- The single-key form and `SICLAW_A2A_KEYS` may be combined; the single key takes
  the `default` slot and a `default` alias inside `SICLAW_A2A_KEYS` is rejected as
  a collision.

## Tools

- `siclaw_investigate`: create or continue an investigation and wait up to 50
  seconds. Longer investigations continue server-side and are watched with
  `siclaw_wait_task`.
- `siclaw_wait_task`: wait up to 50 seconds on an existing task without submitting
  another investigation. Use it repeatedly as the same-turn watchdog.
- `siclaw_get_task`: get one immediate compact snapshot; terminal snapshots
  include the full result.
- `siclaw_cancel_task`: cancel a non-terminal task.
- `siclaw_list_tasks`: recover/list tasks; aggregates across all agents when
  `agent` is omitted.

Every tool takes an optional `agent` alias. Its description is populated at startup
with the configured aliases and their resolved agent ids, so the model does not
have to guess which alias maps to which agent.

## Security

- The key exists only in configuration/env (or a `0600` key file). It is never a
  tool parameter, never logged, and never echoed in an error message.
- The model-visible surface carries aliases and resolved agent ids only.
- Diagnostic output on stderr reports the endpoint origin and `alias=agentId`
  pairs, never key material.

## Build and test

```bash
npm install
npm test
npm run build
```

Requires Node.js 22.19 or newer.

## Configuration

Required:

- `SICORE_URL`: Sicore base URL, for example `https://sicore.example.com`.
- at least one key, from any combination of:
  - `SICLAW_A2A_KEYS`: JSON object of named keys, e.g. `{"sre":"sk-a","kb":"sk-b"}`.
    Alias must match `^[a-z0-9][a-z0-9_-]{0,31}$`.
  - `SICLAW_A2A_KEY_FILE`: path to a file containing a single key (the `default`
    alias). On Unix it must have mode `0600` or stricter.
  - `SICLAW_A2A_KEY`: direct single-key environment fallback for ephemeral testing
    (the `default` alias).

Optional:

- `SICLAW_AGENT_ID`: the agent UUID bound to the single `default` key. By default
  the adapter resolves the agent from each key at startup (`GET /api/v1/a2a/self`).
  Set it to pin the `default` agent as a cross-check or for an older Sicore without
  `/self`. It cannot be combined with `SICLAW_A2A_KEYS`.
- `SICLAW_A2A_TIMEOUT_MS`: network-operation timeout, default `30000`. Bounded GET
  retries share this same budget.
- `SICLAW_A2A_POLL_INTERVAL_MS`: task polling interval, default `3000`.

Keys must never be passed as a command-line argument or committed to a project MCP
config. Prefer a private key file outside the repository for the single-key form:

```bash
mkdir -p ~/.config/siclaw
umask 077
read -s SICLAW_TEST_KEY
printf '%s' "$SICLAW_TEST_KEY" > ~/.config/siclaw/test-a2a-key
unset SICLAW_TEST_KEY
chmod 600 ~/.config/siclaw/test-a2a-key
```

For `SICLAW_A2A_KEYS`, keep the JSON in a private env file the MCP client loads,
not in a shared/committed config.

## Run directly

Single key:

```bash
SICORE_URL=https://sicore.example.com \
SICLAW_A2A_KEY_FILE=~/.config/siclaw/test-a2a-key \
node dist/index.js
```

Multiple named keys:

```bash
SICORE_URL=https://sicore.example.com \
SICLAW_A2A_KEYS='{"sre":"sk-a","kb":"sk-b"}' \
node dist/index.js
```

The process speaks MCP over stdout. Diagnostic startup messages go only to stderr
and never include a key.

## Codex

Use absolute paths so the MCP process does not depend on the current project
directory:

```bash
codex mcp add \
  --env SICORE_URL=https://sicore.example.com \
  --env SICLAW_A2A_KEYS='{"sre":"sk-a","kb":"sk-b"}' \
  siclaw -- node /absolute/path/to/sicore-a2a-adapter/dist/index.js
```

## Claude Code

```bash
claude mcp add -s user \
  -e SICORE_URL=https://sicore.example.com \
  -e SICLAW_A2A_KEYS='{"sre":"sk-a","kb":"sk-b"}' \
  siclaw -- node /absolute/path/to/sicore-a2a-adapter/dist/index.js
```

The model-visible tool schemas contain no key parameter and no `agent_id`
parameter — only an `agent` alias. With one key you can keep the original
single-key form and omit `agent`; with several, the model passes the alias.

## Watchdog behavior

Sicore owns the durable background task. The local adapter stays stateless across
restarts (the only in-memory state is the `task_id -> alias` map, which
`siclaw_list_tasks` rebuilds). When `siclaw_investigate` returns a working task,
the MCP client should keep the current turn open and call `siclaw_wait_task` with
the same `task_id` until the task is terminal, the user asks it to stop, or an
overall investigation deadline is exhausted.

Working responses contain only the latest status, timestamp, and accumulated
character count. The growing partial report is deliberately withheld so each
watchdog call does not repeat many kilobytes into the model context. The full
report is returned once on a terminal response. `siclaw_list_tasks` can recover
task IDs after a client restart without returning stored reports.

The same watchdog rule is advertised through MCP server instructions, so the
client model does not have to infer or remember the polling protocol from a
previous conversation.

## Failure behavior

- A2A `message:send` is never automatically retried, avoiding duplicate
  investigation tasks.
- Idempotent task reads retry transient timeouts, connection failures, malformed
  responses, HTTP 408/429, and HTTP 500/502/503/504 at most twice with short
  backoff. Retries stay inside the read or watchdog deadline.
- Task cancellation is never automatically retried.
- If a bounded wait expires, the tool returns a compact working task; call
  `siclaw_wait_task` again instead of resubmitting the question.
- HTTP 401/403/429/503 and A2A error reasons are returned as MCP tool errors
  without request headers or key material.
- Adapter restarts do not lose server-side tasks; recover them with
  `siclaw_list_tasks` using the same keys.

## Relation to the remote Sicore MCP endpoint

Sicore also exposes a first-party remote MCP endpoint (`/api/v1/mcp`, stateless
streamable HTTP). That endpoint is out of scope for this adapter: each remote MCP
client configuration carries its own `Authorization` header, so multi-agent use
there is just multiple client configurations, one per agent — no alias multiplexing
is needed. This local stdio adapter exists for clients that inject credentials from
env/files rather than per-request headers, and it is where named-key aliasing
applies.
