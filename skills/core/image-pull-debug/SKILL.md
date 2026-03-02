---
name: image-pull-debug
description: >-
  Diagnose container image pull failures (ErrImagePull / ImagePullBackOff).
  Checks pod status, containerd logs, and events to identify root cause.
---

# Image Pull Failure Diagnosis

When a pod is stuck in `ErrImagePull` or `ImagePullBackOff`, follow this flow to identify the root cause.

**Important:** `ErrImagePull`, `ImagePullBackOff`, and `Back-off pulling image` are NOT causes — they only indicate the pull failed. You MUST proceed through all steps below to find the actual cause. Never conclude with just these status messages.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt network-level debugging (ping, curl, iptables, traceroute, etc.) — that is outside the scope of this skill and should be left to the user or network administrator.

## Diagnostic Flow

### 1. Get pod info

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.nodeName}'
kubectl get pod <pod> -n <ns> -o jsonpath='{.status.containerStatuses[*].image}'
kubectl get pod <pod> -n <ns> -o jsonpath='{.status.containerStatuses[0].state.waiting.message}'
```

Note the **node name**, **image name**, and **waiting message** (may already contain the root cause).

Also check the image registry:
- If the image has **no registry prefix** (e.g. `nginx:latest`, `envoyproxy/gateway:v1.2.8`), it pulls from **Docker Hub** (`docker.io`).
- If it has a prefix (e.g. `registry.example.com/app:v1`), it pulls from that registry.

### 2. Check containerd logs

Containerd logs are the authoritative source for the root cause. Pod events are often generic ("Failed to pull image") and do not contain the actual error — always check containerd logs.

Use the `node-logs` skill:

```bash
bash skills/core/node-logs/scripts/get-node-logs.sh \
  --node <nodeName> --unit containerd --grep "<image>" --since "1h ago"
```

Replace `<image>` with the image name or a unique substring. Adjust `--since` to cover the pod's creation time.

If journalctl returns nothing, try log files:

```bash
bash skills/core/node-logs/scripts/get-node-logs.sh \
  --node <nodeName> --file /var/log/messages --grep "<image>"
```

### 3. Match error and conclude

Match the error from containerd logs (or the `state.waiting.message` from step 1) against the patterns below. Once a pattern matches, **report the root cause to the user and stop**. Do not continue with further diagnostic commands.

If containerd logs have no relevant entries, check events as a supplementary source:

```bash
kubectl get events -n <ns> --field-selector involvedObject.name=<pod>
```

If still no match, report whatever error information you have found and let the user decide next steps. Do NOT start autonomous network investigation.

---

#### `not found` / `manifest unknown` — Image does not exist

The image name or tag does not exist in the registry. Inform the user to verify the image name and tag.

---

#### `unauthorized` / `access denied` / `denied` — Authentication failed

The registry rejected the request. Advise the user to:
1. Configure an imagePullSecret for the pod with valid registry credentials
2. Or adjust image permissions on the registry side to allow access

---

#### `x509` / `certificate` / `tls` — Certificate not trusted

The node's containerd does not trust the registry's CA certificate. Advise the user to add the registry CA to the node's containerd trust config (`/etc/containerd/certs.d/`) or system trust store.

---

#### `no such host` / `lookup.*failed` — DNS resolution failed

The registry hostname cannot be resolved. Advise the user to check the hostname spelling and node DNS config.

---

#### `connection reset by peer` — Remote reset

TCP reached the registry but was reset by the remote end — a server-side or intermediary issue.

---

#### `i/o timeout` / `dial tcp.*timeout` — Connection timed out

The node cannot establish a TCP connection to the registry. Common causes: firewall blocking, proxy misconfiguration, or registry unreachable from the node's network.

**Docker Hub specific:** If the image is from Docker Hub (`docker.io`) and the node is in mainland China, this is almost certainly caused by network restrictions (GFW). Advise the user to use a registry mirror or re-tag the image to a domestically accessible registry.

Report the timeout to the user and stop. Do NOT attempt network diagnostics (ping, curl, iptables, etc.).

---

#### `connection refused` — Connection refused

TCP reached the host but the port is not listening. The registry service is down or on a different port.

---

#### `too many requests` / `429` / `rate limit` — Rate limited

The registry is throttling requests. Inform the user to wait for the rate limit window to expire, or configure a registry mirror to reduce direct requests.

---

#### `no space left on device` — Disk full

Containerd cannot unpack image layers due to insufficient disk space on the node.

---

#### `invalid reference format` — Malformed image name

The image reference contains illegal characters or has incorrect format. Inform the user to fix the image field in the pod spec.

---

#### `server gave HTTP response to HTTPS client` — Protocol mismatch

The registry serves HTTP but containerd expects HTTPS. Advise the user to configure the registry as insecure in containerd config, or enable TLS on the registry.

---

#### `does not match the specified platform` — Architecture mismatch

The image exists but has no manifest for this node's CPU architecture. Inform the user to use a multi-arch image or the correct platform-specific tag.

---

#### `ErrImageNeverPull` — Pull policy forbids pulling

`imagePullPolicy` is `Never` but the image is not present on the node. Inform the user to pre-load the image or change `imagePullPolicy`.

## Notes

- The `--since` parameter should cover the pod's creation time. If the pod was created long ago, increase accordingly (e.g. `--since "24h ago"`).
- If both containerd logs and events are empty, the `state.waiting.message` from step 1 is your best available information — report it directly.
