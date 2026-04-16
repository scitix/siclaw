---
title: scitix-csi-plugins
type: component
---

# scitix-csi-plugins

scitix-csi-plugins is a unified CSI (Container Storage Interface) driver that provides multiple storage backends through a single deployment: NFS, GPFS, XSTOR (REST + NFS hybrid), OSS (FUSE-mounted object storage), localshared (hostPath bind mount), and rootfs (qemu-img disk images for VMs).

## When to use this page

Read this page when:
- A pod or VM is stuck in `ContainerCreating` with a `FailedMount` event
- A PVC is stuck `Pending`
- Investigating storage-layer issues (NFS unreachable, GPFS stale mount, XSTOR provisioning failure)
- Determining which CSI driver is involved (provisioner name in StorageClass tells you which)
- Diagnosing the rootfs PVC backend used by [[vce-operator]]

## Architecture

Two core components, both in the CSI namespace (typically `scitix-system`, but discover via `kubectl get pods -A -l app=csi-plugin`):

| Component | Deployment | Role |
|-----------|-----------|------|
| **Provisioner** | Deployment, 2 replicas | Creates/deletes PVs when PVCs are created. One external-provisioner sidecar per driver. Talks to storage backend APIs. |
| **Node Plugin** | DaemonSet on every node | Mounts/unmounts volumes on the pod's node. Runs privileged (needs host mount namespace). |

```
PVC creation
  → Provisioner watches PVC, matches StorageClass
  → Provisioner calls CSI CreateVolume (creates dir/bucket on backend)
  → Provisioner creates PV, binds to PVC
  → Pod scheduled to node
  → kubelet calls CSI NodePublishVolume on that node's plugin
  → Plugin mounts storage to pod's mount path
```

## Storage Drivers

The provisioner field in a StorageClass identifies which driver handles it:

| Provisioner | Type | Mount mechanism |
|------------|------|----------------|
| `nfs.plugin.csi.scitix.ai` | Network FS | NFS mount with `url` from StorageClass |
| `gpfs.plugin.csi.scitix.ai` | Network FS | Bind-mount from GPFS already mounted on node |
| `xstor.plugin.csi.scitix.ai` | Distributed | REST API to XSTOR console for provisioning, NFS for mount |
| `oss.plugin.csi.scitix.ai` | Object | FUSE mount (geesefs / s3fs / rclone) |
| `localshared.plugin.csi.scitix.ai` | Local | hostPath bind mount |
| `rootfs.plugin.csi.scitix.ai` | Block image | qemu-img disk images (used by [[vce-operator]] PVC mode) |

## Driver Notes

### NFS Driver

Most commonly used. The XSTOR-backed NFS URL format:

```
<fsID>.<cluster>.<protocol>:<ip1>@tcp:<ip2>@tcp:<ip3>@tcp
```

The CSI plugin does not parse this string — it concatenates `<url>:<path>` and passes the whole mount source to `mount -t xstor-nfs`. Multi-endpoint failover, if it happens, is performed by the kernel NFS client, not by the CSI plugin.

Key behaviors:
- **Provisioner**: creates a subdirectory on the NFS server per PV
- **Node plugin**: mounts the NFS directory to the pod's volume path
- **Unpublish**: unmounts but does NOT delete the remote directory (PV reclaim policy decides)

### GPFS Driver

GPFS must already be mounted on the node at `GPFS_ROOT_PATH` (default: `/mnt/scitix-gpfs-csi`). The CSI plugin does NOT mount GPFS itself — it only bind-mounts subdirectories.

```
Node: GPFS mounted at /mnt/scitix-gpfs-csi/
  CSI creates: /mnt/scitix-gpfs-csi/<fsID>/<volume-id>/
  Pod sees:    /mnt/data (bind mount from above)
```

If GPFS is not mounted on the node, all GPFS PVCs on that node fail with mount error. The CSI plugin uses `nsenter --mount=/proc/1/ns/mnt mount.xstor-gpfs ...` to perform mount in host namespace when needed (10s timeout).

Behavior flags:
- `AUTO_UMOUNT=true`: unmounts a GPFS subpath when the last pod using it is gone
- Per-volume locking serializes concurrent mount/unmount

### OSS / S3 Driver

Two-stage mount:
1. `NodeStageVolume`: FUSE mount S3 bucket to staging path
2. `NodePublishVolume`: bind-mount staging to pod volume

Supported FUSE mounters: `geesefs` (default), `s3fs`, `rclone`. The mounter binary must exist on the node — missing binary → mount fails.

### Rootfs Driver

Used by [[vce-operator]] in PVC mode. Creates qemu-img disk image files as VM rootfs.

StorageClass naming convention: `<storageType>-<imageId>`, where storageType is `local` or `shared`.

## StorageClass → PV → Mount Chain

The diagnostic chain for any CSI-mounted volume:

```
StorageClass (cluster-scoped)
  └─→ provisioner field selects which CSI driver
  └─→ parameters carry backend config (URL, fsID, etc.)
  
PVC (namespaced)
  └─→ storageClassName selects StorageClass
  └─→ Provisioner creates PV based on parameters
  
PV
  └─→ csi.driver matches a provisioner
  └─→ csi.volumeAttributes carry the actual mount info
  
Pod
  └─→ kubelet calls Node Plugin → mount executed on pod's node
```

## Failure Modes

### FM-1: Pod stuck in ContainerCreating with `FailedMount`

The diagnostic anchor is the driver name in the event.

