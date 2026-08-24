# Event fields and timestamps: why the queries read what they read

Read this when you are changing the queries in `SKILL.md`, or when one of them
returns something that looks impossible. It records what was measured, so the next
edit does not have to rediscover it.

Every claim here was reproduced — against a live cluster, a fixture, or the
Kubernetes source — not inferred from the API docs.

## Two field layouts

`Event` exists in two API groups with almost disjoint field names:

| | `v1` (what `kubectl get events` returns) | `events.k8s.io/v1` |
|---|---|---|
| last activity | `lastTimestamp`, or `series.lastObservedTime` for a **series** | `deprecatedLastTimestamp`, else `eventTime` |
| first seen | `firstTimestamp` | `deprecatedFirstTimestamp`, else `eventTime` |
| occurrences | `count`, or `series.count` | `deprecatedCount` |
| the object | `involvedObject` | `regarding` |

`series` is neither hypothetical nor confined to the other group: `kubectl explain
events.series` shows `{count, lastObservedTime}` on the plain `v1` Event, and that is
where a continuing event records its latest activity.

Reading only `lastTimestamp // eventTime` drops such an event out of every windowed
query. Measured: an event still active at 09:05, whose `eventTime` was seven months
earlier, vanished from a window starting 08:42 — and the retention probe reported its
oldest observed activity as seven months old for the same reason.

The `events.k8s.io` shape matters too. `kubectl get events.events.k8s.io` returns
objects with **no** `lastTimestamp`, `count` or `involvedObject` at all; reading
`.involvedObject.kind` on those renders `null/null`.

## Why `series` comes FIRST in `active` and `count`

Not a preference — the other order is wrong on exactly the events `series` exists for.
From the Kubernetes source:

| | |
|---|---|
| `client-go/tools/events/event_broadcaster.go` | on a repeat, updates `Series.Count` and `Series.LastObservedTime`, and touches **no** deprecated field |
| `pkg/apis/events/v1/conversion.go` | `out.LastTimestamp = in.DeprecatedLastTimestamp` |

So on a series event the `v1` `lastTimestamp` and `count` are frozen at whatever they
were first written as, while `series.*` carries the truth. Reading `lastTimestamp`
first places a still-active event at its origin: reproduced with an event last observed
at 09:05 whose `lastTimestamp` said January.

`start` has no `series` term on purpose. A series has no separate start —
`firstTimestamp` (or `eventTime`) already is it.

## Why timestamps are PADDED, not truncated

`series.lastObservedTime` and `eventTime` are `MicroTime` and serialise with a
fraction; `lastTimestamp` does not. A raw string comparison gets that backwards:
`"2026-08-21T09:00:00.500000Z" >= "2026-08-21T09:00:00Z"` is **false**, because `.`
sorts below `Z`. A window opening on a whole second therefore drops everything in its
first second.

Measured against real time semantics over same-second, boundary and adjacent-second
inputs:

| strategy | wrong answers |
|---|---|
| truncate the event side only | 2 |
| truncate both sides | 2 |
| **pad both sides to 6 fractional digits** | **0** |

Truncating cannot work on either side: cutting to whole seconds maps `…00.400000Z` and
`…00.600000Z` onto the same value, so a window opening at `…00.500000Z` can no longer
separate them and admits an event from before its own start.

Padding keeps the precision and makes the strings comparable at once. Every
whole-second value becomes `.000000`; every fraction is right-padded, and truncated
past microseconds, which is `MicroTime`'s own precision. Output stays whole-second —
a reader does not need six digits to see a boundary.

## Why a non-UTC window is refused rather than converted

RFC3339 permits an offset, and `2026-08-21T16:30:00+08:00` is a legal spelling of
08:30 UTC. But the comparison is lexical and an offset does not sort against
Kubernetes' `…Z`: padded naively it became `…T16:30:00+08:00.000000Z`, and an event at
`08:45:00Z` was **silently dropped** from a window that should have contained it. A
timestamp with no zone at all was silently assumed to be UTC — the same mistake in a
different spelling.

`pad` now fails loudly instead, naming the value it rejected.

The alternative was arithmetic on the offset. `jq`'s `fromdateiso8601` accepts neither
an offset nor a fraction, so that would mean hand-rolling zone conversion inside a
skill: more code to be wrong in, serving a spelling the cluster never emits. A query
that stops and says what is wrong is worth more here than one that quietly answers a
different question — which is this skill's whole subject.

## Why both queries filter AFTER building their object

The listing and the ranking are deliberately the same shape: build the object, then
`map(select(.raw …))`. That is what lets one `--until` snippet serve both.

An earlier version filtered inside the ranking's construction, where only the jq
*variable* `$raw` exists and the field `.raw` is null. Pasting the documented snippet
there failed with `null (null) cannot be matched, as it is not a string`. If either
query is rewritten to filter during construction, the shared snippet silently stops
applying to it — `cluster-events-skill-queries.test.ts` asserts the ordering for that
reason.
