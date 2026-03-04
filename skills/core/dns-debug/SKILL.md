---
name: dns-debug
description: >-
  Diagnose DNS resolution failures in the cluster (NXDOMAIN, timeouts, SERVFAIL).
  Checks CoreDNS health, service endpoints, and DNS configuration.
---

# DNS Resolution Failure Diagnosis

When pods report DNS resolution failures (service discovery not working, NXDOMAIN errors, DNS timeouts), follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify CoreDNS configuration or network policies — that should be left to the user or cluster administrator.

## Diagnostic Flow

### 1. Verify DNS resolution from a pod

If a specific pod is having DNS issues, test DNS resolution from within that pod:

```bash
kubectl exec <pod> -n <ns> -- nslookup <service-name>
```

For cross-namespace service resolution:

```bash
kubectl exec <pod> -n <ns> -- nslookup <service-name>.<target-namespace>.svc.cluster.local
```

If `nslookup` is not available in the container, try:

```bash
kubectl exec <pod> -n <ns> -- cat /etc/resolv.conf
```

This shows the DNS server the pod is configured to use and the search domains.

### 2. Check CoreDNS pod status

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
```

All CoreDNS pods should be `Running` and `Ready`. Note which nodes they are running on.

### 3. Check CoreDNS logs

```bash
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100
```

Look for error messages, SERVFAIL responses, or upstream DNS failures.

### 4. Check DNS Service and Endpoints

```bash
kubectl get svc -n kube-system kube-dns
kubectl get endpoints -n kube-system kube-dns
```

The `kube-dns` service should have a ClusterIP, and the endpoints should list the CoreDNS pod IPs. If endpoints are empty, CoreDNS pods are not ready.

### 5. Match error and conclude

---

#### `NXDOMAIN` / `server can't find` — Name does not exist

The DNS name cannot be resolved. Common causes:

- **Typo in service name** — verify the service exists: `kubectl get svc -n <target-namespace> <service-name>`
- **Wrong namespace** — services must be referenced as `<service>.<namespace>.svc.cluster.local` from other namespaces
- **Service doesn't exist** — the target service has not been created
- **Headless service with no endpoints** — the service exists but has no backing pods

Advise the user to verify the service name, namespace, and that the target service exists with ready endpoints.

---

#### `connection timed out` / `no servers could be reached` — DNS timeout

DNS queries are not reaching CoreDNS or CoreDNS is not responding.

Check CoreDNS pod health (step 2). If CoreDNS pods are healthy, possible causes:
- **Network policy** blocking DNS traffic (UDP/TCP port 53 to kube-dns service)
- **Node-level network issue** — the pod's node may have connectivity problems to CoreDNS nodes
- **CoreDNS overloaded** — too many DNS queries overwhelming CoreDNS

```bash
kubectl top pods -n kube-system -l k8s-app=kube-dns
```

---

#### `SERVFAIL` — Server failure

CoreDNS received the query but failed to resolve it. Common causes:
- **Upstream DNS failure** — CoreDNS cannot reach the upstream/external DNS server
- **Invalid CoreDNS configuration** — check the CoreDNS ConfigMap

```bash
kubectl get configmap -n kube-system coredns -o yaml
```

Look for the `forward` directive — it defines where CoreDNS forwards external queries.

---

#### `ndots` / slow external DNS resolution — Search domain misconfiguration

By default, Kubernetes sets `ndots:5` in pods' `resolv.conf`, causing external domains (e.g., `api.example.com`) to be tried with cluster search domains first, leading to unnecessary NXDOMAIN queries before the real resolution.

Check the pod's DNS configuration:

```bash
kubectl exec <pod> -n <ns> -- cat /etc/resolv.conf
```

If `ndots:5` is set and the pod frequently resolves external domains, advise the user to set `dnsConfig.options` in the pod spec to lower `ndots` or add specific `searches` entries.

---

#### CoreDNS pods `CrashLoopBackOff` / not ready — CoreDNS failure

CoreDNS itself is failing. Check CoreDNS logs (step 3) for the specific error.

Common causes:
- **Invalid Corefile** — syntax error in CoreDNS ConfigMap
- **Upstream DNS unreachable** — the `forward` target is not reachable
- **Resource exhaustion** — CoreDNS pods need more CPU/memory

---

#### Endpoints empty for `kube-dns` — No CoreDNS backends

The DNS service has no endpoints, meaning no CoreDNS pods are ready. All DNS queries in the cluster will fail.

Check CoreDNS pod status and events for why they are not ready.

## Notes

- The `kube-dns` service name is used even when CoreDNS is the DNS provider — this is for backwards compatibility.
- For pods using `hostNetwork: true`, DNS resolution uses the node's `/etc/resolv.conf` instead of the cluster DNS. These pods cannot resolve cluster-internal service names by default.
- If testing DNS from outside the cluster, remember that `*.svc.cluster.local` names are only resolvable from within the cluster.
