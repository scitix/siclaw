---
name: gpu-debug
description: >-
  Diagnose GPU scheduling and device plugin failures (GPU not allocatable, device plugin crash,
  nvidia-smi errors, GPU resource mismatch). Checks device plugin DaemonSet, node GPU capacity,
  pod GPU requests, and driver/runtime status.
---

# GPU Scheduling & Device Plugin Diagnosis

When pods requesting GPU resources are stuck in `Pending`, `Unschedulable`, or fail with device plugin errors, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to restart device plugins, modify resource limits, or change node configurations.

## Diagnostic Flow

### 1. Check GPU resources across nodes

```bash
kubectl get nodes -o custom-columns='NODE:.metadata.name,GPU_ALLOC:.status.allocatable.nvidia\.com/gpu,GPU_CAP:.status.capacity.nvidia\.com/gpu'
```

If the `nvidia.com/gpu` column shows `<none>` on a node that should have GPUs, the device plugin is not reporting GPU resources on that node.

Also check for other GPU resource types (e.g., AMD, Intel):

```bash
kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, allocatable: (.status.allocatable | to_entries | map(select(.key | contains("gpu") or contains("nvidia") or contains("amd"))) | from_entries)}'
```

### 2. Check GPU device plugin DaemonSet

```bash
kubectl get daemonset -A | grep -iE 'gpu|nvidia|dcgm'
```

```bash
kubectl get pods -A -l app=nvidia-device-plugin -o wide
```

If the DaemonSet is missing or pods are not running on GPU nodes, the device plugin is not installed or has crashed.

For detailed status:

```bash
kubectl describe daemonset -n <gpu-plugin-namespace> <daemonset-name>
```

Focus on:
- **Desired** vs **Current** vs **Ready** — any mismatch indicates scheduling or crash issues
- **Node Selector** or **Tolerations** — the DaemonSet may be targeting wrong nodes

### 3. Check device plugin pod logs

```bash
kubectl logs -n <gpu-plugin-namespace> <device-plugin-pod> --tail=200
```

If the pod has restarted:

```bash
kubectl logs -n <gpu-plugin-namespace> <device-plugin-pod> --previous --tail=200
```

Look for:
- `Failed to initialize NVML` — NVIDIA driver not loaded on the host
- `failed to register device plugin` — kubelet communication failure
- `no devices found` — GPU hardware not detected
- `error retrieving GPU information` — driver/runtime mismatch

### 4. Check the pod requesting GPU

```bash
kubectl describe pod <pod> -n <ns>
```

Focus on:
- **Events** — look for `FailedScheduling` with `Insufficient nvidia.com/gpu`
- **Resources** section — verify GPU request count

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{range .spec.containers[*]}{.name}: cpu={.resources.requests.cpu}, memory={.resources.requests.memory}, gpu={.resources.requests.nvidia\.com/gpu}{"\n"}{end}'
```

### 5. Check GPU allocation on the target node

If you know which node should run the pod:

```bash
kubectl describe node <node> | grep -A 15 "Allocated resources"
```

Check `nvidia.com/gpu` in both the "Requests" and "Limits" columns. If requests equal the allocatable count, the node's GPUs are fully allocated.

To see which pods are using GPUs on a specific node:

```bash
kubectl get pods --field-selector spec.nodeName=<node> -A -o json | jq '.items[] | select(.spec.containers[].resources.requests["nvidia.com/gpu"] != null) | {name: .metadata.name, namespace: .metadata.namespace, gpu: .spec.containers[].resources.requests["nvidia.com/gpu"]}'
```

### 6. Check nvidia-smi on the node (if accessible)

If you can exec into a pod on the node or the device plugin pod mounts the host GPU device:

```bash
nvidia-smi
```

Or via a debug pod / node-exec:

```bash
nvidia-smi -q
```

Look for:
- **Driver Version** and **CUDA Version** — mismatch with container runtime can cause failures
- **GPU Utilization** and **Memory Usage** — high utilization may indicate contention
- **ECC Errors** — uncorrectable ECC errors can mark a GPU as unhealthy
- **Xid Errors** — check `dmesg | grep -i xid` for GPU hardware/driver errors

### 7. Match pattern and conclude

---

#### `Insufficient nvidia.com/gpu` — No GPU capacity available

All GPUs in the cluster are allocated or no node has GPU resources.

Check:
- Cluster-wide GPU allocation (step 1 + step 5)
- Whether new GPU nodes need to be added
- Whether other pods are hoarding GPUs unnecessarily

---

#### Device plugin pods not running / CrashLoopBackOff

The NVIDIA device plugin cannot start. Common causes:
- NVIDIA drivers not installed on the host (`Failed to initialize NVML`)
- Container runtime (containerd/docker) missing NVIDIA runtime hook
- Incompatible driver/plugin version
- Node lacks GPU hardware

Check the device plugin pod logs (step 3) for the specific error.

---

#### GPUs show in capacity but 0 in allocatable

The device plugin detected GPUs but they are marked unhealthy. Possible causes:
- GPU ECC errors (uncorrectable memory errors)
- GPU fallen off the bus (Xid 79)
- Device plugin health check failure

Check `nvidia-smi` output and `dmesg` for Xid errors on the node.

---

#### Pod gets GPU but nvidia-smi inside container fails

The container cannot access the GPU device. Causes:
- Container runtime not configured with NVIDIA runtime
- Missing `runtimeClassName: nvidia` in pod spec (for some setups)
- Device mount path mismatch between device plugin and container runtime

Check the pod spec:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.runtimeClassName}'
```

---

#### GPU resource type mismatch

The pod requests a resource name that doesn't match what the device plugin advertises. For example, requesting `nvidia.com/gpu` when the cluster uses `nvidia.com/gpu.shared` or a custom MIG resource like `nvidia.com/mig-1g.5gb`.

```bash
kubectl get nodes -o json | jq '.items[].status.allocatable | keys[] | select(contains("nvidia") or contains("gpu"))'
```

Compare with the pod's resource request and advise the user to align them.

## Notes

- NVIDIA device plugin typically runs in `kube-system` or `gpu-operator` namespace.
- In clusters with GPU Operator, check the ClusterPolicy CR: `kubectl get clusterpolicies -o yaml`
- For MIG (Multi-Instance GPU) setups, each MIG profile is a separate resource type (e.g., `nvidia.com/mig-1g.5gb`). The device plugin must be configured in MIG mode.
- DCGM Exporter pods report GPU health metrics to Prometheus — check its logs if GPU health monitoring is needed.
- Time-slicing and MPS configurations change how GPUs are shared — a single physical GPU may appear as multiple allocatable units.
