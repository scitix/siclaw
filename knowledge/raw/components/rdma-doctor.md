---
title: rdma-doctor
type: component
---

# rdma-doctor

rdma-doctor periodically validates RDMA network health at three layers (Kubernetes node config, host NIC/SR-IOV state, per-pod RDMA reachability) and emits results as Prometheus metrics. It is a **purely OS-level diagnostic tool** — it observes whether the network actually works, independent of which operator configured it.

## When to use this page

Read this page when:
- A Prometheus alert mentions `rdma_doctor_*`, `RoceHostOffline`, `RocePodOffline`, `RoceNodeUnitLabelMiss`, or related
- Investigating "is RDMA actually working on this node/pod?" rather than "is configuration correct?"
- Trying to distinguish between configuration faults (use [[roce-operator]]) and runtime faults (use this page)
- Looking for cluster-wide RDMA health signals via PromQL

For the configuration system that creates RDMA networking (and the symmetric IPAM perspective), see [[roce-operator]] @related — they are independent at runtime.

## Why It Exists Independently of roce-operator

This is the most important conceptual point about rdma-doctor.

**rdma-doctor does not read any roce-operator CRDs.** It does not query IPAllocation, IPPool, Tenant, or topology ConfigMap. Source code inspection confirms: the agent only uses the kubelet `/pods` API for pod discovery, and only reads node label/annotation metadata for its own configuration.

Everything rdma-doctor checks is observed directly from the OS:
- Pod gateways come from the kernel routing table inside the pod's netns, not from IPAllocation `gateway` field
- Pod VF presence is observed by enumerating `/sys/class/infiniband/` inside the pod's netns
- Host VF counts come from sysfs (`/sys/class/net/<pf>/device/sriov_numvfs`) and netlink
- VLAN tags are read from kernel netlink via `link.Attrs().Vfs`, not from IPPool subnet config

**Diagnostic implication**: rdma-doctor and roce-operator give two views of the same RoCE setup. roce-operator says "this is what I configured." rdma-doctor says "this is what actually works." When they disagree, the fault lies between configuration and OS effect — typically VF injection, CNI execution, or physical network.

## Architecture

| Component | Deployment | Role |
|-----------|-----------|------|
| **rdma-doctor-agent** | DaemonSet on every node | Runs read-only health checks every scrape interval (default 5min). Exposes Prometheus metrics on `:9188/metrics` (HTTPS, self-signed) |
| **rdma-doctor-controller** | Deployment, single replica | REST API for on-demand fullmesh / perftest. **Creates DaemonSets and runs `ib_write_bw`** — these are write operations affecting cluster, NOT passive diagnostics. Do not invoke during routine investigation. |

For diagnostic purposes, only the agent's metrics are relevant. The controller's perftest is for active testing, not investigation.

## Three Layers of Checks

The agent checks three independent layers each scrape cycle. Each layer answers a different question:

| Layer | Question | Failures point to |
|-------|---------|-------------------|
| **Node** | Is the K8s configuration on this node complete? | Missing labels/annotations → ops needs to onboard the node |
| **Host** | Are PF interfaces, SR-IOV VFs, and gateways healthy at the OS level? | Physical network, NIC driver, or switch issues |
| **Pod** | Can each RoCE pod see its RDMA device and reach its gateway? | Pod-specific config issues that don't affect the host |

The **layer where the failure appears** is the diagnostic anchor:
- Failure at host but not pod (rare) → host has fault but pods don't yet need that path
- Failure at pod but not host → fault is pod-specific (VF injection, VLAN/MTU mismatch, IPAM issue)
- Failure at node → setup not complete; investigate before looking at host/pod

## Pod Discovery and Netns Entry

For pod-level checks, rdma-doctor needs to enter the pod's network namespace. The mechanism:

1. Fetch all pods on the node via kubelet API (`https://127.0.0.1:10250/pods`)
2. Filter to pods requesting RDMA resources. The resource name list is configurable per deployment. Note: Kubernetes resource names (e.g. `rdma/foo_bar_0`) are plugin-registration names and may not reflect the actual NIC vendor/driver in use — for real hardware identification check `lspci`, `lsmod`, and `/sys/class/infiniband/<dev>/device/driver`.
3. For each candidate pod, find the containerd container ID from `pod.status.containerStatuses[].containerID` (filters for `containerd://` prefix)
4. Look up container PID at `/run/containerd/io.containerd.runtime.v2.task/k8s.io/<containerID>/init.pid`
5. Open netns at `/proc/<PID>/ns/net` and switch into it (using vishvananda/netns)
6. Run RDMA device enumeration, gateway ping, route check inside the pod netns
7. Restore original netns when done

