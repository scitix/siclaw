---
name: pod-ping-gateway
description: >-
  Ping a pod's gateway for a given network interface.
  Auto-detects gateway IP from the routing table, then pings it.
  Execute via pod_netns_script tool.
---

# Pod Ping Gateway

## Tool

Use the `pod_netns_script` tool to run this skill:

```
pod_netns_script: pod="<pod>", namespace="<ns>", skill="pod-ping-gateway", script="ping-gateway.sh", args="<args>"
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
pod_netns_script: pod="rdma-pod", namespace="rdma-test", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1"
```

```
pod_netns_script: pod="rdma-pod", namespace="rdma-test", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1 --source-ip"
```

```
pod_netns_script: pod="rdma-pod", namespace="rdma-test", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1 --source-dev"
```

Node version: see `node-ping-gateway`.
