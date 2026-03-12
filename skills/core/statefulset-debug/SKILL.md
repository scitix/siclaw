---
name: statefulset-debug
description: >-
  Diagnose StatefulSet rollout and scaling failures (ordered update stuck, OnDelete not updating, partition misconfiguration, PVC binding deadlocks).
  Checks update strategy, pod ordinal progression, PVC bindings, and ordered startup to identify why a StatefulSet is not progressing.
---

# StatefulSet Rollout & Scaling Failure Diagnosis

When a StatefulSet rollout is stuck, pods are not updating, or scaling is not progressing, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify the StatefulSet, delete pods, or change PVCs — that should be left to the user.

**When to use:** A StatefulSet is not progressing — pods are not updating to the new version, scaling up/down is stuck, or specific ordinal pods are not becoming ready.

**Not for Deployments:** Deployment rollouts have different semantics (parallel, unordered). Use `deployment-rollout-debug` for Deployments.

## Key Concepts

StatefulSets differ fundamentally from Deployments:
- **Fixed pod identity** — pods have stable names with ordinal suffixes (pod-0, pod-1, ...)
- **Ordered operations** — updates go in reverse order (N-1 → 0), scaling up goes in forward order (0 → N-1)
- **Per-pod PVCs** — each pod gets its own PersistentVolumeClaim via `volumeClaimTemplates`
- **Blocking progression** — in OrderedReady mode (default), if pod at ordinal K is not Ready, all pods with ordinal < K will NOT be updated

## Diagnostic Flow

### 1. Get StatefulSet overview

```bash
kubectl get statefulset <name> -n <ns> -o wide
```

Compare the columns:
- **READY** — pods that are running and ready
- **REPLICAS** — desired replica count (from `spec.replicas`)
- **UP-TO-DATE** — pods running the current version (matching `currentRevision` == `updateRevision`)

If `READY < REPLICAS` or there is no `UP-TO-DATE` column showing full count, the rollout or scaling is incomplete.

### 2. Describe the StatefulSet

```bash
kubectl describe statefulset <name> -n <ns>
```

Focus on:
- **Update Strategy** — `RollingUpdate` or `OnDelete`
- **Partition** — if set, only pods with ordinal ≥ partition are updated
- **maxUnavailable** — if set (Kubernetes 1.24+), allows multiple pods to be updated simultaneously instead of one-at-a-time
- **Current Revision / Update Revision** — if different, an update is in progress
- **Events** — look for errors or warnings

### 3. Check pod status by ordinal

First get the StatefulSet's pod selector to reliably find its pods:

```bash
kubectl get statefulset <name> -n <ns> -o jsonpath='{.spec.selector.matchLabels}'
```

Then use the returned labels to list pods:

```bash
kubectl get pods -n <ns> -l <key>=<value> --sort-by='.metadata.name'
```

Identify which ordinal pod is stuck. In a StatefulSet with OrderedReady policy, **the stuck pod blocks all subsequent operations**.

### 4. Match the failure pattern

---

#### OnDelete strategy — Pods not updating after StatefulSet change

The StatefulSet uses `updateStrategy.type: OnDelete`. In this mode, Kubernetes does **not** automatically update pods — the user must manually delete each pod for it to be recreated with the new spec.

```bash
kubectl get statefulset <name> -n <ns> -o jsonpath='{.spec.updateStrategy}'
```

If the output shows `{"type":"OnDelete"}` or no `rollingUpdate` field:

Check if the current and update revisions differ:

```bash
kubectl get statefulset <name> -n <ns> -o jsonpath='current={.status.currentRevision} update={.status.updateRevision}'
```

If they differ, the StatefulSet spec has been updated but pods are still running the old version. This is **expected behavior** for OnDelete — pods must be manually deleted to pick up the new version.

Check which pods are still on the old revision (use the selector from step 3):

```bash
kubectl get pods -n <ns> -l <key>=<value> -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.controller-revision-hash}{"\n"}{end}'
```

Pods whose `controller-revision-hash` matches `currentRevision` (not `updateRevision`) are still on the old version.

---

