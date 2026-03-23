---
name: pdb-debug
description: >-
  Diagnose PodDisruptionBudget issues (node drain blocked, rolling update stuck, eviction
  rejected). Checks PDB configuration, disruption budget status, and interaction with
  cluster operations.
---

# PodDisruptionBudget Diagnosis

When node drain is blocked, rolling updates stall, or pod evictions are rejected with `Cannot evict pod as it would violate the pod's disruption budget`, follow this flow to identify the PDB causing the issue.

**Scope:** This skill is for **diagnosis only**. Once you identify the blocking PDB and why it's blocking, report it to the user and stop. Do NOT attempt to modify or delete PDBs.

## Diagnostic Flow

### 1. List PDBs in the namespace

```bash
kubectl get pdb -n <ns>
```

```bash
kubectl get pdb -n <ns> -o custom-columns='NAME:.metadata.name,MIN-AVAILABLE:.spec.minAvailable,MAX-UNAVAILABLE:.spec.maxUnavailable,ALLOWED-DISRUPTIONS:.status.disruptionsAllowed,CURRENT:.status.currentHealthy,DESIRED:.status.desiredHealthy,EXPECTED:.status.expectedPods'
```

Key fields:
- `ALLOWED-DISRUPTIONS` — how many pods can be evicted right now (0 = drain blocked)
- `CURRENT` vs `DESIRED` — current healthy pods vs minimum required

### 2. Identify the blocking PDB

If `disruptionsAllowed` is 0, the PDB is blocking evictions. This means:
- `currentHealthy <= desiredHealthy` — already at or below the minimum

Check why current healthy pods are at the minimum:

```bash
kubectl describe pdb <pdb-name> -n <ns>
```

### 3. Check which pods the PDB protects

```bash
kubectl get pdb <pdb-name> -n <ns> -o jsonpath='{.spec.selector.matchLabels}'
```

List the matching pods:

```bash
kubectl get pods -n <ns> -l <key>=<value> -o wide
```

Check their status — are they all healthy?

```bash
kubectl get pods -n <ns> -l <key>=<value> -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,STATUS:.status.phase,NODE:.spec.nodeName'
```

### 4. Understand the budget arithmetic

**For `minAvailable`:**
- Can be absolute (e.g., `2`) or percentage (e.g., `50%`)
- `disruptionsAllowed = currentHealthy - minAvailable`
- If minAvailable >= total replicas, **no eviction is ever possible**

**For `maxUnavailable`:**
- `disruptionsAllowed = maxUnavailable - (expectedPods - currentHealthy)`
- If maxUnavailable is 0, **no eviction is ever possible**

```bash
kubectl get pdb <pdb-name> -n <ns> -o json | jq '{minAvailable: .spec.minAvailable, maxUnavailable: .spec.maxUnavailable, currentHealthy: .status.currentHealthy, desiredHealthy: .status.desiredHealthy, expectedPods: .status.expectedPods, disruptionsAllowed: .status.disruptionsAllowed}'
```

### 5. Match pattern and conclude

---

#### `disruptionsAllowed: 0` — Budget exhausted

The PDB allows 0 disruptions. No pods can be evicted until more pods become healthy.

Common causes:
- **minAvailable equals replica count** — e.g., 3 replicas with `minAvailable: 3` means zero tolerance for disruption
- **Pods already unhealthy** — some pods are not Ready, consuming the budget before drain even starts
- **Single replica with minAvailable: 1** — a 1-replica deployment with `minAvailable: 1` blocks all evictions

Report the PDB configuration and whether it's intentionally restrictive or a misconfiguration.

---

#### Node drain blocked by PDB

`kubectl drain` respects PDBs and will wait indefinitely if a PDB doesn't allow disruption.

```bash
kubectl get pods --field-selector spec.nodeName=<node> -A -o json | jq '.items[] | {name: .metadata.name, namespace: .metadata.namespace}'
```

Identify which pods on the draining node are protected by PDBs with 0 allowed disruptions.

If urgent maintenance is needed, advise the user to:
1. Scale up the deployment to increase healthy pod count (allowing budget slack)
2. Wait for unhealthy pods to recover
3. As a last resort, use `--delete-emptydir-data --force --ignore-daemonsets` flags (but PDBs are still respected unless `--disable-eviction` is used, which bypasses PDB — dangerous)

---

#### Rolling update stuck — new pod not Ready, PDB blocks old pod eviction

During a Deployment rollout, the old pod cannot be evicted because:
1. The new pod is not Ready yet (readiness probe failing)
2. PDB counts only Ready pods as healthy
3. Evicting the old pod would drop below `minAvailable`

This creates a deadlock if there aren't enough extra replicas.

```bash
kubectl get deployment <name> -n <ns>
kubectl get replicaset -n <ns> -l app=<app> --sort-by='.metadata.creationTimestamp'
```

---

#### PDB selector matches no pods

If the PDB's selector doesn't match any pods, `expectedPods` will be 0 and the PDB has no effect.

```bash
kubectl get pdb <name> -n <ns> -o jsonpath='{.status.expectedPods}'
```

If 0, the PDB is orphaned or the selector labels are wrong. This is not blocking anything but may indicate a misconfiguration.

---

#### Multiple PDBs selecting the same pods

If multiple PDBs select the same pods, **all** PDBs must allow the disruption. The most restrictive PDB wins.

```bash
kubectl get pdb -n <ns> -o json | jq '.items[] | {name: .metadata.name, selector: .spec.selector}'
```

Check if overlapping selectors create an unintended total restriction.

---

#### PDB with percentage-based budget on small replica count

`minAvailable: 50%` on a 3-replica deployment means `desiredHealthy = 2` (ceiling). Only 1 pod can be disrupted at a time. With 2 replicas, `minAvailable: 50%` means `desiredHealthy = 1`, allowing 1 disruption.

Percentage values are rounded **up** for `minAvailable` and rounded **down** for `maxUnavailable`, making small replica counts more restrictive than expected.

## Notes

- PDBs only affect **voluntary disruptions** (drain, eviction, Deployment rollouts). Involuntary disruptions (node crash, OOM kill) ignore PDBs.
- `kubectl drain --disable-eviction` bypasses PDB checks entirely (K8s 1.18+). This should only be used for emergency maintenance.
- PDBs are commonly created alongside Deployments/StatefulSets. Check if the PDB was created by a Helm chart or operator.
- `kubectl get events -n <ns> | grep -i "disruption\|evict\|drain"` may show PDB-related event history.
- For cluster autoscaler: PDBs also block node scale-down. If the autoscaler cannot evict pods due to PDB, nodes won't be removed.
