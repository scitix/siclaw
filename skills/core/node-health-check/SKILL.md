---
name: node-health-check
description: >-
  Check node health and diagnose node-level issues (NotReady, DiskPressure, MemoryPressure, PIDPressure).
  Inspects node conditions, resource allocation, and real-time usage.
---

# Node Health Check

When nodes are `NotReady`, experiencing resource pressure, or suspected of causing pod failures, follow this flow to diagnose node-level issues.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to drain, cordon, or restart nodes — that should be left to the user or cluster administrator.

## Diagnostic Flow

### 1. Get node overview

```bash
kubectl get nodes -o wide
```

Note the **STATUS** of each node. Healthy nodes show `Ready`. Look for `NotReady`, `SchedulingDisabled`, or condition-related flags like `Ready,SchedulingDisabled`.

### 2. Inspect specific node conditions

For any node showing issues:

```bash
kubectl describe node <node>
```

Focus on the **Conditions** section. Key conditions:

| Condition | Healthy Value | Problem Value | Meaning |
|-----------|--------------|---------------|---------|
| Ready | True | False/Unknown | Kubelet is healthy and can accept pods |
| MemoryPressure | False | True | Node memory usage is critically high |
| DiskPressure | False | True | Node disk usage exceeds eviction threshold |
| PIDPressure | False | True | Too many processes running on node |
| NetworkUnavailable | False | True | Node network is not configured correctly |

Also check:
- **Allocatable vs Capacity** — shows total resources and what's available for pods
- **Allocated resources** section — shows how much is requested/limited by pods on this node
- **Events** — look for recent warnings

### 3. Check real-time resource usage

```bash
kubectl top node <node>
```

Compare actual CPU and memory usage against the node's allocatable resources from step 2.

### 4. Match condition and conclude

---

#### `NotReady` — Kubelet not responding

The kubelet on the node is not communicating with the API server. Common causes:
- Kubelet service crashed or stopped
- Node is powered off or unreachable
- Network partition between node and control plane

If node-level logs are available, use the `node-logs` skill to check kubelet logs:

```bash
bash skills/core/node-logs/scripts/get-node-logs.sh \
  --node <node> --unit kubelet --since "30m ago" --tail 100
```

Report the node's NotReady status and any kubelet errors to the user.

---

#### `DiskPressure` — Disk usage exceeds threshold

The node's disk usage exceeds the eviction threshold (typically 85%). The kubelet will start evicting pods.

Check which pods are using the most ephemeral storage:

```bash
kubectl get pods --field-selector spec.nodeName=<node> -A -o wide
```

Advise the user to clean up unused images/containers, increase disk size, or move workloads to other nodes.

---

#### `MemoryPressure` — Memory usage critically high

The node's memory usage is critically high. The kubelet may evict pods based on their QoS class (BestEffort first, then Burstable).

Check pod memory usage on the node:

```bash
kubectl top pods --field-selector spec.nodeName=<node> -A --sort-by=memory
```

If the above doesn't work (field-selector may not be supported for `top`), list pods on the node and check their usage:

```bash
kubectl get pods --field-selector spec.nodeName=<node> -A -o wide
kubectl top pods -A --sort-by=memory | head -20
```

---

#### `PIDPressure` — Too many processes

The node is running too many processes. This can prevent new containers from starting.

Advise the user to investigate which pods are creating excessive processes, and consider setting PID limits in the container runtime or kubelet configuration.

---

#### `NetworkUnavailable` — Node network not configured

The node's network plugin (CNI) has not configured networking. The CNI plugin may not be installed, crashed, or failed to initialize.

Check CNI pod status on the node:

```bash
kubectl get pods -A --field-selector spec.nodeName=<node> | grep -E 'cni|calico|cilium|flannel|weave'
```

---

#### `SchedulingDisabled` — Node is cordoned

The node has been cordoned (`kubectl cordon`) and will not accept new pods. Existing pods continue running.

This is usually intentional (maintenance). Report to the user that the node is cordoned.

### 5. Check allocated resources (optional)

If resource overcommitment is suspected:

```bash
kubectl describe node <node> | grep -A 20 "Allocated resources"
```

Compare the total requests against allocatable resources. If CPU or memory requests exceed 90% of allocatable, new pods may fail to schedule on this node.

## Notes

- `kubectl top` requires the Metrics Server to be installed in the cluster. If it returns an error, the metrics server may not be available.
- Node conditions have a `lastTransitionTime` — this tells you when the condition last changed, which helps correlate with events or changes.
- For multi-node issues, check if there's a common pattern (same zone, same instance type, same kernel version) that might indicate an infrastructure-level problem.
