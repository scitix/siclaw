---
name: volcano-gang-scheduling
description: >-
  Gang Scheduling diagnostic guide for Volcano.
  Use when PodGroup cannot schedule completely, member Pods remain Pending,
  or minAvailable/minMember constraints are not satisfied.
---

# Gang Scheduling Diagnosis

This is a diagnostic guide for Gang scheduling issues in Volcano. Gang scheduling requires that all members of a PodGroup be scheduled simultaneously. If the cluster cannot satisfy the `minMember` requirement, none of the pods will be scheduled.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify PodGroups or resource configurations.

## When to Use This Guide

Use this skill when:
- PodGroup status is `Inqueue` but member Pods remain `Pending`
- Events contain `minMember` related errors
- Volcano Job has `minAvailable` or `minMember` that cannot be satisfied
- Some member Pods are running, others are Pending, and the entire group won't start
- You see `FailedScheduling` events mentioning Gang constraints

## Understanding Gang Scheduling

Gang scheduling in Volcano ensures that either all members of a workload are scheduled, or none are. This is crucial for distributed workloads like MPI, TensorFlow, PyTorch where partial scheduling is wasteful.

**Key Concepts:**
- `minMember` (in PodGroup spec): Minimum number of pods that must be scheduled simultaneously
- `minResources` (in PodGroup spec): Aggregate resource floor (e.g., total GPUs) that must be available — **both** `minMember` and `minResources` must be satisfied if set
- `minAvailable` (in Job spec): Similar concept at Job level
- The scheduler checks if there are **simultaneous** resources for all minMember pods before allocating

## Diagnostic Steps

### Step 1: Identify the PodGroup

Find the PodGroup associated with the pending pods:

```bash
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.metadata.annotations.scheduling.volcano.sh/pod-group}'
```

### Step 2: Check PodGroup Status

Get detailed PodGroup information:

```bash
kubectl get podgroup <podgroup-name> -n <namespace> -o yaml
```

**Key fields to examine:**

| Field | Meaning | What to Look For |
|-------|---------|------------------|
| `spec.minMember` | Minimum pods required | Is this number achievable? |
| `spec.minResources` | Aggregate resource floor | Is total cluster capacity sufficient? |
| `status.phase` | Current scheduling phase | Should be `Inqueue` for ready-to-schedule |
| `status.running` | Currently running pods | Compare to minMember |
| `status.pending` | Pending pods | These are waiting for Gang constraint |
| `spec.queue` | Queue name | Check if queue has sufficient resources |

**Common scenarios:**

- `status.phase: Pending` - PodGroup is waiting to be enqueued
- `status.phase: Inqueue` - Ready for scheduling but constraint not met
- `status.running < spec.minMember` - Gang constraint not satisfied

### Step 3: Calculate Resource Requirements

Calculate the total resources needed for the Gang:

```
Total CPU = minMember × single Pod CPU request
Total Memory = minMember × single Pod Memory request
Total GPU = minMember × single Pod GPU request (if applicable)
```

Get a pod's resource requests:

```bash
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].resources.requests}'
```

### Step 4: Check Cluster Resources

#### Option A: Check Node Resources

View available resources across nodes:

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory,GPU:.status.allocatable.nvidia\.com/gpu'
```

Check current resource usage:

```bash
kubectl top nodes
```

#### Option B: Check by Node Labels (if pods have node affinity)

If pods target specific nodes:

```bash
kubectl get nodes -l <label-key>=<label-value> -o wide
```

### Step 5: Check Events for Gang Errors

Look for Gang-specific scheduling errors:

```bash
kubectl get events -n <namespace> --field-selector involvedObject.name=<pod-name> --sort-by='.lastTimestamp'
```

**Common Gang-related event messages:**

| Message | Meaning | Investigation |
|---------|---------|---------------|
| `minMember not satisfied` | Gang constraint preventing scheduling | Check if total resources >= minMember requirements |
| `gang member not ready` | Some pods in the gang are not ready | Check individual pod status |
| `resource insufficient` | Not enough resources for all members | Use `volcano-resource-insufficient` skill |

### Step 6: Verify Queue Resources

If the PodGroup is in a Queue, check if the queue has sufficient deserved resources:

```bash
kubectl get queue <queue-name>
kubectl describe queue <queue-name>
```

Look for:
- `status.deserved` vs `status.allocated`
- If allocated >= deserved, the queue is at capacity
- Check `status.state` is `Open` (not `Closing` or `Closed`)

## Common Causes and Solutions

### Cause 1: minMember Too Large

**Symptom:** `minMember` is larger than the number of available nodes, or requires more resources than any single node can provide.

**Example:**
- minMember = 10
- Each pod requests 8 GPUs
- Only 5 nodes have 8 GPUs each
- **Result:** Gang can never be satisfied

**Solution:**
- Reduce `minMember` in PodGroup spec
- Increase cluster capacity (add nodes)
- Reduce per-pod resource requests

### Cause 2: Resource Fragmentation

**Symptom:** Total cluster resources are sufficient, but not concentrated on enough nodes to satisfy simultaneous scheduling.

**Example:**
- minMember = 4, each needs 4 CPUs
- Total cluster: 20 CPUs available
- But distributed across 10 nodes with 2 CPUs each
- **Result:** Cannot find 4 nodes with 4 CPUs simultaneously

**Solution:**
- Configure `binpack` plugin to concentrate pods on fewer nodes
- Defragment cluster by rescheduling or draining nodes
- Adjust resource requests to fit node sizes

### Cause 3: Priority Preemption

**Symptom:** Resources exist but are being used by lower-priority workloads that should be preempted.

**Check:**
- Compare PodGroup priority vs running PodGroups
- Check if higher priority exists in the same queue

**Solution:**
- Ensure correct PriorityClass is assigned
- Check `priority` plugin is enabled in scheduler config

### Cause 4: Queue Resource Exhaustion

**Symptom:** The PodGroup's queue has used all its deserved resources.

**Check:**
```bash
kubectl get queue <queue-name> -o jsonpath='{.status.allocated}'
kubectl get queue <queue-name> -o jsonpath='{.status.deserved}'
```

**Solution:**
- Increase queue weight or capability
- Wait for other jobs to complete
- Use `volcano-queue-diagnose` for detailed analysis

### Cause 5: Affinity/Anti-Affinity Conflicts (Effective Node Pool Narrowing)

**Symptom:** Queue shows available capacity, but Gang still blocks. Pod scheduling constraints narrow the effective node pool below what Gang requires.

**Diagnosis — compute the effective node pool:**
```bash
# 1. Check pod's nodeSelector
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.nodeSelector}'

