---
title: Policy Routing
type: concept
---

# Policy Routing

Policy routing is the per-interface routing-table mechanism used by [[roce-operator]] to make multi-VF (multi-rail) pods send traffic out the correct interface for each subnet. Without it, a pod with multiple RDMA interfaces ends up with multiple default routes and conflicting subnet routes in the main routing table — traffic ends up going through the wrong NIC.

## When to use this page

Read this page when:
- A pod has multiple RDMA interfaces (multi-rail, multi-VF) and traffic is going through the wrong interface
- Inside a pod, `ip rule list` shows only the default rules (0, 32766, 32767) — policy routing not active
- Investigating why a static route configured in IPPool `routes[]` doesn't appear in the pod
- Understanding how `[[roce-operator]]` separates traffic per interface
- A NAD has `policyRouting: true` set but routing still misbehaves

## What Policy Routing Solves

Without policy routing:
- Pod has interfaces `net1` (subnet S1) and `net2` (subnet S2)
- Both want a default route → conflict in main table
- Subnet routes also accumulate in main table → kernel may pick the wrong interface for cross-rail traffic
- Result: traffic for S1 may exit through `net2` and vice versa

With policy routing:
- Each interface gets its own routing table
- A policy rule `from <subnet>` directs traffic from that subnet to the dedicated table
- Traffic stays on the correct interface

## Where It Lives

Policy routing is implemented in **[[roce-operator]]'s CNI IPAM plugin**, NOT in the Manager. This means:
- Activation is per-pod (per-interface), determined at CNI ADD time
- The Manager doesn't know whether policy routing is active for a given pod
- Configuration is in the NAD, not in [[roce-operator]] CRDs

## Activation Conditions

Policy routing is activated for an interface only when **both** are true:

1. The NAD's IPAM config has `"policyRouting": true`
2. The interface name matches the pattern `net[1-8]` (net1, net2, ..., net8)

If either condition fails, policy routing is silently skipped for that interface — traffic ends up in the main table.

## Mapping (Fixed by Interface Name)

The mapping from interface name to routing table and rule priority is hardcoded:

| Interface | Routing table | Rule priority |
|-----------|--------------|---------------|
| net1 | 101 | 10010 |
| net2 | 102 | 10020 |
| net3 | 103 | 10030 |
| net4 | 104 | 10040 |
| net5 | 105 | 10050 |
| net6 | 106 | 10060 |
| net7 | 107 | 10070 |
| net8 | 108 | 10080 |

Pattern: table = `100 + N`, priority = `10000 + N*10` for interface `netN`.

## What Policy Routing Installs

For each policy-routed interface, the CNI plugin installs three things in the pod's network namespace:

1. **Policy rule**: `from <subnet>/<prefix> table <N> pref <priority>`
   - The source subnet uses the actual prefix length of the allocated IP (not /32)
2. **Connected subnet route in dedicated table**: `<subnet> dev <iface> scope link table <N>`
3. **Default gateway route in dedicated table**: `default via <gateway> table <N>`

The main routing table is **not** modified for this interface — no default route is added there.

## Verification Inside Pod

To check whether policy routing is active for an interface:

```bash
# Should show per-interface rules
kubectl exec <pod> -n <ns> -- ip rule list
# Looks for: from <subnet> lookup <table-id>

# Should show subnet route + default route
kubectl exec <pod> -n <ns> -- ip route show table 101
```

If `ip rule list` shows only:
```
0:      from all lookup local
32766:  from all lookup main
32767:  from all lookup default
```
Then policy routing is not active. Either `policyRouting` is not set, or the interface name doesn't match `net[1-8]`.

## Important Quirk: IPPool routes[] Are Ignored

In policy routing mode, the IPPool's `subnets[].routes[]` field is **completely ignored** by the CNI plugin. Only two routes go into each table:
1. The connected subnet route
2. The default-via-gateway route

This means: any custom static routes you configured in the IPPool will not appear in policy-routed pods. If you need additional routes in a multi-VF pod, the NAD/policy routing implementation must be extended.

This is a frequent source of "I configured a route in IPPool but it doesn't appear in the pod" confusion.

## Failure Modes

| Symptom | Likely cause |
|---------|-------------|
| `ip rule list` shows only default rules | `policyRouting: true` not set, OR interface name doesn't match `net[1-8]` |
| Some interfaces have rules, others don't | Mixed interface naming — only `net[1-8]` activates policy routing |
| IPPool `routes[]` not visible in pod | Expected — they are ignored in policy routing mode |
| Traffic goes through wrong interface despite policy routing | Source IP doesn't match the rule's `from` subnet (e.g., NAT rewrite, source binding to wrong IP) |

## See Also

- [[roce-operator]] @depends_on — implements policy routing in the CNI plugin; IPPool subnet provides the values
- [[rdma-doctor]] @related — pod `route_check` interpretation depends on whether policy routing is enabled (the agent detects and adjusts)
