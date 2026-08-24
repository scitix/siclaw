---
name: cluster-events
description: >-
  Analyze cluster-wide Kubernetes events to identify issues and patterns.
  Aggregates Warning events, detects high-frequency patterns, and correlates related events.
---

# Cluster Events Analysis

Use this flow to analyze cluster-wide events for identifying issues, patterns, and correlations across resources.

**Scope:** This skill is for **analysis and diagnosis only**. It helps you understand what is happening across the cluster by examining events. Do NOT attempt to fix issues directly — identify root causes and either use a specific diagnostic skill or report findings to the user.

## Diagnostic Flow

### 0. Normalise the fields first — an event has two layouts

`Event` exists in two API groups with almost disjoint field names, and the `v1` object
additionally carries `series` for a continuing event. Reading only one layout loses
half the events silently, so every query below opens with the same four definitions.
Copy them as-is:

```
def pad: if test("Z$") | not
         then error("timestamps must be UTC and end in Z; got \(.) — convert the offset first")
         else capture("^(?<b>[^.Z]+)(\\.(?<f>[0-9]+))?Z$")
              | .b + "." + (((.f // "") + "000000")[0:6]) + "Z" end;   # fixed width, for comparison
def cut: sub("\\.[0-9]+";"");                                          # whole seconds, for display

active: (.series.lastObservedTime // .lastTimestamp // .deprecatedLastTimestamp // .eventTime)
start:  (.firstTimestamp // .deprecatedFirstTimestamp // .eventTime)
count:  (.series.count // .count // .deprecatedCount // 1)
object: (.involvedObject // .regarding // {})
```

Four things about these are load-bearing, and each was measured rather than assumed:

- **`series` comes first** in `active` and `count`. On a series event the `v1`
  `lastTimestamp` and `count` are frozen at first write; `series.*` carries the truth.
- **`start` has no `series` term.** A series has no separate start.
- **Compare padded, display cut.** `MicroTime` values carry a fraction and
  `"…09:00:00.500000Z" >= "…09:00:00Z"` is false, because `.` sorts below `Z`.
- **The window must be UTC.** `pad` refuses an offset or a missing zone by name rather
  than mis-sorting it.

Full reasoning, the measurements behind each, and what breaks if the ordering changes:
`references/event-timestamps-and-fields.md`. Read it before editing any query here.

### 0a. Fix the time window first, and measure what the cluster actually kept

Events expire. A cluster keeps roughly the last hour by default, so "the events
that exist" is not the same as "what happened" — and the difference is invisible
in the output. Answering "any recent warnings?" from an unbounded listing produces
a conclusion with no reproducible boundary, and one that reads as "nothing went
wrong" when it can only mean "nothing that is still retained".

So establish two things before interpreting anything:

