---
name: pvc-debug
description: >-
  Diagnose PersistentVolumeClaim failures (Pending PVC, StorageClass not found, PV binding issues, capacity mismatch).
  Checks PVC, PV, StorageClass, and provisioner events to identify why storage is not available.
---

# PersistentVolumeClaim Failure Diagnosis

When a PVC is stuck in `Pending`, a pod cannot mount its volume, or storage provisioning fails, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify PVCs, PVs, or StorageClasses — that should be left to the user or cluster administrator.

## Diagnostic Flow

### 1. Check PVC status

```bash
kubectl get pvc <pvc-name> -n <ns>
```

Note the **STATUS**, **VOLUME**, **CAPACITY**, and **STORAGECLASS** columns.

- `Bound` — PVC is healthy, issue may be elsewhere (pod mount, permissions)
- `Pending` — PVC is waiting for a PV to be provisioned or bound
- `Lost` — The PV the PVC was bound to has been deleted

### 2. Describe the PVC

```bash
kubectl describe pvc <pvc-name> -n <ns>
```

Focus on:
- **Events** — provisioner errors, binding failures, or quota exceeded messages
- **Access Modes** — requested access mode (ReadWriteOnce, ReadWriteMany, ReadOnlyMany)
- **StorageClass** — which StorageClass is requested
- **Volume Name** — if bound, which PV it is bound to

### 3. Check the StorageClass

```bash
kubectl get storageclass
```

Verify the StorageClass referenced by the PVC exists and note:
- **PROVISIONER** — the volume provisioner responsible for creating PVs
- **RECLAIMPOLICY** — Delete or Retain
- **VOLUMEBINDINGMODE** — Immediate or WaitForFirstConsumer

If the StorageClass uses `WaitForFirstConsumer`, the PV will not be provisioned until a pod using the PVC is scheduled to a node.

### 4. Check available PVs (for static provisioning)

If the cluster uses pre-created PVs instead of dynamic provisioning:

```bash
kubectl get pv
```

For a PVC to bind to a PV, the PV must:
- Be in `Available` status
- Match the PVC's requested `storageClassName`
- Meet the PVC's capacity request (PV capacity >= PVC request)
- Support the PVC's access mode
- Match any `selector` labels on the PVC

Check a specific PV:

```bash
kubectl describe pv <pv-name>
```

### 5. Match patterns and conclude

---

#### `storageclass.storage.k8s.io "<name>" not found` — StorageClass does not exist

The PVC references a StorageClass that does not exist in the cluster.

```bash
kubectl get storageclass
```

Advise the user to either create the StorageClass or update the PVC to use an existing one. If no StorageClass is specified in the PVC, it uses the cluster's default StorageClass — check if one is set:

```bash
kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'
```

---

#### `waiting for first consumer to be created` — WaitForFirstConsumer binding mode

The StorageClass has `volumeBindingMode: WaitForFirstConsumer`. The PV will not be provisioned until a pod that uses this PVC is scheduled.

This is normal behavior. Check if a pod using the PVC exists and is being scheduled. If the pod is `Pending`, use the `pod-pending-debug` skill.

---

#### `no persistent volumes available for this claim` — No matching PV

For static provisioning: no available PV matches the PVC's requirements.

Check the mismatch:

```bash
kubectl get pvc <pvc-name> -n <ns> -o jsonpath='storageClass={.spec.storageClassName} capacity={.spec.resources.requests.storage} accessModes={.spec.accessModes[*]}'
```

```bash
kubectl get pv -o custom-columns='NAME:.metadata.name,CAPACITY:.spec.capacity.storage,ACCESS:.spec.accessModes[*],CLASS:.spec.storageClassName,STATUS:.status.phase'
```

Common mismatches:
- **Capacity** — PV is smaller than PVC request
- **Access mode** — PV does not support the requested access mode (e.g., PV is ReadWriteOnce but PVC requests ReadWriteMany)
- **StorageClass** — PV and PVC reference different StorageClasses

---

#### Provisioner error in events — Dynamic provisioning failure

The provisioner failed to create a volume. Common provisioner errors:

- **Quota exceeded** — cloud account's disk quota has been reached
- **Zone/region mismatch** — the provisioner cannot create a volume in the zone where the node is located
- **Permission denied** — the provisioner's service account lacks permission to create volumes

```bash
kubectl get events -n <ns> --field-selector involvedObject.name=<pvc-name> --sort-by='.lastTimestamp'
```

Advise the user to check the provisioner's logs and the cloud provider's quota/permissions.

---

#### PVC `Bound` but pod cannot mount — Mount failure

The PVC is bound, but the pod cannot mount the volume. Check the pod events:

```bash
kubectl describe pod <pod> -n <ns>
```

Look for `FailedMount` or `FailedAttachVolume` events. Common causes:
- **Multi-attach error** — a ReadWriteOnce volume is already attached to another node. Check which node the PV is attached to and whether another pod on a different node is using it.
- **Volume not found** — the underlying cloud disk was deleted but the PV still exists
- **Filesystem corruption** — the volume cannot be mounted due to a corrupt filesystem

---

#### PVC `Lost` — Bound PV was deleted

The PV that the PVC was bound to has been deleted or is no longer available.

```bash
kubectl get pv
```

If the PV no longer exists, the data may be lost. Advise the user to check if the underlying storage still exists in the cloud provider and whether it can be recovered.

## Notes

- `pod-pending-debug` covers PVC issues briefly as a scheduling failure cause. This skill provides deeper PVC-specific diagnosis.
- For PVCs used by StatefulSets, each replica gets its own PVC (named `<volumeClaimTemplate>-<statefulset>-<ordinal>`). Check all of them if a specific replica is failing.
- `kubectl get pvc -n <ns>` lists all PVCs in a namespace — useful when you don't know which PVC is problematic.
- Expanding a PVC (increasing size) requires the StorageClass to have `allowVolumeExpansion: true`. If a PVC expansion is stuck, check the PVC's conditions: `kubectl get pvc <name> -n <ns> -o jsonpath='{.status.conditions}'`.