**Step 1: identify the driver**

```bash
kubectl describe pod <pod> -n <ns> | grep -A5 "Events"
# Look for "FailedMount" — the message usually contains the CSI driver name
```

**Step 2: node plugin running on that node?**

```bash
kubectl get pods -A -l app=csi-plugin -o wide | grep <node>
```

If not Running or not present → CSI plugin pod issue on that node.

**Step 3: storage backend reachable from that node?**

Driver-dependent:
- NFS: `ping <nfs-server-ip>` from node
- GPFS: `mount | grep gpfs` (must already be mounted)
- S3: `curl -sk https://<s3-endpoint>` from node

**Step 4: PV / PVC binding OK?**

```bash
kubectl get pvc <pvc-name> -n <ns>
# Bound = OK at provisioning level
# Pending = Provisioner issue (see FM-2)

kubectl get pv <pv-name> -o yaml
# Check csi.volumeAttributes for correct url/path
```

### FM-2: PVC stuck Pending

```bash
# StorageClass exists?
kubectl get sc <storageclass-name>

# Provisioner running?
kubectl get pods -A -l app=csi-provisioner -o wide

# Provisioner logs (--tail required)
kubectl logs -n <csi-ns> -l app=csi-provisioner -c csi-provisioner --tail=100

# For XSTOR specifically, console reachable?
kubectl get secret xstor-csi-console-secret -n <csi-ns>
```

### FM-3: NFS mount fails (connection refused / timeout)

1. NFS server IP reachable from node? `ping <ip>` via node_exec
2. NFS port (2049) open?
3. URL format valid? Must match `<fsID>.<cluster>.<proto>:<ip>@tcp:...`
4. Firewall blocking NFS between nodes?

### FM-4: GPFS mount fails

GPFS chain is longer than NFS — diagnose from pod event down to the node mount.

**Step 1: read pod event for the specific error**

```bash
kubectl describe pod <pod> -n <ns>
```

Common error patterns:
- `"mounting failed, err: ..., cmd: 'nsenter ... mount.xstor-gpfs ...'"` — mount command failed
- `"check sourcePath exist failed"` — `GPFS_ROOT_PATH` directory missing
- `"check mount point mounted failed"` — findmnt check failed
- `"Protect path ... error"` — chattr +i failed (likely permission/missing dir)

**Step 2: CSI node plugin running on target node?**

```bash
kubectl get pods -A -l app=csi-plugin -o wide | grep <node>
kubectl logs -n <csi-ns> -l app=csi-plugin -c csi-plugin --tail=200 | grep -i "gpfs\|mount"
```

**Step 3: `mount.xstor-gpfs` tool present on node?**

```bash
which mount.xstor-gpfs
# Missing → GPFS client not installed (infra issue, not CSI bug)
```

**Step 4: GPFS root mounted on node?**

```bash
findmnt -T /mnt/scitix-gpfs-csi -t gpfs
# No output → GPFS not mounted

mount | grep gpfs
# No gpfs entry → GPFS client not initialized or mount failed
```

**Step 5: GPFS mounted but pod still fails**

```bash
# Subdirectory exists?
ls -la /mnt/scitix-gpfs-csi/<fsID>/
# Missing → provisioner didn't create, or wrong fsID

# Stale (hung) mount?
ls /mnt/scitix-gpfs-csi/
# Hangs → stale mount; need umount + remount on node

# Disk space?
df -h /mnt/scitix-gpfs-csi/
```

**Step 6: StorageClass parameters correct?**

```bash
kubectl get sc <storageclass> -o yaml
# parameters.url format: <fsID>.<cluster>.gpfs:<ip1>@tcp:<ip2>@tcp
# parameters.fsID and parameters.rootPath should match
```

Common root causes summary:
- `mount.xstor-gpfs` not installed → infra
- GPFS not mounted at all → GPFS cluster connectivity / GPFS server down
- GPFS stale mount → previous mount succeeded but underlying connection lost; `ls` hangs; umount + remount
- fsID/url wrong → StorageClass config issue
- GPFS full → cleanup or expand

### FM-5: CSI plugin pods stuck Terminating

Common during node drain. Plugin pods have `system-node-critical` priority and mount propagation dependencies. Usually resolves once node drain completes and mount propagation is cleaned up.

## Diagnostic Commands

```bash
# Discover CSI namespace (typically scitix-system)
kubectl get pods -A -l app=csi-plugin -o wide

# Provisioner status
kubectl get pods -A -l app=csi-provisioner -o wide

# Registered CSI drivers
kubectl get csidrivers

# StorageClasses
kubectl get sc -o custom-columns='NAME:.metadata.name,PROVISIONER:.provisioner,RECLAIM:.reclaimPolicy'

# PVC / PV
kubectl get pvc -n <ns> -o wide
kubectl get pvc <pvc-name> -n <ns> -o jsonpath='{.spec.volumeName}'
kubectl get pv <pv-name> -o yaml

# Logs
kubectl logs -n <csi-ns> -l app=csi-provisioner -c csi-provisioner --tail=100
kubectl logs -n <csi-ns> -l app=csi-plugin -c csi-plugin --tail=100

# Node-level
mount | grep -E "nfs|gpfs|fuse|s3"
df -h | grep -E "nfs|gpfs|fuse"
ls /var/lib/kubelet/csi-plugins/
```

## See Also

- [[vce-operator]] @related — uses rootfs driver for VM disk images in PVC mode; uses localshared for shared storage