**Containerd-specific**: rdma-doctor only supports containerd-managed containers. Pods on other runtimes (CRI-O, Docker) won't be checked.

## Primary Metric: `rdma_doctor_check_status`

Single gauge, value `0` (failed) or `1` (passed). Discriminated by labels:

| Label | Meaning |
|-------|---------|
| `node` | Node name |
| `scope` | `node` / `host` / `pod` — which layer |
| `check` | Check name (see check tables below) |
| `target` | Interface name, PF, or check target |
| `gateway` | Gateway IP (for ping checks) |
| `namespace`, `pod` | Set when scope=pod |
| `iface` | Interface name (for pod checks) |
| `reason` | Failure reason text |

### Node-layer checks (scope=node)

Verify Kubernetes config on the node is complete.

| `check` value | Validates | Failure means |
|---------------|-----------|---------------|
| `pf_label_present` | Node has `roce.scitix.ai/pf-names` label | NodeMeta controller in [[roce-operator]] hasn't run, or node not labeled by ops |
| `resource_label_present` | Node has RDMA resource annotation | SR-IOV device plugin not reporting resources |
| `network_label_present` | Node has NAD annotation | Multus/SR-IOV CNI not configured |
| `topology_label_present` | Node has `roce.scitix.ai/unit` label | [[roce-operator]] cannot allocate IPs for pods on this node |

Failures here are configuration completeness — fix at the K8s layer.

### Host-layer checks (scope=host)

Verify PF interfaces and SR-IOV VFs at the OS level.

| `check` value | Validates | Failure means |
|---------------|-----------|---------------|
| `gateway_ping` | PF can reach its gateway (interface-bound ping) | Physical network issue |
| `gateway_ping_ip` | Gateway reachable via source IP | Routing or IP config issue |
| `route_check` | Routing table has correct entries for PF | Missing routes, drift from expected config |
| `issue_detail` | Summary of PF-level faults | Check `reason` label for specifics |

Numeric metrics at host level:

| Metric | Alert when |
|--------|-----------|
| `rdma_doctor_host_sriov_numvfs` | Changes unexpectedly |
| `rdma_doctor_host_detected_vfs` | Differs from `numvfs` → driver/firmware issue |
| `rdma_doctor_host_vf_netdevices` | Lower than `detected_vfs` → netdev binding issue |
| `rdma_doctor_host_issue_count` | `> 0` → check `last_error_info` for details |

**Pattern**: if `gateway_ping` fails:
- Single PF on one node → cable / port / NIC issue on that interface
- All PFs on one node → node-level network or NIC driver issue
- Same PF across multiple nodes → switch/fabric-wide issue
- VF counts mismatch → SR-IOV driver or firmware issue, not network

### Pod-layer checks (scope=pod)

Verify each RoCE pod can use its allocated network.

| `check` value | Validates | Failure means |
|---------------|-----------|---------------|
| `device_present` | RDMA device visible inside pod netns | SR-IOV CNI didn't inject VF, or NAD misconfigured |
| `gateway_ping` | Pod can reach its gateway from RoCE interface | VLAN / MTU mismatch, or [[roce-operator]] IPAM issue |
| `route_check` | Pod routing table is correct | Policy routing not active, or wrong routes |
| `vf_count_match` | Actual VF count matches expected | Pod spec requests don't match what's allocated |

**Pattern**: if pod `gateway_ping` fails but host `gateway_ping` passes:
- Problem is pod-specific, not physical network
- Check whether the pod has a valid IPAllocation (see [[roce-operator]])
- Check VLAN: does the IPPool subnet VLAN match the switch port?
- Check MTU: does the IPPool subnet MTU match physical network MTU?
- Check policy routing: `ip rule list` inside pod should show per-VF rules if `policyRouting: true`. See [[policy-routing]].

## Cross-Layer Diagnostic Patterns

The combination of which layers fail tells you where to look:

| Node fails | Host fails | Pod fails | Diagnosis |
|:---------:|:---------:|:---------:|-----------|
| ✓ | — | — | Node setup incomplete. Configure labels/annotations before deeper investigation. |
| — | ✓ | ✓ (same metric) | Physical/host fault. Pod failures are downstream symptoms. Fix host first. |
| — | ✓ | — | Host has fault but no pods rely on that path yet. Fix before scheduling RoCE workloads. |
| — | — | ✓ | Pod-specific. Configuration was correct at host, broken at pod level. Investigate VF injection, VLAN, MTU, [[policy-routing]], IPAM. |
| — | — | ✓ (cluster-wide) | Cluster-wide pod-layer config drift. Likely a recent change to NAD or [[roce-operator]] config. |

