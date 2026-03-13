---
name: networkpolicy-debug
description: >-
  Diagnose NetworkPolicy-related connectivity issues (traffic unexpectedly blocked, default-deny effects, egress blocking DNS).
  Identifies which NetworkPolicies affect a pod, checks ingress/egress rules, and verifies CNI support.
---

# NetworkPolicy Connectivity Diagnosis

When pod-to-pod or pod-to-external communication is unexpectedly blocked, and Service/DNS/Ingress diagnostics show no issues, NetworkPolicy is a common root cause. Follow this flow to identify whether a NetworkPolicy is blocking traffic.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify or delete NetworkPolicies — that should be left to the user or cluster administrator.

**When to use:** Pod connectivity "suddenly broke" or a newly deployed pod cannot reach other services. Typical clues:
- `service-debug` shows endpoints exist and ports match, but connections time out
- `dns-debug` shows DNS timeouts (may be egress NetworkPolicy blocking UDP 53)
- Traffic works from some pods but not others in the same namespace
- A new NetworkPolicy was recently applied

**Not for other network issues:** If the problem is DNS resolution → use `dns-debug`. If the problem is Service having no endpoints → use `service-debug`. If the problem is Ingress routing → use `ingress-debug`. This skill specifically diagnoses NetworkPolicy-level blocking.

## Key Concepts

- A NetworkPolicy selects pods via `podSelector` and defines allowed `ingress` (incoming) and/or `egress` (outgoing) traffic rules.
- **NetworkPolicy is deny-by-default once applied.** If any NetworkPolicy selects a pod for a given direction (ingress or egress), all traffic in that direction is denied EXCEPT what is explicitly allowed by the rules. Pods with NO NetworkPolicy selecting them allow all traffic.
- Multiple NetworkPolicies selecting the same pod are **additive (union)** — a connection is allowed if ANY matching policy permits it.
- NetworkPolicy requires **CNI support**. If the CNI plugin does not support NetworkPolicy (e.g., Flannel without additional plugins), policies are silently ignored — they can be created but have no effect.

## Diagnostic Flow

### 1. Verify CNI supports NetworkPolicy

Not all CNI plugins enforce NetworkPolicy. If the CNI does not support it, policies are silently ignored — they exist as API objects but have no effect.

Check which CNI is running:

```bash
kubectl get pods -n kube-system -o custom-columns='NAME:.metadata.name' | grep -E 'calico|cilium|weave|antrea|flannel|canal|kube-router'
```

If no results, the CNI may run in a different namespace (e.g., `cilium` in `cilium` namespace, `calico` in `calico-system`). Check other namespaces or inspect the node's CNI config:

```bash
kubectl get pods -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name' | grep -E 'calico|cilium|weave|antrea|flannel|canal|kube-router'
```

| CNI | NetworkPolicy support |
|-----|----------------------|
| Calico | Yes |
| Cilium | Yes (also supports extended CiliumNetworkPolicy) |
| Weave Net | Yes |
| Antrea | Yes |
| Canal (Flannel + Calico) | Yes |
| kube-router | Yes |
| Flannel (standalone) | **No** — policies are silently ignored |
| kubenet | **No** |

If the CNI does not support NetworkPolicy:
- Policies exist but do nothing — not the cause of blocked traffic, look elsewhere
- If the user expects policies to work, they need to switch to a CNI that supports them

If the CNI does support NetworkPolicy, continue to step 2.

### 2. List NetworkPolicies in the namespace

```bash
kubectl get networkpolicy -n <ns>
```

If no NetworkPolicies exist in the namespace, NetworkPolicy is not the cause — all traffic is allowed by default. Look elsewhere (firewall rules, service mesh, node-level iptables).

If NetworkPolicies exist, continue to step 3.

### 3. Identify which policies affect the target pod

Kubernetes does not provide a direct API to query "which policies affect this pod." You must manually match each policy's `podSelector` against the pod's labels.

