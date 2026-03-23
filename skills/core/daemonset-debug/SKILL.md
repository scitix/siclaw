---
name: daemonset-debug
description: >-
  Diagnose DaemonSet failures (pods not scheduled on all nodes, node selector mismatch,
  taint/toleration issues, rolling update stuck). Checks node coverage, scheduling constraints,
  and per-node pod status.
---

# DaemonSet Failure Diagnosis

When a DaemonSet is not running on all expected nodes, pods are failing on specific nodes, or a rolling update is stuck, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify DaemonSets, node labels, or taints.

## Diagnostic Flow

### 1. Check DaemonSet status

```bash
kubectl get daemonset <name> -n <ns>
```

Compare **DESIRED** vs **CURRENT** vs **READY**:
- `DESIRED` = number of nodes matching the DaemonSet's node selector/affinity
- `CURRENT` = number of pods created
- `READY` = number of pods running and passing readiness probes

```bash
kubectl describe daemonset <name> -n <ns>
```

Focus on:
- **Node-Selector** — which nodes are targeted
- **Tolerations** — which taints are tolerated
- **Events** — look for `FailedCreate` or scheduling errors
- **Desired / Current / Ready / Up-to-date / Available** numbers

### 2. Find nodes missing the DaemonSet pod

```bash
kubectl get pods -n <ns> -l <daemonset-selector> -o wide --sort-by='.spec.nodeName'
```

Get the DaemonSet's selector if unknown:

```bash
kubectl get daemonset <name> -n <ns> -o jsonpath='{.spec.selector.matchLabels}'
```

Compare against the full node list:

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,STATUS:.status.conditions[?(@.type=="Ready")].status,TAINTS:.spec.taints[*].key'
```

Identify nodes that have no matching pod from step above.

### 3. Check why the pod is missing from a specific node

For a node without the DaemonSet pod, check:

**Node labels (for nodeSelector):**

```bash
kubectl get node <missing-node> -o jsonpath='{.metadata.labels}'
```

Compare with the DaemonSet's nodeSelector:

```bash
kubectl get daemonset <name> -n <ns> -o jsonpath='{.spec.template.spec.nodeSelector}'
```

**Node taints:**

```bash
kubectl describe node <missing-node> | grep -A 5 Taints
```

**DaemonSet tolerations:**

```bash
kubectl get daemonset <name> -n <ns> -o jsonpath='{.spec.template.spec.tolerations}'
```

A DaemonSet pod will NOT be scheduled on a node if:
- The node has a taint not tolerated by the DaemonSet
- The node's labels don't match the DaemonSet's nodeSelector or nodeAffinity

### 4. Check failing pods

If pods exist but are not Ready:

```bash
kubectl get pods -n <ns> -l <daemonset-selector> --field-selector status.phase!=Running -o wide
```

For each failing pod:

```bash
kubectl describe pod <pod> -n <ns>
kubectl logs <pod> -n <ns> --tail=200
```

### 5. Match pattern and conclude

---

#### Node has a taint the DaemonSet does not tolerate

Common taints that block DaemonSet pods:
- `node-role.kubernetes.io/control-plane:NoSchedule` — control plane nodes
- `node.kubernetes.io/not-ready:NoSchedule` — NotReady nodes
- `node.kubernetes.io/unschedulable:NoSchedule` — cordoned nodes
- Custom taints (e.g., `dedicated=gpu:NoSchedule`)

Report the taint and that the DaemonSet needs a matching toleration.

---

#### NodeSelector or NodeAffinity mismatch

The DaemonSet targets nodes with specific labels, but some nodes lack those labels.

```bash
kubectl get nodes --show-labels | grep -v <expected-label>
```

Report which nodes lack the required labels.

---

#### Pod failing on specific nodes — node-specific issue

The pod is scheduled but crashing or not Ready on certain nodes. This usually indicates a node-specific problem:
- Missing host path or device (e.g., GPU device for device plugin DaemonSet)
- Kernel module not loaded
- Insufficient resources on that node

Check the pod logs and events on the affected node's pod (step 4).

---

#### Rolling update stuck — maxUnavailable constraint

DaemonSet `RollingUpdate` strategy has a `maxUnavailable` setting (default: 1). If a new pod on a node can't become Ready, the update halts because it can't exceed `maxUnavailable`.

```bash
kubectl get daemonset <name> -n <ns> -o jsonpath='strategy={.spec.updateStrategy.type} maxUnavailable={.spec.updateStrategy.rollingUpdate.maxUnavailable}'
```

Identify which node's pod is not Ready and diagnose that specific pod (step 4).

---

#### DaemonSet wants to run on a node being drained

During node drain (`kubectl drain`), pods are evicted but DaemonSet pods are **not evicted by default** (drain respects DaemonSet pods). However, if the node is cordoned, new DaemonSet pods can still be scheduled there (DaemonSets tolerate `unschedulable` by default).

If the DaemonSet pod was manually deleted during drain:

```bash
kubectl get events -n <ns> --field-selector involvedObject.name=<pod> --sort-by='.lastTimestamp'
```

---

#### Too many pods — DaemonSet running on unintended nodes

If `DESIRED` is higher than expected, the DaemonSet's nodeSelector may be too broad or missing.

```bash
kubectl get daemonset <name> -n <ns> -o jsonpath='{.spec.template.spec.nodeSelector}'
```

If empty, the DaemonSet runs on **all** nodes (including control plane if it tolerates the taint).

## Notes

- DaemonSets automatically tolerate `node.kubernetes.io/not-ready:NoExecute` and `node.kubernetes.io/unreachable:NoExecute` — they stay on NotReady nodes.
- To check rollout progress, compare `DESIRED`, `CURRENT`, `READY`, and `UP-TO-DATE` columns in `kubectl get daemonset <name> -n <ns>`. Also check `kubectl describe daemonset <name> -n <ns>` for update status.
- To check if a DaemonSet uses the `OnDelete` update strategy (pods only update when manually deleted): `kubectl get daemonset <name> -n <ns> -o jsonpath='{.spec.updateStrategy.type}'`
- Infrastructure DaemonSets (CNI, device plugin, log collector) are critical — a missing DaemonSet pod can affect all workloads on that node.
