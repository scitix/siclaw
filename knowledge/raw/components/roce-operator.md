---
title: roce-operator
type: component
---

# roce-operator

roce-operator is a Kubernetes operator that manages IPAM (IP Address Management) for RoCE/SR-IOV networking. It assigns IP addresses to pod RDMA interfaces based on a topology-aware allocation chain that maps namespaces (or a static pool) → IPPools → topology units → leaf-switch subnets → individual IPs.

## When to use this page

Read this page when:
- A pod with RoCE network is stuck in `ContainerCreating` and the error mentions IPAM, "tenant", or "subnet"
- An `IPAllocation` CR shows `<nil>` or empty `address`
- You need to understand how a pod's RDMA IP was determined (which IPPool, which subnet, why)
- Investigating IP address leaks or subnet exhaustion
- Determining whether a cluster runs in single-tenant or multi-tenant mode

For verifying whether allocated configuration actually works at the OS level, see [[rdma-doctor]] @related — they are independent. For RoCE mode taxonomy and per-mode endpoint rules, see [[roce-modes]] @depends_on.

## Architecture

Three components, each with a distinct role:

| Component | Deployment | Role |
|-----------|-----------|------|
| **Manager** | Deployment, single replica with leader election | Central IPAM server, creates `IPAllocation` CRs, watches Pod/Node events |
| **Agent** | Per-node (DaemonSet or host service) | Proxy between node-local CNI plugin and cluster-level Manager |
| **CNI IPAM Plugin** | Host binary at `/opt/cni/bin/` | Called by kubelet during pod network setup |

The CNI plugin talks to the Agent over a Unix domain socket on the node. The Agent forwards to the Manager over HTTP through a ClusterIP service. This means:

- A node that cannot reach the cluster's ClusterIP network will fail ALL RoCE pod creations
- The Manager must be running before any RoCE pod can start
- The Agent must be running on every node that hosts RoCE pods

## IP Allocation Flow

```
Pod creation
  → kubelet invokes SR-IOV CNI
    → SR-IOV CNI invokes IPAM plugin (configured in NAD)
      → IPAM plugin → Agent (Unix socket)
        → Agent → Manager (HTTP POST)
          → Manager: lookup IPPool → lookup topology unit → lookup subnet → allocate IP
          → Manager creates IPAllocation CR with pod as ownerRef + finalizer
        ← IP returned through the chain
      ← CNI configures pod's network interface with allocated IP
```

The Manager keeps all allocations in memory. The `IPAllocation` CR is the persistence layer for crash recovery. On Manager restart, it reads all `IPAllocation` CRs back into memory and reallocates any with nil/invalid addresses.

## CRDs

Three CRDs in API group `roce.scitix.ai/v1`:

### Tenant (cluster-scoped, multi-tenant only)

Maps Kubernetes namespaces to an IPPool. One Tenant binds 1:1 to one IPPool.

Key fields:
- `spec.namespaces[]` — namespaces this tenant covers
- `status.boundIPPool` — currently bound IPPool (empty = not yet bound)

Binding lifecycle:
- **Bind**: on first pod allocation in a covered namespace, Manager binds an available IPPool
- **Unbind**: background loop every 30s — unbinds when active IP count for the tenant reaches zero

### IPPool (cluster-scoped)

Defines IP subnets for allocation. Each subnet maps to one physical network segment (typically one leaf switch).

Key fields:
- `spec.subnets[].name` — must match a `leaf` value in [[topology-config]] @depends_on
- `spec.subnets[].cidr` — subnet range
- `spec.subnets[].gateway` — gateway IP for this subnet
- `spec.subnets[].vlan` — VLAN tag (0 = no VLAN tagging)
- `spec.subnets[].mtu` — expected MTU; must match physical network MTU
- `spec.subnets[].routes[]` — static routes injected into pod
- `spec.subnets[].excludeIps` — reserved IPs (gateway, broadcast, etc.)

### IPAllocation (namespaced)

Created 1:1 with each RoCE pod. Owned by the pod (OwnerReference). Finalizer `roce.scitix.ai/ip-allocation` prevents premature deletion before IP is returned to pool.