Get the pod's labels:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.metadata.labels}'
```

Get all NetworkPolicies with their full pod selectors:

```bash
kubectl get networkpolicy -n <ns> -o custom-columns='NAME:.metadata.name,SELECTOR:.spec.podSelector'
```

Note: `podSelector` can use both `matchLabels` (exact key-value pairs) and `matchExpressions` (operators like `In`, `NotIn`, `Exists`, `DoesNotExist`). The command above shows both forms. If the output is truncated, use `-o yaml` to see the full selector.

A NetworkPolicy affects the pod if:
- The policy's `podSelector.matchLabels` matches a **subset** of the pod's labels
- The policy's `podSelector.matchExpressions` conditions are satisfied by the pod's labels (e.g., `{key: tier, operator: Exists}` matches any pod with a `tier` label)
- An **empty podSelector** (`{}`) matches ALL pods in the namespace

List the matching policies — these are the ones controlling the pod's traffic.

### 4. Check for default-deny policies

A common pattern is a namespace-wide "deny all" policy:

```bash
kubectl get networkpolicy -n <ns> -o yaml
```

Look for policies with empty ingress or egress rules:

**Default deny all ingress:**
```yaml
spec:
  podSelector: {}     # matches all pods
  policyTypes:
  - Ingress
  # no ingress rules = deny all incoming
```

**Default deny all egress:**
```yaml
spec:
  podSelector: {}
  policyTypes:
  - Egress
  # no egress rules = deny all outgoing
```

**Default deny both:**
```yaml
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

If a default-deny policy exists, ALL traffic to/from pods in the namespace is blocked unless another NetworkPolicy explicitly allows it.

### 5. Determine which directions a policy controls

Before diagnosing ingress or egress, first confirm which direction(s) each matching policy actually controls. This depends on the `policyTypes` field:

```bash
kubectl get networkpolicy <policy-name> -n <ns> -o jsonpath='{.spec.policyTypes}'
```

| `policyTypes` value | Ingress controlled? | Egress controlled? |
|---------------------|--------------------|--------------------|
| `[Ingress]` | Yes | No — egress is unrestricted |
| `[Egress]` | No — ingress is unrestricted | Yes |
| `[Ingress, Egress]` | Yes | Yes |
| *Omitted entirely* | Yes (always implied) | Only if `egress` rules exist |

**The omitted case is a common trap:** If `policyTypes` is not specified but the policy has `ingress` rules and no `egress` rules, only ingress is controlled — egress remains fully open. If both `ingress` and `egress` rules are present (even empty), both directions are controlled.

If the connectivity issue is incoming traffic, focus on policies that control ingress (step 6). If outgoing, focus on egress (step 7). Do not waste time analyzing a direction the policy does not control.

### 6. Diagnose blocked ingress (incoming traffic to the pod)

If external pods or services cannot reach the target pod, check the ingress rules of all matching policies.

For each matching policy:

```bash
kubectl get networkpolicy <policy-name> -n <ns> -o yaml
```

Check the `ingress` section. Traffic is allowed if the source matches ANY `from` rule:

- **from[].podSelector** — allows traffic from pods with matching labels in the SAME namespace
- **from[].namespaceSelector** — allows traffic from pods in namespaces with matching labels
- **from[].podSelector + namespaceSelector** (in same `from` entry) — AND logic: pods must match both selectors
- **from[].ipBlock** — allows traffic from specific CIDR ranges

**Common issue: separate vs combined selectors**

```yaml
# AND logic — pod must be in matching namespace AND have matching labels
ingress:
- from:
  - namespaceSelector:
      matchLabels: {env: prod}
    podSelector:
      matchLabels: {role: frontend}

# OR logic — ANY pod in matching namespace OR ANY pod with matching labels
ingress:
- from:
  - namespaceSelector:
      matchLabels: {env: prod}
  - podSelector:
      matchLabels: {role: frontend}
```

The difference is whether `namespaceSelector` and `podSelector` are in the **same list item** (AND) or **separate list items** (OR). This is a frequent source of misconfiguration.

Check if the source pod's labels and namespace match any `from` rule. If not, the ingress is blocked.

Also check the `ports` section — if specified, only listed ports/protocols are allowed:

```yaml
ingress:
- from: [...]
  ports:
  - protocol: TCP
    port: 8080
```

If the source is connecting on a different port, it will be blocked even if the `from` selector matches.

### 7. Diagnose blocked egress (outgoing traffic from the pod)

If the pod cannot reach other services or external endpoints, check the egress rules.

For each matching policy that includes `Egress` in `policyTypes`:

