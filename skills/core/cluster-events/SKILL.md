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

### 1. Get recent events

Get all events sorted by time, focusing on Warning events:

```bash
kubectl get events -A --sort-by='.lastTimestamp' --field-selector type=Warning
```

If you need all event types for context:

```bash
kubectl get events -A --sort-by='.lastTimestamp'
```

For events in a specific namespace:

```bash
kubectl get events -n <ns> --sort-by='.lastTimestamp'
```

### 2. Identify high-frequency events

Look for events with high `COUNT` values — these indicate repeated occurrences and often point to persistent issues.

For a structured view:

```bash
kubectl get events -A --field-selector type=Warning -o custom-columns='LAST SEEN:.lastTimestamp,COUNT:.count,KIND:.involvedObject.kind,NAME:.involvedObject.name,NAMESPACE:.involvedObject.namespace,REASON:.reason,MESSAGE:.message'
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

**Next step:** Use the `pod-pending-debug` skill to diagnose the specific pod.

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

## Notes

- Kubernetes events have a default TTL of 1 hour. For older events, check monitoring/logging systems.
- Events with `count > 1` show the first and last timestamp — the actual frequency may be higher than it appears.
- When multiple Warning events appear simultaneously across different resources, look for a common cause (e.g., a node going down affects all pods on that node).