- **The window you were asked about.** Take it from the request ("in the last 20
  minutes", "around 09:53Z"). If the request does not imply one, ask — do not
  substitute "whatever is retained".
- **The window the cluster can answer for.** Measure it:

```bash
kubectl get events -A -o json | jq -r '
  def pad: if test("Z$") | not
           then error("timestamps must be UTC and end in Z; got \(.) — convert the offset first")
           else capture("^(?<b>[^.Z]+)(\\.(?<f>[0-9]+))?Z$")
                | .b + "." + (((.f // "") + "000000")[0:6]) + "Z" end;
  def cut: sub("\\.[0-9]+";"");
  [(.items // [])[]] as $e
  | ($e | map(.series.lastObservedTime // .lastTimestamp // .deprecatedLastTimestamp // .eventTime)
        | map(select(. != null)) | sort_by(pad) | map(cut)) as $active
  | ($e | map(.firstTimestamp // .deprecatedFirstTimestamp // .eventTime)
        | map(select(. != null)) | sort_by(pad) | map(cut)) as $started
  | if ($active | length) == 0 then "no events retained at all"
    else "\($e | length) events retained
  oldest observed activity: \($active[0])
  oldest start still present: \($started[0])
  newest activity: \($active[-1])" end'
```

These are OBSERVATIONS, not a retention boundary. Read them as lower bounds:

- **oldest observed activity** proves the cluster still holds something that recent.
  It does **not** locate the TTL cutoff — with a one-hour TTL and a single event at
  09:55, this reads 09:55 while everything back to 09:00 is still within retention and
  merely uneventful. Treating it as the cutoff would report "the evidence for 09:30 is
  deleted" when the truth is "nothing happened at 09:30".
- **oldest start still present** says some currently-active condition began that long
  ago. It says nothing about coverage in between: anything that started AND finished
  there is gone without a trace.

So for any window earlier than the oldest observed activity, coverage is **unknown** —
"no events" there could mean quiet or deleted, and this data cannot tell them apart.
Say which one you cannot rule out rather than picking one. If the answer depends on it,
go to logs or monitoring, which retain on their own schedule.

The actual cutoff is the apiserver's `--event-ttl` (default 1h), which is usually not
readable from inside the cluster — `kubectl -n kube-system get pod -l
component=kube-apiserver -o jsonpath='{.items[0].spec.containers[0].command}'` works on
some deployments and not on managed control planes. If you can read it, the cutoff is
`now - ttl` and everything above becomes a check rather than a guess. If you cannot,
say the window is bounded by an unknown TTL rather than by the oldest event you saw.

### 0b. Confirm the namespace exists, if the question names one

`kubectl get events -n <ns>` returns an empty list and **exit code 0** for a
namespace that does not exist. Measured: no error, no warning, just
`"items": []`. A typo in the namespace is therefore indistinguishable from a
namespace with no warnings, and both read as "nothing wrong there".

```bash
kubectl get namespace <ns> -o name
```

If that fails, the events listing that follows proves nothing. Report the bad
namespace rather than its empty result.

### 1. List Warning events inside the window

`kubectl` has no server-side time filter for events — `--field-selector
'lastTimestamp>...'` is rejected as an invalid selector — so the window is applied
client-side:

```bash
SINCE=2026-08-21T08:30:00Z   # window start, RFC3339
kubectl get events -A --field-selector type=Warning -o json | jq -r --arg since "$SINCE" '
  def pad: if test("Z$") | not
           then error("timestamps must be UTC and end in Z; got \(.) — convert the offset first")
           else capture("^(?<b>[^.Z]+)(\\.(?<f>[0-9]+))?Z$")
                | .b + "." + (((.f // "") + "000000")[0:6]) + "Z" end;
  def cut: sub("\\.[0-9]+";"");
  [(.items // [])[]
   | (.involvedObject // .regarding // {}) as $o
   | (.series.lastObservedTime // .lastTimestamp // .deprecatedLastTimestamp // .eventTime) as $raw
   | {raw: $raw, n: (.series.count // .count // .deprecatedCount // 1),
      k: ($o.kind // "?"), name: ($o.name // "?"),
      ns: (.metadata.namespace // $o.namespace // "?"), r: .reason,
      first: (.firstTimestamp // .deprecatedFirstTimestamp // .eventTime)}]
  | map(select(.raw != null and (.raw | pad) >= ($since | pad)))
  | sort_by(.raw | pad)
  | map(.t = (.raw | cut) | .first = (if .first == null then null else (.first | cut) end))
  | .[] | "\(.t)  x\(.n)  \(.k)/\(.name)  \(.ns)  \(.r)  (first seen \(.first // "?"))"'
```

**Closing the window at the other end.** For a past incident, add an upper bound to
the `select`, on `.raw` and padded — the same pair the lower bound uses:

```
  | map(select(.raw != null and (.raw | pad) >= ($since | pad)
                             and (.raw | pad) <= ($until | pad)))
```

with `--arg until <RFC3339>` beside `--arg since`. Bound it on `.raw`, NOT on `.t`:
`.t` is produced by the `map(.t = …)` that runs AFTER this filter, so at select time
it is `null`, and jq orders `null` below every string — `null <= $until` is **true**
for every event, so the bound silently does nothing and the listing still runs to the
present. Measured: an event 30 minutes past `$until` was still reported.

The ranking query in step 2 takes the identical line. Both build the object first and
filter on `.raw` afterwards, so one form works in both — that is why they are shaped
the same way rather than each being written the shortest way on its own. An earlier
version filtered inside the ranking's construction, where only the jq *variable*
`$raw` exists and `.raw` is null; pasting this snippet there failed with `null (null)
cannot be matched, as it is not a string`.

For all event types (not just Warning), drop the `--field-selector`. For one
namespace, replace `-A` with `-n <ns>`.

### 2. Identify high-frequency events — and do not confuse frequency with recency

A high `count` means the event repeated, **not** that it repeated recently. An
event's `lastTimestamp` refreshes on every occurrence while `firstTimestamp` stays
put, so a long-running condition sorts to the top of any recency-ordered list
forever. Measured on a live cluster: a `BackOff` with `count: 1159275` and a
`lastTimestamp` from seconds ago — its first occurrence was far outside any window
worth investigating, and it says nothing about what just changed.

Both numbers are in the listing above. Read them together:

- `first seen` inside your window → this started during the period you care about
- `first seen` long before it, high count → a persistent condition, probably
  background noise for this investigation unless the question is about it

To rank by what is actually new in the window:

```bash
SINCE=2026-08-21T08:30:00Z
kubectl get events -A --field-selector type=Warning -o json | jq -r --arg since "$SINCE" '
  def pad: if test("Z$") | not
           then error("timestamps must be UTC and end in Z; got \(.) — convert the offset first")
           else capture("^(?<b>[^.Z]+)(\\.(?<f>[0-9]+))?Z$")
                | .b + "." + (((.f // "") + "000000")[0:6]) + "Z" end;
  def cut: sub("\\.[0-9]+";"");
  [(.items // [])[]
   | (.involvedObject // .regarding // {}) as $o
   | {raw: (.firstTimestamp // .deprecatedFirstTimestamp // .eventTime),
      n: (.series.count // .count // .deprecatedCount // 1),
      k: ($o.kind // "?"), name: ($o.name // "?"),
      ns: (.metadata.namespace // $o.namespace // "?"), r: .reason}]
  | map(select(.raw != null and (.raw | pad) >= ($since | pad)))
  | sort_by(.raw | pad)
  | map(.start = (.raw | cut))
  | .[] | "\(.start)  x\(.n)  \(.k)/\(.name)  \(.ns)  \(.r)"'
```

### 3. Correlate events by resource

When you find Warning events, check if the same resource has related events that tell a more complete story:

```bash
kubectl get events -n <ns> --field-selector involvedObject.name=<resource-name>
```

### 4. Match event patterns and recommend next steps

Match the Warning events against the patterns below. For each matched pattern, recommend the appropriate diagnostic skill or action.

---

#### `FailedScheduling` — Pod cannot be scheduled

The scheduler cannot place a pod on any node.

**Next step:** Use the `pod-pending-debug` skill to diagnose the specific pod. If the pod has a `scheduling.volcano.sh/pod-group` annotation (managed by Volcano scheduler), use `volcano-diagnose-pod` skill instead for Volcano-specific issues (PodGroup, Queue, Gang scheduling).

---

#### `BackOff` / `Back-off restarting failed container` — Container crash loop

A container is repeatedly crashing and restarting.

**Next step:** Use the `pod-crash-debug` skill to diagnose the specific pod.

---

#### `Failed` / `ErrImagePull` / `ImagePullBackOff` — Image pull failure

The container image cannot be pulled.

**Next step:** Use the `image-pull-debug` skill to diagnose the specific pod.

---

#### `FailedMount` / `FailedAttachVolume` — Volume mount failure

A volume (PVC, ConfigMap, Secret, or other) cannot be mounted.

Check the specific error message:
- `not found` — the referenced ConfigMap/Secret/PVC does not exist
- `already attached` — the volume is stuck on another node (common with RWO PVs)
- `timed out waiting` — the storage provisioner is slow or failing

---

#### `Unhealthy` — Probe failure

A liveness or readiness probe is failing.

Check which probe is failing from the event message:
- **Liveness probe failed** — the container will be restarted, may lead to CrashLoopBackOff
- **Readiness probe failed** — the container is removed from service endpoints but not restarted
- **Startup probe failed** — the container is killed during startup

Advise the user to check probe configuration (endpoint, port, timing parameters).

---

#### `NodeNotReady` — Node became unhealthy

A node transitioned to NotReady state, which may affect all pods on that node.

**Next step:** Use the `node-health-check` skill to diagnose the specific node.

---

#### `Evicted` — Pod was evicted

A pod was evicted from a node, typically due to resource pressure (DiskPressure, MemoryPressure).

Check which node evicted the pod and investigate node health:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.status.reason} {.status.message}'
```

---

#### `FailedCreate` — Controller cannot create pods

A ReplicaSet, Job, or other controller cannot create pods. Common causes: resource quota exceeded, admission webhook rejection.

Check the controller's events:

```bash
kubectl describe rs <replicaset> -n <ns>
```

---

#### `OOMKilling` — Kernel OOM killer invoked

The kernel killed a process due to memory exhaustion. This may affect containers on the node.

**Next step:** Use the `pod-crash-debug` skill for the affected pod, or `node-health-check` for the node.

## Reporting

State the boundary, every time. A finding about events is only as good as the
window it was read from, and the reader cannot see that window in your conclusion.

Every report must carry:

- **The window examined** — as absolute timestamps, not "recently". `08:30Z–09:08Z`
  is reproducible; "the last while" is not.
- **What the cluster retained** — the oldest and newest event it still had. If that
  is narrower than what was asked about, say which part of the question the data
  cannot answer.
- **For each finding, whether it started inside the window.** A condition that
  began before it is a different fact than one that began during it, even when both
  appear in the same listing.

Never write "no warnings" without the window attached. "No Warning events between
08:30Z and 09:08Z" is a finding; "no warnings" is a claim the data does not support,
because everything older than the retention period is missing rather than clean.

## Notes

- Kubernetes events have a default TTL of 1 hour. For older events, check monitoring/logging systems.
- `kubectl` cannot filter events by time server-side (`--field-selector
  'lastTimestamp>…'` is rejected as an invalid selector), which is why the flow
  above filters client-side rather than pushing the window to the apiserver.
- Events with `count > 1` carry `firstTimestamp` and `lastTimestamp`. The count is
  the total since first occurrence — including occurrences already outside the
  retention window — so it is not a rate and not a within-window figure.
- When multiple Warning events appear simultaneously across different resources, look for a common cause (e.g., a node going down affects all pods on that node).
