---
name: pod-show-gateway
description: >-
  Show the gateway for a network interface in a Kubernetes pod.
  Reads the routing table via `ip -j route` from the pod's network namespace.
  Execute via pod_netns_script tool.
---

# Pod Show Gateway

## Tool

Use the `pod_netns_script` tool to run this skill:

```
pod_netns_script: pod="<pod>", namespace="<ns>", skill="pod-show-gateway", script="show-gateway.sh", args="<args>"
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--interface IFACE` | no | Network interface name. If omitted, shows all. |
| `--json` | no | Output in JSON format |

## Examples

```
pod_netns_script: pod="rdma-pod", namespace="rdma-test", skill="pod-show-gateway", script="show-gateway.sh", args="--interface net1"
```

```
pod_netns_script: pod="rdma-pod", namespace="rdma-test", skill="pod-show-gateway", script="show-gateway.sh"
```

```
pod_netns_script: pod="rdma-pod", namespace="rdma-test", skill="pod-show-gateway", script="show-gateway.sh", args="--json"
```

## Output

The output table includes a TYPE column identifying each interface type:

| TYPE | Meaning |
|------|---------|
| `RoCE` | Ethernet interface with an RDMA device attached |
| `Ethernet` | Regular Ethernet interface |
| `IB` | InfiniBand interface |

Detection logic: `/sys/class/net/<dev>/type` = 32 → IB; type=1 and `rdma link` contains `netdev <dev>` → RoCE; otherwise → Ethernet.

JSON output (`--json`) also includes a `type` field in each gateway entry.

See `node-show-gateway` for the node version.
