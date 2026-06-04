---
name: node-show-gateway
description: >-
  Show the gateway for a network interface on a Kubernetes node.
  Runs `ip -j route` on the host. Run via host_script (preferred) or node_script.
---

# Node Show Gateway

## Tool

Prefer `host_script` when the node is a bound SSH host (check `host_list`) — it runs over
SSH with no debug pod. Fall back to `node_script` otherwise. Both take the same `skill`/`script`/`args`.

```
host_script: host="<host>", skill="node-show-gateway", script="show-node-gateway.sh", args="<args>"
node_script: node="<node>", skill="node-show-gateway", script="show-node-gateway.sh", args="<args>"
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--interface IFACE` | no | Network interface name. If omitted, shows all. |

## Examples

```
node_script: node="nodepool-061", skill="node-show-gateway", script="show-node-gateway.sh", args="--interface eth0"
```

```
node_script: node="nodepool-061", skill="node-show-gateway", script="show-node-gateway.sh"
```

## Output

The output table includes a TYPE column identifying each interface type:

| TYPE | Meaning |
|------|---------|
| `RoCE` | Ethernet interface with an RDMA device attached |
| `Ethernet` | Regular Ethernet interface |
| `IB` | InfiniBand interface |

Detection logic: `/sys/class/net/<dev>/type` = 32 → IB; type=1 and `rdma link` contains `netdev <dev>` → RoCE; otherwise → Ethernet.

## Switchdev Note

If the target interface is a PF in switchdev mode, the displayed gateway routes are **not meaningful** —
the PF acts as an embedded switch and cannot send or receive traffic as an endpoint.

**What to do instead:** run `node-list-roce-pods` on the node to find a RoCE pod,
then use `pod-show-gateway` on that pod. This tests the actual VF data path.
See `roce-diag-sriov-switchdev` for full background.

See `pod-show-gateway` for the pod version.