#### RollingUpdate stuck at a specific ordinal — Ordered update blocked

In RollingUpdate mode, StatefulSet updates pods in **reverse ordinal order** (N-1 → N-2 → ... → 0). By default (one-at-a-time), if pod at ordinal K is not Ready, the update stops — pods K-1, K-2, ..., 0 will not be updated.

**Check maxUnavailable** (Kubernetes 1.24+, GA in 1.27):

```bash
kubectl get statefulset <name> -n <ns> -o jsonpath='{.spec.updateStrategy.rollingUpdate.maxUnavailable}'
```

If `maxUnavailable` is set (e.g., `3`), multiple pods can be updated simultaneously instead of strict one-at-a-time. In this case, seeing 2-3 pods updating at once is normal — not a sign of being stuck. Only investigate if the number of updating pods is below `maxUnavailable` for an extended period, or if specific pods are stuck in a non-Ready state.

Find pods that are not Ready:

```bash
kubectl get pods -n <ns> -l <key>=<value> --sort-by='.metadata.name'
```

Check the stuck pod's status:
- **Pending** → Use `pod-pending-debug`
- **CrashLoopBackOff / Error** → Use `pod-crash-debug`
- **ImagePullBackOff** → Use `image-pull-debug`
- **Running but not Ready** → Check readiness probe (see below)

If the pod is Running but not Ready:

```bash
kubectl describe pod <stuck-pod> -n <ns>
```

Look for `Readiness probe failed` events. Common causes:
- Application not listening on the expected port after config change
- New version has a bug that prevents health check from passing
- Readiness probe configuration too aggressive for the new version's startup time

---

#### Partition update — Only some pods updated

The StatefulSet has `spec.updateStrategy.rollingUpdate.partition` set. Only pods with ordinal **≥ partition** are updated; pods with ordinal < partition remain on the old version.

```bash
kubectl get statefulset <name> -n <ns> -o jsonpath='{.spec.updateStrategy.rollingUpdate.partition}'
```

If this returns a number (e.g., `3`), then pods 0, 1, 2 will NOT be updated. This is often used intentionally for **canary rollouts** — update a subset first, verify, then lower the partition to 0 to roll out fully.

If the user expects all pods to be updated, the partition value needs to be set to `0` or removed.

---

#### Scaling up stuck — Ordered creation blocked

When scaling up, StatefulSet creates pods in **forward ordinal order** (0 → 1 → 2 → ...). Pod at ordinal K+1 is not created until pod K is Running and Ready.

```bash
kubectl get pods -n <ns> | grep <statefulset-name>
```

Find the highest ordinal pod that exists — the next ordinal is waiting for this pod to become Ready.

Check why the current highest pod is not Ready (same diagnosis as the "stuck at specific ordinal" pattern above).

For the `podManagementPolicy` field:

```bash
kubectl get statefulset <name> -n <ns> -o jsonpath='{.spec.podManagementPolicy}'
```

- **OrderedReady** (default) — strict ordered creation, one at a time
- **Parallel** — all pods are created simultaneously (no ordering guarantee)

If the policy is `Parallel` and pods are still stuck, the issue is not ordering — check individual pod status.

---

#### PVC binding deadlock — Pod stuck in Pending due to volume topology

StatefulSet pods use `volumeClaimTemplates` to create per-pod PVCs. If the PVC is bound to a PV in a specific availability zone (AZ) or node, but that node/AZ has no resources, the pod cannot be scheduled.

Check PVC status for the stuck pod:

```bash
kubectl get pvc -n <ns> | grep <statefulset-name>
```

```bash
kubectl describe pvc <pvc-name> -n <ns>
```

Check the StorageClass's `volumeBindingMode`:

```bash
kubectl get storageclass $(kubectl get pvc <pvc-name> -n <ns> -o jsonpath='{.spec.storageClassName}') -o jsonpath='{.volumeBindingMode}'
```

