---
title: Tenant Isolation
type: concept
---

# Tenant Isolation

Tenant isolation is the multi-tenant networking model used by [[roce-operator]] to bind groups of namespaces to specific IPPools, enabling network-level separation between tenants in shared clusters. Critically, it is **a check that must be performed first when investigating cross-namespace RDMA failures** — and just as critically, **it does not exist in single-tenant clusters**, where many "tenant isolation" hypotheses are impossible.

## When to use this page

Read this page when:
- A pod can communicate with pods in its own namespace but not with pods in another namespace
- Investigating "cross-namespace RDMA failure"
- An IPAM error mentions "tenant" or "not match any tenant"
- Determining whether a cluster's RoCE setup is single-tenant or multi-tenant
- Triaging cross-namespace failures: tenant should be ruled in or out before deep network diagnosis

## Single-Tenant vs Multi-Tenant — The First Check

[[roce-operator]] supports two modes, controlled by Manager env var `ROCE_TOPOLOGY_STATIC_IPPOOL_NAME`:

| Mode | Env var | Tenant CRs | Cross-namespace isolation? |
|------|---------|-----------|---------------------------|
| Single-tenant | Set to an IPPool name | Not used | **No** — all pods share the same IPPool |
| Multi-tenant | Empty/unset | Required | Possible — depends on Tenant configuration |

**If the cluster is single-tenant, tenant isolation cannot be the cause of any cross-namespace failure.** This eliminates a large class of false leads. Determine the mode first.

### How to determine mode

In priority order:

1. `kubectl get tenant.roce.scitix.ai` — any Tenant CRs?
   - **Zero CRs + IPAllocations exist + pods get IPs normally** → definitively single-tenant
   - **Tenant CRs with `status.boundIPPool` set** → definitively multi-tenant
2. Still ambiguous? Check Manager env var:
   ```bash
   kubectl get deploy <manager-deploy> -n <roce-ns> -o jsonpath='{.spec.template.spec.containers[0].env}'
   ```
   `ROCE_TOPOLOGY_STATIC_IPPOOL_NAME` non-empty → single-tenant.

## Tenant CR Structure (multi-tenant only)

The Tenant CR is cluster-scoped. Each Tenant maps a list of namespaces to one IPPool:

- `spec.namespaces[]` — list of namespaces this tenant covers
- `status.boundIPPool` — currently bound IPPool name (empty until first allocation)

Binding lifecycle:
- **Bind**: on first pod allocation in a covered namespace, Manager binds an available IPPool
- **Unbind**: background loop every 30s — unbinds when active IP count for the tenant reaches zero

A namespace can belong to **at most one** Tenant. If a namespace is not in any Tenant's `spec.namespaces`, IPAM fails with `"not match any tenant"`.

## Cross-Namespace Communication: The Diagnostic Flow

When investigating "pods in namespace A cannot talk to pods in namespace B over RDMA":

```
Step 1: Is tenant isolation even possible here?
  - kubectl get crd | grep -i tenant
    → No CRD       → Tenant feature not installed. Skip this whole flow.
    → CRD exists  → Continue.
  - kubectl get tenant.roce.scitix.ai
    → No instances → Multi-tenant feature unused. Skip.
    → Instances exist → Continue.

Step 2: Are A and B in the same namespace?
  → Same namespace → Tenant cannot be the cause. Look elsewhere.
  → Different namespaces → Continue.

Step 3: Are both namespaces in the same Tenant's spec.namespaces?
  → Yes (same tenant) → Tenant is not the cause; look elsewhere.
  → No (different tenants OR one is unmatched) → Tenant isolation IS blocking.
```

## What "Tenant Isolation" Actually Does

Mechanically, tenant isolation works by giving different tenants different IPPools, which means different subnets, which means traffic is segmented at L3.

**Important**: this isolation is logical (separate IP space) but not necessarily enforced at the data plane. Whether traffic between subnets is actually blocked depends on:
- Switch routing/ACL configuration (typically allow within fabric, may restrict at gateways)
- IPPool subnet definitions and routes

So you can have a multi-tenant configuration where the ALLOCATION is segmented but the DATA PLANE is not — pods from different tenants get different IPs but can still reach each other over the network. Verify both the allocation (different tenants/pools) AND the actual reachability before concluding.

## Common Misdiagnoses

1. **Assuming tenant isolation when it doesn't exist** (most common). Cluster is single-tenant; user reports cross-namespace failure; investigator wastes time looking at "tenant config" that doesn't apply.

2. **Concluding "different tenant ⇒ data plane blocked"**. Different tenant means different IPPool (different subnets), which means different IPs and gateways. Actual traffic blocking depends on physical network, not on the Tenant CR itself. Verify by attempting connectivity.

3. **Missing namespace not in any tenant**. Pod fails to allocate IP at all because its namespace isn't covered. Symptom is `ContainerCreating`, not "communication failure". Error message: `"not match any tenant"`.

## Related Errors and Failure Modes

| Error | Meaning | Fix |
|-------|---------|-----|
| `"not match any tenant"` | Pod's namespace is in no Tenant's `spec.namespaces` | Add namespace to a Tenant |
| `"all IPPool is inuse"` | Every IPPool is bound 1:1 to a Tenant; no pool available for this Tenant | Create new IPPool, or free one by deleting all pods of an unused Tenant |

Both errors are multi-tenant only and produce IPAM allocation failures (pod stuck in `ContainerCreating`). See [[roce-operator]] FM-1.

## See Also

- [[roce-operator]] @depends_on — implements the Tenant/IPPool binding; this concept is its semantic feature
- [[roce-modes]] @related — independent concern; tenant isolation can apply in any RoCE mode
