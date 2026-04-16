---
title: vce-operator
type: component
---

# vce-operator

vce-operator (Virtual Compute Engine) manages KubeVirt VMs for multi-tenant GPU compute. It handles the full VM lifecycle: rootfs preparation, multi-network setup (Ethernet via [[vbr-cni]] + RDMA via [[roce-operator]]), cloud-init injection, start/stop, online disk resize, and cleanup.

## When to use this page

Read this page when:
- A `VirtualComputeEngine` (VCE) CR is stuck in `Creating` or `Starting`
- A VM is in `Terminating` and not deleting within timeout
- Investigating which step of VM creation failed (rootfs, NAD, KubeVirt VM)
- Determining whether an issue is with the VM itself, its network ([[vbr-cni]] / [[roce-operator]]), or its storage ([[scitix-csi-plugins]])
- Understanding rootfs storage modes (hostPath GPFS vs PVC local)

## Resource Dependency Graph

A VCE CR triggers creation of multiple downstream resources. Each is independently observable; failures localize:

```
VirtualComputeEngine (VCE) CR
  │
  ├─→ RootFS preparation
  │     hostPath mode (default): operator copies image directly on GPFS, no PVC
  │     PVC mode (local/shared): operator creates PVC, CSI rootfs driver handles
  │       (StorageClass = <storageType>-<imageId>)
  │     Ready marker: "ready" file when complete
  │
  ├─→ Cloud-init Secret (<vce-name>-cloudinit)
  │     Contents: #cloud-config YAML (password, SSH keys, userdata)
  │     Referenced by: KubeVirt VM CloudInitNoCloud volume
  │
  ├─→ NetworkAttachmentDefinitions (NADs)
  │     eth0 (primary):   type=vbr, master=<bond>, vlan, ipNet from spec
  │     eth1 (secondary): type=vbr, optional second VLAN
  │     RDMA interfaces:  type=sriov, one per spec.infinibands[] entry
  │
  └─→ KubeVirt VirtualMachine
        References: cloud-init Secret + NADs + GPU device requests
        Managed by: KubeVirt's virt-controller (separate operator)
```

## CRD: VirtualComputeEngine (vce.scitix.ai/v1)

Short names: `vce`, `vces`. Namespaced resource.

### Spec — what the user requests

| Field | Mutable | Diagnostic meaning |
|-------|---------|-------------------|
| `hostname`, `userId` | No | VM hostname and tenant identifier |
| `cpus`, `memory` | No | Resource requests; must fit on node |
| `gpus` (map type → count) | No | GPU type and quantity (e.g. `nvidia.com/a10: 2`) |
| `infinibands` ([]string) | No | Existing SR-IOV NAD names; each becomes an RDMA interface |
| `vlan`, `ipNet`, `gateway` | No | Primary network (Ethernet) — see [[vbr-cni]] |
| `secondaryVlan`, `secondaryIPNet`, `secondaryGateway` | No | Secondary network (optional) |
| `nameservers` ([]string) | No | DNS servers for cloud-init |
| `rootfsStorageType` | No | "hostPath" (default), "local", or "shared" — determines storage path |
| `rootfsImageId`, `rootfsImageType` | No | OS image identifier; must exist in `/data/area-0/images/<type>/` |
| `rootfsSize` | **Yes** | Disk size; can be increased online via qemu-img resize |
| `nodeSelectors` | No | K8s node selector labels |
| `stop` | **Yes** | true → stop VM, false → start |
| `password`, `sshPublicKeysBase64`, `userDataBase64` | No | Cloud-init injection (validated before VM creation) |

### Status — what's actually happening

| Field | Meaning |
|-------|---------|
| `phase` | Lifecycle state (see below) |
| `reason` | Brief error reason on failure |
| `conditions[]` | Per-step status — find the first `False` condition to locate the stuck step |

**Phase lifecycle:**

```
Pending → Creating → Created → Starting → Running
                                    ↓
                              Stopping → Stopped
                                    ↓
                           Terminating → Terminated
                        (any phase) → Failed
```

**Conditions** (each independently tracks one preparation step):

| Condition | Meaning when False |
|-----------|-------------------|
| `OperatorSeen` | Operator hasn't processed this VCE yet |
| `RootfsPrepared` | Image copy / PVC binding failed or pending |
| `RootfsResized` | qemu-img resize failed |
| `CloudInitPrepared` | Cloud-init validation failed (bad SSH key, password decrypt, userdata too large) |
| `NadPrepared` | NAD creation failed (network config issue) |
| `VmPrepared` | KubeVirt VM creation failed |
| `VmStopped` | Stop operation failed |

## VM Lifecycle Details

### Creation

