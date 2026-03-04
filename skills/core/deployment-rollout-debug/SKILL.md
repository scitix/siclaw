---
name: deployment-rollout-debug
description: >-
  Diagnose Deployment rollout failures (stuck rollouts, ProgressDeadlineExceeded, replica mismatch).
  Checks rollout status, ReplicaSets, and new pod health to identify why an update is failing.
---

# Deployment Rollout Failure Diagnosis

When a Deployment rollout is stuck, not progressing, or shows replica mismatches, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to roll back, scale, or modify the Deployment — that should be left to the user.

## Diagnostic Flow

### 1. Check rollout status

```bash
kubectl rollout status deployment/<name> -n <ns> --timeout=5s
```

This shows whether the rollout is progressing, complete, or stuck. A timeout indicates the rollout is not making progress.

### 2. Get Deployment details

```bash
kubectl get deployment <name> -n <ns> -o wide
```

Compare the columns:
- **DESIRED** — target replica count
- **CURRENT** — total pods (old + new)
- **UP-TO-DATE** — pods running the new version
- **AVAILABLE** — pods ready to serve traffic

If `UP-TO-DATE < DESIRED` or `AVAILABLE < DESIRED`, the rollout is incomplete.

### 3. Describe the Deployment

```bash
kubectl describe deployment <name> -n <ns>
```

Focus on:
- **Conditions** — look for `Progressing` (status and reason) and `Available`
- **Events** — look for scaling events, errors, or warnings
- **Strategy** — note `maxSurge` and `maxUnavailable` settings

### 4. Check ReplicaSets

```bash
kubectl get rs -n <ns> -l app=<name>
```

If the label `app=<name>` doesn't match, find ReplicaSets owned by the Deployment:

```bash
kubectl get rs -n <ns> --sort-by='.metadata.creationTimestamp' | grep <name>
```

You should see the old RS (with reduced replicas) and the new RS (scaling up). If the new RS has `0` ready replicas, its pods are failing.

### 5. Check new ReplicaSet's pods

Find pods from the new RS:

```bash
kubectl get pods -n <ns> -l app=<name> --sort-by='.metadata.creationTimestamp'
```

Check the status of the newest pods. Based on their status:
- **Pending** → Use the `pod-pending-debug` skill
- **CrashLoopBackOff / Error** → Use the `pod-crash-debug` skill
- **ImagePullBackOff / ErrImagePull** → Use the `image-pull-debug` skill
- **Running but not Ready** → Check readiness probe below

### 6. Match deployment-level patterns

---

#### `ProgressDeadlineExceeded` — Rollout timed out

The Deployment's `spec.progressDeadlineSeconds` (default 600s) has been exceeded without progress.

This is a symptom, not a cause. The root cause is in the new pods — check step 5 for why new pods are not becoming ready.

---

#### `MinimumReplicasUnavailable` — Not enough replicas available

The Deployment cannot maintain the minimum number of available replicas during the rollout.

Check the new pods' status (step 5). The new version's pods are failing to start or pass readiness probes.

---

#### New pods `Running` but not `Ready` — Readiness probe failing

The new pods started successfully but are failing their readiness probe. The rollout will not progress because the new pods are not considered available.

Check the readiness probe configuration and failures:

```bash
kubectl describe pod <new-pod> -n <ns>
```

Look for `Readiness probe failed` events. Common causes:
- Application not listening on the expected port
- Health endpoint returning errors
- Probe timing too aggressive (`initialDelaySeconds` too low)

---

#### Rollout stuck with `maxSurge: 0` and `maxUnavailable: 0` — Invalid strategy

If both `maxSurge` and `maxUnavailable` are `0`, the rollout cannot proceed because it cannot create extra pods and cannot remove existing pods. At least one must be greater than `0`.

---

#### New RS created but not scaling up — Admission webhook or quota

The new ReplicaSet exists but has 0 replicas or cannot create pods:

```bash
kubectl describe rs <new-rs> -n <ns>
```

Check events for:
- **Admission webhook denied** — a webhook is rejecting the new pod spec
- **Exceeded quota** — resource quota in the namespace prevents creating more pods
- **FailedCreate** — other creation failures

---

#### Old RS not scaling down — Waiting for new pods

The old ReplicaSet keeps its replicas because the new RS pods are not ready yet. This is expected behavior — Kubernetes will not remove old pods until new pods are available. Fix the new pods first.

## Notes

- `kubectl rollout status` waits for the rollout to complete by default. Use `--timeout` to avoid blocking.
- If the user wants to undo a failed rollout: `kubectl rollout undo deployment/<name> -n <ns>` (but let the user decide, do not execute this).
- For Deployments managed by Helm or ArgoCD, the rollout may be triggered by those tools — check if the issue is in the Helm chart values or ArgoCD sync.
- StatefulSet rollouts follow a different pattern (ordered, one-at-a-time by default). This skill is specific to Deployments.
