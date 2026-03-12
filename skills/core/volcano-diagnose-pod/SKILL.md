---
name: volcano-diagnose-pod
description: >-
  Diagnose Volcano-managed Pod scheduling issues.
  Checks Pod status, PodGroup, events, and Queue to identify scheduling failures.
---

# Volcano Pod Diagnosis

Diagnose Volcano-managed Pod scheduling issues. This skill checks Pod status, associated PodGroup, scheduling events, and Queue configuration to identify why a Pod cannot be scheduled.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify pod specs, PodGroups, or Queues — that should be left to the user.

## Usage

```bash
bash skills/core/volcano-diagnose-pod/scripts/diagnose-pod.sh --pod <pod-name> --namespace <namespace>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--pod POD` | yes | Pod name to diagnose |
| `--namespace NS` | no | Namespace (default: `default`) |
| `--verbose` | no | Show detailed output including node resources |

## Examples

Diagnose a pending pod in default namespace:
```bash
bash skills/core/volcano-diagnose-pod/scripts/diagnose-pod.sh --pod my-job-0
```

Diagnose a pod in specific namespace:
```bash
bash skills/core/volcano-diagnose-pod/scripts/diagnose-pod.sh --pod my-job-0 --namespace training
```

Verbose mode with node resource information:
```bash
bash skills/core/volcano-diagnose-pod/scripts/diagnose-pod.sh --pod my-job-0 --namespace training --verbose
```

## Diagnostic Flow

The script performs the following checks in order:

### 1. Pod Status
Check the Pod's current phase and conditions.

```bash
kubectl get pod <pod> -n <ns> -o wide
kubectl describe pod <pod> -n <ns>
```

### 2. PodGroup Status
Check if the Pod is associated with a PodGroup and its scheduling status.

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.metadata.annotations.scheduling.volcano.sh/pod-group}'
kubectl get podgroup <podgroup> -n <ns>
```

Key fields to check:
- `spec.minMember`: Minimum members required for Gang scheduling
- `status.phase`: Pending, Inqueue, Running, Unknown
- `status.running`: Number of running pods
- `status.pending`: Number of pending pods

### 3. Events Analysis
Check scheduling events for failure reasons.

```bash
kubectl get events -n <ns> --field-selector involvedObject.name=<pod> --sort-by='.lastTimestamp'
```

Look for these event patterns:

#### `FailedScheduling` - General scheduling failure
The scheduler attempted but failed to schedule the pod. Check the message for specific reasons.

**Volcano-specific sub-patterns:**

| Event Message | Meaning | Next Step |
|---------------|---------|-----------|
| `0/N nodes are available` + `minMember` | Gang constraint not satisfied | Use `volcano-gang-scheduling` |
| `exceeded quota` / `queue resource exceeded` | Queue deserved resources exhausted | Use `volcano-queue-diagnose` |
| `Insufficient cpu/memory` + Gang mention | Resource shortage blocking Gang | Use `volcano-resource-insufficient` |
| `pod group is not ready` | PodGroup not in Inqueue phase | Check PodGroup status |
| `task <name> is not ready` | Task dependencies not met | Check dependent tasks |

> **Quick Reference vs Detailed Analysis:** The table above provides a quick lookup for common patterns. The sections below provide detailed analysis, additional context, and more diagnostic commands for each pattern.

#### `Insufficient cpu` / `Insufficient memory` - Resource shortage
No node has enough allocatable resources. Check:
- Node resources: `kubectl top nodes`
- Pod resource requests: `kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[*].resources.requests}'`

**Volcano context:** If this is a Gang-scheduled pod, even if total cluster resources are sufficient, you need enough resources **simultaneously** on enough nodes. Use `volcano-resource-insufficient` to check fragmentation.

#### `minMember` not satisfied - Gang constraint
The PodGroup requires `minMember` pods to be scheduled simultaneously, but the cluster cannot satisfy this. Use `volcano-gang-scheduling` skill for detailed diagnosis.

