---
name: volcano-job-diagnose
description: >-
  Diagnose Volcano Job status and issues.
  Check Job phases, task statuses, PodGroup associations, and overall job health.
---

# Volcano Job Diagnosis

Diagnose Volcano Job (batch.volcano.sh/v1beta1) status and issues. This skill checks Job phases, task statuses, PodGroup associations, and overall job health.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify job specs or restart jobs — that should be left to the user.

## Usage

```bash
bash skills/core/volcano-job-diagnose/scripts/diagnose-job.sh --job <job-name> --namespace <namespace>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--job JOB` | yes | Job name to diagnose |
| `--namespace NS` | no | Namespace (default: `default`) |
| `--verbose` | no | Show detailed task and pod information |

## Examples

Diagnose a Volcano Job:
```bash
bash skills/core/volcano-job-diagnose/scripts/diagnose-job.sh --job my-training-job --namespace training
```

Verbose mode with task details:
```bash
bash skills/core/volcano-job-diagnose/scripts/diagnose-job.sh --job my-training-job --namespace training --verbose
```

## Understanding Volcano Jobs

### Job Structure

```yaml
apiVersion: batch.volcano.sh/v1beta1
kind: Job
spec:
  schedulerName: volcano
  tasks:
    - name: worker
      replicas: 4
      template:
        spec:
          containers:
            - name: worker
              resources:
                requests:
                  cpu: "4"
                  memory: "8Gi"
  maxRetry: 3              # Max retries before job is Aborted
  policies:
    - event: PodFailed
      action: RestartJob
```

> **Note:** Volcano Jobs can also be queried using the short name `vcjob` (e.g., `kubectl get vcjob`). This is an alias for `job.batch.volcano.sh`. Be careful not to confuse with native Kubernetes `batch/v1 Job` — always use `job.batch.volcano.sh` or `vcjob` for Volcano Jobs.

### Job Phases

| Phase | Meaning |
|-------|---------|
| `Pending` | Job is waiting for resources or admission |
| `Running` | Job is executing |
| `Completing` | Job tasks are completing |
| `Completed` | Job finished successfully |
| `Failed` | Job failed |
| `Restarting` | Job is being restarted due to policy |
| `Terminating` | Job is being terminated |
| `Aborted` | Job was aborted |

### Task Statuses

Each task within a job has its own status:
- `Pending` - Task pods not yet scheduled
- `Running` - Task pods are running
- `Completed` - Task finished
- `Failed` - Task failed

## Diagnostic Flow

### Step 1: Job Overview

Get the Job status:

```bash
kubectl get job.batch.volcano.sh <job-name> -n <namespace> -o yaml
```

**Key fields to check:**
- `status.state.phase` - Current job phase
- `status.failed` - Number of failed tasks
- `status.succeeded` - Number of succeeded tasks
- `status.running` - Number of running tasks
- `status.pending` - Number of pending tasks

### Step 2: Check Tasks

List all tasks and their statuses:

```bash
kubectl get pods -n <namespace> -l volcano.sh/job-name=<job-name> -o wide
```

**What to look for:**
- Pod phases (Pending, Running, Completed, Failed)
- Pod restart counts
- Node assignments

### Step 3: Check PodGroup Association

Find the PodGroup created for this Job:

```bash
kubectl get podgroups -n <namespace> -l volcano.sh/job-name=<job-name>
```

Or check the Job's tasks for PodGroup annotations:

```bash
kubectl get pods -n <namespace> -l volcano.sh/job-name=<job-name> \
  -o jsonpath='{.items[0].metadata.annotations.scheduling\.volcano\.sh/pod-group}'
```

**Next step:** If PodGroup status is problematic, use `volcano-diagnose-pod` for detailed PodGroup analysis.

### Step 4: Check Policies

Review job policies that may affect behavior:

```bash
kubectl get job.batch.volcano.sh <job-name> -n <namespace> -o jsonpath='{.spec.policies}'
```

**Common policies:**
- `PodFailed` → `RestartJob` - Restart entire job on any pod failure
- `PodFailed` → `RestartTask` - Restart only the failed task
- `PodEvicted` → `RestartTask` - Restart evicted tasks
- `PodEvicted` → `AbortJob` - Abort entire job when a pod is evicted (can cause unexpected aborts during preemption)
- `TaskCompleted` → `CompleteJob` - Complete job when task finishes

Also check `maxRetry` — when retries are exhausted the job moves to `Aborted`:
```bash
kubectl get job.batch.volcano.sh <job-name> -n <namespace> -o jsonpath='{.spec.maxRetry}'
```

### Step 5: Events Analysis

Check job-related events:

```bash
kubectl get events -n <namespace> --field-selector involvedObject.name=<job-name>
```

**Common event patterns:**

#### `JobFailed` - Job has failed
Check the reason and message for failure details.

#### `JobRestarting` - Job is being restarted
Check the restart policy and previous failure reason.

