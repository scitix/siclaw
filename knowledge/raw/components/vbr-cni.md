---
title: vbr-cni
type: component
---

# vbr-cni

vbr-cni (VLAN Bridge CNI) is a CNI plugin that creates 802.1Q VLAN sub-interfaces and Linux bridges to connect pods or VMs to VLAN networks. It is the primary networking plugin used by [[vce-operator]] for KubeVirt VM primary and secondary interfaces. **It is unrelated to RoCE/SR-IOV networking** — VCE Ethernet does not use SR-IOV.

## When to use this page

Read this page when:
- A VM (VCE) is running but has no network connectivity
- Pod with vbr-type NAD is stuck in `ContainerCreating`
- Determining which VLAN a VM is actually using
- Investigating why VLAN/bridge interfaces appear or don't appear on a node
- Diagnosing IPAM allocation failures on dynamic-IP vbr networks

For VM lifecycle and how vbr NADs are created, see [[vce-operator]] @related.

## The Network Stack vbr Builds

When a pod with a vbr NAD annotation is scheduled, kubelet calls the vbr CNI plugin, which builds this network stack on the host:

```
Physical NIC (e.g., bond0)
  │
  └─ vlan.<id>            802.1Q VLAN sub-interface (vbr creates if not exists)
       │
       └─ vbr.<id>        Linux bridge (vbr creates if not exists)
            │
            └─ vbrv<hex>   veth host side (attached to bridge)
                 │
                 └─ eth0   veth pod side (in pod's network namespace)
                          IP assigned (static or via IPAM server)
```

**Key behavior**: the VLAN sub-interface and bridge are **shared across all pods using the same VLAN on the same node**. They are created on the first pod and deleted when the last pod using that VLAN goes away.

## NAD Configuration

vbr supports two IP modes, distinguished by NAD config:

### Static IP (used by vce-operator)

vce-operator creates NADs with static IPs from VCE spec:

```json
{
  "cniVersion": "1.0.0",
  "type": "vbr",
  "name": "vce-eth0-net",
  "master": "<host-physical-iface>",
  "vlan": <vlan-id>,
  "ipNet": "<pod-ip>/<prefix>",
  "gateway": "<gateway-ip>"
}
```

### Dynamic IP (standalone usage)

For environments with a VPC IPAM server:

```json
{
  "cniVersion": "1.0.0",
  "type": "vbr",
  "name": "<nad-name>",
  "master": "<host-physical-iface>",
  "vlan": <vlan-id>,
  "dynamicIpNet": true,
  "ipamServer": "<host:port>",
  "instanceId": "<id>",
  "multiInstance": true
}
```

### Config field reference

| Field | Mode | Purpose |
|-------|------|---------|
| `master` | both | Host physical interface (parent for the VLAN sub-interface) |
| `vlan` | both | 802.1Q VLAN ID, 0-4094. 0 = no VLAN tag |
| `ipNet` | static | Pod IP in CIDR format |
| `gateway` | static | Default gateway IP |
| `dynamicIpNet` | dynamic | Set true to allocate from IPAM server |
| `ipamServer` | dynamic | IPAM server `host:port` |
| `instanceId` | dynamic | Identifier used by IPAM for allocation |
| `multiInstance` | dynamic | If true, append pod UID to instanceId |
| `mac` | optional | Custom MAC for pod interface |
| `routes` | optional | Additional static routes |
| `noDefaultRoute` | optional | Skip default route installation |

## CNI Operations

### ADD (pod creation)

1. Lock state file
2. If first pod on this VLAN: create `vlan.<id>` on master, create `vbr.<id>` bridge, attach VLAN to bridge
3. If dynamic mode: POST to IPAM server `/vpc/allocate` to get IP
4. Create veth pair: host side `vbrv<random>` attached to bridge, pod side `eth0` in pod netns
5. Assign IP, gateway, and routes on pod interface
6. Update state file, unlock

### DEL (pod deletion)

1. Lock state file
2. Delete pod veth
3. If dynamic mode: POST IPAM server `/vpc/release` to free IP
4. If last pod on this VLAN: delete bridge `vbr.<id>` and VLAN `vlan.<id>`
5. Update state file, unlock

### CHECK

Verifies the pod interface still exists by name in the pod netns. Returns error if missing.

## Deployment

- DaemonSet `vbr-deployer` copies the binary to `/opt/cni/bin/vbr` on each node
- Patches node label `vbr.scitix.ai/vbr-plugin-version=<version>` to indicate readiness
- State file: `/var/lib/cni/vbr/state` (JSON; tracks container → VLAN mappings for cleanup)
- Lock file: `/var/lib/cni/vbr/locker` (flock for concurrency safety)

If a node lacks the vbr binary, all pods with vbr NADs scheduled to it will fail at CNI ADD.

## Relationship to vce-operator

[[vce-operator]] creates vbr-type NADs for VM primary and secondary network interfaces. The mapping:

