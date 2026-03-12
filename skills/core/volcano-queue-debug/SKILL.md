---
name: volcano-queue-debug
description: >-
  Diagnose Volcano Queue and PodGroup scheduling failures in gang scheduling clusters.
  Checks Queue capacity, PodGroup status, minMember/minResources, weight-based sharing, reclaim/preemption,
  and cross-validates queue capability against actual cluster resources.
  Not applicable to native Kubernetes ResourceQuota — use quota-debug instead.
---

# Volcano Queue & PodGroup Scheduling Diagnosis

When batch jobs or gang-scheduled workloads are stuck waiting for resources, running unexpectedly terminated, or failing in a Volcano-managed cluster, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify Queue capability, weights, or job specs — that should be left to the user or cluster administrator.

**When to use:** Jobs submitted to Volcano are not running (PodGroup stuck in `Pending` or `Inqueue`), jobs were unexpectedly killed (Preempted/Aborted), or pods are not being created despite the job being submitted. This skill applies only to clusters using Volcano scheduler (`volcano.sh`).

**Not applicable to native ResourceQuota:** If the cluster does not use Volcano and relies on Kubernetes native ResourceQuota/LimitRange for admission control, use the `quota-debug` skill instead. Volcano Queue and Kubernetes ResourceQuota are completely independent resource control mechanisms. To check:

```bash
kubectl get queue 2>/dev/null
```

If this returns an error or empty result, Volcano is not installed — use `quota-debug`.

## Diagnostic Flow

### 1. Check Queue status

```bash
kubectl get queue
```

```bash
kubectl describe queue <queue-name>
```

Key fields:
- **spec.capability** — the resource ceiling for this queue (cpu, memory, GPU, etc.)
- **spec.weight** — relative priority for inter-queue resource sharing
- **status.allocated** — resources currently consumed by running jobs in this queue
- **status.state** — `Open` (accepting jobs) or `Closed` (rejecting new jobs)

If Queue state is `Closed`, no new jobs will be admitted. Check why it was closed before proceeding.

### 2. Check PodGroup status

```bash
kubectl get podgroup -n <ns>
```

```bash
kubectl describe podgroup <podgroup-name> -n <ns>
```

PodGroup status indicates where the job is stuck:
- **Pending** — not yet admitted to any queue, or queue is closed
- **Inqueue** — admitted to the queue but waiting for resources to become available
- **Running** — resources allocated, pods should be running

Also check both gang scheduling constraint fields:

```bash
kubectl get podgroup <podgroup-name> -n <ns> -o jsonpath='minMember={.spec.minMember} minResources={.spec.minResources}'
```

- **minMember** — minimum number of pods that must be scheduled together
- **minResources** — minimum total resources required before the gang can start (e.g., `nvidia.com/gpu: 32` means 32 GPUs must be available simultaneously)

Both constraints must be satisfied. `minMember` controls pod count, `minResources` controls aggregate resource quantity. A training job may set `minMember: 4` (4 worker pods) with `minResources: {nvidia.com/gpu: 32}` (8 GPUs per worker).

If the PodGroup has events, check them for specific error messages.

### 3. Match the failure pattern

---

#### PodGroup `Pending`, Queue `Closed` — Queue not accepting jobs

The queue is closed and will not admit new PodGroups.

Check the queue state and any annotations or conditions indicating why it was closed. A queue may be closed administratively or due to policy.

---

#### PodGroup `Inqueue`, Queue `Allocated` approaching `Capability` — Queue resource ceiling reached

The queue has admitted the job but cannot schedule it because the queue's resource ceiling has been reached.

```bash
kubectl get queue -o custom-columns='NAME:.metadata.name,CAPABILITY:.spec.capability,ALLOCATED:.status.allocated'
```

For GPU-specific checks (GPU is often the bottleneck in Volcano clusters):

```bash
kubectl get queue -o custom-columns='NAME:.metadata.name,GPU_CAP:.spec.capability.nvidia\.com/gpu,GPU_ALLOC:.status.allocated.nvidia\.com/gpu'
```

Compare `Allocated` vs `Capability` for each resource dimension (cpu, memory, GPU). If any dimension is at or near the ceiling, the queue cannot allocate more resources.