1. Operator adds finalizer → phase `Creating`
2. Verify rootfs image exists at `/data/images/<imageType>/<imageId>`
3. Prepare rootfs (mode-specific, see below) → "ready" marker
4. `qemu-img resize` to `spec.rootfsSize`
5. Build cloud-init YAML — validate SSH keys (must match `ssh-(rsa|ed25519|ecdsa-*|dss) <key>`), decrypt password (AES-CFB), validate userdata (base64, max 32KB, UTF-8)
6. Create cloud-init Secret
7. Create NADs — vbr-type for Ethernet, sriov-type for RDMA
8. Create KubeVirt VirtualMachine → phase `Created`
9. Start VM → phase `Running`

### Deletion

1. Phase `Terminating`
2. Delete KubeVirt VM, poll every 5s, timeout 2 minutes
3. Delete all NADs
4. Remove rootfs (mark with "deleted" flag)
5. Remove finalizer → phase `Terminated`

### Stop / Start (mutable)

- `spec.stop: true` → KubeVirt Stop → phase `Stopped`
- `spec.stop: false` → KubeVirt Start → phase `Running`

### Online Resize

Changing `spec.rootfsSize` triggers `qemu-img resize` on the disk image. No VM restart needed if guest OS supports online resize (e.g., `growpart` + `resize2fs`).

## Network Configuration

vce-operator creates NADs for each VM interface. Per-interface mapping:

| VM interface | NAD type | Config source | Component |
|-------------|----------|---------------|-----------|
| `eth0` (primary Ethernet) | `vbr` | `spec.vlan`, `spec.ipNet`, `spec.gateway` | [[vbr-cni]] |
| `eth1` (secondary Ethernet, optional) | `vbr` | `spec.secondaryVlan`, etc. | [[vbr-cni]] |
| RDMA interfaces (`ib-0`, `ib-1`, ...) | `sriov` | Each entry in `spec.infinibands[]` is an existing SR-IOV NAD name | [[roce-operator]] |

Master interface for vbr NADs is controlled by env vars on vce-operator:
- `PRIMARY_INTERFACE_MASTER` (default: `bond0`)
- `SECONDARY_INTERFACE_MASTER` (default: same as primary)

## Rootfs Storage: Two Distinct Modes

This is the most important diagnostic distinction for failure mode 1. The mode determines where rootfs lives, who handles it, and where to look when it fails.

| | hostPath mode | PVC mode |
|---|---|---|
| `rootfsStorageType` value | empty or `"hostPath"` | `"local"` or `"shared"` |
| Implementation | Operator copies image with `io.Copy` directly | Operator creates PVC; [[scitix-csi-plugins]] rootfs driver handles via qemu-img |
| Backend storage | GPFS (shared across cluster) | Local disk (`local` mode, primary) or GPFS (`shared` mode) |
| Path | `/data/area-0/rootfs/<userId>/<vce>/disk.img` | Determined by CSI |
| Has PVC? | No | Yes — `kubectl get pvc -n <ns>` shows it |
| Failure radius | GPFS fault → all hostPath VCEs cluster-wide | Local disk fault → only that node's VCEs |
| Diagnostic entry | Node `/data/area-0/` + GPFS mount state | PVC status → CSI provisioner / node plugin logs |

**Detection**: `kubectl get vce <name> -o jsonpath='{.spec.rootfsStorageType}'`
- Empty or `"hostPath"` → hostPath mode
- `"local"` → PVC mode (local disk, currently the recommended/primary mode)
- `"shared"` → PVC mode (shared GPFS via CSI)

## Failure Modes

### FM-1: VCE stuck in `Creating`

The diagnostic anchor is `status.conditions` — find the first `False` condition.

**Step 1: Identify the failing step**

```bash
kubectl get vce <name> -o yaml
```

Conditions appear in creation order. The first `False` is where it stuck. `status.reason` usually has a one-line error.

**Step 2: Identify the target node**

```bash
# If VM exists, check VMI scheduling
kubectl get vmi <name> -n <ns> -o jsonpath='{.status.nodeName}'

# Otherwise, check candidate nodes from spec
kubectl get vce <name> -o jsonpath='{.spec.nodeSelectors}'
kubectl get nodes -l <key>=<value>
```

**Step 3: Drill into the failed condition**

#### `RootfsPrepared=False`

**First determine the mode** (hostPath vs PVC). Then:

For **hostPath mode**:
```bash
# GPFS mounted on node? (hostPath depends on it)
mount | grep gpfs
df -h /data/area-0/

# Source image exists?
ls -la /data/area-0/images/<imageType>/<imageId>

# Rootfs directory state?
ls -la /data/area-0/rootfs/<userId>/<vce-name>/
# disk.img + "ready" marker → done
# "deleted" marker → cleanup in progress

# GPFS space?
df -h /data/area-0/
```