Key fields:
- `spec.podUID` — must match the pod's UID; mismatch indicates a stale CR
- `spec.ipPool` — which IPPool was used
- `spec.unit` — topology unit name; must match the node's `roce.scitix.ai/unit` label
- `spec.allocations[ifName].address` — allocated IP in CIDR; `<nil>` or empty means allocation failed
- `spec.allocations[ifName].gateway`, `.vlan`, `.mtu`, `.routes` — per-interface network config

## The Allocation Chain

This is the most important diagnostic concept for this component. IP allocation traverses a chain; if any link is broken, allocation fails (often silently or with a generic error). Diagnose by walking the chain:

```
Pod (in namespace N)
  │
  ├─[multi-tenant]─→  Namespace N must be in a Tenant's spec.namespaces
  │                   └─→ Tenant must have an IPPool bound (or one available to bind)
  │
  ├─[single-tenant]─→ Manager env var ROCE_TOPOLOGY_STATIC_IPPOOL_NAME points to an IPPool
  │                   (Tenant lookup is skipped entirely)
  │
  ├─→ Pod's node has label roce.scitix.ai/unit = <some unit name>
  │   └─→ <unit name> must match a unit in the topology ConfigMap
  │       └─→ Each interface in the unit definition has a leaf field
  │           └─→ Each leaf must match a subnet name in the chosen IPPool
  │               └─→ Subnet must have available IPs
  │
  └─→ IPAllocation CR created with per-interface IP, gateway, MTU, VLAN, routes
```

See [[topology-config]] for the topology ConfigMap structure.

### Failure modes mapped to the chain

| Where chain breaks | Error / Symptom | Fix |
|--------------------|----------------|-----|
| Namespace not in any Tenant | `"not match any tenant"` | Add namespace to a Tenant's `spec.namespaces` |
| All IPPools already bound | `"all IPPool is inuse"` | Create new IPPool, or free one by deleting all pods of an unused Tenant |
| Node missing unit label | Allocation fails silently | Apply `roce.scitix.ai/unit=<unit>` label to the node |
| Unit name doesn't match topology | "unknown unit" or silent failure | Fix node label or topology ConfigMap to match |
| Topology `leaf` doesn't match IPPool subnet | `"unknown subnet"` | Align topology `leaf` field with IPPool `subnet.name` |
| Subnet exhausted | `"no available IP in subnet for interface"` | Expand CIDR, free IPs, or add more subnets |

## Single-Tenant vs Multi-Tenant Mode

Controlled by Manager env var `ROCE_TOPOLOGY_STATIC_IPPOOL_NAME`. Set → single-tenant (all pods use the named IPPool directly, Tenant CRs are ignored). Unset → multi-tenant (namespace → Tenant → bound IPPool).

In single-tenant mode, the `"not match any tenant"` and `"all IPPool is inuse"` errors are impossible — those are multi-tenant-only failure modes.

See [[tenant-isolation]] for how to determine the mode from a running cluster and for the cross-namespace diagnostic flow.

## Policy Routing

Implemented in the **CNI IPAM plugin** (not the Manager), activated per-interface when both `policyRouting: true` is set in the NAD's IPAM config AND the interface name matches `net[1-8]`. When active, each interface gets its own routing table and a source-subnet policy rule — multi-VF pods avoid main-table routing conflicts.

See [[policy-routing]] for the table/priority mapping, what the CNI plugin installs, and the IPPool `routes[]` quirk.

## NodeMeta Controller

A controller inside the Manager that automatically derives node annotations from a label.

Reads label `roce.scitix.ai/pf-names` (dot-separated PF interface names, e.g. `eth0.eth1`).

Writes annotations:
- `roce.scitix.ai/networks` — NAD references (CSV); the agent uses these when injecting RoCE networks into pods
- `roce.scitix.ai/resources` — RDMA resource names (CSV); SR-IOV device plugin reports VFs under these names

The mapping from PF count to specific NAD/resource names is configured via Manager env vars `ROCE_FULL_NETWORKS_DEFINITIONS` and `ROCE_FULL_RESOURCES_DEFINITIONS`. Legacy label `roce-netdevice` (also dot-separated) is supported as a fallback.

