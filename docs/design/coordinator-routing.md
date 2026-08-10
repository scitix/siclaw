---
title: "Coordinator Routing"
sidebarTitle: "Coordinator Routing"
description: "Stable resource-coverage and alias-resolution contract for coordinator agents."
---

# Coordinator Routing

The coordinator answers what it can and routes what it cannot; it never
diagnoses resources itself. Delegation is authorized only after `list_delegates`
finds an exact cluster or host binding on a roster member.

## Answer or route

The coordinator has two modes, chosen per request:

- **Answer** — a knowledge question (concepts, how-to, definitions,
  comparisons, documented facts) is answered directly from the coordinator's
  own skills and knowledge base. Delegating such a question only to have a
  specialist restate the answer costs a round trip and buys nothing.
- **Route** — anything needing the live state of a specific resource, hands-on
  inspection/diagnosis/remediation, or a conclusion only the resource's
  authorized specialist can stand behind is delegated.

The deciding question is whether a correct answer depends on a specific
environment's **live state** or on a **hands-on action**. If it does, or if that
is uncertain, the coordinator routes: a specific cluster's current state is
never answered from the coordinator's own knowledge. This is why answering is
bounded to environment-independent knowledge — the coordinator holds no
authorization over any resource, so it can never be the authority on one.

Skills and knowledge also inform *where* to route: the specialist domain and
target are worked out from them rather than guessed by scanning the roster.
`list_delegates` remains the authorization step, not the discovery mechanism.

Answering depends on the coordinator actually having skills or a knowledge base
attached; it is `defaultNoSkills` at creation, so a coordinator left without
them can only route.

### The triage stays invisible

Which mode was chosen is machinery, and the reader must never see it. A reply
opens with the answer, not with the classification that produced it — no "this
is a knowledge question", no "I looked this up in the knowledge base", no "as a
coordinator I do not do hands-on work". Naming the mode is not merely noise: it
invites the reader to doubt whether the answer is authoritative.

When no answer is possible, the reply states the **outcome** the reader needs —
the specialist covering that resource could not be reached, or which detail is
still missing — rather than the internal rule that produced it.

## Coverage lookup

- The first lookup uses the target exactly as established from the user's
  request. This keeps canonical-name requests to one in-box tool call and works
  when the coordinator has no skills, which is the default.
- A non-empty query matches bound cluster and host names exactly,
  case-insensitively. Delegate names, descriptions, and partial resource-name
  matches are not coverage evidence.
- A successful lookup identifies the roster member that may receive the task.
  The roster remains the authorization source; a routing helper never grants
  coverage.

## Optional alias resolution

When the first lookup misses and the target may be a cluster alias, the
coordinator may consult a routing-helper skill that was explicitly attached to
it. Routing helpers are optional and have no fixed implementation or serialized
field name, but their semantic result must distinguish:

- one confirmed canonical Siclaw binding name;
- an ambiguous result; or
- an unresolved result.

Only the first outcome permits one retry. The retry passes the canonical name
with `binding_name_confirmed=true`. That flag is caller-supplied, so it is a
declaration of what was resolved rather than a guarantee: it is not an
authorization assertion, it does not weaken exact roster matching, and it cannot
by itself bound the number of retries.

The bound is enforced by the tool, as a single-use retry token scoped to ONE
routing attempt. An empty result issues a token; spending the retry means
presenting it; presenting it consumes it — whether that retry hits or misses — and
while a token is outstanding any further empty result in the same attempt is
terminal. That holds against both ways a caller could otherwise loop: repeating
the unresolved name, and changing it, since the real alias flow replaces the alias
with a canonical name and a per-name memory would not recognise the second call as
the same attempt.

The attempt boundary matters as much as the bound. An offer the coordinator never
spends — it was told to consult a helper, none was attached, so it answered the
user instead — is retired when the turn changes, rather than surviving to make the
next question's first miss look terminal. The tool observes the turn through
`ToolRefs.turnRef`, bumped by whoever owns the prompt; where that is absent the
state simply stays session-scoped. The bound lives in the tool; the choice of
canonical name remains the coordinator's.

