---
name: pod-pending-debug
description: >-
  Diagnose pod scheduling failures (Pending, Unschedulable).
  Checks events, node resources, taints, affinity, and PVC bindings to identify why a pod cannot be scheduled.
---

# Pod Scheduling Failure Diagnosis

When a pod is stuck in `Pending` state, follow this flow to identify why the scheduler cannot place it on a node.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify node taints, labels, or pod specs — that should be left to the user.

## Diagnostic Flow

### 1. Read the pod and its events — one call

```
k8s_inspect(kind: "pod", name: "<pod>", namespace: "<ns>")
```

The scheduler's `FailedScheduling` event carries the reason, and this returns the pod's events
alongside its phase and container states in a single call.

Two things to read carefully:
- The `FailedScheduling` message — it says how many nodes were evaluated and why each was rejected,
  and that count is what separates "no capacity anywhere" from "one taint on one node". The compact
  bundle keeps substantially more of long scheduler messages, but if a line ends in `…`, fetch that
  event with `kubectl get events` or `kubectl describe pod` before concluding from the missing tail.
- The final `status:` line. An **empty** events section on a Pending pod is itself the finding: the
  scheduler never spoke, which points at a missing scheduler, a webhook, or a `schedulerName` nothing
  is servicing — a different problem from every pattern below. `partial (events: …)` means the
  opposite, that the events could not be read at all.

If the message names a specific node, read that node the same way:

```
k8s_inspect(kind: "node", name: "<node>")
```

Reach for `kubectl describe pod <pod> -n <ns>` when you need the pod's affinity rules, tolerations or
volume declarations verbatim.

### 2. Match scheduling failure and investigate

Match the `FailedScheduling` message against the patterns below.

---

#### `Insufficient cpu` / `Insufficient memory` — Not enough resources

No node has enough allocatable CPU or memory to satisfy the pod's resource requests.

Check node resource usage:

```bash
kubectl top nodes
```

Check what the pod is requesting:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[*].resources.requests}'
```

Advise the user to either reduce the pod's resource requests, scale up existing nodes, or add new nodes to the cluster.

---

#### `didn't match Pod's node affinity/selector` — Node affinity/selector mismatch

The pod has a `nodeSelector` or `nodeAffinity` that no available node satisfies.

Check the pod's node selection criteria:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.nodeSelector}'
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.affinity}'
```

Check available node labels:

```bash
kubectl get nodes --show-labels
```

Advise the user to either update the pod's selector/affinity or add the required labels to appropriate nodes.

---

#### `had taint` ... `that the pod didn't tolerate` — Taint/toleration mismatch

Nodes have taints that the pod does not tolerate.

Check node taints:

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
```

Check the pod's tolerations:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.tolerations}'
```

Advise the user to either add the appropriate toleration to the pod or remove the taint from a node.

---

#### `persistentvolumeclaim` ... `not found` / `not bound` — PVC issue

The pod references a PVC that does not exist or is not bound to a PV.

Check PVC status:

```bash
kubectl get pvc -n <ns>
```

If the PVC exists but is `Pending`, check its events:

```bash
kubectl describe pvc <pvc-name> -n <ns>
```

Common causes: no matching PV, StorageClass not found, or provisioner failed.

---

#### `0/N nodes are available` (all filtered) — No nodes available

Every node in the cluster was rejected. The message usually lists multiple reasons. Address each reason individually — the most impactful one is typically resource insufficiency or taints.

---

#### `didn't find available persistent volumes` — No matching PV

The PVC exists but no PV matches its requirements (size, access mode, storage class).

```bash
kubectl get pv
kubectl get pvc <pvc-name> -n <ns> -o yaml
```

---

#### `pod has unbound immediate PersistentVolumeClaims` — PVC not yet bound

The PVC is waiting for a PV to be provisioned. Check if the StorageClass provisioner is working:

```bash
kubectl get storageclass
kubectl get events -n <ns> --field-selector involvedObject.name=<pvc-name>
```

---

#### `Preempting` — Scheduler is preempting lower-priority pods

The scheduler is attempting to evict lower-priority pods to make room. This is normal behavior for priority-based scheduling. If the pod remains Pending after preemption, there may be additional constraints.

## Notes

- If no `FailedScheduling` event exists, the pod may not have been processed by the scheduler yet — check if the scheduler pod itself is healthy: `kubectl get pods -n kube-system -l component=kube-scheduler`.
- For pods created by controllers (Deployment, StatefulSet), the pending pod name may change as the controller recreates it — use label selectors to find the current pending pod.
- If the pod has a `scheduling.volcano.sh/pod-group` annotation, it is managed by Volcano scheduler — use `volcano-diagnose-pod` skill instead for Volcano-specific issues (PodGroup, Queue, Gang scheduling).
