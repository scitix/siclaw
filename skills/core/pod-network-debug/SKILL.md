---
name: pod-network-debug
description: >-
  Diagnose end-to-end pod network connectivity (pod-to-pod, pod-to-service, pod-to-external).
  Checks DNS resolution, service endpoints, CNI plugin health, and routing issues.
---

# Pod Network Connectivity Diagnosis

When a pod cannot reach another pod, service, or external endpoint, follow this flow to identify where the network path is broken.

**Scope:** This skill is for **diagnosis only**. Once you identify the break point, report it to the user and stop. Do NOT attempt to modify services, network configurations, or CNI settings.

## Diagnostic Flow

### 1. Identify the connection endpoints

Determine source, destination, and protocol:

```bash
kubectl get pod <source-pod> -n <source-ns> -o jsonpath='podIP={.status.podIP} hostIP={.status.hostIP} node={.spec.nodeName}'
```

For pod-to-service:

```bash
kubectl get service <service> -n <target-ns>
kubectl get endpoints <service> -n <target-ns>
```

For pod-to-pod:

```bash
kubectl get pod <target-pod> -n <target-ns> -o jsonpath='podIP={.status.podIP} hostIP={.status.hostIP} node={.spec.nodeName}'
```

### 2. Check DNS resolution

Most connectivity issues that appear as "connection refused" are actually DNS failures.

Test from the source pod:

```bash
kubectl exec <source-pod> -n <source-ns> -- nslookup <service>.<target-ns>.svc.cluster.local
```

If DNS fails, check CoreDNS:

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
```

Check the pod's DNS configuration:

```bash
kubectl get pod <source-pod> -n <source-ns> -o jsonpath='{.spec.dnsPolicy}'
```

Use `dns-debug` skill for deeper DNS analysis.

### 3. Check service and endpoints

```bash
kubectl get service <service> -n <target-ns> -o wide
```

Verify:
- **CLUSTER-IP** — is it assigned? (headless services have `None`)
- **PORT(S)** — do the ports match the target container's ports?
- **SELECTOR** — does it match the target pod labels?

```bash
kubectl get endpoints <service> -n <target-ns>
```

If endpoints are empty or missing the target pod, the service selector doesn't match:

```bash
kubectl get service <service> -n <target-ns> -o jsonpath='{.spec.selector}'
kubectl get pod <target-pod> -n <target-ns> -o jsonpath='{.metadata.labels}'
```

### 4. Check target pod health

The target pod must be Running and passing readiness probes to receive traffic:

```bash
kubectl get pod <target-pod> -n <target-ns> -o wide
```

If the pod is Running but not Ready, check readiness probe:

```bash
kubectl describe pod <target-pod> -n <target-ns> | grep -A 10 "Readiness"
```

Not-Ready pods are excluded from service endpoints.

### 5. Check CNI plugin health

```bash
kubectl get pods -n kube-system | grep -iE 'calico|cilium|flannel|weave|antrea|multus'
```

If CNI pods are not Running on the affected nodes, network connectivity will fail.

For Cilium:

```bash
kubectl get pods -n kube-system -l k8s-app=cilium -o wide
```

### 6. Check NetworkPolicies

If DNS and service are healthy, NetworkPolicies may be blocking traffic:

```bash
kubectl get networkpolicy -n <source-ns>
kubectl get networkpolicy -n <target-ns>
```

If policies exist, use `networkpolicy-debug` skill for detailed analysis.

### 7. Check same-node vs cross-node

Determine if source and target are on the same node:

```bash
kubectl get pod <source-pod> -n <source-ns> -o jsonpath='{.spec.nodeName}'
kubectl get pod <target-pod> -n <target-ns> -o jsonpath='{.spec.nodeName}'
```

If same-node communication works but cross-node fails, the issue is at the node networking / overlay / underlay level.

### 8. Match pattern and conclude

---

#### DNS resolution fails — CoreDNS issue

The source pod cannot resolve service names. Check CoreDNS pods (step 2). Common causes:
- CoreDNS pods not running
- CoreDNS ConfigMap misconfigured
- Pod dnsPolicy set to `Default` (uses node DNS, not cluster DNS)
- Network policy blocking DNS traffic (UDP/TCP port 53)

---

#### Empty endpoints — service selector mismatch

Service exists but has no endpoints. The service's label selector doesn't match any Running+Ready pods.

Compare service selector with pod labels (step 3). This is the most common cause of "service unreachable."

---

#### Pod not Ready — excluded from service endpoints

Target pod is Running but failing readiness probes. It won't receive service traffic.

Check readiness probe configuration and pod logs to understand why the probe fails.

---

#### Connection refused on correct IP

The target pod's IP is reachable but the application is not listening on the expected port.

```bash
kubectl get pod <target-pod> -n <target-ns> -o jsonpath='{.spec.containers[*].ports}'
```

Verify the service `targetPort` matches the container's listening port. Note: `port` is the service port, `targetPort` is the container port.

---

#### Cross-node communication fails, same-node works

The overlay network (VXLAN, Geneve, WireGuard, etc.) or underlay routing between nodes is broken.

Check:
- CNI pods are running on both nodes (step 5)
- Node-to-node connectivity at the infrastructure level
- Firewall rules between nodes (cloud security groups, iptables)
- MTU mismatches (common with overlay networks)

---

#### External connectivity fails — pod cannot reach internet

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.dnsPolicy}'
```

Check:
- Is there a default egress NetworkPolicy blocking external traffic?
- Does the node have internet access?
- Is there a NAT gateway or proxy configured?
- Check if pod uses `hostNetwork: true` — that bypasses pod networking entirely

---

#### kube-proxy / iptables issues

Service ClusterIP traffic is handled by kube-proxy (iptables/IPVS mode). If kube-proxy is down, service IPs won't route:

```bash
kubectl get pods -n kube-system | grep kube-proxy
kubectl logs -n kube-system -l k8s-app=kube-proxy --tail=50
```

In IPVS mode, check IPVS rules on the node. In iptables mode, the rules are managed automatically.

## Notes

- Always test DNS first — it's the most common cause of connectivity failures.
- `kubectl exec <pod> -- cat /etc/resolv.conf` shows the pod's DNS configuration.
- For multi-container pods, specify the container: `kubectl exec <pod> -c <container> -- ...`
- If the source pod has no network utilities (curl, nslookup), consider using a debug container or the `dns-debug` skill's debug pod approach.
- Service type `ExternalName` does a CNAME redirect — it doesn't have endpoints or ClusterIP. DNS issues with ExternalName services are different from ClusterIP services.
