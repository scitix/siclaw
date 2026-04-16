---
title: RoCE Modes
type: concept
---

# RoCE Modes

A cluster runs RoCE (RDMA over Converged Ethernet) in one of four modes. The mode determines:
- Whether the PF (physical function) is a network endpoint or a switch fabric
- Which diagnostic tools apply at which level
- What "normal" looks like — many "failures" in one mode are expected behavior in another
- Where RDMA traffic flows (PF directly, through VFs, or through virtual interfaces)

**Misidentifying the mode is the single most common cause of misdiagnosis** in RoCE investigations.

## When to use this page

Read this page when:
- You're investigating any RoCE issue and don't yet know the cluster's mode
- A diagnostic tool reports "expected" behavior that you're tempted to flag as a problem (e.g., PF cannot ping gateway in switchdev)
- Determining which connectivity test (node-level vs pod-level) is valid in this cluster
- Understanding why [[gid-consistency]] is a problem in some modes but not others

## The Four Modes

| Mode | NAD type | eSwitch | PF role | VFs? | RDMA netns | Test connectivity from |
|------|----------|---------|---------|------|------------|------------------------|
| **SR-IOV Legacy** | `sriov` | `legacy` | Network endpoint | Yes | shared or exclusive | Node OR pod |
| **SR-IOV Switchdev** | `sriov` | `switchdev` | **Embedded switch** (NOT endpoint) | Yes (with representors) | exclusive | **Pod only** |
| **IPVLAN** | `ipvlan` | n/a | Parent interface | No | shared | Node OR pod |
| **MACVLAN** | `macvlan` | n/a | Parent interface | No | shared | Node OR pod |

## How to Determine the Mode

Always do this first when investigating any RoCE issue:

1. Check `cluster_info` for keywords: `sriov`/`SR-IOV`, `ipvlan`, `macvlan`, `legacy`, `switchdev`
2. Check NetworkAttachmentDefinitions:
   ```bash
   kubectl get net-attach-def -A
   kubectl get net-attach-def <name> -n <ns> -o jsonpath='{.spec.config}'
   ```
   Look for `"type": "sriov"` / `"ipvlan"` / `"macvlan"` in the CNI config.
3. If SR-IOV, determine sub-mode: run `roce-show-node-mode` on a Ready RoCE node. Check eSwitch mode: `legacy` or `switchdev`.

```
NAD type    eSwitch    Mode
sriov       legacy     SR-IOV legacy
sriov       switchdev  SR-IOV switchdev
ipvlan      —          IPVLAN
macvlan     —          MACVLAN
no NAD      —          RoCE not configured
```

## SR-IOV Legacy

In legacy mode, the NIC's SR-IOV capability creates Virtual Functions (VFs) that are **independent network endpoints**:

- The **PF** is a full network endpoint with its own IP, MAC, and RDMA device
- Each **VF** is also independent, assigned to pods via the SR-IOV device plugin
- PF and VFs operate in parallel — both can send/receive RDMA traffic
- No VF representors on the PF side (unlike switchdev)
- RDMA netns mode is typically **shared** or **exclusive**

Tools that work: all of them — node-level (PF) and pod-level (VF) tests both produce meaningful results.

## SR-IOV Switchdev

**Switchdev is a normal, intended production configuration** for hardware-offloaded SR-IOV. It is NOT an error or misconfiguration. Do NOT suggest "switching to legacy".

In switchdev mode, the PF becomes an **embedded switch**:

- The PF acts as switch fabric — forwards traffic between VFs and uplink, but does not send/receive its own data traffic
- Each VF has a **representor netdev** on the PF side (e.g., `eth0_0`, `eth0_1`)
- All RoCE traffic flows through **VFs assigned to pods** — this is the only data path
- RDMA netns mode is typically **exclusive**
- The PF itself has **no usable RoCE endpoint**

```
Pod A (VF0) ──→ NIC embedded switch (PF) ──→ Uplink ──→ Physical switch
                      │
Pod B (VF1) ──────────┘
```

Tools that work in switchdev:

| Tool | Use? | Note |
|------|------|------|
| Pod-to-pod connectivity | YES | The actual data path |
| **Node-to-node (PF) connectivity** | **NO** | PF is a switch — will fail or produce meaningless results |
| Pod gateway ping | YES | Correct test for connectivity |
| **PF gateway ping** | **NO** | PF cannot send regular traffic — **fails, this is EXPECTED** |
| `roce-show-node-mode` | YES | Confirm switchdev |
| `roce-check-node-config` | YES | Validate labels, resources, NADs |