If no helper is attached, the helper is ambiguous or unresolved, or the
confirmed retry misses, the coordinator does not guess or loop. It tells the
user that no authorized agent covers the supplied name and that the name may be
an alias.

## Runtime placement contract

Roster membership authorizes *which agent* may receive a delegated task; it
does not decide *where that agent runs*. Before creating an AgentBox, the source
Runtime must resolve the coordinator and peer against management-plane truth:

- the coordinator must belong to the authenticated source Runtime;
- the peer must be an active member of that coordinator's roster and organization;
- `sourceRuntimeId`, `targetRuntimeId`, and the local/remote classification must
  be present and mutually consistent; and
- an unresolved or inconsistent route fails closed. It must never fall back to
  creating the peer in the coordinator's Runtime.

Same-Runtime delegation keeps the local AgentBox path. Cross-Runtime delegation
uses the management-plane Runtime mesh: `delegation.start` routes the peer turn,
`delegation.event` carries best-effort progress back to the source,
`delegation.control` delivers acknowledged terminal/error/input/artifact frames,
and `delegation.abort` stops the target turn. Runtime-private Gateway addresses
are never part of this contract.

The source creates and sequences the delegated session/user row so coordinator
ownership, parent lineage, and the delegation boundary are durable before the
target starts. Its `delegation.start` prompt therefore declares
`skipInitialPersistence=true`; the management plane revalidates the delegation
edge and reasserts that flag before forwarding `chat.send`. The target does not
create a second user row, so a target-side `promptMessageId` is intentionally
absent. A bare, non-delegated `chat.send` may never suppress persistence.

Live progress events are not the correctness record for the result. They may be
dropped individually, so even a non-empty reassembled answer can be incomplete.
Lifecycle, error, clarification and artifact frames therefore travel with an
acknowledgement on *both* legs: the target Runtime reports a delegated turn's
terminal to the management plane over an acknowledged RPC, and the management
plane relays control frames to the source over one, retried until this Runtime
confirms that the matching delegation consumer handled them. Each retry budget has
to outlast a WS reconnect: a few hundred milliseconds would give up while the only
route back is still being re-established: a single reconnect can take the client's
whole backoff cap plus jitter.

A terminal produced by the SUPERVISOR — a Runtime shutdown, or a box removed under
a turn — takes the same acknowledged route, and cancels every turn it reports: a
queued turn declared interrupted must not go on to start afterwards. The suppression
of a turn's own reporting is likewise per turn, or the other live turn would still
emit a plain terminal that reads as a turn which succeeded. Those paths bypass the turn's own
reporting, which is exactly why they needed their own way to reach it, and shutdown
waits briefly for those deliveries before closing the transport they travel over.

A reported terminal enters the same ordered queue as the stream it accompanies.
Acting on it straight from the RPC would let it overtake an artifact, error or
clarification that preceded it, retiring supervision before those were delivered. A
terminal that cannot be queued is refused rather than acknowledged — acknowledging it
would stop the only party able to send it again.
And a re-delivered terminal must be acknowledged, not rejected: its consumer is
gone precisely because it consumed the original, and refusing it keeps a sender
retrying — which keeps supervision alive over a turn that already ended.

After the terminal event, the source always derives remote `finalText` from
assistant rows after the current delegation boundary in durable session history.
Recovery widens a window over the newest rows rather than walking a timestamp
cursor, because `created_at` is second-granular and a cursor would skip rows
sharing a second. Artifact-only and input-required turns may legitimately have no
assistant text; an ordinary completed turn with no durable result fails instead
of returning an empty or partial success. The remote relay timeout measures event
*silence* and is renewed by matching events;
`SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT` may override it in seconds, bounded by
the management plane's own relay lease — waiting past that point cannot succeed,
because the events being waited for no longer have a route.

### Cancellation is addressed by turn, not by session

A session id names a *conversation*, and delegation deliberately reuses a peer
session for follow-ups in one investigation. "Abort session S" is therefore
ambiguous the moment a turn ends, and a supervisor's abort can be delayed past
that point by a lease expiry or a retry. Every abort a Runtime sends names the
turn it means:

