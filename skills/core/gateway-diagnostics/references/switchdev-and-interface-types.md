# Switchdev & Interface Types

Read this when a gateway result is empty/failing on a node interface, or when
you need to interpret the TYPE column.

## Interface TYPE column

`show-gateway.sh` tags each interface with a type:

| TYPE | Meaning |
|------|---------|
| `RoCE` | Ethernet interface with an RDMA device attached |
| `Ethernet` | Regular Ethernet interface |
| `IB` | InfiniBand interface |

Detection logic:

- `/sys/class/net/<dev>/type` = `32` → **IB**
- type = `1` **and** `rdma link` output contains `netdev <dev>` → **RoCE**
- otherwise → **Ethernet**

With `--json`, the type is also included as a `type` field on each gateway entry
(and a top-level `type` when `--interface` is given).

## Switchdev PF caveat

If the target interface is a **PF (physical function) in switchdev mode**
(e.g. `eth0` / `eth1` on RoCE hosts):

- **`show-gateway.sh`**: the displayed gateway routes are **not meaningful** —
  the PF acts as an embedded switch and cannot send/receive traffic as an
  endpoint.
- **`ping-gateway.sh`**: ping **will always fail**. This is expected behavior,
  not a network problem.

### What to do instead

Test the actual VF data path through a RoCE pod:

1. Run `node-list-roce-pods` on the node to find a RoCE pod.
2. Use this skill's **pod target** (`node_script` with `pod=` — one step; node +
   netns resolved automatically) against that pod's interface (typically `net1`).

See `roce-diag-sriov-switchdev` for full background on SR-IOV switchdev mode.
