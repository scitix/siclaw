---
name: quota-debug
description: >-
  Diagnose Kubernetes native ResourceQuota and LimitRange admission rejections (exceeded quota, forbidden by LimitRange, FailedCreate).
  Checks namespace quotas, current usage, LimitRange constraints, and ReplicaSet events to identify why pods cannot be created.
  Not applicable to Volcano Queue — use volcano-queue-debug for gang scheduling clusters.
---

# ResourceQuota & LimitRange Admission Diagnosis

When pods fail to be created due to Kubernetes native namespace-level resource constraints — ResourceQuota exceeded or LimitRange violations — follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify ResourceQuota, LimitRange, or pod specs — that should be left to the user or cluster administrator.

**When to use:** Pods are not being created at all (not Pending, not CrashLoopBackOff — simply missing). Typical trigger: a ReplicaSet or Job shows `FailedCreate` events mentioning `exceeded quota` or `forbidden: ... LimitRange`.

**Not applicable to Volcano Queue:** If the cluster uses Volcano for gang scheduling, resource quotas are managed by Volcano Queue, not Kubernetes native ResourceQuota. Use the `volcano-queue-debug` skill instead. To check:

```bash
kubectl get queue 2>/dev/null
```

If this command returns results (Queue resources listed), the cluster uses Volcano — use `volcano-queue-debug`. If it returns nothing or an error, Volcano is not installed — continue with this skill.

## Diagnostic Flow

### 1. Identify the creation failure

If the user reports a Deployment not progressing or pods not appearing, first find the controller that owns the pods:

```bash
kubectl get rs -n <ns> --sort-by='.metadata.creationTimestamp' | grep <deployment-name>
```

Then check the ReplicaSet events for creation failures:

```bash
kubectl describe rs <new-rs> -n <ns>
```

Look for events with reason `FailedCreate`. The event message reveals whether it is a ResourceQuota or LimitRange rejection.

If the user already has a specific error message, skip to step 2.

### 2. Match the rejection type

---

#### `exceeded quota` — ResourceQuota exhausted

The namespace has a ResourceQuota and creating the pod would exceed the allowed limits.

Check current quota usage:

```bash
kubectl get resourcequota -n <ns>
```

For detailed usage breakdown:

```bash
kubectl describe resourcequota -n <ns>
```

Compare the `Used` vs `Hard` columns. Common quota dimensions:
- **requests.cpu / requests.memory** — total CPU/memory requests across all pods in the namespace
- **limits.cpu / limits.memory** — total CPU/memory limits
- **pods** — maximum number of pods allowed in the namespace
- **count/deployments.apps, count/services** — object count limits
- **requests.nvidia.com/gpu** — total GPU requests (common in GPU-scheduled clusters)
- **requests.storage** — total PVC storage requested
- **persistentvolumeclaims** — number of PVCs

Then check what the pod is requesting:

```bash
kubectl get pod -n <ns> -l app=<name> -o jsonpath='{range .items[0].spec.containers[*]}{.name}{"\t"}{.resources}{"\n"}{end}' 2>/dev/null
```

If no pods exist yet (all creation failed), check the Deployment or template spec:

```bash
kubectl get deployment <name> -n <ns> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\t"}{.resources}{"\n"}{end}'
```

**Root cause analysis:**
- If `Used` is near `Hard` for cpu/memory: existing pods are consuming most of the quota — need to scale down other workloads or increase quota
- If `pods` count is at the limit: too many pods in namespace — clean up or increase quota
- If the pod's resource requests are very large: consider reducing requests to fit within remaining quota

---

#### `forbidden: ... minimum cpu/memory` — LimitRange minimum violation

The pod's container does not meet the minimum resource request required by the namespace's LimitRange.

```bash
kubectl get limitrange -n <ns>
```

```bash
kubectl describe limitrange -n <ns>
```

Check the `Min` column for Container type. If a container does not specify resource requests, or its requests are below the minimum, admission will be rejected.

Compare with the pod's resource spec. If the container has no resource requests at all, the LimitRange default will be applied — but if the LimitRange has `min` without `default`, admission fails.

---

#### `forbidden: ... maximum cpu/memory` — LimitRange maximum violation

The pod's container exceeds the maximum resource limit allowed by the LimitRange.

Check LimitRange as above and compare the `Max` column with the container's resource requests/limits.

---

#### `forbidden: ... maxLimitRequestRatio` — LimitRange ratio violation

The ratio between the container's resource limit and request exceeds the allowed ratio (e.g., limit is 10x the request, but ratio cap is 3x).

```bash
kubectl describe limitrange -n <ns>
```

Check the `Max Limit/Request Ratio` column. Then compare the pod's limits vs requests:

```bash
kubectl get deployment <name> -n <ns> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\t requests:"}{.resources.requests}{"\t limits:"}{.resources.limits}{"\n"}{end}'
```

---

#### `forbidden: ... no resources specified` — Missing required resources

The LimitRange requires resource specifications, but the container has none and no defaults are configured.

Check if the LimitRange has `Default` and `DefaultRequest` values:

```bash
kubectl describe limitrange -n <ns>
```

If `Default` and `DefaultRequest` are empty but `Min` or `Max` are set, containers MUST explicitly specify resources.

---

#### Pod type LimitRange — min/max per pod

LimitRange can also enforce constraints at the Pod level (sum of all containers). Check if the LimitRange has a `Pod` type entry:

```bash
kubectl get limitrange -n <ns> -o jsonpath='{range .items[*].spec.limits[*]}{.type}{"\t min:"}{.min}{"\t max:"}{.max}{"\n"}{end}'
```

If the sum of all container resources exceeds the Pod-level max, admission is rejected.

---

#### `exceeded quota` for storage — PVC quota exhausted

If the error mentions `requests.storage` or `persistentvolumeclaims`:

```bash
kubectl describe resourcequota -n <ns>
```

Check the storage-related rows. Also check if there are per-StorageClass quotas:

```bash
kubectl get resourcequota -n <ns> -o yaml
```

Look for keys like `<storageclass>.storageclass.storage.k8s.io/requests.storage`.

### 3. Check for multiple constraints

A namespace can have multiple ResourceQuotas and LimitRanges. Always check for all of them:

```bash
kubectl get resourcequota,limitrange -n <ns>
```

All ResourceQuotas must be satisfied (intersection). The most restrictive LimitRange applies.

### 4. Verify scoped quotas

ResourceQuotas can be scoped to specific priority classes or pod phases:

```bash
kubectl get resourcequota -n <ns> -o yaml
```

Look for `spec.scopes` or `spec.scopeSelector`. A scoped quota only applies to pods matching the scope (e.g., `PriorityClass=high`). If the user's pod has a specific priority class, it may hit a scoped quota while the general quota still has capacity.

## Notes

- ResourceQuota admission happens **before scheduling**. A pod rejected by quota will never appear in `kubectl get pods` — look at the controller (ReplicaSet, Job) events instead.
- When a namespace has a ResourceQuota for compute resources (cpu/memory), **every container must specify requests/limits** for those resources, otherwise admission is rejected. This catches users who are used to running without resource specs.
- LimitRange can automatically inject default requests/limits into containers that don't specify them. Check if defaults are configured before telling users to add explicit resource specs.
- For cross-reference: if the pod IS created but stuck in Pending, use the `pod-pending-debug` skill instead — that covers scheduling failures (node resources, taints, affinity).
- `kubectl top pods -n <ns>` shows actual resource usage, while quota tracks **requested** resources. A namespace can hit quota limits even if actual usage is low. Note: `kubectl top` requires metrics-server to be installed — if it returns an error, skip it and rely on quota `Used` values instead.
