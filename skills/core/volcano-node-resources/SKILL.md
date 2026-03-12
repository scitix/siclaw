---
name: volcano-node-resources
description: >-
  Query cluster node resources for Volcano scheduling.
  Check allocatable CPU, memory, GPU, and current usage.
---

# Volcano Node Resources

Query cluster node resources to understand capacity and availability for Volcano scheduling. This skill helps identify resource bottlenecks at the node level.

**Scope:** This skill is for **diagnosis only**. It retrieves resource information but does not modify any cluster state.

## Usage

```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh [options]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--node NODE` | no | Query specific node only |
| `--label LABEL` | no | Filter nodes by label (e.g., gpu=true) |
| `--show-usage` | no | Show current resource usage (requires metrics-server) |
| `--show-pods` | no | Show pods running on each node |
| `--format FORMAT` | no | Output format: table (default), json, wide |

## Examples

Get overview of all nodes:
```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh
```

Check specific node:
```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --node worker-1
```

Check GPU nodes:
```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --label nvidia.com/gpu.present=true
```

Show resource usage:
```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --show-usage
```

Show with pod information:
```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --show-pods
```

JSON output for parsing:
```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --format json
```

## Understanding Node Resources

### Resource Types

| Resource | Description | Scheduling Impact |
|----------|-------------|-------------------|
| `cpu` | CPU cores (millicores) | Primary scheduling constraint |
| `memory` | RAM (bytes) | Primary scheduling constraint |
| `nvidia.com/gpu` | GPU devices | Hardware-specific scheduling |
| `pods` | Max pods per node | Density limit |
| `ephemeral-storage` | Disk space | Secondary constraint |

### Capacity vs Allocatable

- **Capacity**: Total physical resources on the node
- **Allocatable**: Resources available for pods (capacity minus system reservations)

**Reservations include:**
- kubelet overhead
- System daemons (kube-proxy, node-exporter)
- Kernel reserved memory
- Eviction threshold

### Resource Usage

When `--show-usage` is enabled and metrics-server is available:

- **Requests**: Sum of all pod resource requests on the node
- **Limits**: Sum of all pod resource limits
- **Usage**: Actual resource consumption

**Key insights:**
- Allocatable - Requests = Available for new pods
- Usage < Requests = Over-provisioning
- Usage > Requests = Over-committing (risky)

## Resource Calculation

### Available Resources

```
Available = Allocatable - Allocated (sum of all requests)
```

Nodes with zero or negative available resources cannot accept new pods.

### Gang Scheduling Calculation

For Gang scheduling, you need:
```
Number of nodes with Available >= Pod Request >= minMember
```

Example:
- minMember = 4
- Pod requests 4 CPUs each
- Need at least 4 nodes with 4+ CPUs available

## Diagnostic Use Cases

### Case 1: Identify Nodes with Available Resources

```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh
```

Look for nodes with positive Available CPU/Memory. Nodes with zero or near-zero availability cannot schedule new pods.

### Case 2: Find GPU-Equipped Nodes

```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --label nvidia.com/gpu.present=true --show-usage
```

Check:
- Which nodes have GPUs
- How many GPUs are allocatable
- How many are currently allocated/used
- GPU utilization patterns

### Case 3: Detect Resource Fragmentation

```bash
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --show-usage
```

Fragmentation indicators:
- Many nodes with small amounts of available resources
- High node count but low available resources per node
- Allocated resources spread thinly across many nodes

### Case 4: Node Affinity Troubleshooting

If pods require specific labels:

```bash
# Check nodes with required labels
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --label <required-label>

# Verify sufficient resources
kubectl describe node <node-name> | grep -A 10 "Allocated resources"
```

### Case 5: Capacity Planning

Monitor trends over time:

```bash
# Current capacity
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh --format json

# Check usage trends (if metrics available)
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  echo "=== $node ==="
  kubectl top node $node 2>/dev/null || echo "Metrics not available"
done
```

## Node Status Indicators

### Ready Status

| Status | Meaning | Action |
|--------|---------|--------|
| `Ready` | Node healthy and schedulable | Normal |
| `NotReady` | Node unhealthy | Check node conditions |
| `SchedulingDisabled` | Node cordoned | May need uncordon |

Check node conditions:
```bash
kubectl get nodes -o json | jq '.items[].status.conditions'
```

### Node Taints

Taints prevent pod scheduling:

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
```

Common taints:
- `node.kubernetes.io/not-ready`
- `node.kubernetes.io/unreachable`
- `node.kubernetes.io/disk-pressure`
- `node.kubernetes.io/memory-pressure`
- `node.kubernetes.io/pid-pressure`

## Common Issues

### Issue 1: Node at Capacity

**Symptom:** Available resources near zero, new pods stuck pending

**Check:**
```bash
kubectl describe node <node-name> | grep -A 5 "Allocated resources"
```

**Solution:**
- Scale cluster (add nodes)
- Drain and consolidate workloads
- Review resource requests (may be over-provisioned)

### Issue 2: GPU Not Allocatable

**Symptom:** Node has GPUs but not showing as allocatable

**Check:**
```bash
kubectl get node <node> -o jsonpath='{.status.allocatable.nvidia\.com/gpu}'
```

**Solution:**
- Verify GPU device plugin is running
- Check nvidia-driver installation
- Review node labels

### Issue 3: Memory Pressure

**Symptom:** Node has `node.kubernetes.io/memory-pressure` taint

**Check:**
```bash
kubectl describe node <node-name> | grep -A 3 "MemoryPressure"
```

**Solution:**
- Evict or reschedule memory-intensive pods
- Increase node memory
- Adjust pod memory limits

### Issue 4: Disk Pressure

**Symptom:** Node has `node.kubernetes.io/disk-pressure` taint

**Check:**
```bash
kubectl describe node <node-name> | grep -A 3 "DiskPressure"
```

**Solution:**
- Clean up unused images/containers
- Increase node disk capacity
- Review log rotation policies

## Output Formats

### Table Format (default)

Human-readable table:
```
NAME        CPU_ALLOC   MEM_ALLOC   GPU_ALLOC   CPU_AVAIL   MEM_AVAIL
node-1      32          64Gi        4           8           16Gi
node-2      16          32Gi        0           2           4Gi
```

### Wide Format

Additional columns:
```
NAME    CPU    MEM    GPU    CPU_AVAIL    MEM_AVAIL    STATUS    AGE
```

### JSON Format

Machine-parseable output:
```json
{
  "nodes": [
    {
      "name": "node-1",
      "allocatable": {
        "cpu": "32",
        "memory": "64Gi",
        "nvidia.com/gpu": "4"
      },
      "available": {
        "cpu": "8",
        "memory": "16Gi"
      }
    }
  ]
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_LABEL` | "" | Default label selector for nodes |

## Integration with Other Skills

Combine with other skills for comprehensive analysis:

```bash
# 1. Check node resources
bash skills/core/volcano-node-resources/scripts/get-node-resources.sh

# 2. Check queue resources
bash skills/core/volcano-queue-diagnose/scripts/diagnose-queue.sh

# 3. If insufficient resources, refer to volcano-resource-insufficient skill guide
#    (This is a documentation skill - follow the diagnostic steps in the SKILL.md)
```

## See Also

- `volcano-resource-insufficient` - Resource shortage diagnosis
- `volcano-diagnose-pod` - Pod-specific scheduling issues
- `volcano-gang-scheduling` - Gang constraint analysis
- `volcano-queue-diagnose` - Queue resource distribution
