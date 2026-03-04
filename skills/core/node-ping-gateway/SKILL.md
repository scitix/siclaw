---
name: node-ping-gateway
description: >-
  Ping a node's gateway for a given network interface.
  Auto-detects gateway IP from the routing table, then pings it.
  Execute via node_script tool.
---

# Node Ping Gateway

## Tool

Use the `node_script` tool to run this skill:

```
node_script: node="<node>", skill="node-ping-gateway", script="ping-node-gateway.sh", args="<args>"
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
node_script: node="nodepool-061", skill="node-ping-gateway", script="ping-node-gateway.sh", args="--interface bond0"
```

```
node_script: node="nodepool-061", skill="node-ping-gateway", script="ping-node-gateway.sh", args="--interface eth0 --source-ip"
```

```
node_script: node="nodepool-061", skill="node-ping-gateway", script="ping-node-gateway.sh", args="--interface eth0 --source-dev"
```

## Switchdev Note

If the target interface is a PF in switchdev mode (e.g. eth0/eth1), ping **will always fail** —
this is expected behavior, not a network problem. The PF acts as an embedded switch and cannot
send or receive regular traffic.

**What to do instead:** run `node-list-roce-pods` on the node to find a RoCE pod,
then use `pod-ping-gateway` on that pod. This tests the actual VF data path.
See `roce-diag-sriov-switchdev` for full background.

See `pod-ping-gateway` for the pod version.
