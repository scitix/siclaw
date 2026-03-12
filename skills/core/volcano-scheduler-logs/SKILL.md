---
name: volcano-scheduler-logs
description: >-
  Retrieve and analyze Volcano scheduler logs.
  Filter by keyword, time range, or pod name to debug scheduling decisions.
---

# Volcano Scheduler Logs

Retrieve and analyze Volcano scheduler logs to understand scheduling decisions, failures, and performance issues.

**Scope:** This skill is for **diagnosis only**. It retrieves logs for analysis but does not modify any cluster state.

## Usage

```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh [options]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--keyword KEYWORD` | no | Filter logs by keyword (case-insensitive) |
| `--pod POD` | no | Filter logs related to specific pod name |
| `--since TIME` | no | Show logs newer than relative time (e.g., 10m, 1h) |
| `--lines N` | no | Number of lines to show (default: 100) |
| `--follow` | no | Stream logs in real-time (Ctrl+C to stop) |
| `--previous` | no | Show logs from previous container instance (after restart) |

## Examples

Get recent scheduler logs:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh
```

Search for error messages:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --keyword error
```

Get logs for a specific pod:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --pod my-job-0
```

Get last 500 lines from the past hour:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --since 1h --lines 500
```

Stream logs for gang scheduling issues:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --keyword gang --follow
```

Check logs from previous scheduler instance (after crash/restart):
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --previous --lines 200
```

## Common Keywords for Filtering

| Keyword | Use Case |
|---------|----------|
| `error` | Find error messages and failures |
| `FailedScheduling` | Scheduling failures |
| `allocate` | Resource allocation attempts |
| `gang` | Gang scheduling decisions |
| `minMember` | MinMember constraint issues |
| `preempt` | Preemption events |
| `reclaim` | Resource reclamation |
| `enqueue` | Queue admission decisions |
| `bind` | Pod binding attempts |
| `queue` | Queue-related decisions |
| `proportion` | Proportion plugin decisions |
| `priority` | Priority-related decisions |

## Understanding Scheduler Logs

### Log Format

Volcano scheduler logs typically follow this format:
```
I0102 15:04:05.123456       1 scheduler.go:123] Starting scheduling session
I0102 15:04:05.234567       1 allocate.go:456] Try to allocate resources for Job <namespace>/<job-name>
E0102 15:04:05.345678       1 gang.go:789] Failed to schedule pod <pod-name>: minMember not satisfied
```

**Log levels:**
- `I` - Info: Normal operation information
- `W` - Warning: Unusual but non-fatal conditions
- `E` - Error: Failures and errors
- `F` - Fatal: Critical errors causing shutdown

### Common Log Patterns

#### Session Start
```
Starting scheduling session
Starting scheduling loop
```
- Indicates scheduler is processing a new batch of pending pods

#### Enqueue Decisions
```
Try to enqueue pod group
PodGroup <name> is enqueued
PodGroup <name> is pending
```
- Shows whether pod groups are admitted to the queue

#### Allocation Attempts
```
Try to allocate resources for Job
Try to allocate for task
```
- Shows scheduling attempts for specific jobs/pods

#### Gang Scheduling
```
minMember not satisfied
gang member not ready
Waiting for gang members
```
- Indicates Gang constraint preventing scheduling

#### Resource Shortage
```
Insufficient cpu
Insufficient memory
0 nodes are available
```
- Indicates resource constraint preventing scheduling

#### Preemption
```
Preempting pods
Found victim pods
```
- Shows preemption decisions for high-priority workloads

#### Reclaim
```
Try to reclaim resources
Reclaiming resources from queue
```
- Shows resource reclamation between queues

## Diagnostic Use Cases

### Case 1: Pod Stuck in Pending

Find relevant scheduler decisions:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --pod <pod-name> --since 30m
```

Look for:
- `FailedScheduling` events
- `minMember not satisfied`
- `Insufficient` resource messages
- `enqueue` decisions (is the PodGroup being admitted?)

### Case 2: Gang Scheduling Issues

Check Gang plugin behavior:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --keyword gang --since 1h
```

Look for:
- `minMember` related messages
- Gang constraint validation
- Comparison of running vs required members

### Case 3: Queue Resource Issues

Check proportion and reclaim decisions:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --keyword "reclaim\|proportion" --since 30m
```

Look for:
- Queue resource calculations
- Reclaim triggers
- Over-commit handling

### Case 4: Scheduler Performance

Check for scheduling delays:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --lines 500 | grep -E "(Starting|Finished) scheduling"
```

Look for:
- Long gaps between "Starting" and "Finished"
- High frequency of scheduling loops
- Errors causing retries

### Case 5: Preemption Analysis

Check preemption decisions:
```bash
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --keyword preempt --since 1h
```

Look for:
- Which pods are being preempted
- Priority comparisons
- Preemption success/failure

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLCANO_SCHEDULER_NS` | `volcano-system` | Scheduler namespace |
| `VOLCANO_SCHEDULER_LABEL` | `app=volcano-scheduler` | Label selector for scheduler pods |

## Limitations

1. **Log retention:** Logs may be rotated based on cluster configuration
2. **Multi-scheduler:** If running multiple schedulers, logs will be interleaved
3. **Log level:** Default log level may not show all debug information
4. **Previous logs:** `--previous` only works if the container has restarted

## Tips for Effective Log Analysis

1. **Use time ranges:** Narrow down with `--since` to focus on recent issues
2. **Combine keywords:** Search for `error\|Failed\|failed` to catch all failures
3. **Check pod context:** Always include `--pod` when investigating specific pods
4. **Look for patterns:** Repeating errors may indicate systemic issues
5. **Correlate with events:** Compare with `kubectl get events` timestamps

## See Also

- `volcano-diagnose-pod` - Diagnose individual pod issues
- `volcano-gang-scheduling` - Gang scheduling specific diagnosis
- `volcano-queue-diagnose` - Queue resource analysis
- `volcano-resource-insufficient` - Resource shortage diagnosis