If annotations are missing on a node that should have them: check that the PF names label is present and the Manager env vars match the cluster's actual NAD/resource naming convention.

## State Management

All allocations are held in Manager memory. The `IPAllocation` CRs are the durable persistence.

**Crash recovery** (Manager restart):
- Phase 1: read all existing `IPAllocation` CRs, mark allocated IPs as in-use
- Phase 2: reallocate any interfaces with `<nil>` or invalid addresses

**IP release**: two mechanisms work together:
1. **Finalizer (primary)**: pod deletion → IPAllocation CR gets `DeletionTimestamp` → Manager's reconciler releases IP and removes finalizer
2. **Pod watcher (secondary)**: Manager watches for pods entering Failed/Succeeded → queues cleanup

If the Manager is down during pod deletion: IPs are not released until the Manager restarts and reads the CR with deletion timestamp.

**IP leak risk**: if an `IPAllocation` CR is manually deleted while the Manager is down, the Manager has no way to know the IP should be returned to the pool — it will think the IP is still in use forever.

## Critical Failure Modes

### FM-1: Pod stuck in ContainerCreating — IPAM failure

Walk the allocation chain from the top:

1. Manager pod healthy? Check pods in the roce-operator namespace
2. Agent running on the target node?
3. Unix socket present at `/run/roce-operator/agent.uds` on the node?
4. (Multi-tenant) Pod's namespace listed in some Tenant's `spec.namespaces`?
5. (Multi-tenant) IPPool available? Or all bound?
6. Node has `roce.scitix.ai/unit` label that matches the topology?
7. Subnet has available IPs?

### FM-2: Pod gets IP but RDMA traffic fails

The IPAllocation CR is valid, IP is assigned, but traffic doesn't flow. The fault is between allocation and OS-level effect:

- MTU mismatch: IPPool subnet MTU vs physical switch MTU
- VLAN mismatch: IPPool subnet VLAN vs switch port VLAN config
- Policy routing not active: `ip rule list` inside pod shows only default rules
- Wrong unit label: node assigned to wrong unit → IPs from wrong leaf subnet

Use [[rdma-doctor]] metrics to verify which layer is broken.

### FM-3: IP address leak

`IPAllocation` CRs exist for pods that no longer exist. Caused by Manager finalizer removal failure or Manager downtime during pod deletion.

Detect: compare `IPAllocation` `spec.podUID` against actual running pods.

Impact: ghost allocations consume subnet IPs → eventual subnet exhaustion.

### FM-4: SR-IOV VF allocation conflict

Symptom: new pod fails with `"pci address is already allocated"`, OR pod deletion fails with `"DeviceInfo not found"`.

**This is NOT a roce-operator bug** — it's an SR-IOV CNI + containerd interaction problem. A VF gets trapped in a stale pod sandbox's network namespace; new pods that get assigned the same VF can't use it.

Root cause chain:
1. Old pod stuck Terminating (containerd stop hung)
2. Force-delete or grace period expires → K8s reclaims the VF
3. But containerd still holds the netns where the VF lives
4. New pod gets same VF → SR-IOV CNI finds PCI already occupied → fails

Fix: identify the stale netns (from `crictl pods` + `crictl inspectp`), delete it with `ip netns delete <name>`. The VF will return to host namespace and become usable again.

Prevention: avoid force-deleting RoCE pods; drain RoCE pods before re-initializing SR-IOV VFs.

## See Also

- [[rdma-doctor]] @related — independent OS-level verifier of whether roce-operator's configuration actually works
- [[roce-modes]] @depends_on — RoCE mode taxonomy (legacy/switchdev/IPVLAN/MACVLAN); some failure modes only apply in specific modes
- [[topology-config]] @depends_on — topology ConfigMap structure that connects unit labels to leaf subnets
- [[policy-routing]] @related — per-interface routing tables for multi-VF pods
- [[tenant-isolation]] @related — multi-tenant mode and namespace-to-Tenant mapping
