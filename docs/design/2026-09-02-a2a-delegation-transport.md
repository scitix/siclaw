# A2A delegation transport

`delegate_to_agent` submits the peer task to the management plane's internal
A2A entrance — the same durable Task/Segment core that serves external A2A
callers — and translates its frames back into the peer-event vocabulary the
coordinator side consumes.

**This is the only delegation transport.** The private start/event/control
relay between Runtimes that preceded it has been deleted.

## Why

- **One task semantics instead of two.** The relay and the external A2A facade
  each carried their own lifecycle. On the A2A core every leg has a durable
  task: waiting states, budgets, idempotent resume, dispatch retries and expiry
  come from the control plane instead of being re-implemented per transport.
- **Authorization belongs to the control plane.** The relay checked the roster
  in this process. The entrance checks `(caller agent, peer agent)` against
  `siclaw_agent_delegates` itself, and derives where the peer runs from the peer
  row — so this Runtime no longer decides either.
- **The model-side experience did not change.** Tool inputs, the SSE frame
  protocol to the coordinator box (`delegate_session` / `peer_event` /
  `delegate_result`) and the card are untouched. Only the leg between this
  Runtime and the peer changed.

## Configuration

None. It reuses what the Runtime already holds:

```
SICLAW_SERVER_URL      # the control plane it is already connected to
SICLAW_PORTAL_SECRET   # the adapter secret the persistent WS already presents
```

Both are required for a Runtime to function at all, so this transport cannot be
pointed at the wrong control plane, cannot be handed a stale token, and has no
rotation story of its own — rotating the adapter secret drops the WS session and
invalidates this in the same instant.

There is deliberately no https requirement and no plaintext escape hatch: the
adapter listener is plain HTTP on a ClusterIP-only port and the control-plane WS
already rides it. Demanding TLS here would have been theatre whose only real
effect was an env var operators set to `1`.

## Identity and authorization

```
X-Auth-Token            the Runtime's adapter secret
X-Siclaw-Caller-Agent   the coordinator this delegation is on behalf of
```

The caller agent is an **assertion**, not a credential: a Runtime connection
authenticates a Runtime, not one of its agents, so the control plane validates
it against `siclaw_agents.runtime_id` before deciding the roster question.
Without that check every coordinator on a Runtime would inherit every other
coordinator's roster.

The peer executes as **its own owner**, resolved control-plane side from the
peer agent's `created_by`. The caller does not lend its identity, and there is
no on-behalf-of: that concept existed for a workload identity that no longer
exists, and its implementation allowed impersonating any member of an org.

## Wire shape

| Concept | On the wire |
|---|---|
| open a leg | `POST /inner/a2a/agents/{peer}/message:stream` |
| answer a parked question | `POST …/message:send` with `message.taskId`, then `…:subscribe` |
| find a parked task | `GET …/tasks?contextId={ctx}&status=TASK_STATE_INPUT_REQUIRED` |
| cancel | `POST …/tasks/{id}:cancel` |
| delegation marker | `metadata["siclaw.delegationId"]`, on the open **and** every resume |
| evidence references | a `data` part, media type `application/vnd.siclaw.context+json` |
| tool records | `{"toolCall": …}` frames, merged by `toolCallId` |

`siclaw.delegationId` is what makes the peer turn a *delegated* turn: the
marker gates `report_findings` and `request_input`, so without it the peer has
no structured artifact, no way to ask a human anything, and nothing for the
one-level recursion guard to key on. It rides the resume too — a marker that
only rode the first turn would stop applying the moment a parked task continued.

## Continuation across a restart

The remote conversation handle is **derived** from the local peer session id, so
it needs no storage and any process addresses the same remote thread. The
waiting task id is a process-local hint with a real fallback: every resume asks
the control plane, so an empty hint after a restart costs one GET rather than a
duplicate task.

It used to be the other way round — both lived only in an in-process map, which
gave a continuation three ways to vanish (a restart, a 500-entry cap's eviction,
any gateway that had not opened the thread) and none of them failed loudly. The
next leg opened a task on a fresh context, so a peer parked mid-question was
abandoned and the human's answer went to a new turn.

## Tests

`src/gateway/delegate-a2a-transport.test.ts` — completed-flow translation,
`toolCall` → rich start/end events, a failed call marked as an error, redaction
of tool output, INPUT_REQUIRED pause plus same-task resume with a stable
idempotency key, the derived context surviving a process that forgot
everything, parked-task adoption from the listing, FAILED → `stream_error`,
and abort → remote `:cancel`.

⚠️ Those run against a hand-written HTTP server, which is why the control-plane
side carries a **cross-repo contract test** driving these exact request shapes
at the real handler. Four mismatches lived through both suites at once — a
rejected `data` part, the wrong `status` spelling, discarded `siclaw.*`
metadata, and an `errorCode` the transport's own fixture invented — because each
side was validating the request it had imagined.