- **Immediate** — PVC is bound to a PV as soon as created, regardless of pod scheduling. If the PV is in a different zone than the only available nodes, the pod cannot be scheduled.
- **WaitForFirstConsumer** — PVC binding is delayed until the pod is scheduled. If no node can satisfy both the pod's scheduling constraints and the storage topology, the PVC stays `Pending` and the pod stays `Pending` — a deadlock.

Check if the PV has a node affinity constraint:

```bash
kubectl get pv <pv-name> -o jsonpath='{.spec.nodeAffinity}'
```

If the PV is locked to a specific node/zone:
- Check if that node has available resources: `kubectl describe node <node>`
- Check if that node is healthy: `kubectl get node <node>`

**Common scenario:** A node was replaced or drained, but the PV is still bound to the old node's zone. The new pod can only be scheduled to nodes that can access this PV, but those nodes may be full or tainted.

For further PVC diagnosis, use the `pvc-debug` skill.

---

#### Scaling down — PVCs left behind

When a StatefulSet is scaled down, pods are deleted in **reverse ordinal order** (N-1 → N-2 → ...). However, Kubernetes does **not** automatically delete the associated PVCs.

```bash
kubectl get pvc -n <ns> | grep <statefulset-name>
```

If there are PVCs for ordinals that no longer exist (e.g., `data-myapp-3` when replicas is 2), these are orphaned PVCs from a previous scale-down.

This is by design to prevent data loss. But when scaling back up, the new pod will reattach to the old PVC with stale data, which may cause application issues.

Check the StatefulSet's `persistentVolumeClaimRetentionPolicy` (Kubernetes 1.27+):

```bash
kubectl get statefulset <name> -n <ns> -o jsonpath='{.spec.persistentVolumeClaimRetentionPolicy}'
```

- **whenDeleted: Retain** (default) — PVCs are kept when StatefulSet is deleted
- **whenScaled: Retain** (default) — PVCs are kept when scaling down
- **whenScaled: Delete** — PVCs are automatically deleted on scale-down

---

#### Pod stuck in Terminating during update or scale-down

During an update or scale-down, if a pod is stuck in `Terminating`, the next operation cannot proceed.

```bash
kubectl describe pod <terminating-pod> -n <ns>
```

First check if a PodDisruptionBudget (PDB) is preventing the deletion:

```bash
kubectl get pdb -n <ns>
```

```bash
kubectl describe pdb <pdb-name> -n <ns>
```

If the PDB's `minAvailable` or `maxUnavailable` limit has been reached, the StatefulSet controller cannot delete the pod. Check `status.disruptionsAllowed` — if it is `0`, no more pods can be disrupted until other pods become Ready.

If PDB is not the issue, check other common causes:
- **Finalizer blocking deletion** — check `metadata.finalizers`
- **PreStop hook hanging** — a long-running preStop hook delays termination
- **Process not responding to SIGTERM** — the container process ignores shutdown signals and must wait for `terminationGracePeriodSeconds` to expire
- **Volume unmount stuck** — the volume cannot be detached from the node

Check the grace period:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.terminationGracePeriodSeconds}'
```

## Notes

- StatefulSet updates go in **reverse** ordinal order (N-1 → 0), but scaling up goes in **forward** order (0 → N-1). This is a common source of confusion.
- `OnDelete` is frequently used in database StatefulSets (MySQL, PostgreSQL, etc.) where the operator wants manual control over when each replica is restarted. If a user complains that pods are not updating, check the strategy before assuming there is a bug.
- The `partition` field is for canary rollouts. A common workflow: set partition=N-1 to update only the last pod, verify, then set partition=0 to roll out to all pods. If a user sees partial updates, check partition before investigating further.
- PVCs created by `volumeClaimTemplates` follow the naming convention `<volumeClaimTemplate-name>-<statefulset-name>-<ordinal>`. Use this pattern to find PVCs for specific ordinals.
- Unlike Deployments, StatefulSets do NOT create new ReplicaSets for updates. They update pods in-place (delete old pod, create new pod with same name and PVC).
- For cross-reference: if the stuck pod's issue is at the scheduling level, use `pod-pending-debug`. If it is crashing, use `pod-crash-debug`. If PVCs are not binding, use `pvc-debug`.
