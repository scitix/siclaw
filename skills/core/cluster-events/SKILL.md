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

### 0. Fix the time window first, and measure what the cluster actually kept

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
  [(.items // [])[]] as $e
  | ($e | map(.lastTimestamp // .eventTime) | map(select(. != null)) | sort) as $active
  | ($e | map(.firstTimestamp // .eventTime) | map(select(. != null)) | sort) as $started
  | if ($active | length) == 0 then "no events retained at all"
    else "\($e | length) events retained
  retention floor: \($active[0])  — anything with no activity since then is already deleted
  earliest start:  \($started[0])  — oldest firstTimestamp still present
  newest activity: \($active[-1])" end'
```

Both numbers are needed, and neither alone is the answer:

- **retention floor** (oldest `lastTimestamp`) is the real limit on what the cluster
  can answer. An event that stopped occurring before this point has been deleted.
- **earliest start** (oldest `firstTimestamp`) only says some still-active condition
  began that long ago. It does **not** mean the period since then is covered —
  anything that started AND finished in between is gone.

If the asked-for window begins before the retention floor, the evidence for that
period is **gone, not absent**. Say so and move to logs or monitoring; reporting
"no warnings" for a period the cluster cannot answer for is wrong.

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
  [(.items // [])[] | {t: (.lastTimestamp // .eventTime), n: (.count // 1), k: .involvedObject.kind,
               name: .involvedObject.name, ns: .metadata.namespace, r: .reason,
               first: .firstTimestamp}]
  | map(select(.t != null and .t >= $since))
  | sort_by(.t)
  | .[] | "\(.t)  x\(.n)  \(.k)/\(.name)  \(.ns)  \(.r)  (first seen \(.first // "?"))"'
```

Add `--until` by extending the filter with `and .t <= $until` when you are looking
at a past incident rather than the present.

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
  [(.items // [])[] | select((.firstTimestamp // .eventTime // "") >= $since)]
  | sort_by(.firstTimestamp // .eventTime)
  | .[] | "\(.firstTimestamp // .eventTime)  x\(.count // 1)  \(.involvedObject.kind)/\(.involvedObject.name)  \(.metadata.namespace)  \(.reason)"'
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
