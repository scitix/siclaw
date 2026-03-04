---
name: ingress-debug
description: >-
  Diagnose Ingress failures (rules not matching, backend unreachable, TLS errors, no address assigned).
  Checks Ingress resources, IngressClass, backend Services, and controller health to identify why external traffic is not routed correctly.
---

# Ingress Failure Diagnosis

When external traffic cannot reach a Service through an Ingress — 404, 502, TLS errors, or no address assigned — follow this flow to identify the root cause.

**Scope:** This skill is for **diagnosis only**. Once you identify the root cause, report it to the user and stop. Do NOT attempt to modify Ingress resources, Services, or TLS secrets — that should be left to the user.

## Diagnostic Flow

### 1. Check Ingress status

```bash
kubectl get ingress <ingress-name> -n <ns>
```

Note:
- **CLASS** — the IngressClass being used
- **HOSTS** — configured hostnames
- **ADDRESS** — the external IP/hostname assigned by the controller. If empty, the controller has not processed this Ingress.
- **PORTS** — 80, 443 (if TLS is configured)

### 2. Describe the Ingress

```bash
kubectl describe ingress <ingress-name> -n <ns>
```

Focus on:
- **Rules** — host and path routing rules with their backend services
- **TLS** — configured TLS hosts and secret names
- **Default backend** — the fallback backend if no rule matches
- **Events** — errors from the Ingress controller (sync failures, configuration errors)
- **Annotations** — controller-specific annotations that affect routing behavior

### 3. Verify backend Service and Endpoints

For each backend referenced by the Ingress rules:

```bash
kubectl get svc <backend-service> -n <ns>
kubectl get endpoints <backend-service> -n <ns>
```

If the backend Service has no endpoints, traffic will fail with 502/503. Use the `service-debug` skill for deeper diagnosis.

### 4. Check Ingress controller health

Find the Ingress controller pods (common labels):

```bash
kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx
```

If not using nginx-ingress, check other common namespaces:

```bash
kubectl get pods --all-namespaces -l app.kubernetes.io/component=controller | head -20
```

Verify controller pods are `Running` and `Ready`. Check controller logs for errors:

```bash
kubectl logs -n <controller-ns> <controller-pod> --tail=100
```

### 5. Check IngressClass

```bash
kubectl get ingressclass
```

Verify the IngressClass referenced by the Ingress exists. If the Ingress does not specify an IngressClass, it relies on the cluster's default:

```bash
kubectl get ingressclass -o jsonpath='{range .items[?(@.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'
```

### 6. Match patterns and conclude

---

#### No ADDRESS assigned — Controller not processing the Ingress

The Ingress has no external IP/hostname assigned.

Common causes:
- **IngressClass mismatch** — the Ingress specifies a class that doesn't match any installed controller
- **Controller not running** — check step 4
- **Controller not watching this namespace** — some controllers are configured to only watch specific namespaces
- **Annotation missing** — older controllers may require `kubernetes.io/ingress.class` annotation instead of `spec.ingressClassName`

Check the controller logs for messages about skipping or ignoring this Ingress.

---

#### 404 Not Found — No matching rule

The Ingress controller received the request but no rule matched.

- **Host mismatch** — the `Host` header in the request does not match any rule's `host` field. Verify DNS resolves to the Ingress address and the host is correct.
- **Path mismatch** — the request path does not match any rule's `path`. Check the `pathType` (`Prefix`, `Exact`, `ImplementationSpecific`) — it affects matching behavior.
- **No default backend** — if no rule matches and no default backend is set, the controller returns 404.

```bash
kubectl get ingress <ingress-name> -n <ns> -o jsonpath='{range .spec.rules[*]}{.host}: {range .http.paths[*]}{.path} ({.pathType}) -> {.backend.service.name}:{.backend.service.port.number}{"\n"}{end}{end}'
```

---

#### 502 Bad Gateway / 503 Service Unavailable — Backend not reachable

The Ingress controller matched a rule but cannot reach the backend.

- **Service has no ready endpoints** — check `kubectl get endpoints <backend-service> -n <ns>`. Use `service-debug` if endpoints are empty.
- **Port mismatch** — the Ingress backend port does not match the Service port.
- **Backend pods not healthy** — pods exist but are failing readiness probes.
- **Network policy blocking** — a NetworkPolicy may be blocking traffic from the controller to the backend pods.

```bash
kubectl get svc <backend-service> -n <ns> -o jsonpath='{range .spec.ports[*]}port={.port} targetPort={.targetPort}{"\n"}{end}'
```

---

#### TLS/SSL errors — Certificate issues

HTTPS requests fail with certificate errors or the controller cannot serve TLS.

Check the TLS secret:

```bash
kubectl get secret <tls-secret-name> -n <ns>
```

If the secret does not exist, the controller cannot serve TLS for that host. Verify the secret type is `kubernetes.io/tls` and contains `tls.crt` and `tls.key`:

```bash
kubectl get secret <tls-secret-name> -n <ns> -o jsonpath='{.type}'
```

Common issues:
- **Secret not found** — the TLS secret referenced in the Ingress does not exist in the same namespace
- **Expired certificate** — the certificate has expired
- **Hostname mismatch** — the certificate's CN/SAN does not match the Ingress host
- **cert-manager not issuing** — if using cert-manager, check the Certificate resource and its events

---

#### Mixed HTTP/HTTPS behavior — Redirect or annotation issue

- Requests on HTTP should redirect to HTTPS but don't (or vice versa)
- The controller may have annotations controlling SSL redirect behavior

Common nginx-ingress annotations:
- `nginx.ingress.kubernetes.io/ssl-redirect` — controls HTTP→HTTPS redirect
- `nginx.ingress.kubernetes.io/force-ssl-redirect` — forces redirect even without TLS configured

Check the Ingress annotations:

```bash
kubectl get ingress <ingress-name> -n <ns> -o jsonpath='{.metadata.annotations}'
```

---

#### Timeout / connection reset — Controller or upstream issue

Requests reach the Ingress but time out or get reset.

- **Backend is slow** — the application takes too long to respond. Check controller timeout annotations.
- **Proxy buffer/body size** — large request bodies may be rejected. Check annotations like `nginx.ingress.kubernetes.io/proxy-body-size`.
- **Controller resource exhaustion** — the controller pod may be overloaded.

```bash
kubectl top pods -n <controller-ns> -l app.kubernetes.io/name=ingress-nginx
```

## Notes

- This skill covers generic Ingress resources. For Gateway API (`HTTPRoute`, `Gateway`), different resources and controllers apply.
- Ingress controller logs are the most useful source for debugging routing issues — always check them when the cause is unclear.
- If the cluster uses multiple Ingress controllers, make sure the Ingress's `ingressClassName` matches the correct controller.
- For cloud-managed Ingress (AWS ALB Ingress Controller, GCE Ingress), the controller creates cloud load balancers — check cloud provider console if the ADDRESS is stuck or the load balancer is unhealthy.
