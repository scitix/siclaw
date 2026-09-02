# Session resume guarantees and opt-in input requests (2026-09-02)

Two small, paired capabilities on the `chat.send` path, both opt-in per call by
the management plane (or any RPC caller):

1. **`requireExistingSession`** — a continuation turn must land on the session
   context it names, or fail loudly. AgentBox never silently starts a fresh
   session for a caller that asked to continue an old one.
2. **`allowInputRequest`** — expose the `request_input` tool on a
   non-delegated turn, so an externally submitted task (A2A / MCP) can pause,
   ask its caller one question, and be resumed with the answer into the SAME
   session.

They ship together because they are two halves of one loop: `allowInputRequest`
is how a turn earns the right to pause and wait for an answer;
`requireExistingSession` is what makes delivering that answer later — possibly
after a pod restart — trustworthy.

## Problem

`request_input` (PR #413) was only available on delegated turns
(`refs.delegation` present). An A2A caller's turn is not a delegated turn, so
an externally submitted investigation could never pause for clarification —
the tool simply did not exist for it.

Separately, `getOrCreate` treats an unknown `sessionId` as "create it". That is
the right default for chat, but wrong for answer delivery: if the AgentBox was
re-created and the session's persisted JSONL is gone, the "resumed" turn starts
from a blank context and the model answers the caller's isolated follow-up as
if it were the whole task. That answer looks complete and is worse than an
error, because nothing signals that the original investigation's context was
lost.

## Contract

### `chat.send` params (caller → Runtime → AgentBox `/api/prompt`)

| Field | Type | Behavior |
|---|---|---|
| `allowInputRequest` | `true` | This turn exposes `request_input` even without a delegation. Absent/false: behavior unchanged (tool only on delegated turns). |
| `requireExistingSession` | `true` | The session context for `sessionId` must be restorable (resident in memory, or persisted JSONL with at least one real user/assistant message). If not: fail with `SESSION_CONTEXT_UNAVAILABLE`, HTTP 412, `retriable: false` — BEFORE any session directory or managed session is created. Absent/false: behavior unchanged (unknown session ⇒ create). |

### AgentBox `/api/prompt` responses

- **412** `{ error: { code: "SESSION_CONTEXT_UNAVAILABLE", message, retriable: false, status: 412 } }`
  — continuation refused; nothing was created, no compensation needed.
- **200** acks now carry `resumed: boolean` — whether the session context was
  restorable at dispatch time (live managed session or persisted history).
  Present on both the normal ack and the aborted-before-start ack.

### `chat.event` (Runtime → caller)

- A 412 from AgentBox surfaces as the standard failure pair:
  `stream_error { error: { code: "SESSION_CONTEXT_UNAVAILABLE", message, retriable: false, status: 412 } }`
  followed by `prompt_done`. Both are reliable control frames.
- `prompt_done` carries `resumed?: boolean` (echoed from the prompt ack) so the
  caller's control plane can record whether the context really came back —
  callers should treat the value as meaningful only on turns they sent as
  continuations; a first turn's `false` just means "freshly created session".

## Implementation notes

- `hasRestorableSessionContext(sessionId)` (`src/agentbox/session.ts`) is a
  side-effect-free probe: live session map first, then the session directory's
  JSONL via `SessionManager.continueRecent`, requiring at least one
  user/assistant message — a directory with only header entries does not count.
  It runs BEFORE `getOrCreate`, so a refused continuation cannot leave an empty
  session directory behind.
- `ManagedSession.allowInputRequest` joins the session-reuse predicate: a warm
  session built without the tool is rebuilt (idle) rather than reused when a
  caller asks for it, and vice versa — capability never leaks across calls.
- Subagent sessions never inherit `allowInputRequest`; a subagent cannot pause
  the parent task.
- `request_input`'s availability is now
  `sessionEventEmitter && (delegation || allowInputRequest === true)`; the
  emitted `input_required` event includes `delegationId` only on delegated
  turns, and the tool description names the actual recipient ("the
  coordinator" vs "the external caller") so the model does not imagine a relay
  that is not there.
- Runtime dispatch-failure compensation (`chat.send`'s by-turn abort) is
  skipped for `SESSION_CONTEXT_UNAVAILABLE`: AgentBox refused before creating a
  session, so an abort could only plant a stale pre-spawn latch for a turn that
  can never run.
- `agentBoxResponseError` prefers the structured `error.message` from a JSON
  error body, so the 412's message survives to the `stream_error` verbatim.

## Dispatch idempotency (`dispatchId`)

`chat.send` additionally accepts an optional `dispatchId: string`. The
management plane persists every dispatch in a durable outbox and may re-send
one whose acknowledgement was lost; the id makes that retry safe:

- Dedup key is `(sessionId, dispatchId)`, held in a process-local map
  (capacity 2000, 6h TTL). Process-local is the exact semantic: a turn cannot
  outlive this process, so a fresh process re-running the dispatch is a
  correct retry, not a duplicate.
- A duplicate returns `{ ok: true, sessionId, turnId, duplicate: true }` with
  the ORIGINAL turn's id — it never starts a second turn and, critically,
  never falls into the busy-session steer fallback (which would inject the
  same input into the running turn twice).
- The key is reserved before the first await in the handler, so a concurrent
  retry cannot slip in mid-persistence.

## Non-goals

- The built-in A2A gateway (`src/portal/a2a-gateway.ts`) does not adopt either
  flag; its input-required support remains deferred.
- No change to `delegate_to_agent` semantics or the delegated `request_input`
  path.
- No retry/outbox on the Runtime side; the caller owns retry policy (the ack is
  asynchronous, failures arrive as `stream_error`).

## Compatibility

| Peer | Behavior |
|---|---|
| Old caller (never sends the flags) | Byte-for-byte unchanged: no `request_input` on non-delegated turns, unknown sessions are created. |
| New caller + old Runtime/AgentBox | Flags are ignored; `prompt_done` has no `resumed`. The caller sees NULL and knows the runtime predates the contract. |
| Old A2A/MCP client of the caller | Sees the task pause as a non-terminal state and keeps polling; nothing here changes their wire format. |

## Testing

- `src/agentbox/session.test.ts` — restorable-context probe (no side effects,
  header-only history rejected), `allowInputRequest` in the rebuild predicate.
- `src/agentbox/http-server.test.ts` — 412 fail-closed before `getOrCreate`,
  `resumed` on both acks, `allowInputRequest` passthrough.
- `src/tools/workflow/request-input.test.ts` — availability matrix, event shape
  without `delegationId`, per-context description.
- `src/gateway/server-chat-abort.test.ts` — flag forwarding, `prompt_done.resumed`,
  `SESSION_CONTEXT_UNAVAILABLE` preserved end-to-end with no compensating abort.
- `src/gateway/agentbox/client.test.ts` — structured error body surfaced.
