---
title: Topology ConfigMap
type: concept
---

# Topology ConfigMap

The topology ConfigMap is the bridge between the cluster's logical IP allocation system ([[roce-operator]]) and its physical network topology. It maps **node groups (units)** to the **leaf switches (subnets)** their interfaces connect to. Without it, the IPAM cannot determine which subnet to use for a given pod's network interface.

## When to use this page

Read this page when:
- A pod gets `"unknown subnet"` or "unknown unit" error during IPAM
- You need to understand how a pod's interface ends up assigned to a specific subnet
- A node label `roce.scitix.ai/unit` doesn't seem to be respected
- Adding a new RoCE node and wondering what topology entries are needed
- IPPool subnet names need to be aligned with topology

## Location

Default: `kube-system/roce-topology-config` ConfigMap, key `topology.yaml`.

Configurable via [[roce-operator]] Manager env vars:
- `ROCE_TOPOLOGY_CONF_NAMESPACE` (default: `kube-system`)
- `ROCE_TOPOLOGY_CONF_NAME` (default: `roce-topology-config`)

The Manager watches this ConfigMap and reloads on update.

## Structure

```yaml
pods:
  - name: <pod-template-name>
    units:
      - name: <unit-name>           # must match node label roce.scitix.ai/unit
        interfaces:
          - name: <if-name>         # must match SR-IOV CNI ifName (e.g. eth0, net1)
            leaf: <subnet-name>     # must match an IPPool subnet's spec.subnets[].name
          - name: <if-name>
            leaf: <subnet-name>
      - name: <another-unit>
        interfaces: [...]
```

Top level is `pods[]`, but in practice this typically has one entry. The meaningful structure is `units[].interfaces[]`.

## Physical Meaning

- A **unit** represents a group of nodes with identical network connectivity (same upstream switches, same uplink design)
- Each **interface** in a unit corresponds to one PF / NIC on the nodes in that unit
- The `leaf` field on each interface names the leaf switch (or its associated subnet) that interface connects to

Two interfaces in the same unit connecting to **different leaves** = dual-rail or dual-uplink design (each NIC on a separate fabric path). This is common in production GPU clusters for fault tolerance and bandwidth aggregation.

## How It Connects to IPAM

The topology is one link in [[roce-operator]]'s allocation chain:

```
Pod's node has label  roce.scitix.ai/unit = U
  └─→ Topology ConfigMap: find unit named U
      └─→ For each interface in U.interfaces:
          └─→ Find IPPool subnet where subnet.name == interface.leaf
              └─→ Allocate IP from that subnet
```

The runtime agent of [[roce-operator]] uses this lookup at every IPAM allocation request.

## The Three Name Alignments

The topology ConfigMap is the *junction point* of three independent naming systems. All three must align for IPAM to work:

| Topology field | Must match | Where the matching value comes from |
|----------------|-----------|------------------------------------|
| `units[].name` | Node label `roce.scitix.ai/unit` value | Set by ops on each node |
| `interfaces[].name` | Interface name passed to SR-IOV CNI (`ifName` in NAD config) | NAD configuration |
| `interfaces[].leaf` | IPPool `subnets[].name` | IPPool CRD definition |

Mismatch in any one breaks allocation:

| Mismatch | Symptom |
|----------|---------|
| Unit name vs node label | Pod can't find topology → IP allocation fails |
| Interface name vs CNI ifName | Interface gets no IP from this allocation |
| Leaf vs subnet name | `"unknown subnet"` error |

## Adding a New Unit / Node

When ops onboards a new RoCE node group, the topology ConfigMap typically needs an entry. Process:

1. Confirm physical wiring: which leaf switches do the new nodes' NICs connect to?
2. Choose a unit name (e.g. `unitN+1`)
3. For each NIC on the nodes, determine its `leaf` (the subnet name in [[roce-operator]]'s IPPool)
4. Add a new unit entry to the topology ConfigMap
5. Apply the unit name as a label `roce.scitix.ai/unit=<name>` on each new node
6. If the leaf doesn't exist as a subnet yet, also add it to the IPPool first

## Verifying the Configuration

```bash
# View topology
kubectl get cm roce-topology-config -n kube-system -o jsonpath='{.data.topology\.yaml}'

# Node unit labels
kubectl get nodes -l roce.scitix.ai/unit -o custom-columns='NAME:.metadata.name,UNIT:.metadata.labels.roce\.scitix\.ai/unit'

# IPPool subnet names (must contain all leaf names from topology)
kubectl get ippool.roce.scitix.ai <pool-name> -o jsonpath='{.spec.subnets[*].name}'
```

Cross-check: every `leaf` value in topology must appear as a `subnets[].name` in the bound IPPool. Every node's label value must appear as a unit name in topology.

## Common Misconfigurations

| Misconfiguration | Effect |
|------------------|--------|
| `leaf` value typo (e.g. `leaf03` vs `leaf003`) | `"unknown subnet"` for any pod scheduled to a node in that unit |
| Unit defined in topology but no node labeled with it | Topology entry is dead — harmless but indicates ops gap |
| Node labeled but unit missing in topology | Pods scheduled there fail IPAM silently |
| Interface name mismatch with NAD ifName | Specific interface gets no IP, pod has partial network |
| Same `leaf` referenced by multiple units (legitimate in shared-fabric topology) | OK — multiple units can share the same leaf subnet |

## See Also

- [[roce-operator]] @depends_on — uses this ConfigMap during every IPAM allocation
- [[tenant-isolation]] @related — tenant binds to IPPool, IPPool defines subnets, topology maps to subnets
