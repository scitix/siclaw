---
name: http-log-stats
description: >-
  Count HTTP status codes and request-duration distribution from an ingress
  controller's access log, over a fixed time window, in one pass.
  Use when asked "how many 503s", "how many requests took over 60s", "what's the
  status code / latency distribution" for a service — i.e. a MEASUREMENT question
  about traffic, not a "why is it broken" diagnosis (for that use ingress-debug).
  Run via local_script.
---

# HTTP Access Log Statistics

Answers **measurement** questions about HTTP traffic: how many of each status
code, how the request durations distribute, how many exceeded a threshold.

This is deliberately separate from `ingress-debug`, which diagnoses *why*
traffic fails (404 / 502 / TLS / no ADDRESS). Here nothing is broken
necessarily — the user wants numbers.

## Before you run it: identify the layer

A request usually passes through several components that can each return a
status code, and the user's word for the one they mean ("router", "gateway",
"entry", "网关") rarely maps to exactly one of them. **Counting on the wrong
layer produces a confident, wrong answer**, so establish the path first:

```bash
kubectl get ingress,svc,endpoints -n <ns> | grep <service>
```

- An Ingress in front → the user's "router 503" is almost certainly the
  **ingress controller's** access log. Use this skill.
- No Ingress, traffic reaches the Service directly → there is no access log to
  count; the numbers must come from the application's own logs or metrics, and
  the format is application-specific.
- **Do not** grep the application pod's log for the string `503`. Application
  logs contain the digits 503 in request bodies, upstream error text and
  unrelated fields; that count is not the number of HTTP 503 responses the
  entry layer returned.

This step costs one command and routinely saves the entire investigation.

## Tool

```
local_script: skill="http-log-stats", script="http-log-stats.sh", args="<args>"
```

Runs `kubectl` from the agent's own context — no debug pod, no node access.

## Parameters

Required:

| Parameter | Description |
|-----------|-------------|
| `--since-time T` | Window start, RFC3339 UTC (`2026-08-17T12:02:06Z`). Absolute on purpose — see Notes. |

Optional:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--until-time T` | now | Window end, RFC3339 UTC |
| `-n, --namespace N` | `ingress-nginx` | Controller namespace |
| `--selector S` | `app.kubernetes.io/name=ingress-nginx` | Pod label selector |
| `--pod P[,P2]` | — | Explicit pod names; overrides `--selector` |
| `--match S` | — | Only count lines containing this substring (ingress name, host, or path) |
| `--buckets a,b,c` | `1,10,60` | Duration bucket edges in seconds |
| `--preset P` | `nginx-ingress` | Access log format |

## Output

```
window:    2026-08-17T12:02:06Z .. 2026-08-17T14:02:06Z
source:    live cluster (kubectl logs), ns=ingress-nginx, 3 pod(s)
coverage:  FULL  (earliest retained line 2026-08-17T11:47:33Z)
match:     my-service
parsed:    1007 lines (status 1007, request_time 1007)

status codes:
  200      1000   99.3%
  499         7    0.7%

request_time buckets (seconds):
  <1        983   97.6%
  1-10       17    1.7%
  10-60       7    0.7%
  >=60        0    0.0%
```

### `coverage` is part of the answer — always report it

| Value | Meaning | What to tell the user |
|-------|---------|-----------------------|
| `FULL` | Live log reaches back past the window start | Report the numbers plainly |
| `PARTIAL` | Log only reaches back to a later point | **Say so.** The counts cover only from that point on — they are a lower bound, not the window total |
| `UNAVAILABLE` | No controller pod matched | There is no live source; do not report zero |
| `UNKNOWN` | Earliest line unreadable | Treat as PARTIAL and say the bound is unverified |

A count over a window the log no longer covers is not a smaller truth, it is a
wrong number. Never present `PARTIAL` results as the window total.

## Notes

- **One pull per replica, all dimensions at once.** Every bucket and every
  status code comes out of a single pass. Do not fall back to running
  `kubectl logs | grep -c` once per number — on a busy controller each full
  pull costs 30–90s, so a four-bucket distribution across three replicas
  becomes twelve full pulls of the same data.
- **Absolute window, not a rolling one.** `--since=2h` moves between
  invocations, so two counts taken minutes apart cover different windows and
  cannot be compared or summed. That is why `--since-time` is required.
- **All replicas are summed.** An ingress controller usually runs several
  replicas and any of them may have served the request; counting one replica
  undercounts silently.
- **Live cluster is the source.** This reads the running controllers, so it is
  authoritative and current — no collection lag, no sampling, no field mapping
  in between. When `coverage` is not `FULL`, that is the point at which a log
  or metrics backend becomes the only option; note the switch explicitly when
  you report, because that data has different freshness and completeness.
- **Format assumption.** Parsing targets the nginx-ingress default
  `log-format-upstream`: `$status` after the quoted request line, `$request_time`
  immediately before the bracketed `$proxy_upstream_name`. If a cluster
  customises `log-format`, the script reports that it parsed 0 values rather
  than returning a silent zero — sample raw lines before trusting anything.

## See also

- `ingress-debug` — why traffic is failing (404 / 502 / TLS / no ADDRESS), as
  opposed to how much of it there is
- `service-debug` — backend Service has no healthy endpoints
