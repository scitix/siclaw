---
name: service-debug
description: >-
  Diagnose Service connectivity issues (empty Endpoints, selector mismatch, port mismatch, no backend pods).
  Checks Service, Endpoints, and target pods to identify why traffic is not reaching backends.
---

# Service Connectivity Diagnosis

When a Service is unreachable, returns connection refused, or has no backends, follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify the Service, Endpoints, or pod specs — that should be left to the user.

## Diagnostic Flow

### 1. Check the Service

```bash
kubectl get svc <service> -n <ns> -o wide
```

Confirm the Service exists and note:
- **TYPE** — ClusterIP, NodePort, LoadBalancer, or ExternalName
- **CLUSTER-IP** — should not be `None` unless it is a headless service
- **PORT(S)** — the port(s) the Service exposes
- **SELECTOR** — the label selector used to find backend pods

### 2. Check Endpoints

```bash
kubectl get endpoints <service> -n <ns>
```

- If `ENDPOINTS` column shows `<none>` or is empty, no pods match the Service's selector — go to step 3.
- If endpoints exist, note the IPs and ports — go to step 4.

For more detail (including `notReadyAddresses`):

```bash
kubectl describe endpoints <service> -n <ns>
```

### 3. Investigate selector and pods

The Service's selector must match labels on running, ready pods.

Get the Service selector:

```bash
kubectl get svc <service> -n <ns> -o jsonpath='{.spec.selector}'
```

List pods that match the selector:

```bash
kubectl get pods -n <ns> -l <key>=<value> -o wide
```

(Replace `<key>=<value>` with each selector pair from the previous command.)

If no pods match:
- The selector may be wrong (typo, outdated label)
- The pods may be in a different namespace
- The pods may not exist yet

If pods exist but none are `Ready`:
- Pods may be starting, crashing, or failing readiness probes
- Use `pod-crash-debug` or check readiness probes

### 4. Check port configuration

Verify that the Service port, targetPort, and the container's actual listening port all align.

```bash
kubectl get svc <service> -n <ns> -o jsonpath='{range .spec.ports[*]}port={.port} targetPort={.targetPort} protocol={.protocol}{"\n"}{end}'
```

```bash
kubectl get pod <backend-pod> -n <ns> -o jsonpath='{range .spec.containers[*].ports[*]}containerPort={.containerPort} protocol={.protocol}{"\n"}{end}'
```

The Service's `targetPort` must match one of the container's `containerPort` values (or the named port). If they don't match, traffic will be sent to the wrong port.

Note: if the container does not declare `containerPort`, the traffic may still work — `containerPort` is informational. The real check is whether the application is actually listening on the `targetPort`.

### 5. Match patterns and conclude

---

#### Endpoints empty — No pods match selector

The Service has no endpoints because no running, ready pods match its label selector.

Possible causes:
- **Selector mismatch** — the Service selector labels don't match the pod labels (typo or outdated after a rename)
- **No pods exist** — the backing Deployment/StatefulSet has 0 replicas or hasn't been created
- **Pods not ready** — pods exist but are failing readiness probes, so they are excluded from Endpoints

Advise the user to compare the Service selector with the pod labels and ensure pods are running and ready.

---

#### `Connection refused` — Port mismatch or application not listening

Endpoints exist, but connections to the Service are refused.

- The Service `targetPort` may not match the port the application is actually listening on
- The application may not have started yet or may have crashed

Check the application logs:

```bash
kubectl logs <backend-pod> -n <ns> --tail=50
```

---

#### Service type `ExternalName` not resolving — DNS-based service issue

ExternalName services return a CNAME record. If the target hostname is unreachable or doesn't resolve, the service will appear broken.

```bash
kubectl get svc <service> -n <ns> -o jsonpath='{.spec.externalName}'
```

Verify the external name resolves from within the cluster (see `dns-debug` skill).

---

#### `NodePort` / `LoadBalancer` not reachable from outside — External access issue

For NodePort: verify the node's firewall allows the allocated port.

```bash
kubectl get svc <service> -n <ns> -o jsonpath='{.spec.ports[*].nodePort}'
```

For LoadBalancer: check the external IP assignment.

```bash
kubectl get svc <service> -n <ns>
```

If `EXTERNAL-IP` shows `<pending>`, the cloud load balancer provisioner may have failed:

```bash
kubectl describe svc <service> -n <ns>
```

Check events for errors from the cloud controller manager.

---

#### Headless Service (`ClusterIP: None`) — Expected behavior

Headless services do not get a cluster IP. DNS returns the individual pod IPs directly. This is by design for StatefulSets and services that need direct pod addressing.

If clients are getting `connection refused`, verify the individual pod IPs are correct and the pods are ready.

## Notes

- For services using `sessionAffinity: ClientIP`, connections from the same source IP are routed to the same pod — if that pod becomes unhealthy, the session sticks to it until the timeout.
- `EndpointSlices` (default in K8s 1.21+) replace Endpoints for large-scale services. You can check them with: `kubectl get endpointslices -n <ns> -l kubernetes.io/service-name=<service>`.
- If the cluster uses a service mesh (Istio, Linkerd), traffic routing may be controlled by the mesh — check the mesh's VirtualService or ServiceProfile resources.