#### `TaskFailed` - Individual task failed
May or may not cause entire job to fail depending on policy.

## Common Issues

### Issue 1: Job Stuck in Pending

**Symptom:** Job phase is `Pending`, no pods created.

**Check:**
1. PodGroup status: `kubectl get podgroups -n <ns>`
2. Queue state: `kubectl get queue <queue>`
3. Events: `kubectl get events -n <ns> | grep <job-name>`

**Likely causes:**
- Queue is Closed
- PodGroup cannot be enqueued (resource shortage)
- Admission webhook rejection

### Issue 2: Some Tasks Running, Others Pending

**Symptom:** Partial task scheduling (e.g., 2/4 tasks running).

**Check:**
1. PodGroup minMember vs actual pod count
2. Gang scheduling constraints
3. Resource availability

**Likely causes:**
- Gang constraint not satisfied (use `volcano-gang-scheduling`)
- Resource fragmentation
- Queue quota exhausted

### Issue 3: Job Restarting Repeatedly

**Symptom:** Job keeps restarting, never completes.

**Check:**
1. Restart policy: `kubectl get job.batch.volcano.sh -o jsonpath='{.spec.policies}'`
2. Pod failure reasons: `kubectl describe pod <pod>`
3. Container logs: `kubectl logs <pod>`

**Likely causes:**
- Application crashing (check container logs)
- Resource pressure causing evictions
- Misconfigured restart policy

### Issue 4: Job Failed After Some Tasks Completed

**Symptom:** Some tasks succeeded, but job marked as Failed.

**Check:**
1. Failed task details
2. Job completion policy
3. Task lifecycle policies

**Likely causes:**
- One critical task failed
- Completion policy is strict (all tasks must succeed)
- Lifecycle policy triggered premature job failure

### Issue 5: Job Aborted Unexpectedly

**Symptom:** Job was Running, then moved to `Aborted`.

**Check:**
```bash
# Check maxRetry
kubectl get job.batch.volcano.sh <job> -n <ns> -o jsonpath='{.spec.maxRetry}'

# Check for preemption/eviction events
kubectl get events -n <ns> --field-selector reason=Preempted
kubectl get events -n <ns> --field-selector reason=Evicted

# Check if running pod count dropped below minMember (Gang breakage)
kubectl get podgroup -n <ns> -l volcano.sh/job-name=<job> -o jsonpath='{"running: "}{.items[0].status.running}{"\nminMember: "}{.items[0].spec.minMember}'
```

**Likely causes:**
- `maxRetry` exhausted — job restarted too many times
- Preemption by higher-priority job — pods evicted, triggering `PodEvicted → AbortJob` policy
- Gang breakage — pod eviction caused running count to drop below `minMember`, tearing down the entire group
- Lifecycle policy mismatch — e.g., `PodEvicted → AbortJob` when `RestartTask` would be more appropriate

## Task Lifecycle Policies

Volcano controls task coordination through lifecycle policies, not explicit task dependencies.

```yaml
spec:
  tasks:
    - name: master
      replicas: 1
      policies:
        - event: TaskCompleted
          action: CompleteJob
    - name: worker
      replicas: 4
      policies:
        - event: PodFailed
          action: RestartTask
```

**Diagnosis:**
```bash
# Check per-task status counts
kubectl get job.batch.volcano.sh <job> -o jsonpath='{.status.taskStatusCount}'

# Check configured policies
kubectl get job.batch.volcano.sh <job> -o jsonpath='{.spec.tasks[*].policies}'
```

Look for mismatched events/actions that could cause unexpected restarts or premature completion.

## Integration with Other Skills

Use this skill in combination with others:

```bash
# 1. Job-level diagnosis
bash skills/core/volcano-job-diagnose/scripts/diagnose-job.sh --job my-job --namespace training

# 2. If PodGroup issues found → Pod-level diagnosis
bash skills/core/volcano-diagnose-pod/scripts/diagnose-pod.sh --pod my-job-worker-0 --namespace training

# 3. If Gang issues → Gang scheduling analysis
# (refer to volcano-gang-scheduling skill)

# 4. If Queue issues → Queue diagnosis
bash skills/core/volcano-queue-diagnose/scripts/diagnose-queue.sh --queue training-queue

# 5. Check scheduler logs for decisions
bash skills/core/volcano-scheduler-logs/scripts/get-scheduler-logs.sh --pod my-job-worker-0 --since 1h
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLCANO_NAMESPACE` | `default` | Default namespace for job lookup |

## See Also

- `volcano-diagnose-pod` - Pod-level scheduling diagnosis
- `volcano-gang-scheduling` - Gang scheduling constraint analysis
- `volcano-queue-diagnose` - Queue resource analysis
- `volcano-scheduler-logs` - Scheduler decision logs
- `deployment-rollout-debug` - (Similar concept for Deployments)