# 2. Check matching nodes
kubectl get nodes -l <selector-key>=<selector-value> -o custom-columns="NAME:.metadata.name,CPU:.status.allocatable.cpu,GPU:.status.allocatable['nvidia.com/gpu']"

# 3. Check tolerations (tainted nodes require matching tolerations)
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.tolerations}'
kubectl get nodes -o custom-columns="NAME:.metadata.name,TAINTS:.spec.taints[*].key"
```

Volcano scheduling is **two-phase**: first queue-level admission (capacity check), then node-level placement. A job can pass the queue check but fail node placement if all matching nodes are occupied.

**Solution:**
- Relax affinity constraints if possible
- Ensure sufficient nodes match the constraints
- Verify toleration matches for tainted nodes

### Cause 6: Queue Has Capacity but Gang Still Blocks

**Symptom:** Queue `allocated < deserved`, PodGroup is `Inqueue`, but pods remain Pending.

**Check — verify remaining capacity vs Gang requirement:**
```bash
# Queue remaining capacity
kubectl get queue <queue> -o jsonpath='{"deserved: "}{.status.deserved}{"\nallocated: "}{.status.allocated}'

# PodGroup minMember and minResources
kubectl get podgroup <pg> -n <ns> -o jsonpath='{"minMember: "}{.spec.minMember}{"\nminResources: "}{.spec.minResources}'
```

Calculate: `remaining = deserved - allocated`. If `remaining < minMember × per-pod-resources`, the Gang cannot be satisfied even though the queue is not fully used.

If `minResources` is set, also verify: `remaining >= minResources` for each resource dimension.

**Solution:**
- Wait for enough resources to free up in the queue
- Reduce `minMember` or `minResources` if the job can tolerate partial scheduling

### Cause 7: Post-Scheduling Gang Breakage

**Symptom:** Job was Running, then moves to Aborted. Running pod count dropped below `minMember`.

This happens when pods are evicted (preemption, node failure, OOM) and the remaining count falls below the Gang constraint, causing the entire group to be torn down.

**Check:**
```bash
# Current running vs required
kubectl get podgroup <pg> -n <ns> -o jsonpath='{"running: "}{.status.running}{"\nminMember: "}{.spec.minMember}'

# Check for eviction/preemption events
kubectl get events -n <ns> --field-selector reason=Preempted
kubectl get events -n <ns> --field-selector reason=Evicted
```

**Solution:**
- Investigate why pods were evicted (resource pressure, preemption, node failure)
- Consider setting `reclaimable: false` on the queue to prevent preemption
- Increase cluster capacity to reduce eviction pressure

## Verification Steps

After identifying the issue, verify your analysis:

1. **Check if issue is Gang-specific:**
   - Try scheduling a single pod with same resources
   - If single pod schedules, it's a Gang constraint issue
   - If single pod doesn't schedule, it's a resource/affinity issue

2. **Calculate minimum requirements:**
   - Confirm minMember × per-pod-resources ≤ available resources
   - Confirm enough nodes can accommodate the pods

3. **Check scheduler logs:**
   ```bash
   # Use volcano-scheduler-logs skill
   bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --keyword gang
   ```

## Key Insight

Gang Scheduling constraint: **Must have enough resources to schedule minMember Pods simultaneously on different nodes.**

Even if total cluster resources are sufficient, if resources are released gradually over time (as other pods complete), the "simultaneous" requirement may not be met.

**Distinguish between:**
1. **Total shortage** - Entire cluster lacks resources
2. **Cannot satisfy simultaneously** - Resources exist but not on enough nodes at the same time
3. **Queue limit** - Queue deserved resources are exhausted

## See Also

- `volcano-diagnose-pod` - General Pod scheduling diagnosis
- `volcano-queue-diagnose` - Queue status and resource analysis
- `volcano-resource-insufficient` - Resource shortage diagnosis
- `volcano-scheduler-logs` - Scheduler log analysis
