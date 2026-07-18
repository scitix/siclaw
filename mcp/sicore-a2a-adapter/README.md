# Sicore A2A MCP Adapter

A minimal local stdio MCP server that lets Codex or Claude Code use one existing Siclaw agent through Sicore's A2A API.

The adapter is intentionally thin:

```text
Codex / Claude Code --stdio MCP--> this adapter --HTTPS A2A--> Sicore --> Siclaw Runtime --> the agent's existing AgentBox
```

It does not hold cluster credentials, choose a Siclaw agent, or execute infrastructure tools. One adapter process is fixed to one `SICLAW_AGENT_ID` and one Sicore A2A key.

## Tools

- `siclaw_investigate`: create or continue an investigation and wait up to 50 seconds. Longer investigations continue server-side and are watched with `siclaw_wait_task`.
- `siclaw_wait_task`: wait up to 50 seconds on an existing task without submitting another investigation. Use it repeatedly as the same-turn watchdog.
- `siclaw_get_task`: get one immediate compact snapshot; terminal snapshots include the full result.
- `siclaw_cancel_task`: cancel a non-terminal task.
- `siclaw_list_tasks`: recover/list tasks scoped to the same agent and API key.

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
- `SICLAW_AGENT_ID`: the agent UUID bound to the A2A key.
- exactly one of:
  - `SICLAW_A2A_KEY_FILE`: path to a file containing the key. On Unix it must have mode `0600` or stricter.
  - `SICLAW_A2A_KEY`: direct environment fallback for ephemeral testing.

Optional:

- `SICLAW_A2A_TIMEOUT_MS`: network-operation timeout, default `30000`. Bounded GET retries share this same budget.
- `SICLAW_A2A_POLL_INTERVAL_MS`: task polling interval, default `3000`.

The key must never be passed as a command-line argument or committed to a project MCP config. Prefer a private key file outside the repository:

```bash
mkdir -p ~/.config/siclaw
umask 077
read -s SICLAW_TEST_KEY
printf '%s' "$SICLAW_TEST_KEY" > ~/.config/siclaw/test-a2a-key
unset SICLAW_TEST_KEY
chmod 600 ~/.config/siclaw/test-a2a-key
```

## Run directly

```bash
SICORE_URL=https://sicore.example.com \
SICLAW_AGENT_ID=<agent-uuid> \
SICLAW_A2A_KEY_FILE=~/.config/siclaw/test-a2a-key \
node dist/index.js
```

The process speaks MCP over stdout. Diagnostic startup messages go only to stderr and never include the key.

## Codex

Use absolute paths so the MCP process does not depend on the current project directory:

```bash
codex mcp add \
  --env SICORE_URL=https://sicore.example.com \
  --env SICLAW_AGENT_ID=<agent-uuid> \
  --env SICLAW_A2A_KEY_FILE=/absolute/path/to/test-a2a-key \
  siclaw-test -- node /absolute/path/to/sicore-a2a-adapter/dist/index.js
```

## Claude Code

```bash
claude mcp add -s user \
  -e SICORE_URL=https://sicore.example.com \
  -e SICLAW_AGENT_ID=<agent-uuid> \
  -e SICLAW_A2A_KEY_FILE=/absolute/path/to/test-a2a-key \
  siclaw-test -- node /absolute/path/to/sicore-a2a-adapter/dist/index.js
```

Create one named MCP server per Siclaw agent/key pair. The model-visible tool schemas intentionally contain no `agent_id` parameter.

## Watchdog behavior

Sicore owns the durable background task. The local adapter stays stateless and
does not run a persistent daemon. When `siclaw_investigate` returns a working
task, the MCP client should keep the current turn open and call
`siclaw_wait_task` with the same `task_id` until the task is terminal, the user
asks it to stop, or an overall investigation deadline is exhausted.

Working responses contain only the latest status, timestamp, and accumulated
character count. The growing partial report is deliberately withheld so each
watchdog call does not repeat many kilobytes into the model context. The full
report is returned once on a terminal response. `siclaw_list_tasks` can recover
task IDs after a client restart without returning stored reports.

The same watchdog rule is advertised through MCP server instructions, so the
client model does not have to infer or remember the polling protocol from a
previous conversation.

## Failure behavior

- A2A `message:send` is never automatically retried, avoiding duplicate investigation tasks.
- Idempotent task reads retry transient timeouts, connection failures, malformed responses, HTTP 408/429, and HTTP 500/502/503/504 at most twice with short backoff. Retries stay inside the read or watchdog deadline.
- Task cancellation is never automatically retried.
- If a bounded wait expires, the tool returns a compact working task; call `siclaw_wait_task` again instead of resubmitting the question.
- HTTP 401/403/429/503 and A2A error reasons are returned as MCP tool errors without request headers or key material.
- Adapter restarts do not lose server-side tasks; recover them with `siclaw_list_tasks` using the same key.
