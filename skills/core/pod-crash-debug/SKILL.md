---
name: pod-crash-debug
description: >-
  Diagnose pod crash failures (CrashLoopBackOff, OOMKilled, Error, RunContainerError).
  Checks pod status, events, and previous logs to identify root cause.
---

# Pod Crash Failure Diagnosis

When a pod is stuck in `CrashLoopBackOff`, `Error`, `OOMKilled`, or `RunContainerError`, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to fix the application code or modify resource limits — that should be left to the user.

## Diagnostic Flow

### 1. Get pod status

```bash
kubectl get pod <pod> -n <ns> -o wide
```

Note the **STATUS**, **RESTARTS** count, and **NODE**. A high restart count confirms the pod is crash-looping.

### 2. Describe the pod

```bash
kubectl describe pod <pod> -n <ns>
```

Focus on:
- **State** and **Last State** under each container — note the `reason`, `exit code`, and `signal`
- **Events** section at the bottom — look for `BackOff`, `Failed`, `Unhealthy`, or `OOMKilling` events

### 3. Get previous container logs

```bash
kubectl logs <pod> -n <ns> --previous --tail=200
```

If the pod has multiple containers, specify the crashing container:

```bash
kubectl logs <pod> -n <ns> -c <container> --previous --tail=200
```

If `--previous` fails with "previous terminated container not found", try current logs:

```bash
kubectl logs <pod> -n <ns> --tail=200
```

### 4. Match error and conclude

Match the information from steps 2-3 against the patterns below. Once a pattern matches, **report the root cause to the user and stop**.

---

#### `OOMKilled` / exit code 137 (from OOM) — Out of Memory

The container exceeded its memory limit and was killed by the kernel OOM killer.

Check the container's resource limits:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[*].resources}'
```

Advise the user to either increase the memory limit or investigate the application's memory usage (possible memory leak).

---

#### Exit code 137 (no OOMKilled) — SIGKILL

The container was killed by SIGKILL but not due to OOM. Common causes:
- Liveness probe failure — check `kubectl describe pod` for `Unhealthy` events with `Liveness probe failed`
- Manual kill or preemption

If liveness probe failures are present, advise the user to adjust probe timing (`initialDelaySeconds`, `timeoutSeconds`, `periodSeconds`) or fix the health endpoint.

---

#### Exit code 1 — Application error

The application exited with a generic error code. The root cause is in the container logs from step 3. Report the relevant error lines to the user.

---

#### Exit code 2 — Shell/binary misuse

Often indicates a missing binary, incorrect command syntax, or shell script error. Check the container's `command` and `args`:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[0].command} {.spec.containers[0].args}'
```

---

#### Exit code 126 — Permission denied

The entrypoint binary exists but is not executable. Advise the user to check file permissions in the container image.

---

#### Exit code 127 — Command not found

The entrypoint binary does not exist in the container image. Advise the user to verify the image contains the expected binary and the `command` field is correct.

---

#### `RunContainerError` — Container failed to start

The container runtime failed to start the container. Common causes:
- Volume mount errors (invalid path, read-only filesystem)
- ConfigMap/Secret not found
- Invalid security context

Check events from step 2 for the specific error message and report it to the user.

---

#### `CreateContainerConfigError` — Invalid container configuration

A referenced ConfigMap, Secret, or other resource does not exist or is misconfigured. Check the events for the specific missing resource name and report it to the user.

---

#### `PostStartHookError` — Lifecycle hook failed

The container's `postStart` hook failed, causing the container to be killed. Check events and logs for the hook's error output.

## Notes

- If `--previous` logs are empty and the container exits immediately, the issue is likely with the entrypoint command — check the image's `ENTRYPOINT`/`CMD` and the pod's `command`/`args` override.
- For init container crashes, use `-c <init-container-name>` to get the specific init container's logs.
- If the pod has been restarted many times, logs from earlier crashes may be lost. The most recent crash's `--previous` logs are usually sufficient.