```bash
kubectl get networkpolicy <policy-name> -n <ns> -o yaml
```

Check the `egress` section. The same selector logic applies as ingress (podSelector, namespaceSelector, ipBlock).

**Critical: DNS egress**

If any egress NetworkPolicy is applied to a pod, DNS traffic (UDP/TCP port 53) must be explicitly allowed, otherwise all DNS resolution will fail:

```yaml
egress:
- to:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
  ports:
  - protocol: UDP
    port: 53
  - protocol: TCP
    port: 53
```

Note: The example above targets only `kube-system` where CoreDNS runs. A broader alternative is `namespaceSelector: {}` (matches all namespaces), which is simpler but allows port 53 traffic to any namespace. When diagnosing, check whether ANY rule allows UDP/TCP 53 — the specificity of the namespace selector is a security concern but not a functionality blocker.

**Symptoms of blocked DNS egress:**
- `nslookup` times out from the pod
- Service names cannot be resolved but IP-based connections work
- Looks identical to a CoreDNS failure but only affects pods with egress policies

If the user reports DNS timeouts and the pod has an egress NetworkPolicy, check DNS port allowance FIRST before investigating CoreDNS with `dns-debug`.

### 8. Cross-namespace communication

When pods in different namespaces need to communicate, NetworkPolicies on BOTH sides may need to allow the traffic:

- The **destination pod's** NetworkPolicy must allow ingress from the source namespace/pod
- The **source pod's** NetworkPolicy (if it has egress rules) must allow egress to the destination namespace/pod

Check both sides:

```bash
# Destination namespace policies
kubectl get networkpolicy -n <destination-ns>

# Source namespace policies
kubectl get networkpolicy -n <source-ns>
```

For `namespaceSelector` to work, the target namespace must have the referenced labels:

```bash
kubectl get namespace <ns> --show-labels
```

If the namespace lacks the expected labels, the `namespaceSelector` will not match and traffic will be blocked.

## Notes

- **No policy = allow all.** NetworkPolicy is not deny-by-default at the cluster level. Only pods explicitly selected by at least one NetworkPolicy have restrictions. This means adding the FIRST NetworkPolicy to a namespace can suddenly break existing communication.
- **Policies are additive.** If policy A allows port 80 and policy B allows port 443 for the same pod, both ports are allowed. Policies never subtract permissions from each other.
- **`policyTypes` matters.** See step 5 for the full behavior matrix. Misunderstanding which direction a policy controls is a common cause of wasted debugging effort.
- **CIDR ranges and pod IPs.** Using `ipBlock` with pod CIDR ranges is fragile — pod IPs change. Prefer `podSelector` / `namespaceSelector` for in-cluster traffic. `ipBlock` is best for external IPs.
- **Service mesh interaction.** If the cluster runs Istio, Linkerd, or similar service meshes, traffic may be additionally controlled by the mesh's own policies (AuthorizationPolicy, etc.). NetworkPolicy operates at L3/L4, while service mesh policies typically operate at L7.
- **GPU clusters: multi-NIC / RDMA traffic is NOT affected by NetworkPolicy.** In GPU training clusters, pods typically have multiple network interfaces: a primary NIC (eth0) managed by the CNI, and secondary NICs (net1, etc.) for RDMA/InfiniBand/RoCE provisioned via Multus + SR-IOV or host-device plugin. NetworkPolicy only applies to the **primary CNI-managed interface**. RDMA/NCCL traffic on secondary interfaces bypasses CNI entirely and is invisible to NetworkPolicy. If a training job's GPU-to-GPU communication (NCCL) fails, NetworkPolicy is NOT the cause — investigate the RDMA network instead. If the same pod cannot reach the API server, download data, or resolve DNS, those go through the primary NIC and CAN be blocked by NetworkPolicy.
- **Quick verification:** To confirm a NetworkPolicy is the cause, test connectivity from a pod in the same namespace that is NOT selected by any NetworkPolicy (or from a different namespace without policies). If the same connection works from the unaffected pod, the NetworkPolicy is confirmed as the blocker.
- For cross-reference: if DNS is timing out, check egress rules here first, then use `dns-debug`. If Service endpoints exist but connections fail, check ingress rules here, then use `service-debug`.
