---
name: volcano-resource-insufficient
description: >-
  Resource shortage diagnostic guide for Volcano.
  Use when seeing Insufficient cpu/memory events, OOMKilled pods,
  or nodes with zero allocatable resources.
---

# Resource Insufficiency Diagnosis

This guide helps diagnose resource shortage issues in Volcano-scheduled workloads. Resource insufficiency is one of the most common causes of scheduling failures.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify resource quotas or delete workloads.

## When to Use This Guide

Use this skill when:
- Events show `Insufficient cpu` or `Insufficient memory`
- Pods are stuck in `Pending` with resource-related events
- Nodes show zero allocatable resources
- Pods are being `OOMKilled` (Out of Memory)
- `FailedScheduling` events mention resource constraints

## Types of Resource Issues

### 1. Cluster-Wide Resource Exhaustion
The entire cluster lacks sufficient resources to meet the workload demands.

### 2. Resource Fragmentation
Total resources exist but are distributed across too many nodes to satisfy specific scheduling constraints (like Gang scheduling).

### 3. Per-Node Resource Shortage
Individual nodes lack enough resources, even though the cluster as a whole has capacity.

### 4. Queue Resource Limits
The Queue has reached its deserved resource limit, preventing new pods from being scheduled.

## Diagnostic Steps

### Step 1: Identify Resource Shortage Type

Check the specific error message in events:

```bash
kubectl get events -n <namespace> --field-selector involvedObject.name=<pod-name> --sort-by='.lastTimestamp'
```

**Common error patterns:**

| Error Message | Resource Type | Scope |
|--------------|---------------|-------|
| `Insufficient cpu` | CPU | Node-level |
| `Insufficient memory` | Memory | Node-level |
| `Insufficient nvidia.com/gpu` | GPU | Node-level |
| `0/N nodes are available` | General | Cluster-level |
| `exceeded quota` | Queue-level | Queue limit |

### Step 2: Check Pod Resource Requests

Determine how much resources the pod is requesting:

```bash
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].resources.requests}'
```

For detailed breakdown:
```bash
kubectl get pod <pod-name> -n <namespace> -o yaml | grep -A 10 "resources:"
```

**Key fields:**
- `resources.requests.cpu` - CPU cores requested (e.g., "100m" = 0.1 core, "2" = 2 cores)
- `resources.requests.memory` - Memory requested (e.g., "1Gi", "512Mi")
- `resources.requests.nvidia.com/gpu` - GPUs requested
- `resources.limits` - Maximum allowed (may be different from requests)

### Step 3: Check Node Allocatable Resources

View total allocatable resources per node:

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory,GPU:.status.allocatable.nvidia\.com/gpu,PODS:.status.allocatable.pods'
```

For detailed node information:
```bash
kubectl describe node <node-name>
```

**Key concepts:**
- `allocatable` = Total capacity - System reserved - Kubelet reserved
- `capacity` = Total hardware capacity
- The difference is reserved for system/Kubernetes daemons

### Step 4: Check Current Resource Usage

If metrics-server is available:

```bash
kubectl top nodes
```

For per-node pod usage:
```bash
kubectl top pods --all-namespaces --sort-by=cpu | head -20
kubectl top pods --all-namespaces --sort-by=memory | head -20
```

**Note:** If metrics-server is not available, you can still see resource allocation (requests) but not actual usage.

### Step 5: Calculate Resource Availability

For each node, calculate available resources:

```
Available CPU = allocatable.cpu - sum(all pod requests on node)
Available Memory = allocatable.memory - sum(all pod requests on node)
```

Quick check with:
```bash
kubectl describe node <node-name> | grep -A 20 "Allocated resources"
```

**Look for:**
- `cpu-requests` vs `cpu-capacity`
- `memory-requests` vs `memory-capacity`
- Percentage of allocation (high % = resource pressure)

### Step 6: Check for Resource Fragmentation

For Gang scheduling or affinity constraints, fragmentation is critical:

```bash
# Count nodes that can fit a single pod
NODE_CPU_REQ="4"
NODE_MEM_REQ="8Gi"

kubectl get nodes -o json | jq -r '
  .items[] |
  select(.status.allocatable.cpu | tonumber >= '"$NODE_CPU_REQ"') |
  select(.status.allocatable.memory | ascii_downcase | gsub("[gimk]"; "") | tonumber >= 8) |
  .metadata.name'
```

**Fragmentation indicators:**
- Many nodes with small amounts of free resources
- No single node can satisfy the pod's resource needs
- Total cluster resources sufficient but poorly distributed

## Common Scenarios

### Scenario 1: Pod Requests Exceed Any Single Node

**Symptom:** `Insufficient cpu` or `Insufficient memory` on all nodes

**Diagnosis:**
```bash
# Check pod request
kubectl get pod <pod> -o jsonpath='{.spec.containers[0].resources.requests.cpu}'
# Output: 32

