---
name: hpa-debug
description: >-
  Diagnose HorizontalPodAutoscaler failures (not scaling, metrics unavailable, target mismatch).
  Checks HPA status, metrics-server health, and scaling events to identify why autoscaling is not working.
---

# HPA Autoscaling Failure Diagnosis

When a HorizontalPodAutoscaler is not scaling as expected — stuck at min/max replicas, showing `<unknown>` metrics, or not responding to load — follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify HPA settings, resource requests, or metrics configuration — that should be left to the user.

## Diagnostic Flow

### 1. Check HPA status

```bash
kubectl get hpa <hpa-name> -n <ns>
```

Note:
- **TARGETS** — current value vs target (e.g., `80%/50%`). If showing `<unknown>/50%`, metrics are unavailable.
- **MINPODS / MAXPODS** — scaling bounds
- **REPLICAS** — current replica count

### 2. Describe the HPA

```bash
kubectl describe hpa <hpa-name> -n <ns>
```

Focus on:
- **Conditions** — look for `AbleToScale`, `ScalingActive`, and `ScalingLimited` with their status and reason
- **Events** — scaling decisions, metric fetch errors, or rate-limiting messages
- **Metrics** — each metric's current value, target, and type (resource, custom, external)

### 3. Check metrics-server health

```bash
kubectl get pods -n kube-system -l k8s-app=metrics-server -o wide
```

If no pods are found, try:

```bash
kubectl get deployment -n kube-system metrics-server
```

Verify metrics-server is serving data:

```bash
kubectl top pods -n <ns>
```

If `kubectl top` returns `error: Metrics API not available`, metrics-server is not working.

### 4. Check target resource requests

HPA with CPU/memory percentage targets requires `resources.requests` to be set on the target containers.

```bash
kubectl get deployment <target-name> -n <ns> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}: cpu={.resources.requests.cpu} memory={.resources.requests.memory}{"\n"}{end}'
```

If requests are not set, the HPA cannot calculate utilization percentages.

### 5. Match patterns and conclude

---

#### `<unknown>` metrics — Metrics not available

The HPA cannot fetch metrics for one or more targets.

Common causes:
- **metrics-server not installed or not running** — check step 3
- **metrics-server not ready yet** — it may take a few minutes after startup to collect data
- **No resource requests set** — CPU/memory percentage targets require `resources.requests` on the target pods (step 4)
- **Custom metrics adapter missing** — if the HPA uses custom or external metrics, the corresponding adapter (e.g., Prometheus adapter) must be installed

Advise the user to check metrics-server health and ensure resource requests are set.

---

#### `ScalingActive: False` — HPA cannot scale

The HPA has been disabled or cannot function.

Check the reason in `kubectl describe hpa`:
- **`FailedGetResourceMetric`** — cannot fetch resource metrics (metrics-server issue)
- **`FailedGetExternalMetric`** — cannot fetch external metrics (adapter issue)
- **`InvalidMetricSourceType`** — the metric source type is not recognized

---

#### `ScalingLimited: True` — At min or max replicas

The HPA wants to scale but is constrained by `minReplicas` or `maxReplicas`.

Check the reason:
- **`TooFewReplicas`** — HPA wants to scale down below `minReplicas`
- **`TooManyReplicas`** — HPA wants to scale up above `maxReplicas`
- **`DesiredWithinRange`** — current replicas are within bounds (normal)

If the HPA is stuck at `maxReplicas` and load is still high, advise the user to increase `maxReplicas` or investigate why the application needs so many replicas (possible performance issue).

---

#### HPA flapping (scaling up and down repeatedly) — Unstable metrics

The HPA keeps oscillating between replica counts.

Check the events for rapid scale-up/scale-down cycles. Common causes:
- **Metric target too close to normal usage** — small load changes trigger scaling
- **Application slow to start** — new pods take time to become effective, causing the HPA to scale up further before they help

The HPA has a default stabilization window (5 minutes for scale-down). Check if custom behavior is set:

```bash
kubectl get hpa <hpa-name> -n <ns> -o jsonpath='{.spec.behavior}'
```

Advise the user to adjust the stabilization window or the target utilization.

---

#### HPA not scaling up under load — Target not reached

The HPA sees metrics below the target threshold, so it does not scale.

Verify the actual pod resource usage:

```bash
kubectl top pods -n <ns> -l <selector>
```

Compare with the HPA target. If actual usage is below the target even under load:
- The resource requests may be set too high (actual usage is a low percentage of requests)
- The metric source may not reflect actual load

---

#### Multiple HPAs targeting the same workload — Conflicting autoscalers

Only one HPA should target a given Deployment/StatefulSet. Multiple HPAs on the same target cause unpredictable behavior.

```bash
kubectl get hpa -n <ns>
```

Check if multiple HPAs reference the same `scaleTargetRef`. Advise the user to consolidate into a single HPA with multiple metrics.

## Notes

- HPA evaluates metrics every 15 seconds by default (controlled by `--horizontal-pod-autoscaler-sync-period` on the controller manager).
- Scale-down has a default stabilization window of 5 minutes to prevent flapping. Scale-up defaults to 0 (immediate).
- For HPAs using `autoscaling/v2`, multiple metrics can be specified. The HPA scales to the highest recommended replica count across all metrics.
- If the target Deployment is managed by ArgoCD or Helm, the HPA replica count may be overwritten on sync — check if the Deployment's `replicas` field is managed externally.