**Also verify queue capability against actual cluster capacity** — a common misconfiguration is setting queue capability higher than the cluster's physical resources:

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory'
```

If the sum of all nodes' allocatable GPUs is less than the queue's `spec.capability.nvidia.com/gpu`, the queue can never be fully utilized. When `Allocated` reaches the cluster's physical limit, the queue will appear to have remaining capacity but no more resources can actually be scheduled.

**Resolution options:**
- Wait for other jobs in the queue to complete and release resources
- Increase the queue's `spec.capability` (only if cluster has physical capacity)
- Adjust queue capability to match actual cluster resources to avoid misleading capacity display
- Move the job to a different queue with available capacity

---

#### PodGroup `Inqueue`, Queue has spare capacity — Gang constraints not satisfiable

The queue has available resources, but not enough to satisfy the gang scheduling constraints.

**Check minMember:**

```bash
kubectl get podgroup <podgroup-name> -n <ns> -o jsonpath='{.spec.minMember}'
```

**Check minResources:**

```bash
kubectl get podgroup <podgroup-name> -n <ns> -o jsonpath='{.spec.minResources}'
```

Check what each pod requests:

```bash
kubectl get vcjob <job-name> -n <ns> -o yaml 2>/dev/null || kubectl get job.batch.volcano.sh <job-name> -n <ns> -o yaml
```

**Example (minMember):** Queue has 4 free GPUs, but the PodGroup requires `minMember: 8` pods each requesting 1 GPU. Gang scheduling requires all 8 pods to be placed simultaneously, so 4 GPUs is insufficient even though individually each pod could fit.

**Example (minResources):** Queue has 16 free GPUs, but the PodGroup requires `minResources: {nvidia.com/gpu: 32}`. Even though individual pods might fit, the total GPU requirement is not met.

**Check for node-level constraints narrowing available resources:**

If the queue appears to have enough capacity but the job is still stuck in `Inqueue`, the job may have `nodeSelector`, `tolerations`, or `affinity` rules that restrict which nodes it can run on:

```bash
kubectl get vcjob <job-name> -n <ns> -o jsonpath='{.spec.tasks[*].template.spec.nodeSelector}' 2>/dev/null
kubectl get vcjob <job-name> -n <ns> -o jsonpath='{.spec.tasks[*].template.spec.tolerations}' 2>/dev/null
```

Then check if the matching nodes actually have available resources:

```bash
kubectl get nodes -l <label-key>=<label-value> -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
kubectl top nodes -l <label-key>=<label-value>
```

Volcano checks queue capacity first, then does node-level scheduling. A job can pass the queue check but fail node placement if all matching nodes are occupied. This is one of the most hidden causes of "queue has capacity but job won't schedule."

**Resolution options:**
- Reduce `minMember` or `minResources` if the job can tolerate partial scheduling
- Wait for enough resources to free up to satisfy the full gang
- Relax `nodeSelector`/affinity constraints if the job can run on other node types
- Increase queue capability (only if cluster has physical capacity on matching nodes)

---

#### PodGroup `Pending`, no matching Queue — Queue not found or misconfigured

The job references a queue that does not exist or the job's queue annotation is missing.

```bash
kubectl get vcjob <job-name> -n <ns> -o jsonpath='{.spec.queue}' 2>/dev/null || kubectl get job.batch.volcano.sh <job-name> -n <ns> -o jsonpath='{.spec.queue}'
```

Verify this queue exists:

```bash
kubectl get queue <queue-name>
```

If the queue name is empty, the job will use the `default` queue. Check if a `default` queue exists.

---

#### Multiple queues competing — Low-weight queue starved

When multiple queues compete for shared cluster resources, Volcano distributes resources proportionally by weight.

```bash
kubectl get queue -o custom-columns='NAME:.metadata.name,WEIGHT:.spec.weight,CAPABILITY:.spec.capability,ALLOCATED:.status.allocated'
```

A queue with low weight may receive fewer resources when the cluster is under contention. Check if higher-weight queues are consuming a disproportionate share.

---

#### Job `Aborted` or `Failed` — Post-scheduling failure

If the job was scheduled but then moved to `Aborted` or `Failed` status:

```bash
kubectl get vcjob <job-name> -n <ns> -o jsonpath='{.status.state.phase}' 2>/dev/null || kubectl get job.batch.volcano.sh <job-name> -n <ns> -o jsonpath='{.status.state.phase}'
```

Check job conditions and events for the reason:

```bash
kubectl describe vcjob <job-name> -n <ns> 2>/dev/null || kubectl describe job.batch.volcano.sh <job-name> -n <ns>
```

Common causes:
- **Aborted due to preemption** — a higher-priority job or queue reclaimed resources (see step 4)
- **Pod failure exceeding maxRetry** — individual pods crashed too many times
- **Lifecycle policy triggered** — job's `failedTaskCount` or other policy conditions were met
- **minMember no longer satisfiable** — some pods were evicted and the remaining count dropped below `minMember`, causing the entire gang to be torn down

Check the pods that belong to this job for their termination reason:

```bash
kubectl get pods -n <ns> -l volcano.sh/job-name=<job-name> --sort-by='.metadata.creationTimestamp'
kubectl describe pod <failed-pod> -n <ns>
```

### 4. Check reclaim and preemption

```bash
kubectl get queue -o custom-columns='NAME:.metadata.name,WEIGHT:.spec.weight,RECLAIMABLE:.spec.reclaimable,ALLOCATED:.status.allocated'
```

- **reclaimable: true** — Volcano can preempt jobs from this queue when higher-weight queues need resources. Jobs in reclaimable queues may be evicted.
- **reclaimable: false** — Once resources are allocated to this queue, they cannot be taken back. This can cause resource hoarding if the queue is underutilizing its allocation.

If the user's queue is low-weight and non-reclaimable queues are holding resources they don't actively need, resources may be locked up.

**If a job was unexpectedly killed (user reports "my job was suddenly terminated"):**

Check for preemption events:

```bash
kubectl get events -n <ns> --field-selector reason=Preempted
```

Check the job's status conditions for preemption or eviction reasons:

```bash
kubectl describe vcjob <job-name> -n <ns> 2>/dev/null || kubectl describe job.batch.volcano.sh <job-name> -n <ns>
```

Look for `Preempted`, `Evicted`, or `Aborted` conditions. Cross-reference with which queue triggered the preemption by checking which higher-weight queue's `Allocated` increased around the same time.

### 5. Check Volcano component health

If all configuration looks correct but jobs are still not being scheduled or pods are not being created:

**Check scheduler:**

```bash
kubectl get pods -n volcano-system -l app=volcano-scheduler
kubectl logs -n volcano-system -l app=volcano-scheduler --tail=100
```

**Check controller-manager** (responsible for creating pods after scheduling decisions):

```bash
kubectl get pods -n volcano-system -l app=volcano-controllers
kubectl logs -n volcano-system -l app=volcano-controllers --tail=100
```

The scheduler makes scheduling decisions, but the controller-manager is responsible for actually creating pods. If the scheduler is healthy but the controller-manager is down, scheduling decisions are made but pods will not be created.

Common issues:
- Scheduler or controller-manager pod not running or in CrashLoopBackOff
- Plugin configuration errors
- Cluster resource discovery failures
- Leader election issues (if running multiple replicas)

## Notes

- Volcano Queue manages resources at the **queue level**, not the namespace level. A single queue can span multiple namespaces, and a namespace can have jobs in different queues.
- Gang scheduling has two constraint fields: `minMember` (pod count) and `minResources` (aggregate resources). Both must be satisfied. `minMember` is more common for distributed training, `minResources` is used when total resource quantity matters more than pod count.
- Queue `spec.capability` is a configuration upper bound, not a guarantee of physical resources. Always cross-validate against actual cluster allocatable resources to avoid phantom capacity.
- Volcano Jobs may be registered as `vcjob` or `job.batch.volcano.sh` depending on the deployment. Always try both: `kubectl get vcjob` first, fallback to `kubectl get job.batch.volcano.sh`. Regular `kubectl get jobs` (batch/v1) will not show Volcano-managed workloads.
- Volcano scheduling is a two-phase process: first queue-level admission (capacity check), then node-level placement. A job can pass queue admission but fail node placement due to `nodeSelector`, taints, or affinity constraints — this manifests as PodGroup stuck in `Inqueue` with queue capacity available.
- For cross-reference: if pods ARE created but stuck in Pending, the issue may be at the Kubernetes scheduler level (node resources, taints, affinity) — use `pod-pending-debug`.
- Volcano Queue and Kubernetes ResourceQuota are independent. If the namespace also has a ResourceQuota, pods may pass Volcano scheduling but still be rejected by Kubernetes admission — use `quota-debug` for that layer.
