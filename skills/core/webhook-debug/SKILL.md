---
name: webhook-debug
description: >-
  Diagnose admission webhook failures (resource creation rejected, timeout errors, webhook
  service unavailable). Checks MutatingWebhookConfiguration, ValidatingWebhookConfiguration,
  webhook service health, and failurePolicy behavior.
---

# Admission Webhook Failure Diagnosis

When resource creation or updates fail with unexpected errors, timeouts, or rejections that don't match RBAC or quota issues, an admission webhook may be the cause. Follow this flow to identify the blocking webhook.

**Scope:** This skill is for **diagnosis only**. Once you identify the failing webhook, report it to the user and stop. Do NOT attempt to modify webhook configurations, delete webhooks, or change failurePolicy.

## Diagnostic Flow

### 1. Check the error message

The error from a webhook rejection typically includes:
- `admission webhook "<name>" denied the request: <reason>`
- `failed calling webhook "<name>": <timeout/connection error>`
- `Internal error occurred: failed calling webhook`

If you have the error message, extract the webhook name from it.

### 2. List all admission webhooks

```bash
kubectl get mutatingwebhookconfigurations
kubectl get validatingwebhookconfigurations
```

For a specific webhook:

```bash
kubectl get validatingwebhookconfigurations <name> -o yaml
```

```bash
kubectl get mutatingwebhookconfigurations <name> -o yaml
```

### 3. Identify which webhook matches the failing resource

Each webhook has `rules` that define what operations and resources it intercepts:

```bash
kubectl get validatingwebhookconfigurations -o json | jq '.items[] | {name: .metadata.name, webhooks: [.webhooks[] | {name: .name, rules: .rules, failurePolicy: .failurePolicy}]}'
```

```bash
kubectl get mutatingwebhookconfigurations -o json | jq '.items[] | {name: .metadata.name, webhooks: [.webhooks[] | {name: .name, rules: .rules, failurePolicy: .failurePolicy}]}'
```

Match the failing resource's API group, version, resource type, and operation (CREATE/UPDATE/DELETE) against the webhook rules.

### 4. Check the webhook's target service

```bash
kubectl get validatingwebhookconfigurations <name> -o json | jq '.webhooks[] | {name: .name, service: .clientConfig.service, url: .clientConfig.url}'
```

If the webhook points to a service, check if it's running:

```bash
kubectl get service <service-name> -n <service-namespace>
kubectl get endpoints <service-name> -n <service-namespace>
```

If endpoints are empty, the webhook backend has no running pods.

```bash
kubectl get pods -n <service-namespace> -l <service-selector> -o wide
```

### 5. Check webhook pod logs

```bash
kubectl logs -n <service-namespace> <webhook-pod> --tail=200
```

Look for:
- Rejection reasons (policy violations, validation failures)
- Panic/crash logs
- TLS handshake errors
- Timeout or memory issues

### 6. Check webhook certificate validity

Webhooks communicate over HTTPS. If the certificate is expired or invalid, the API server cannot reach the webhook.

```bash
kubectl get validatingwebhookconfigurations <name> -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | base64 -d | openssl x509 -text -noout | grep -E "Not Before|Not After|Subject:"
```

### 7. Match pattern and conclude

---

#### `admission webhook denied the request` — Policy violation

The webhook backend is running and intentionally rejected the request. The denial reason is in the error message.

Common causes:
- Pod security policy / OPA / Kyverno / Gatekeeper rule violation
- Image registry whitelist rejection (only approved registries allowed)
- Missing required labels or annotations
- Resource naming convention enforcement

Report the specific denial reason and which policy is enforcing it.

---

#### `failed calling webhook: context deadline exceeded` — Webhook timeout

The API server could not reach the webhook backend within the timeout (default 10s).

Causes:
- Webhook service has no ready endpoints (pods crashed or not scheduled)
- Network policy blocking API server → webhook communication
- Webhook pod is overloaded and responding slowly

Check failurePolicy to understand the impact:

```bash
kubectl get validatingwebhookconfigurations <name> -o json | jq '.webhooks[] | {name: .name, failurePolicy: .failurePolicy, timeoutSeconds: .timeoutSeconds}'
```

- `failurePolicy: Fail` — the resource operation is rejected (blocks the request)
- `failurePolicy: Ignore` — the resource operation proceeds without webhook review

---

#### Webhook service not found / no endpoints

The webhook references a service that doesn't exist or has no backing pods.

```bash
kubectl get service <service> -n <namespace>
kubectl get endpoints <service> -n <namespace>
```

This typically happens when:
- The webhook operator was uninstalled but the webhook configuration was left behind
- The webhook deployment was scaled to 0
- The webhook pods are crashing

---

#### TLS certificate expired or mismatched

The `caBundle` in the webhook configuration doesn't match the certificate presented by the webhook service.

If the webhook uses cert-manager, check the Certificate resource:

```bash
kubectl get certificate -A | grep <webhook-related-name>
kubectl describe certificate <name> -n <namespace>
```

---

#### Webhook applies to more resources than intended

A broad webhook rule (e.g., matching all resources `*`) can block unexpected operations. Check the `namespaceSelector` and `objectSelector` to see if the webhook scope is too wide:

```bash
kubectl get validatingwebhookconfigurations <name> -o json | jq '.webhooks[] | {name: .name, namespaceSelector: .namespaceSelector, objectSelector: .objectSelector}'
```

Webhooks that exclude `kube-system` namespace typically use a `namespaceSelector` with `matchExpressions` excluding the namespace.

---

#### Webhook creates circular dependency at cluster bootstrap

If a webhook depends on a service that itself requires the webhook to be available (e.g., webhook blocks all pod creation including its own pods), the cluster enters a deadlock.

Check if the webhook has a `namespaceSelector` that excludes its own namespace:

```bash
kubectl get validatingwebhookconfigurations <name> -o json | jq '.webhooks[].namespaceSelector'
```

## Notes

- `kubectl get events -A --field-selector reason=FailedCreate` may show webhook-related pod creation failures.
- Mutating webhooks run before validating webhooks. A mutating webhook can modify the resource before validation.
- Webhooks are ordered by name within each type. Multiple webhooks can act on the same resource.
- If urgent: `failurePolicy: Ignore` can be a temporary workaround (but reduces security). Report this option but advise caution.
- To see all webhooks and their failure policies at a glance: `kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations -o custom-columns='NAME:.metadata.name,WEBHOOKS:.webhooks[*].name,FAILURE:.webhooks[*].failurePolicy'`
