---
name: pod-ping-gateway
description: >-
  Ping a pod's gateway for a given network interface.
  Auto-detects gateway IP from the routing table, then pings it.
  First resolve_pod_netns, then node_script with netns param.
---

# Pod Ping Gateway

## Tool

This skill runs in the pod's network namespace using host tools. Two steps required:

1. Resolve the pod's network namespace:
```
resolve_pod_netns: pod="<pod>", namespace="<ns>"
```

2. Run the script with the returned node and netns:
```
node_script: node="<node>", netns="<netns>", skill="pod-ping-gateway", script="ping-gateway.sh", args="<args>"
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--interface IFACE` | yes | Network interface to find gateway for |
| `--source-ip` | no | flag, auto-detect IP from interface, use as ping source (`-I <ip>`) |
| `--source-dev` | no | flag, use interface name as ping source (`-I <iface>`) |
| `--count N` | no | Number of ping packets (default: 3) |

`--source-ip` and `--source-dev` are mutually exclusive flags (no value needed).

## Examples

```
resolve_pod_netns: pod="rdma-pod", namespace="rdma-test"
→ node="worker-1", netns="abc123"

node_script: node="worker-1", netns="abc123", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1"
```

```
node_script: node="worker-1", netns="abc123", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1 --source-ip"
```

```
node_script: node="worker-1", netns="abc123", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1 --source-dev"
```

Node version: see `node-ping-gateway`.
