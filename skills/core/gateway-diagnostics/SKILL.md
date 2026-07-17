---
name: gateway-diagnostics
description: >-
  Show and ping the gateway of a network interface, on a Kubernetes node or
  inside a pod's network namespace. Auto-detects the gateway from the routing
  table (ip -j route), reports interface type (RoCE / Ethernet / IB), and tests
  reachability with ping. Use for default-route / gateway questions, network
  reachability checks, RoCE/RDMA data-path validation, and "can this
  node/pod reach its gateway" investigations.
---

# Gateway Diagnostics

Inspect and test the **gateway** of a network interface. Two operations, one
script each; both run identically on a node or inside a pod — the only
difference is how you launch them (see Targets below).

## Router

| Need | Action |
| --- | --- |
| See the gateway / default route for an interface (with TYPE) | `scripts/show-gateway.sh` |
| Test whether the gateway is reachable | `scripts/ping-gateway.sh` |
| Target is a **node** (or a bound SSH host) | run directly — see Node target |
| Target is a **pod** | resolve the netns first — see Pod target |
| Switchdev PF caveat, or what RoCE/Ethernet/IB means | read `references/switchdev-and-interface-types.md` |

## Targets

### Node target

Prefer `host_script` when the node is a bound SSH host (check `host_list`) — it
runs over SSH with no debug pod. Fall back to `node_script` otherwise. Both take
the same `skill` / `script` / `args`.

```
host_script: host="<host>", skill="gateway-diagnostics", script="show-gateway.sh", args="<args>"
node_script: node="<node>", skill="gateway-diagnostics", script="show-gateway.sh", args="<args>"
```

### Pod target

Runs in the pod's network namespace using host tools — one step: pass `pod`
(+ `namespace`) and `node_script` resolves the node and enters the pod's netns
for you:
```
node_script: pod="<pod>", namespace="<ns>", skill="gateway-diagnostics", script="ping-gateway.sh", args="<args>"
```

> `node_script` resolves the pod → node + netns internally and runs the script in
> the pod's network namespace. The same script file serves both node and pod targets.

## Parameters

### show-gateway.sh

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--interface IFACE` | no | Network interface name. If omitted, shows all. |
| `--json` | no | Output in JSON format (adds a `type` field per gateway). |

### ping-gateway.sh

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--interface IFACE` | yes | Network interface to find the gateway for |
| `--source-ip` | no | flag — auto-detect IP from the interface, use as ping source (`-I <ip>`) |
| `--source-dev` | no | flag — use the interface name as ping source (`-I <iface>`) |
| `--count N` | no | Number of ping packets (default: 3) |

`--source-ip` and `--source-dev` are mutually exclusive flags (no value needed).

## Examples

Show all gateways on a node:
```
node_script: node="nodepool-061", skill="gateway-diagnostics", script="show-gateway.sh"
```

Show one interface's gateway on a bound host:
```
host_script: host="nodepool-061", skill="gateway-diagnostics", script="show-gateway.sh", args="--interface eth0"
```

Ping a node's gateway, sourcing from the interface IP:
```
node_script: node="nodepool-061", skill="gateway-diagnostics", script="ping-gateway.sh", args="--interface bond0 --source-ip"
```

Show / ping a pod's gateway (one step — `pod` resolves node + netns):
```
node_script: pod="rdma-pod", namespace="rdma-test", skill="gateway-diagnostics", script="show-gateway.sh", args="--interface net1 --json"
node_script: pod="rdma-pod", namespace="rdma-test", skill="gateway-diagnostics", script="ping-gateway.sh", args="--interface net1 --source-dev"
```

## Interface types & switchdev

The output includes a TYPE column (RoCE / Ethernet / IB). If a target interface
is a PF in **switchdev mode**, gateway routes are not meaningful and ping will
always fail — this is expected, not a network problem. For the detection logic
and what to do instead (use a RoCE pod + the pod target), read
`references/switchdev-and-interface-types.md`.