For **PVC mode**:
```bash
# PVC bound?
kubectl get pvc -n <ns> | grep <vce-name>
# Pending → CSI provisioner issue
# Bound → CSI node plugin issue at mount

# If Pending:
kubectl describe pvc <vce-name> -n <ns>
kubectl get sc | grep <storageType>

# CSI provisioner / node plugin logs
kubectl get pods -n scitix-system -l app=csi-provisioner
kubectl logs -n scitix-system -l app=csi-provisioner -c csi-provisioner --tail=100 | grep -i "rootfs\|error"
kubectl logs -n scitix-system -l app=csi-plugin -c csi-plugin --tail=100 | grep -i "rootfs\|error"

# Node-level for local mode
df -h /data/local-0/
```

See [[scitix-csi-plugins]] for CSI driver details.

#### `CloudInitPrepared=False`

Validation failed before VM creation. Common causes (no node access needed):
- SSH key wrong format (must be `ssh-(rsa|ed25519|ecdsa-*|dss) <base64key>`)
- userdata exceeds 32KB
- Password decryption failed (encryption format mismatch)

```bash
kubectl logs -n <vce-ns> -l app.kubernetes.io/name=vce-operator --tail=200 | grep <vce-name>
```

#### `NadPrepared=False`

NAD creation failed.

```bash
# Did NADs get created?
kubectl get net-attach-def -n <ns>

# Operator logs
kubectl logs -n <vce-ns> -l app.kubernetes.io/name=vce-operator --tail=200 | grep -i "nad\|network"

# Master interface exists on node?
ip link show <master-name>
# "Device not found" → wrong PRIMARY_INTERFACE_MASTER env on vce-operator
```

See [[vbr-cni]] for vbr NAD config; see [[roce-operator]] for sriov NAD config.

#### `VmPrepared=False`

KubeVirt VM creation failed.

```bash
# VM created?
kubectl get vm <name> -n <ns>

# If yes but not running, check events
kubectl describe vm <name> -n <ns>

# Node has requested resources?
kubectl describe node <node> | grep -A10 "Allocated resources"

# KubeVirt healthy?
kubectl get pods -n kubevirt -l kubevirt.io=virt-controller
```

#### All conditions True but still `Creating`

Operator itself stuck:
```bash
# Pod healthy?
kubectl get pods -n <vce-ns> -l app.kubernetes.io/name=vce-operator

# Leader election (2 replicas, only leader works)
kubectl logs -n <vce-ns> -l app.kubernetes.io/name=vce-operator --tail=50 | grep -i "leader"

# Crash/restart history
kubectl describe pod -n <vce-ns> -l app.kubernetes.io/name=vce-operator | grep -A5 "Last State"
```

### FM-2: VCE stuck in `Starting`

VM was created, KubeVirt cannot start it.

- VMI scheduled? `kubectl get vmi -n <ns>`
- VMI events? `kubectl describe vmi <name> -n <ns>`
- GPU available on node? `kubectl get node <node> -o json | jq '.status.allocatable'`
- Node has the labels in `spec.nodeSelectors`?

### FM-3: VCE network unreachable after `Running`

Phase is `Running`, VM boots, but no network connectivity.

- NADs correct? `kubectl get net-attach-def -n <ns> -o yaml`
- For Ethernet: see [[vbr-cni]] FM-2 (most common: physical switch trunk not configured for the VLAN)
- For RDMA: see [[roce-operator]] and [[rdma-doctor]]
- IP conflict? Another VM with the same IP

### FM-4: VCE stuck in `Terminating`

VM not deleting within 2-minute timeout.

- KubeVirt VM still exists? `kubectl get vm -n <ns>`
- VMI still running? `kubectl get vmi -n <ns>`
- KubeVirt virt-controller healthy?
- If VM gone but VCE still Terminating → operator logs for NAD/rootfs cleanup errors

## Diagnostic Commands

```bash
# Discover operator
kubectl get deploy -A -l app.kubernetes.io/name=vce-operator

# All VCEs cluster-wide
kubectl get vce -A -o wide

# Specific VCE state
kubectl get vce <name> -n <ns> -o yaml

# KubeVirt VMs / VMIs
kubectl get vm -n <ns> -o wide
kubectl get vmi -n <ns> -o wide

# NADs created for VM
kubectl get net-attach-def -n <ns>

# Node-level (hostPath mode)
ls -la /data/area-0/rootfs/<vce-name>/
ls -la /data/area-0/images/

# Operator logs
kubectl logs -n <vce-ns> -l app.kubernetes.io/name=vce-operator --tail=100
```

## See Also

- [[vbr-cni]] @related — provides Ethernet networking (eth0, eth1) for VMs via VLAN bridge
- [[roce-operator]] @related — provides RDMA IPAM for VMs that have `spec.infinibands[]`
- [[scitix-csi-plugins]] @related — provides rootfs PVC backend in PVC mode
