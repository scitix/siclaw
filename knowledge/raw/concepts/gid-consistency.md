---
title: GID Consistency
type: concept
---

# GID Consistency

GID (Global Identifier) consistency is one of the most common and most-misdiagnosed causes of NCCL communication failure in RoCE clusters. This page explains why it happens, when it matters, and when it can be ruled out.

## When to use this page

Read this page when:
- NCCL training fails with timeouts or "no path" errors and you've ruled out gateway/IPAM issues
- A pod has multiple RDMA interfaces (multi-VF / multi-rail training)
- The cluster runs in IPVLAN or MACVLAN mode and pods were created concurrently
- You see different GID indices for IPv4-mapped GIDs across a pod's RDMA devices

For mode-specific context (this issue only matters in some modes), see [[roce-modes]] @depends_on.

## What GIDs Are

Each RDMA device maintains a **GID table** — a list of (IP, GID) entries. Each entry has an index. NCCL and other RDMA libraries use a GID **index** to select which IP/path to communicate over.

A pod with multiple RDMA devices typically wants:
- Device A's GID for its IP at some index
- Device B's GID for its IP at the same index
- So a single `--gid-index` flag works for both devices

## Why Inconsistency Happens (IPVLAN/MACVLAN)

In IPVLAN/MACVLAN mode, secondary network interfaces created by the CNI plugin get GID entries in a **shared** RDMA device's GID table. The GID index assigned depends on the order in which interfaces are created.

When multiple pods are created concurrently on the same node:
1. Each pod's CNI invocations run in parallel
2. CNI plugin operations across pods interleave
3. The interleaving determines the order of IP additions to the GID table
4. Two RDMA devices in the same pod may end up with **different GID indices** for their respective IPs

Example: device A uses GID index 2 for its IP, but device B uses GID index 6 for its IP. NCCL configured with a single `--gid-index` cannot work for both.

## Why SR-IOV Is Immune

In SR-IOV mode, each VF is a **separate** RDMA device with its own GID table. Each VF's table starts fresh from index 0 and contains only the GIDs for that specific VF.

This means: indices are inherently consistent across all devices visible in a pod, because each device's table is independent. Concurrent pod creation cannot interleave because each pod's VFs are separate hardware contexts.

Conclusion: **if the cluster is SR-IOV (legacy or switchdev), GID consistency is not a possible cause of NCCL failure.** Skip this check entirely and look elsewhere.

## Why It Breaks NCCL

NCCL selects GIDs in one of two ways:
1. **Fixed GID index** (via `NCCL_IB_GID_INDEX` or auto-detection of a single index) — fails when devices have different indices for their IPs
2. **IP range matching** (via `NCCL_IB_ADDR_RANGE`) — works correctly even with mismatched indices because NCCL matches by IP, not index

Without `NCCL_IB_ADDR_RANGE`, NCCL has no way to resolve the correct GID per device when indices differ. Communication setup fails or hangs.

## Detection

Use the diagnostic skills:

- **Pod-level**: `roce-pod-show-gids` — returns raw GID table from a pod's network namespace (does not require RDMA tools inside the pod; uses host-side enumeration)
- **Node-level**: `check-gid-node.sh <pf1> [pf2 ...]` via `node_script` — returns raw GID table per PF

Look at the output: for each RDMA device, find the IPv4-mapped GIDs. They look like:

```
0000:0000:0000:0000:0000:ffff:<ipv4-hex>
```

Compare the **index** of these entries across devices.

## Interpretation

| Observation | Verdict |
|------------|---------|
| Same IPv4-mapped GID index across all devices | **OK** — not the cause of NCCL issue |
| Different indices, but `NCCL_IB_ADDR_RANGE` env var is set on pod and covers RoCE IP range | **WARN** — inconsistent but mitigated; should still work for NCCL |
| Different indices, no `NCCL_IB_ADDR_RANGE` (or doesn't cover) | **FAIL** — likely cause of NCCL communication failure |

## Mitigation

Two strategies:

1. **Set `NCCL_IB_ADDR_RANGE`** on pods that may experience this issue. This is the more robust mitigation — works regardless of GID index assignment.
2. **Avoid concurrent pod creation** on the same node when in IPVLAN/MACVLAN mode. Stagger pod scheduling. Less reliable but reduces the chance of inconsistency.

Long-term, switching to SR-IOV eliminates the issue entirely (at the cost of needing SR-IOV-capable NICs and configuration).

## Diagnostic Order

When investigating possible GID consistency issue:

1. **Determine the mode** first (see [[roce-modes]]). If SR-IOV → skip this check, look elsewhere.
2. If IPVLAN/MACVLAN, run `roce-pod-show-gids` on the affected pod
3. Find IPv4-mapped GIDs, compare indices across devices
4. If inconsistent: check pod env for `NCCL_IB_ADDR_RANGE`
5. If absent or doesn't cover the IP range → root cause confirmed

## See Also

- [[roce-modes]] @depends_on — this issue only applies in IPVLAN/MACVLAN, never SR-IOV
- [[roce-operator]] @related — IPAM that creates the IPs; not directly involved in GID assignment but provides the IPs that get added to the GID table