```
VCE spec field            → vbr NAD config field
─────────────────────────────────────────────────
spec.vlan                 → vlan
spec.ipNet                → ipNet
spec.gateway              → gateway
PRIMARY_INTERFACE_MASTER  → master (env var on vce-operator, default "bond0")

spec.secondaryVlan        → vlan (second NAD)
spec.secondaryIPNet       → ipNet
spec.secondaryGateway     → gateway
SECONDARY_INTERFACE_MASTER → master
```

VCE VMs may also have RDMA interfaces — those use SR-IOV NADs (not vbr) and go through [[roce-operator]] for IPAM.

## Identifying Which VLAN a VM Uses

VCE Ethernet interfaces don't use SR-IOV — they use veth pairs connected to vbr bridges. To trace from a VM to its actual VLAN, follow the netns chain:

1. Find the VM's sandbox container and netns:
   - `crictl pods | grep <vm-name>`
   - `crictl inspectp <sandbox-id>` and read the netns path (e.g. `/var/run/netns/cni-<uuid>`)
2. On the host, find veths attached to that netns:
   - `ip link show | grep <netns-id-fragment>`
   - Output shows `vbrv...@if<N>: ... master vbr.<vlan-id> ... link-netns cni-<uuid>`
3. The bridge name `vbr.<vlan-id>` contains the VLAN ID directly

The full host-side chain for a VM interface is:
```
bond0 → vlan.<vlan-id>@bond0 → vbr.<vlan-id> (bridge) → vbrv<hex>@ifN → pod netns (eth0)
```

## Failure Modes

### FM-1: Pod stuck in ContainerCreating (CNI ADD failed)

Walk the dependency chain:

| Check | If broken |
|-------|-----------|
| vbr binary on node? `ls /opt/cni/bin/vbr` | vbr-deployer DaemonSet not running on this node |
| Master interface exists? `ip link show <master>` | NAD config has wrong master, or interface not present (check vce-operator's `PRIMARY_INTERFACE_MASTER` env) |
| VLAN ID valid (0-4094)? | Invalid NAD config |
| VLAN already exists with different master? | Conflict — another NAD using same VLAN with different parent |
| IP conflict? `ip neigh show \| grep <ip>` | Another pod/VM has the same IP |

### FM-2: Pod/VM has no connectivity (CNI ADD succeeded but traffic fails)

This is the most common production issue. Diagnosis:

| Check | If broken | Likely cause |
|-------|-----------|-------------|
| Bridge state UP? `ip link show vbr.<vlan>` | Down | Local config issue |
| VLAN sub-interface UP? `ip link show vlan.<vlan>` | Down | Local config issue |
| veth correctly attached to bridge? | master is wrong | State file corruption |
| Gateway reachable? `kubectl exec <pod> -- ping <gateway>` | Unreachable | VLAN/switch issue (most common) |
| IP in correct subnet? | Mismatch | NAD misconfigured |

**High-frequency production cause**: VM starts normally, node-side vbr/VLAN bridge config is correct, but no connectivity. Almost always means the host's physical port (bond0 or whichever master) is **not configured to trunk this VLAN on the upstream switch**. Node side is automatic (vbr creates `vlan.<id>` on demand); switch side needs network ops to add the VLAN to the trunk.

### FM-3: Dynamic IPAM allocation fails

Only applies to dynamic-IP NADs (not used by vce-operator's static IPAM):
- IPAM server reachable? `curl -s http://<ipamServer>/health` from node
- VPC has available IPs? Check IPAM server logs
- `instanceId` correct? With `multiInstance=false`, an instance with an existing IP can't get another → conflict

### FM-4: State file corruption (orphaned interfaces)

If vbr state gets corrupted (e.g., node crash during ADD), VLAN/bridge interfaces may persist after their pods are gone:

```bash
# State file
cat /var/lib/cni/vbr/state

# List all vbr-managed interfaces
ip link show type bridge | grep vbr
ip link show type vlan | grep vlan

# Manual cleanup IF SAFE (no pods using this VLAN)
ip link del vbr.<id>
ip link del vlan.<id>
```

Verify no pods are using a VLAN before deleting its bridge/VLAN interface.

## Diagnostic Commands

```bash
# Cluster-level
kubectl get ds -A | grep vbr
kubectl get nodes -l vbr.scitix.ai/vbr-plugin-version
kubectl get net-attach-def -n <ns> -o yaml

# Node-level (via node_exec)
ls -la /opt/cni/bin/vbr
ip link show type bridge | grep vbr
ip link show type vlan | grep vlan
cat /var/lib/cni/vbr/state
ip link show | grep <pod-netns-fragment>
```

## See Also

- [[vce-operator]] @related — primary consumer of vbr-cni; creates vbr NADs for VM primary/secondary networks
- [[roce-operator]] @related — separate IPAM system for RDMA/SR-IOV interfaces; VMs may have both vbr (Ethernet) and SR-IOV (RDMA) interfaces
