---
name: pod-show-gateway
description: >-
  Show the gateway for a network interface in a Kubernetes pod.
  Reads the routing table via `ip -j route` from the pod's network namespace.
  First resolve_pod_netns, then node_script with netns param.
---

# Pod Show Gateway

## Tool

This skill runs in the pod's network namespace using host tools. Two steps required:

1. Resolve the pod's network namespace:
```
resolve_pod_netns: pod="<pod>", namespace="<ns>"
```

2. Run the script with the returned node and netns:
```
node_script: node="<node>", netns="<netns>", skill="pod-show-gateway", script="show-gateway.sh", args="<args>"
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--interface IFACE` | no | Network interface name. If omitted, shows all. |
| `--json` | no | Output in JSON format |

## Examples

```
resolve_pod_netns: pod="rdma-pod", namespace="rdma-test"
→ node="worker-1", netns="abc123"

node_script: node="worker-1", netns="abc123", skill="pod-show-gateway", script="show-gateway.sh", args="--interface net1"
```

```
node_script: node="worker-1", netns="abc123", skill="pod-show-gateway", script="show-gateway.sh"
```

```
node_script: node="worker-1", netns="abc123", skill="pod-show-gateway", script="show-gateway.sh", args="--json"
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
