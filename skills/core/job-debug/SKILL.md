---
name: job-debug
description: >-
  Diagnose Job and CronJob failures (BackoffLimitExceeded, DeadlineExceeded, pods failing, CronJob not triggering).
  Checks Job status, pod logs, and CronJob schedule to identify why batch workloads are failing.
---

# Job / CronJob Failure Diagnosis

When a Job has failed, is stuck, or a CronJob is not triggering as expected, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to delete, restart, or modify Jobs or CronJobs — that should be left to the user.

## Diagnostic Flow

### 1. Check Job status

```bash
kubectl get jobs -n <ns>
```

Note the **COMPLETIONS** (succeeded/total) and **DURATION** columns. For a specific Job:

```bash
kubectl describe job <job-name> -n <ns>
```

Focus on:
- **Conditions** — look for `Complete` (success) or `Failed` (failure) with the reason
- **Events** — look for `BackoffLimitExceeded`, `DeadlineExceeded`, or pod creation errors
- **Pods Statuses** — counts of Succeeded, Failed, and Active pods

### 2. Check the Job's pods

```bash
kubectl get pods -n <ns> -l job-name=<job-name> --sort-by='.metadata.creationTimestamp'
```

Note pod statuses. For failed pods, check logs:

```bash
kubectl logs <pod-name> -n <ns>
```

If the pod was terminated, check the exit code:

```bash
kubectl get pod <pod-name> -n <ns> -o jsonpath='{.status.containerStatuses[*].state.terminated}'
```

### 3. For CronJobs — check schedule and history

```bash
kubectl get cronjobs -n <ns>
```

Note the **SCHEDULE**, **SUSPEND**, **ACTIVE**, and **LAST SCHEDULE** columns.

For details:

```bash
kubectl describe cronjob <cronjob-name> -n <ns>
```

Focus on:
- **Schedule** — the cron expression
- **Suspend** — if `True`, the CronJob will not create new Jobs
- **Last Schedule Time** — when the last Job was triggered
- **Active Jobs** — currently running Jobs
- **Events** — look for creation events or errors

List Jobs created by the CronJob:

```bash
kubectl get jobs -n <ns> -l job-name --sort-by='.metadata.creationTimestamp' | grep <cronjob-name>
```

### 4. Match patterns and conclude

---

#### `BackoffLimitExceeded` — Too many pod failures

The Job's pods have failed more times than the `backoffLimit` (default: 6). The Job is marked as Failed.

Check why the pods are failing — look at the logs of the most recent failed pod (step 2). Common causes:
- **Application error** — the program exits with a non-zero code
- **OOMKilled** — the container exceeded its memory limit (use `pod-crash-debug` for deeper analysis)
- **Configuration error** — missing environment variables, wrong arguments, or missing config files

Advise the user to fix the underlying pod failure, then create a new Job.

---

#### `DeadlineExceeded` — Job took too long

The Job did not complete within its `activeDeadlineSeconds` limit. All running pods are terminated.

```bash
kubectl get job <job-name> -n <ns> -o jsonpath='{.spec.activeDeadlineSeconds}'
```

Check if the Job's pods are slow or stuck:
- The workload may genuinely take longer than the deadline allows
- Pods may be stuck waiting for resources, network, or external dependencies

Advise the user to either increase `activeDeadlineSeconds` or investigate why the workload is slow.

---

#### Pods in `Pending` — Scheduling issues

Job pods are created but cannot be scheduled.

Use the `pod-pending-debug` skill to diagnose the scheduling failure. Common causes for batch jobs:
- **Resource constraints** — the Job requests more resources than available
- **Node affinity** — the Job's pods can only run on specific nodes that are busy

---

#### Pods in `ImagePullBackOff` — Image issue

The Job pod cannot pull its container image. Use the `image-pull-debug` skill.

---

#### Job succeeded but results are wrong — Application-level issue

The Job completed (status `Complete`) but produced incorrect results. This is not a Kubernetes issue — check the application logs:

```bash
kubectl logs <succeeded-pod> -n <ns>
```

If the pod has been garbage collected, check if `ttlSecondsAfterFinished` caused it to be deleted:

```bash
kubectl get job <job-name> -n <ns> -o jsonpath='{.spec.ttlSecondsAfterFinished}'
```

---

#### CronJob not triggering — Schedule or suspend issue

The CronJob exists but is not creating Jobs on schedule.

- **Suspended** — `spec.suspend` is `true`. No new Jobs will be created until it is unsuspended.
- **Invalid schedule** — the cron expression may be malformed. Kubernetes uses standard 5-field cron syntax (minute, hour, day-of-month, month, day-of-week).
- **Concurrency policy** — if `concurrencyPolicy: Forbid` and a previous Job is still running, the new Job will be skipped.

```bash
kubectl get cronjob <cronjob-name> -n <ns> -o jsonpath='suspend={.spec.suspend} concurrencyPolicy={.spec.concurrencyPolicy} schedule={.spec.schedule}'
```

Check if there are active Jobs blocking the next run:

```bash
kubectl get jobs -n <ns> | grep <cronjob-name>
```

---

#### CronJob creates Jobs but they keep failing — Recurring failure

If every Job created by the CronJob fails, the root cause is in the Job template. Diagnose the most recent Job using steps 1-2 above.

Check the `startingDeadlineSeconds` — if set, Jobs that miss their window (e.g., because the previous Job ran too long) are skipped:

```bash
kubectl get cronjob <cronjob-name> -n <ns> -o jsonpath='{.spec.startingDeadlineSeconds}'
```

Also check `successfulJobsHistoryLimit` and `failedJobsHistoryLimit` — if these are set to `0`, completed/failed Jobs and their pods are deleted immediately, making diagnosis harder.

## Notes

- Jobs created by CronJobs are named `<cronjob-name>-<timestamp>`. Use this pattern to find related Jobs.
- By default, failed Job pods are kept (not deleted) so you can inspect their logs. The `backoffLimit` controls how many retries happen before the Job is marked as Failed.
- `completions` and `parallelism` control how many pods need to succeed and how many run concurrently. A Job with `completions: 5, parallelism: 2` runs 2 pods at a time until 5 have succeeded.
- For indexed Jobs (`completionMode: Indexed`), each pod gets a unique index. A failure in one index does not affect others — check which specific index is failing.
