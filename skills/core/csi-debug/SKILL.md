---
name: csi-debug
description: >-
  Diagnose CSI (Container Storage Interface) driver and volume provisioning failures.
  Checks CSI driver installation, provisioner pod health, VolumeAttachment status,
  and node-level mount errors beyond basic PVC diagnosis.
---

# CSI Storage Driver Diagnosis

When PVC provisioning fails at the driver level, volumes fail to attach or mount, or CSI driver pods are unhealthy, follow this flow for deep storage diagnosis. For basic PVC status issues, start with `pvc-debug` first.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to restart CSI pods, delete VolumeAttachments, or modify StorageClass configurations.

## Diagnostic Flow

### 1. Identify the CSI driver in use

```bash
kubectl get storageclass -o custom-columns='NAME:.metadata.name,PROVISIONER:.provisioner,RECLAIM:.reclaimPolicy,BINDING:.volumeBindingMode'
```

Note the **PROVISIONER** — this is the CSI driver name (e.g., `ebs.csi.aws.com`, `pd.csi.storage.gke.io`, `csi.vsphere.vmware.com`, `disk.csi.azure.com`).

### 2. Check CSI driver installation

```bash
kubectl get csidrivers
```

```bash
kubectl describe csidriver <driver-name>
```

Check the driver's capabilities:
- `attachRequired` — whether volumes need explicit attachment
- `podInfoOnMount` — whether pod info is passed to the driver
- `volumeLifecycleModes` — `Persistent` and/or `Ephemeral`

### 3. Check CSI driver pods

CSI drivers typically deploy as:
- **Controller** (Deployment/StatefulSet): handles provisioning and attachment
- **Node plugin** (DaemonSet): handles mounting on each node

```bash
kubectl get pods -A | grep -iE 'csi|ebs|gce-pd|vsphere|azure-disk|longhorn|rook|ceph'
```

```bash
kubectl get daemonset -A | grep -i csi
kubectl get deployment -A | grep -i csi
kubectl get statefulset -A | grep -i csi
```

For a specific CSI driver, check all its pods:

```bash
kubectl get pods -n <csi-namespace> -o wide
```

Verify all pods are Running and Ready. Pay special attention to:
- **csi-provisioner** sidecar — handles CreateVolume
- **csi-attacher** sidecar — handles ControllerPublishVolume
- **csi-node-driver-registrar** — registers node plugin with kubelet

### 4. Check VolumeAttachment status

When a PV is bound to a PVC and a pod is scheduled, the volume must be attached to the node.

```bash
kubectl get volumeattachment
```

```bash
kubectl get volumeattachment -o custom-columns='NAME:.metadata.name,ATTACHER:.spec.attacher,NODE:.spec.nodeName,PV:.spec.source.persistentVolumeName,ATTACHED:.status.attached'
```

If `ATTACHED` is `false`, the attachment is pending or failed. Check the VolumeAttachment events:

```bash
kubectl describe volumeattachment <name>
```

### 5. Check CSI driver logs

**Controller (provisioner/attacher) logs:**

```bash
kubectl logs -n <csi-namespace> <controller-pod> -c csi-provisioner --tail=200
kubectl logs -n <csi-namespace> <controller-pod> -c csi-attacher --tail=200
kubectl logs -n <csi-namespace> <controller-pod> -c <driver-container> --tail=200
```

**Node plugin logs (on the specific node):**

```bash
kubectl logs -n <csi-namespace> <node-plugin-pod-on-target-node> --tail=200
```

Look for:
- `FailedPrecondition` — volume in wrong state for the requested operation
- `ResourceExhausted` — cloud provider quota exceeded
- `NotFound` — underlying disk/volume doesn't exist
- `PermissionDenied` — CSI driver's service account lacks cloud provider permissions
- `Unavailable` — CSI driver not responding

### 6. Check pod mount events

For a pod stuck in `ContainerCreating` with volume mount issues:

```bash
kubectl describe pod <pod> -n <ns>
```

Look for events:
- `FailedAttachVolume` — controller-level attachment failed
- `FailedMount` — node-level mount failed
- `VolumeNotFound` — the underlying disk was deleted
- `Multi-Attach error` — volume already attached to another node

### 7. Match pattern and conclude

---

#### CSI driver pods not running / CrashLoopBackOff

The CSI driver itself is unhealthy. Without running driver pods, no provisioning, attachment, or mounting can happen.

Check logs for the crashing pod:

```bash
kubectl logs -n <csi-namespace> <crashing-pod> --previous --tail=200
```

Common causes: missing RBAC permissions, incompatible Kubernetes version, missing CRDs.

---

#### `FailedAttachVolume` — Volume cannot be attached to node

The CSI controller cannot attach the volume to the target node.

Causes:
- **Max volumes per node reached** — cloud providers limit attached volumes per instance (e.g., AWS EC2 has a limit per instance type)
- **Volume in another AZ** — the volume and node are in different availability zones
- **Volume still attached to previous node** — detachment from a previous node hasn't completed

```bash
kubectl get volumeattachment -o json | jq '.items[] | select(.spec.source.persistentVolumeName == "<pv-name>") | {node: .spec.nodeName, attached: .status.attached}'
```

---

#### `Multi-Attach error` — ReadWriteOnce volume on multiple nodes

A RWO (ReadWriteOnce) volume is already attached to a different node. A second pod on a new node cannot mount it.

```bash
kubectl get volumeattachment -o json | jq '.items[] | select(.spec.source.persistentVolumeName == "<pv-name>")'
```

Causes:
- Pod rescheduled to a new node but old VolumeAttachment hasn't been cleaned up
- Two different pods on different nodes reference the same PVC (only valid for ReadWriteMany volumes)

---

#### `FailedMount` — Node-level mount failure

The volume is attached but cannot be mounted in the pod's filesystem.

Causes:
- **Filesystem corruption** — the volume's filesystem is damaged
- **Wrong fsType** — the StorageClass specifies a filesystem type the node doesn't support
- **Device not found** — the attached device path doesn't exist on the node

---

#### Provisioning timeout — volume not created

The CSI controller's provisioner sidecar failed to create the volume in the backend storage system.

Check provisioner logs (step 5) and look for:
- Cloud API errors (quota, permissions, region constraints)
- Storage backend errors (pool full, connectivity issues)
- Timeout waiting for volume to become available

---

#### CSI node plugin not running on target node

If the CSI DaemonSet pod is missing from the node where the pod is scheduled, volume mount will fail even if the PV is provisioned and attached.

```bash
kubectl get pods -n <csi-namespace> -l <csi-node-label> --field-selector spec.nodeName=<target-node>
```

Use `daemonset-debug` skill if the CSI DaemonSet is not running on certain nodes.

## Notes

- `pvc-debug` handles PVC-level issues (Pending, StorageClass not found, capacity mismatch). Use this skill when the problem is at the CSI driver or volume attachment level.
- CSI drivers often create CSINode objects: `kubectl get csinodes <node-name> -o yaml` shows which drivers are registered on each node and their volume limits.
- For cloud-managed clusters (EKS, GKE, AKS), CSI driver issues may require checking the cloud provider's IAM roles and policies.
- `kubectl get events -A --field-selector reason=FailedAttachVolume,reason=FailedMount` quickly surfaces storage-related failures across the cluster.