**Key insight:** Even if `kubectl top nodes` shows enough total resources, Gang requires **simultaneous** availability on **different nodes**.

#### `queue resource exceeded` - Queue quota limit
The Queue associated with this Pod has exceeded its deserved resources. Check Queue status with `volcano-queue-diagnose` skill.

**Volcano-specific terms you might see:**
- `overused` - Queue has exceeded its fair share
- `deserved resources` - Calculated from queue weight proportion
- `allocated resources` - Currently used by jobs in this queue

#### `reclaim` events - Resource reclamation triggered
If you see events mentioning `reclaim`:
- Another queue is trying to reclaim resources from your pod's queue
- Your queue may be `over-allocated` (allocated > deserved)
- Check queue status: `volcano-queue-diagnose --queue <queue>`

#### `preempt` events - Priority preemption
Higher priority workload is evicting this pod. Check:
- Pod priority class: `kubectl get pod <pod> -o jsonpath='{.spec.priorityClassName}'`
- Preemptor details in scheduler logs: `volcano-scheduler-logs --keyword preempt`

#### `enqueue` related events
- `PodGroup is enqueued` - PodGroup admitted to queue, ready for scheduling
- `PodGroup is pending` - Waiting for queue admission (capacity or resource check)
- `enqueue failed` - Failed admission check (overcommit, queue closed, etc.)

### 4. Queue Status
Check the Queue configuration and resource allocation.

```bash
kubectl get podgroup <podgroup> -n <ns> -o jsonpath='{.spec.queue}'
kubectl get queue <queue>
kubectl describe queue <queue>
```

Key fields:
- `spec.weight`: Queue weight for resource sharing
- `spec.capability`: Maximum resources the queue can use
- `status.state`: Open, Closed, or Closing
- `status.deserved`: Resources deserved by this queue
- `status.allocated`: Resources currently allocated

### 5. Node Resources (verbose mode)
When `--verbose` is specified, also check node allocatable resources.

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory'
```

## Common Issues and Solutions

### Pod stuck in Pending, no events
- Check if Volcano scheduler is running: `kubectl get pods -n volcano-system -l app=volcano-scheduler`
- Check if Volcano controller-manager is running: `kubectl get pods -n volcano-system -l app=volcano-controller-manager`
  - The controller-manager is responsible for Job lifecycle, PodGroup creation, and queue management — if it's down, jobs won't transition states even if the scheduler is healthy
- Check scheduler logs: `volcano-scheduler-logs` skill

### PodGroup phase is Pending
- The PodGroup is waiting for enqueue action to admit it
- **Verify the queue actually exists** — a typo in queue name causes the PodGroup to stay Pending silently:
  ```bash
  kubectl get podgroup <pg> -n <ns> -o jsonpath='{.spec.queue}'
  kubectl get queue <queue-name>
  ```
  If the queue name is empty, the job uses the `default` queue — verify it exists and is Open
- Check Queue capacity and deserved resources
- Check if cluster has sufficient resources

### PodGroup phase is Inqueue but Pod is Pending
- Check if `minMember` constraint is not satisfied
- Check if there are affinity/anti-affinity conflicts
- Check if taints prevent scheduling

### Queue status shows insufficient deserved resources
- The queue may have insufficient weight or capability configured
- Other queues may be reclaiming resources
- Use `volcano-queue-diagnose` for detailed analysis

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLCANO_NAMESPACE` | `default` | Default namespace for Pod lookup |
| `VOLCANO_SCHEDULER_NS` | `volcano-system` | Namespace where volcano scheduler runs |

## See Also

- `volcano-gang-scheduling` - Detailed Gang scheduling diagnosis
- `volcano-queue-diagnose` - Queue status and quota analysis
- `volcano-scheduler-logs` - Scheduler log analysis
- `volcano-resource-insufficient` - Resource shortage diagnosis