- a prompt carries the caller's turn id. A supervisor that will have to abort the
  turn later fixes it *before* dispatch and passes it in the prompt — learning it
  from the acknowledgement would leave the one case that needs it most, an
  acknowledgement that never arrived, with nothing to name. The Runtime mints one
  only when the caller supplies none, and echoes whichever id is in force;
- the box records it as the running turn. An abort naming a different turn does not
  stop the running one — but "not running" is not the same as "finished": that turn's
  prompt may still be in flight, or its session may be rebuilding. The intent is
  therefore recorded as a latch for the named turn rather than discarded, and latches
  are held per turn, since cancelling one turn while another runs is ordinary;
- a pre-spawn abort latch records the turn that armed it and is consumed only by
  that turn's prompt, so an orphaned latch cannot cancel a later, deliberate prompt
  on the same reused session id. That is also why a named latch is armed
  unconditionally: the "already has history on disk" guard exists only because a
  session-wide latch could cancel an unrelated prompt, and skipping it is what lets
  a Stop on a REUSED session — which a delegated peer thread always is — arm
  anything at all; and
- `chat.abort` accepts an optional turn id and ignores a stale one. The user's Stop
  button sends none, which still means "stop what is running" — and more than one
  turn can be live at that moment, because a second send registers its turn before
  it can acquire the session lock. All live turns are therefore named, snapshotted
  before the consumer is broken: reading them afterwards would miss the very turn
  being stopped, since a settling turn removes itself. Cancellation is per turn on
  this side too — aborting the session's controllers would break the RUNNING turn's
  consumer even for a request that named a queued one, and the box, told only about
  the named turn, would leave the running one going with nobody reading it.

Both fields are optional, which is what makes naming a turn safe to roll out in
either order: a box that ignores the field keeps session-wide semantics, and a
caller that sends none behaves as before.

Because an abort is turn-scoped, compensation no longer has to guess whether a
dispatch landed. AgentBox starts a run *before* acknowledging the prompt, so a
lost acknowledgement leaves a turn running that nobody will consume; the Runtime
therefore aborts by turn on every prompt rejection, which is a no-op when the
turn never started. Cancellation is latched before authorization and route lookup
so an HTTP close cannot be missed during pre-stream awaits. An abort the box never
confirmed is reported as a failure rather than a successful Stop — answering
otherwise tells the management plane to stop retrying and tear down supervision.
A terminal carrying `aborted=true` is authoritative interruption, even if partial
assistant rows were already persisted.

Supervision ends when a terminal is *observed*, whether or not it could be handed
onwards. The target turn is over by definition at that point, so an abort issued
after it — the one a lease expiry would otherwise send — could only land on a
successor.

This contract creates one strict rollout dependency and one that is merely
preferred. The strict one: the management plane implementing route/start/abort and
the reverse event lane must be deployed **before** the Runtime containing this
behavior, because an older management plane makes every delegation route lookup
fail closed — including same-Runtime delegation. The preferred one: turn
addressing spans the AgentBox image as well, and each half degrades to the older
session-wide meaning on its own, so that half can roll in either order.

Cross-Runtime delegation also assumes the management plane terminates every
Runtime connection it must reach in one process. Placement decisions, command
delivery and event subscription all resolve against connections local to the
process handling the delegation, so a multi-replica control plane would fail
closed on any pair split across replicas rather than misroute.

## Behavioral invariants

Tests for coordinator routing should verify observable routing behavior rather
than exact persona wording:

- canonical cluster and host bindings match case-insensitively;
- partial bindings and delegate metadata do not prove coverage;
- the first miss offers at most one optional alias-resolution retry, and within an
  attempt the offer is not reissuable — neither by querying the same unresolved
  name again nor by changing it (alias → canonical) with the flag omitted;
- the offer is resolved whether the retry hits or misses, and an unspent offer does
  not outlive its turn — a later, unrelated routing question still gets its own;
- a confirmed binding-name miss is terminal; and
- the Portal's mirror of the locked capabilities and descriptions matches this
  registry, so the type picker cannot advertise an agent this code no longer
  builds.
