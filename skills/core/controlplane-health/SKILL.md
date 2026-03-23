---
name: controlplane-health
description: >-
  Check Kubernetes control plane health (API server, etcd, controller-manager, scheduler).
  Verifies component status, pod health, leader election, and common failure patterns.
---

# Control Plane Health Check

When cluster-wide issues are observed (API slowness, scheduling failures, controllers not reconciling), follow this flow to check the health of Kubernetes control plane components.

**Scope:** This skill is for **diagnosis only**. Once you identify the issue, report it to the user and stop. Do NOT attempt to restart control plane components or modify their configurations.

## Diagnostic Flow

### 1. Quick cluster health overview

```bash
kubectl cluster-info
```

```bash
kubectl version
```

```bash
kubectl get nodes -o wide
```

If the API server is unreachable, none of these commands will work — the issue is at the network or API server level.

### 2. Check control plane pods

In kubeadm-based clusters, control plane runs as static pods in `kube-system`:

```bash
kubectl get pods -n kube-system -l tier=control-plane -o wide
```

If the label filter returns nothing, try:

```bash
kubectl get pods -n kube-system | grep -E 'kube-apiserver|kube-controller-manager|kube-scheduler|etcd'
```

Check that all pods are `Running` and `Ready`. Note if any have high restart counts.

### 3. Check API server health

```bash
kubectl get pod -n kube-system -l component=kube-apiserver -o wide
```

```bash
kubectl logs -n kube-system -l component=kube-apiserver --tail=100
```

Look for:
- `etcd` connection errors — API server cannot reach etcd
- `TLS handshake error` — certificate issues
- `request timeout` — API server overloaded
- `watch channel was closed` — etcd watch disruption
- `too many open files` — file descriptor exhaustion

Check API server resource usage:

```bash
kubectl top pod -n kube-system -l component=kube-apiserver
```

### 4. Check etcd health

```bash
kubectl get pod -n kube-system -l component=etcd -o wide
```

```bash
kubectl logs -n kube-system -l component=etcd --tail=100
```

Look for:
- `rafthttp: request cluster ID mismatch` — etcd member misconfiguration
- `mvcc: database space exceeded` — etcd storage full
- `apply request took too long` — etcd disk I/O too slow
- `leader changed` — frequent leader elections indicate instability
- `compaction` errors — etcd compaction falling behind

### 5. Check controller-manager

```bash
kubectl get pod -n kube-system -l component=kube-controller-manager -o wide
```

```bash
kubectl logs -n kube-system -l component=kube-controller-manager --tail=100
```

Check leader election lease:

```bash
kubectl get lease -n kube-system kube-controller-manager -o jsonpath='{.spec.holderIdentity}'
```

Look for:
- `unable to sync` — controller cannot reconcile resources
- `rate limiter` — too many events, controller falling behind
- `error syncing` — specific resource reconciliation failures

### 6. Check scheduler

```bash
kubectl get pod -n kube-system -l component=kube-scheduler -o wide
```

```bash
kubectl logs -n kube-system -l component=kube-scheduler --tail=100
```

Check leader election:

```bash
kubectl get lease -n kube-system kube-scheduler -o jsonpath='{.spec.holderIdentity}'
```

Look for:
- `no nodes available to schedule` — all nodes are full or tainted
- `failed to schedule` — specific scheduling constraint failures
- Pending pod backlog — scheduler cannot keep up

Check for unschedulable pods cluster-wide:

```bash
kubectl get pods -A --field-selector status.phase=Pending -o wide
```

### 7. Match pattern and conclude

---

#### API server pod not running or crashlooping

The API server is the gateway to all cluster operations. If it's down:
- Static pod manifest may be invalid (kubeadm clusters: `/etc/kubernetes/manifests/`)
- Certificate expired
- etcd unreachable
- Insufficient memory on control plane node

Check the pod events and logs from step 3.

---

#### etcd disk space exceeded

etcd has a default 2GB storage limit. When exceeded, it rejects all write operations.

```bash
kubectl logs -n kube-system -l component=etcd --tail=50 | grep -i "space"
```

Indicators: `mvcc: database space exceeded`, cluster goes read-only. Advise the user to run etcd compaction and defragmentation.

---

#### Frequent etcd leader elections

If etcd logs show frequent `leader changed` messages, the etcd cluster is unstable.

Causes:
- Slow disk I/O on etcd nodes (etcd requires low-latency storage)
- Network instability between etcd members
- Resource contention on the etcd node

---

#### Controller-manager not reconciling

If deployments, replicasets, or other resources aren't being reconciled:
- Check if the controller-manager is running (step 5)
- Check leader election — if the holder identity doesn't match any running pod, the lease is stale
- Check logs for specific controller errors

---

#### Scheduler backlog — many Pending pods

If the scheduler is running but pods remain Pending:
- The scheduler may be overloaded (check CPU/memory)
- Scheduling constraints may be unsatisfiable (node affinity, taints, resource requests)
- Custom scheduler plugins may be misbehaving

Use `pod-pending-debug` for individual pod diagnosis.

---

#### Control plane component certificate expired

Control plane components communicate via TLS. Expired certificates cause connection failures.

```bash
kubectl get pod -n kube-system -l component=kube-apiserver -o jsonpath='{.items[0].metadata.name}'
```

Check API server certificate:

```bash
kubectl logs -n kube-system <apiserver-pod> --tail=50 | grep -iE "certificate|tls|x509"
```

For kubeadm clusters, certificate expiry can be checked via `kubeadm certs check-expiration` on the control plane node.

## Notes

- Managed Kubernetes (EKS, GKE, AKS) handles control plane health automatically — these checks are primarily for self-managed clusters.
- In HA setups (multiple control plane nodes), check that all instances are running and that leader election is stable.
- `kubectl get componentstatuses` is deprecated in newer K8s versions but may still work.
- etcd performance directly affects all cluster operations. Slow etcd = slow everything.
- Control plane pods in kubeadm clusters are static pods managed by kubelet — they don't have a Deployment or ReplicaSet.
