# A2A delegation transport (experimental, default off)

`delegate_to_agent` currently rides a private start/event/control relay between
Runtimes. This change adds a third, opt-in transport that submits the peer task
to the management plane's **inner A2A profile** — the same durable Task/Segment
core that serves external A2A callers — and translates its frames back into the
peer-event vocabulary the coordinator side already consumes.

## Why

- **One task semantics instead of two.** The private relay and the external A2A
  facade each carry their own lifecycle. Moving delegation onto the A2A core
  gives every leg a durable task: waiting states, budgets, idempotent resume,
  dispatch retries and expiry all come from the control plane instead of being
  re-implemented in the relay.
- **The model-side experience must not change.** The tool inputs, the SSE frame
  protocol to the coordinator box (`delegate_session` / `peer_event` /
  `delegate_result`), and the roster authorization all stay exactly as they
  are. Only the leg between this Runtime and the peer changes.

## Activation

```
SICLAW_DELEGATION_TRANSPORT=a2a
SICLAW_INNER_A2A_URL=http://<internal-a2a-service>:<port>
SICLAW_INNER_A2A_TOKEN=wk-…            # workload credential issued by the management plane
```

All three must be set; otherwise the legacy transport runs (a partial
configuration logs a warning and falls back). Default is legacy — this is a
dual-stack migration, not a switch-over.

## How it maps

| Legacy concept | A2A transport |
|---|---|
| dispatch (`delegation.start` / local prompt) | `POST /inner/a2a/agents/{peer}/message:stream` (SSE until terminal) |
| peer progress events | `statusUpdate` frames → fabricated `tool_execution_end` steps; artifact deltas accumulate |
| `request_input` pause | `TASK_STATE_INPUT_REQUIRED` → `input_required` peer event; the WAITING task id is remembered per local peer-session |
| answer delivery | next `delegate_to_agent` on the same peer session → `message:send` with `taskId` + fresh `messageId` (idempotent), then `tasks/{id}:subscribe` |
| session reuse (context retention) | remembered `contextId` per local peer-session → same control-plane runtime session |
| stop / disconnect | fetch abort + best-effort `tasks/{id}:cancel`; the control plane's wait expiry converges an orphaned wait |
| peer terminal | `TASK_STATE_COMPLETED` → `message_end` with accumulated artifact text; FAILED/CANCELED/REJECTED → `stream_error` with the machine-readable detail |

Redaction: every model-visible text crossing back (question, final text, error
detail) passes `redactText` with the peer's model-config redaction set — this
transport closes the delegation-payload redaction gap the legacy local path
still has.

## Ownership during dual-stack

The **control-plane Task/Segment is the source of truth for execution state**.
The local peer-session row remains the coordinator-side READ MODEL: ownership,
lineage, recency-bounded reuse policy — unchanged. At terminal, the final
answer is mirrored into that row (best-effort) so "open full session" still
reads; the full execution transcript lives on the control-plane side, reachable
via the task (`metadata.sessionId`).

## Known deltas vs. legacy (accepted for the experimental flag)

- The peer turn runs as an ordinary A2A turn, not a delegated turn: the
  `report_findings` structured artifact is not available (the result carries
  `finalText`, `artifact` stays null), and the one-level anti-recursion relies
  on roster/agent-type policy rather than the delegation marker.
- The local peer-session transcript is opening-question + final answer, not the
  full turn-by-turn view.
- The continuation map (local peer session → remote context / waiting task) is
  process-local; a Runtime restart starts the next leg on a fresh remote
  context — the same in-flight-state loss the legacy relay has.

Closing these requires the management plane to accept a delegation context on
the inner profile (planned follow-up), at which point the marker, structured
artifact and full transcript relay can return.

## Tests

`src/gateway/delegate-a2a-transport.test.ts` (mock control-plane HTTP server):
completed-flow translation, INPUT_REQUIRED pause + same-task resume with an
idempotency key, context reuse across legs, FAILED → `stream_error`, redaction
of every model-visible text, and abort → remote `:cancel`.
