---
title: "Coordinator Routing"
sidebarTitle: "Coordinator Routing"
description: "Stable resource-coverage and alias-resolution contract for coordinator agents."
---

# Coordinator Routing

The coordinator routes work; it does not diagnose resources itself. Delegation
is authorized only after `list_delegates` finds an exact cluster or host binding
on a roster member.

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
with `binding_name_confirmed=true`. That flag records the routing state so a
second miss is terminal; it is not an authorization assertion and does not
weaken exact roster matching.

If no helper is attached, the helper is ambiguous or unresolved, or the
confirmed retry misses, the coordinator does not guess or loop. It tells the
user that no authorized agent covers the supplied name and that the name may be
an alias.

## Behavioral invariants

Tests for coordinator routing should verify observable routing behavior rather
than exact persona wording:

- canonical cluster and host bindings match case-insensitively;
- partial bindings and delegate metadata do not prove coverage;
- the first miss offers at most one optional alias-resolution retry; and
- a confirmed binding-name miss is terminal.
