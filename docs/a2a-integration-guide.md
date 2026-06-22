# Calling Siclaw from Another Agent (A2A Integration Guide)

This guide is for an **external agent** (an LLM agent, an orchestrator, a workflow)
that wants to delegate SRE diagnosis to Siclaw and get a streamed or polled result
back — without coupling to Siclaw's internal chat event schema.

Siclaw exposes an [A2A](https://a2a-protocol.org/)-aligned HTTP+JSON gateway. The
contract here (`task` / `statusUpdate` / `artifactUpdate`) is stable: Siclaw's
internal runtime events can change without breaking your integration.

---

## 1. What you need

Three things, nothing else:

1. **An Agent Card URL** — describes the agent, its skills, capabilities, and the
   base URL for all operations.
2. **An API key** — `Authorization: Bearer sk-...`. The key is bound to one agent.
3. **A natural-language problem** — e.g. "pods in kube-system keep restarting on node X".

Base path (all routes are per-agent, because one Portal can host many agents):

```
https://<portal-host>/api/v1/a2a/agents/<agentId>
```

Every JSON response carries an `A2A-Version: 1.0` header and
`Content-Type: application/a2a+json; charset=utf-8`.

---

## 2. Discover the agent (Agent Card)

```bash
curl -s "https://<portal-host>/api/v1/a2a/agents/<agentId>/.well-known/agent-card.json"
# alias: .../agent-card.json
```

Returns (abridged):

```jsonc
{
  "name": "Siclaw SRE Agent",
  "version": "1.0",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/markdown", "text/plain"],
  "supportedInterfaces": [
    { "url": "https://<portal-host>/api/v1/a2a/agents/<agentId>",
      "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0" }
  ],
  "securitySchemes": {
    "siclawApiKey": { "httpAuthSecurityScheme": { "scheme": "Bearer" } }
  },
  "skills": [
    { "id": "sre_cluster_diagnosis", "name": "SRE Cluster Diagnosis",
      "examples": ["Diagnose why pods in kube-system are restarting.", "..."] }
  ]
}
```

The card route is **public** (no auth) and exposes no secrets.

> Note: discovery is **agent-scoped** (`/api/v1/a2a/agents/<agentId>/.well-known/...`),
> not the A2A canonical host-root `/.well-known/agent-card.json`. An off-the-shelf
> A2A client that auto-discovers at the host root will not find it — use the
> agent-scoped URL you were given.

---

## 3. Authentication

```
Authorization: Bearer sk-...
```

- The key is bound to exactly one `agentId`; using it on a different agent's route
  returns `403 PERMISSION_DENIED`.
- A missing/invalid key returns `401 UNAUTHENTICATED`.
- Tasks are scoped to the **key that created them** — you can only read/cancel
  tasks your own key started.

---

## 4. Two ways to consume — pick by who reads the output

### 4a. Headless (recommended for agent-to-agent)

Your agent just wants the final diagnosis to feed back into its own reasoning.
**No SSE needed.** Submit, then poll until terminal.

```bash
# 1) submit (returns immediately with a WORKING task — this is NOT the result yet)
curl -s -X POST "https://<host>/api/v1/a2a/agents/<agentId>/message:send" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"message":{"role":"ROLE_USER","parts":[{"text":"diagnose kube-system restarts"}]}}'
# -> { "task": { "id": "<taskId>", "contextId": "<ctx>", "status": { "state": "TASK_STATE_WORKING" } } }

# 2) poll until terminal
curl -s "https://<host>/api/v1/a2a/agents/<agentId>/tasks/<taskId>" \
  -H "Authorization: Bearer $API_KEY"
```

When `status.state` is terminal, the answer is in `artifacts`:

```jsonc
{ "task": {
  "id": "<taskId>",
  "status": { "state": "TASK_STATE_COMPLETED" },
  "artifacts": [
    { "artifactId": "assistant-text", "name": "Siclaw diagnosis",
      "parts": [{ "text": "## Diagnosis\n...", "mediaType": "text/markdown" }] }
  ]
}}
```

> `message:send` is **non-blocking**: it returns a `WORKING` task right away, not
> the finished result. Always poll `GET .../tasks/<taskId>` (or stream) for the
> outcome.

Minimal poll loop:

```python
import time, requests
H = {"Authorization": f"Bearer {API_KEY}"}
base = "https://<host>/api/v1/a2a/agents/<agentId>"
task = requests.post(f"{base}/message:send", headers=H,
                     json={"message": {"role": "ROLE_USER",
                                       "parts": [{"text": "diagnose kube-system restarts"}]}}).json()["task"]
tid = task["id"]
TERMINAL = {"TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"}
while True:
    t = requests.get(f"{base}/tasks/{tid}", headers=H).json()["task"]
    if t["status"]["state"] in TERMINAL:
        break
    time.sleep(2)
print(t.get("artifacts", [{}])[0].get("parts", [{}])[0].get("text", ""))
```

### 4b. Streaming (when a human watches progress)

Use SSE when you relay live progress (tool calls, partial text) to a person.

```bash
curl -sS -N -X POST "https://<host>/api/v1/a2a/agents/<agentId>/message:stream" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":{"role":"ROLE_USER","parts":[{"text":"diagnose kube-system restarts"}]}}'
```

A2A SSE uses **unnamed `data:` frames**, each holding one typed object. There is
no `event:` line. The first frame is always the `task` snapshot:

```
data: {"task":{"id":"<taskId>","contextId":"<ctx>","status":{"state":"TASK_STATE_WORKING"}}}

data: {"statusUpdate":{"taskId":"<taskId>","status":{"state":"TASK_STATE_WORKING"},"metadata":{"currentTool":"restricted_bash"}}}

data: {"artifactUpdate":{"taskId":"<taskId>","artifact":{"artifactId":"assistant-text","parts":[{"text":"## Diag","mediaType":"text/markdown"}]},"append":true,"lastChunk":false}}

data: {"artifactUpdate":{"taskId":"<taskId>","artifact":{"artifactId":"assistant-text","parts":[{"text":""}]},"append":true,"lastChunk":true}}

data: {"statusUpdate":{"taskId":"<taskId>","status":{"state":"TASK_STATE_COMPLETED"}}}

: keepalive
```

Consumer rules:

- **Frame type** = the single top-level key: `task` | `statusUpdate` | `artifactUpdate`.
- `artifactUpdate` with `append: true` → **concatenate** `artifact.parts[].text` to
  build the answer. `lastChunk: true` marks the final chunk.
- `statusUpdate` with a terminal `status.state` → the stream is done.
- Lines starting with `:` are heartbeat comments (every ~25s) — ignore them.

Python consumer:

```python
import json, requests
buf = []
with requests.post(f"{base}/message:stream", headers=H, stream=True,
                   json={"message": {"role": "ROLE_USER",
                                     "parts": [{"text": "diagnose kube-system restarts"}]}}) as r:
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        obj = json.loads(line[6:])
        if "artifactUpdate" in obj:
            for p in obj["artifactUpdate"]["artifact"].get("parts", []):
                buf.append(p.get("text", ""))
        elif "statusUpdate" in obj:
            state = obj["statusUpdate"]["status"]["state"]
            if state.startswith("TASK_STATE_") and state not in ("TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"):
                break
print("".join(buf))
```

---

## 5. Continue, reconnect, cancel, list

- **Continue the same investigation thread**: pass the same `contextId` on the next
  `message:send`/`message:stream`. Omit it to start fresh (the server generates one
  and returns it on the task). Each call still creates a new task; the `contextId`
  reuses the underlying session.
- **Reconnect a dropped stream**: `POST .../tasks/<taskId>:subscribe` (only while the
  task is non-terminal; a terminal task returns `400`). Or just fall back to polling
  `GET .../tasks/<taskId>` — polling always works.
- **Cancel**: `POST .../tasks/<taskId>:cancel` → aborts the run, returns the task in
  `TASK_STATE_CANCELED`.
- **List your tasks**: `GET .../tasks?pageSize=20&pageToken=0&contextId=<ctx>&status=TASK_STATE_WORKING`.
  Returns `{ tasks, totalSize, pageSize, nextPageToken }`. `pageSize` is 1–100
  (default 20); `pageToken` is an integer offset; empty `nextPageToken` means no more.

Task states: `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`, `TASK_STATE_COMPLETED`,
`TASK_STATE_FAILED`, `TASK_STATE_CANCELED`, `TASK_STATE_REJECTED`.

---

## 6. Errors

JSON error envelope (google.rpc shape):

```jsonc
{ "error": {
  "code": 403,
  "status": "PERMISSION_DENIED",
  "message": "API key is not authorized for this agent",
  "details": [{ "reason": "FORBIDDEN", "domain": "a2a-protocol.org",
                "metadata": { "timestamp": "2026-06-22T..." } }]
}}
```

| HTTP | `status` | When |
|------|----------|------|
| 400  | `INVALID_ARGUMENT` | bad body, empty/oversized ids, non-text parts, bad pageSize |
| 401  | `UNAUTHENTICATED` | missing/invalid key |
| 403  | `PERMISSION_DENIED` | key not bound to this `agentId` |
| 404  | `NOT_FOUND` | task does not exist (or not yours) |
| 413  | `RESOURCE_EXHAUSTED` | body over 1 MB |
| 502  | `UNAVAILABLE`/runtime error | runtime command failed |
| 503  | `UNAVAILABLE` | agent runtime not connected |

---

## 7. Constraints (MVP)

- **Text parts only.** `message.parts[].text`; `raw`/`url`/`data`/file parts are rejected.
- `message.role`, if present, must be `ROLE_USER`.
- Body ≤ **1 MB**; any id (`messageId`/`contextId`) ≤ **255 bytes**.
- `message.taskId` continuation / `input-required` is **not** supported yet — start a
  new task in the same `contextId` instead.
- Push notifications, Agent Card signing, OAuth/mTLS, and the full A2A JSON-RPC
  binding are deferred. This is a documented HTTP+JSON contract, not a drop-in for
  every A2A SDK — implement against the schemas above (or use the client snippets).

---

## 8. Embedding Siclaw as a tool in your agent

The cleanest way to let an LLM agent use Siclaw is to expose it as a single tool
that wraps the flow above (send+poll for headless, stream for human-facing):

```jsonc
{
  "name": "siclaw_diagnose",
  "description": "Delegate a Kubernetes / GPU / host / network / storage SRE problem to Siclaw and return an operational diagnosis with evidence.",
  "input_schema": {
    "type": "object",
    "properties": {
      "problem":    { "type": "string", "description": "Natural-language symptom, e.g. 'pods in kube-system keep restarting on node X'." },
      "context_id": { "type": "string", "description": "Reuse to continue the same investigation thread; omit to start fresh." }
    },
    "required": ["problem"]
  }
}
```

Tool body: `POST message:send` → poll `GET tasks/<taskId>` to terminal → return
`artifacts[0].parts[0].text`. (OpenAI function-calling format is analogous.)