## Useful PromQL

```promql
# All failed checks across the cluster (start here)
rdma_doctor_check_status == 0

# Agent stale or erroring (agent itself is broken)
time() - rdma_doctor_diag_last_run_timestamp > 600
rdma_doctor_diag_success == 0

# Node config issues
rdma_doctor_node_check_failure == 1
rdma_doctor_node_pf_label_present == 0
rdma_doctor_node_roce_resource_capacity == 0

# Host hardware issues
rdma_doctor_check_status{scope="host", check="gateway_ping"} == 0
rdma_doctor_host_sriov_numvfs != rdma_doctor_host_detected_vfs
rdma_doctor_host_issue_count > 0

# Pod RDMA issues
rdma_doctor_check_status{scope="pod", check="device_present"} == 0
rdma_doctor_check_status{scope="pod", check="gateway_ping"} == 0
rdma_doctor_pod_vf_count != rdma_doctor_pod_expected_vf_count
```

## Alert-to-Action Mapping

When alerts fire, this is the typical first action. Most alerts require manual investigation or ops escalation.

| Alert | Condition pattern | First action |
|-------|------------------|--------------|
| `RoceHostOffline` | host `gateway_ping` AND `gateway_ping_ip` both fail | Physical network issue (cable, switch port, NIC). Manual investigation. |
| `RoceHostGatewayNotMatch` | host `gateway_ping` fails but `gateway_ping_ip` passes | NIC plugged into wrong switch port, or switch VLAN config mismatch. Cable/switch check. |
| `RoceHostRouteMiss` | host `route_check` fails | Node init gap — missing route config. Ops setup. |
| `RocePodOffline` | pod `gateway_ping` AND `gateway_ping_ip` both fail | Drain healthy pods from node, then investigate. |
| `RocePodGatewayNotMatch` | pod `gateway_ping` fails but `gateway_ping_ip` passes | Likely VLAN or MTU mismatch at pod level. |
| `RocePodRouteMiss` | pod `route_check` fails | Usually cluster-wide — check [[roce-operator]] policy routing config and NAD. |
| `RocePodDeviceMiss` | pod `vf_count_match` fails | VF not injected. Drain healthy pods, investigate SR-IOV device plugin and NAD. |
| `RoceNodeUnitLabelMiss` | node `topology_label_present` fails | New node, missing `roce.scitix.ai/unit`. Cordon + ops apply label. |
| `RoceNodePfNamesLabelMiss` | node `pf_label_present` fails | New node not initialized. Cordon + wait for ops. |
| `RoceNodeResourceLabelMiss` | resource label missing but PF label present | NodeMeta controller in [[roce-operator]] not working. Check operator logs. |
| `RoceNodeNetworkLabelMiss` | network label missing but PF label present | Same as above — NodeMeta controller issue. |
| `RoceRegisterFailed` | RDMA resources not in node `allocatable` | Restart RDMA device plugin pod. |
| `RoceVfDeviceMiss` | `numvfs` and expected match but `detected_vfs` lower | Drain pods, re-initialize VFs or investigate driver/firmware. |
| `RoceSriovInitError` | `numvfs != expected_resource_count` | Node SR-IOV not set up. Cordon, manual init. |

## Recommended Diagnostic Order

When investigating RoCE issues on a node via metrics:

1. **Agent running?** `rdma_doctor_diag_last_run_timestamp` — if stale, agent itself is down
2. **Node config OK?** `rdma_doctor_node_check_failure` — labels, resources, topology
3. **Host NICs OK?** `rdma_doctor_host_issue_count` and host `check_status` — gateway, VF counts
4. **Pods OK?** Pod `check_status` — device_present, gateway_ping, routes
5. **Drill down**: `reason` label on `*_last_error_info` metrics for specifics

This is the same priority as the cross-layer pattern table — earlier failures invalidate later checks.

## See Also

- [[roce-operator]] @related — independent IPAM/configuration system; rdma-doctor verifies its effects at OS level
- [[roce-modes]] @depends_on — pod-level checks behave differently per RoCE mode (e.g., switchdev PF cannot ping gateway, this is normal)
- [[policy-routing]] @related — pod `route_check` interpretation depends on whether policy routing is enabled