## IPVLAN

IPVLAN creates virtual interfaces that share the **same MAC address** as the parent (PF) but have their own IP:

- The PF acts as the parent interface
- Each pod gets an IPVLAN sub-interface with its own IP but the parent's MAC
- No SR-IOV — no VFs, no eSwitch mode (`sriov_numvfs = 0` is correct here)
- RDMA netns mode is typically **shared** — all RDMA devices visible in all namespaces
- RoCE traffic from pods uses the PF's RDMA device, distinguished by IP

IPVLAN sub-modes (in NAD config): **L2** (default, same broadcast domain) or **L3** (routed). Affects routing/ARP but not RDMA.

Tools that work: all of them, including node-level tests (PF is an active endpoint).

## MACVLAN

MACVLAN creates virtual interfaces with **unique MAC addresses** derived from the parent (PF):

- Each pod gets a MACVLAN sub-interface with a unique MAC and its own IP
- No SR-IOV — no VFs, no eSwitch mode
- RDMA netns mode is typically **shared**
- Host (PF) **cannot communicate with its own MACVLAN sub-interfaces** by default — this is a well-known MACVLAN limitation

MACVLAN modes: **bridge** (pods communicate directly), **private** (fully isolated), **vepa** (hairpin through switch), **passthru** (single sub-interface).

### MACVLAN vs IPVLAN

| Aspect | MACVLAN | IPVLAN |
|--------|---------|--------|
| MAC address | Unique per sub-interface | Shared with parent |
| Switch compatibility | Switch must allow multiple MACs per port | No extra switch config |
| Host ↔ pod (same node) | Blocked by default | Works in L2 mode |

## Normal Phenomena That Look Like Failures

These observations appear in different modes and are **expected behavior**, not faults. Misreporting them is the most common diagnostic error.

| Observation | Why it's normal | Applies to |
|-------------|----------------|------------|
| PF ping/connectivity fails | PF is a switch in switchdev | **Switchdev only** |
| VFs showing DOWN in `rdma link` | VFs activate when assigned to a pod | SR-IOV (both) |
| Dual-port NIC with one port DOWN | Common in production — only one port cabled | All modes |
| Large number of RDMA devices on host | Expected in exclusive netns with many VFs | Switchdev |
| All RDMA devices visible inside pod | Expected in shared netns mode | IPVLAN, MACVLAN, Legacy (shared) |
| Host-to-pod ping fails on MACVLAN | MACVLAN isolation prevents host↔own-pod on same node | MACVLAN |
| `sriov_numvfs = 0` | No SR-IOV in IPVLAN/MACVLAN — correct | IPVLAN, MACVLAN |

## Endpoint Applicability Quick Reference

| Test type | Legacy | Switchdev | IPVLAN | MACVLAN |
|-----------|--------|-----------|--------|---------|
| Node-to-node (PF) connectivity | ✓ | **✗** PF is switch | ✓ | ✓ |
| Pod-to-pod (VF/sub-if) connectivity | ✓ | ✓ data path | ✓ | ✓ |
| PF gateway ping | works | **fails — expected** | works | works |
| Pod gateway ping | works | works | works | works cross-node; fails same-node |

## Mode-Specific Diagnostic Anchors

When investigating a RoCE issue, after determining the mode, use these starting points:

**Switchdev**: NEVER test from the PF. Always use a RoCE pod's VF. If no pods exist on the node, suggest creating a test pod before declaring the network broken.

**Legacy**: Both PF and VF tests work. PF test isolates physical network from VF/pod issues; VF test validates the actual data path used by workloads.

**IPVLAN**: PF tests work. In shared netns, pods see all RDMA devices — must specify exact device with `--server-device`/`--client-device` to test the right one. [[gid-consistency]] is a real risk here.

**MACVLAN**: Same as IPVLAN, plus: same-node host-to-pod tests will fail (MACVLAN isolation). Test cross-node.

## See Also

- [[roce-operator]] @related — IPAM operator that allocates IPs in any mode
- [[rdma-doctor]] @related — verifies network state at OS level; some failures are expected per mode (see Normal Phenomena above)
- [[gid-consistency]] @related — concurrent pod creation in IPVLAN/MACVLAN can cause inconsistent GID indices; SR-IOV is immune
- [[tenant-isolation]] @related — orthogonal concern that applies in any mode
