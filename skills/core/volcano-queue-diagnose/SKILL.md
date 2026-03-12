---
name: volcano-queue-diagnose
description: >-
  Diagnose Volcano Queue status and resource allocation.
  Check queue weights, deserved resources, allocated resources,
  and identify queue-related scheduling bottlenecks.
---

# Volcano Queue Diagnosis

Diagnose Volcano Queue status, resource allocation, and scheduling bottlenecks. This skill helps understand how resources are distributed across queues and why workloads may be pending due to queue constraints.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify queue configurations or delete queues.

**Not applicable to native ResourceQuota:** Volcano Queue and Kubernetes ResourceQuota are independent mechanisms. If the cluster does not use Volcano, use `quota-debug` instead. To check: `kubectl get queue 2>/dev/null` — if it returns an error or empty, Volcano is not installed.

## Usage

```bash
bash skills/core/volcano-queue-diagnose/scripts/diagnose-queue.sh [options]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--queue QUEUE` | no | Queue name to diagnose (default: all queues) |
| `--show-pods` | no | Show pods associated with each queue |
| `--verbose` | no | Show detailed resource breakdown |

## Examples

Diagnose all queues:
```bash
bash skills/core/volcano-queue-diagnose/scripts/diagnose-queue.sh
```

Diagnose specific queue:
```bash
bash skills/core/volcano-queue-diagnose/scripts/diagnose-queue.sh --queue training-queue
```

Show verbose output with pod information:
```bash
bash skills/core/volcano-queue-diagnose/scripts/diagnose-queue.sh --queue training-queue --show-pods --verbose
```

## Understanding Volcano Queues

### Queue Concept

In Volcano, a Queue is a cluster-level resource allocation unit. Jobs and PodGroups are submitted to queues, and the scheduler distributes resources among queues based on:

1. **Weight** - Relative share of cluster resources (proportional: weight 10 vs weight 2 = 83% vs 17%)
2. **Capability** - Maximum resources a queue can use (ceiling, not guarantee — actual allocation depends on cluster capacity and competition)
3. **Parent** - Hierarchical queue relationships (if enabled)

**Important:** A Queue is a **cluster-scoped** resource. PodGroups from **any namespace** can reference the same queue, so cross-namespace resource competition within a queue is expected.

### Queue Status Fields

| Field | Meaning |
|-------|---------|
| `state` | Queue state: Open, Closed, Closing |
| `deserved` | Resources the queue should receive based on weight |
| `allocated` | Resources currently allocated to jobs in this queue |
| `used` | Resources actually used by running pods (≤ allocated) |
| `pending` | Number of PodGroups waiting in the queue |
| `running` | Number of running PodGroups |

## Diagnostic Flow

### Step 1: List All Queues

Get an overview of all queues:

```bash
kubectl get queue
```

**Output columns:**
- NAME: Queue name
- WEIGHT: Queue weight (higher = more resources)
- STATE: Open, Closed, or Closing
- PARENT: Parent queue (for hierarchical queues)

### Step 2: Check Queue Details

Get detailed information about a specific queue:

```bash
kubectl get queue <queue-name> -o yaml
kubectl describe queue <queue-name>
```

**Key sections to examine:**

#### Spec (Configuration)
```yaml
spec:
  weight: 10              # Relative weight (default: 1)
  capability:             # Max resources allowed
    cpu: "100"
    memory: "200Gi"
  reclaimable: true       # Allow resource reclamation
```

#### Status (Runtime State)
```yaml
status:
  state: Open             # Open, Closed, or Closing
  pending: 5              # PodGroups waiting
  running: 10             # Running PodGroups
  deserved:               # Resources this queue should get
    cpu: "40"
    memory: "80Gi"
  allocated:              # Resources actually allocated
    cpu: "35"
    memory: "70Gi"
```

### Step 3: Check Queue Resource Utilization

Calculate utilization ratios:

```
Allocation Ratio = allocated / deserved
Utilization Ratio = used / allocated
```

**Interpretation:**
- `allocated >= deserved`: Queue is at or over its fair share
- `allocated < deserved`: Queue has room to grow
- `used << allocated`: Jobs have reserved resources but not using them

### Step 4: Identify PodGroups in Queue

Find workloads associated with a queue:

```bash
# Find all PodGroups in a queue
kubectl get podgroups --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.queue=="<queue-name>") | "\(.metadata.namespace)/\(.metadata.name)"'

# Check pending PodGroups
kubectl get podgroups --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.queue=="<queue-name>" and .status.phase=="Pending") | \
  "\(.metadata.namespace)/\(.metadata.name): \(.status.phase)"'
```

### Step 5: Check Queue Events

Look for queue-related events:

```bash
kubectl get events --all-namespaces --field-selector reason=FailedScheduling | grep -i queue
```

## Common Queue Issues

### Issue 1: Queue Resource Exhaustion

**Symptom:** `allocated >= deserved`, new PodGroups stay in Pending

