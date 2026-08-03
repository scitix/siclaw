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

While a retry offer is outstanding, a matching result without that token is not
coverage evidence either; it is a caller attempting to bypass the retry boundary
and is rejected. After a terminal retry outcome, later lookups in the same turn are
also rejected, including hits. A new user turn starts a new routing attempt.

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