# Check largest node's allocatable
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.allocatable.cpu}{"\n"}{end}' | sort -k2 -n | tail -1
# Output: node-1    16
```

**Analysis:** Pod requests 32 CPUs, but largest node only has 16 allocatable.

**Solution:**
- Reduce pod resource requests (if actual usage is lower)
- Add larger nodes to cluster
- Use node pool with bigger instances

### Scenario 2: Cluster at Capacity

**Symptom:** Most nodes show high allocation percentage

**Diagnosis:**
```bash
kubectl describe node <node-name> | grep "Allocated resources"
# cpu-requests:  14900m (93%)
# memory-requests:  55000Mi (85%)
```

**Analysis:** Nodes are 85-93% allocated, leaving little room for new pods.

**Solution:**
- Scale cluster (add more nodes)
- Review and optimize resource requests (may be over-provisioned)
- Consider cluster autoscaler for dynamic scaling

### Scenario 3: Resource Fragmentation

**Symptom:** Gang scheduling fails despite total resources being sufficient

**Diagnosis:**
```bash
# Total cluster CPU
kubectl get nodes -o jsonpath='{range .items[*]}{.status.allocatable.cpu}{"\n"}{end}' | awk '{sum+=$1} END {print sum}'
# Output: 64

# Available nodes for 4-CPU pods
kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU:.status.allocatable.cpu' | awk '$2 >= 4 {count++} END {print count " nodes can fit the pod"}'
# Output: 2 nodes can fit the pod

# But we need 8 pods for Gang
# 2 < 8, so Gang fails
```

**Analysis:** Total cluster has 64 CPUs, but only 2 nodes have 4+ CPUs. Gang needs 8 pods.

**Solution:**
- Enable `binpack` plugin to concentrate pods
- Defragment by draining and rebalancing nodes
- Use larger nodes to reduce fragmentation

### Scenario 4: Queue Resource Exhaustion

**Symptom:** Events mention queue limits, PodGroup stays in Pending

**Diagnosis:**
```bash
# Check queue status
kubectl get queue <queue-name> -o yaml
```

**Look for:**
- `status.allocated` >= `status.deserved`
- `state` is `Open` but no capacity available

**Analysis:** Queue has used all its deserved resources.

**Solution:**
- Increase queue weight or capability
- Wait for other jobs to complete
- Use `volcano-queue-diagnose` for detailed analysis

### Scenario 5: GPU Resource Shortage

**Symptom:** `Insufficient nvidia.com/gpu` in events

**Diagnosis:**
```bash
# Check GPU allocatable
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'

# Check GPU usage (if metrics available)
kubectl top nodes --show-capacity 2>/dev/null || echo "GPU metrics not available"
```

**Analysis:** GPU resources are fully allocated or fragmented across nodes.

**Solution:**
- Verify GPU device plugin is running
- Check if GPUs are properly allocatable on nodes
- Consider GPU sharing if workload supports it

## Resource Calculation Examples

### Example 1: Calculate Total Cluster Capacity

```bash
kubectl get nodes -o json | jq -r '
  .items |
  map(.status.allocatable) |
  reduce .[] as $item ({}; 
    . + {cpu: ((.cpu // 0 | tonumber) + ($item.cpu | tonumber)),
         memory: ((.memory // 0) + ($item.memory | tonumber))})'
```

### Example 2: Find Pods with High Resource Requests

```bash
kubectl get pods --all-namespaces -o json | jq -r '
  .items[] |
  select(.spec.containers[].resources.requests.cpu | tonumber > 4) |
  "\(.metadata.namespace)/\(.metadata.name): \(.spec.containers[].resources.requests)"'
```

### Example 3: Check Resource Utilization vs Request

```bash
# High-level view
kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU_ALLOC:.status.allocatable.cpu,MEM_ALLOC:.status.allocatable.memory'
```

## Prevention and Best Practices

1. **Right-size resource requests**
   - Set requests based on actual usage, not maximum possible
   - Use Vertical Pod Autoscaler (VPA) for recommendations

2. **Use cluster autoscaler**
   - Automatically scale nodes based on pending pod demands
   - Configure appropriate node pools for different workloads

3. **Enable binpack plugin**
   - Reduces fragmentation by concentrating pods
   - Better for batch workloads

4. **Monitor resource quotas**
   - Set up alerts for queue resource exhaustion
   - Use `volcano-queue-diagnose` proactively

5. **Regular capacity planning**
   - Track resource growth trends
   - Plan cluster expansion before hitting capacity

## See Also

- `volcano-diagnose-pod` - General Pod scheduling diagnosis
- `volcano-gang-scheduling` - Gang scheduling constraint issues
- `volcano-queue-diagnose` - Queue resource analysis
- `volcano-node-resources` - Node resource querying