**Check:**
```bash
kubectl get queue <queue> -o jsonpath='{"
  Deserved: "}{.status.deserved}{"
  Allocated: "}{.status.allocated}{"
  Ratio: "}{.status.allocated.cpu}{"/"}{.status.deserved.cpu}{"
"}'
```

For GPU-specific checks (GPU is often the bottleneck):
```bash
kubectl get queue -o custom-columns="NAME:.metadata.name,GPU_CAP:.spec.capability['nvidia.com/gpu'],GPU_ALLOC:.status.allocated['nvidia.com/gpu']"
```

**Also cross-validate capability against actual cluster capacity** — a common misconfiguration is setting `spec.capability` higher than the cluster's physical resources:
```bash
kubectl get nodes -o custom-columns="NAME:.metadata.name,GPU:.status.allocatable['nvidia.com/gpu'],CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory"
```
If the sum of all nodes' allocatable GPUs is less than the queue's `spec.capability`, the queue can never be fully utilized. When allocation reaches the cluster's physical limit, the queue appears to have remaining capacity but no more resources can actually be scheduled.

**Solution:**
- Increase queue weight (requires scheduler config change)
- Increase queue capability (only if cluster has physical capacity)
- Wait for other jobs to complete
- Check if other queues are over-allocated (reclaim may help)

### Issue 2: Queue is Closed

**Symptom:** `status.state: Closed`, new PodGroups rejected

**Check:**
```bash
kubectl get queue <queue> -o jsonpath='{.status.state}'
```

**Solution:**
- Queue must be reopened by admin
- Use a different queue

### Issue 3: Weight Imbalance

**Symptom:** One queue gets all resources, others starve

**Check:**
```bash
kubectl get queue -o custom-columns='NAME:.metadata.name,WEIGHT:.spec.weight,STATE:.status.state,CPU_DESERVED:.status.deserved.cpu,CPU_ALLOC:.status.allocated.cpu,MEM_DESERVED:.status.deserved.memory,MEM_ALLOC:.status.allocated.memory'
```

**Analysis:** Volcano distributes resources proportionally by weight. For example:
- Queue A (weight=10) + Queue B (weight=2): A gets 10/12 ≈ 83%, B gets 2/12 ≈ 17% of total cluster resources
- If Queue B has many pending jobs but low deserved resources, its weight is too low relative to others

**Solution:**
- Adjust queue weights proportionally
- Check if high-weight queues have capability limits preventing allocation

### Issue 4: Resource Reclaim Not Working

**Symptom:** Queue is over-allocated but reclaim is not triggered

**Check:**
```bash
# Check reclaim is enabled in scheduler config
kubectl get cm volcano-scheduler-configmap -n volcano-system -o yaml | grep reclaim
```

**Reclaim troubleshooting checklist (all must be true):**
1. `reclaim` action must be in scheduler actions
2. `proportion` plugin must be enabled
3. Source queue must be under-utilized (allocated < deserved)
4. Target queue must have over-allocated resources (allocated > deserved)
5. Target queue must have `reclaimable: true`

Check the reclaimable flag on the specific queue:
```bash
kubectl get queue <queue> -o jsonpath='{.spec.reclaimable}'
```
If `reclaimable` is `false` (or unset), the queue's resources **cannot be reclaimed** even if it's over-allocated.

**Solution:**
- Verify all 5 prerequisites above
- Check scheduler logs for reclaim attempts: use `volcano-scheduler-logs --keyword reclaim`

## Queue Hierarchy (Advanced)

If using hierarchical queues:

```bash
# Check parent-child relationships
kubectl get queue -o custom-columns='NAME:.metadata.name,PARENT:.spec.parent,WEIGHT:.spec.weight'
```

**Key points:**
- Child queues share parent's deserved resources
- Weight is relative to siblings, not absolute
- Parent queue's deserved = sum of children's usage

## Script Output Interpretation

The diagnose-queue.sh script provides:

1. **Queue Summary Table**
   - Name, State, Weight
   - Pending/Running counts
   - Resource allocation summary

2. **Resource Breakdown (with --verbose)**
   - CPU: deserved, allocated, usage ratio
   - Memory: deserved, allocated, usage ratio
   - GPU: if available

3. **Warning Flags**
   - `[OVER]` - Queue allocated > deserved
   - `[FULL]` - Queue at capacity
   - `[CLOSED]` - Queue not accepting new jobs
   - `[HIGH_PEND]` - Many pending PodGroups

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLCANO_NAMESPACE` | `default` | Default namespace for pod lookup |

## See Also

- `volcano-diagnose-pod` - Diagnose individual pod scheduling
- `volcano-gang-scheduling` - Gang constraint issues
- `volcano-resource-insufficient` - Resource shortage diagnosis
- `volcano-scheduler-logs` - Check scheduler decisions
- `quota-debug` - Native Kubernetes ResourceQuota/LimitRange diagnosis (non-Volcano)
