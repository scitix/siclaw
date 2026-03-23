---
name: cert-debug
description: >-
  Diagnose TLS certificate issues (expired certificates, cert-manager failures, webhook TLS
  errors, secret missing). Checks certificate validity, issuer health, and renewal status.
---

# TLS Certificate Diagnosis

When TLS handshake failures, certificate expiration warnings, or cert-manager errors occur, follow this flow to identify the certificate issue.

**Scope:** This skill is for **diagnosis only**. Once you identify the certificate problem, report it to the user and stop. Do NOT attempt to renew, delete, or recreate certificates.

## Diagnostic Flow

### 1. Identify the TLS failure context

Determine where the TLS error is occurring:
- **Ingress / LoadBalancer** — external client TLS errors
- **Webhook** — API server cannot reach admission webhook over TLS
- **Internal service** — pod-to-pod mTLS failure
- **API server** — kubelet or client cannot connect to API server

### 2. Check TLS secrets in the namespace

```bash
kubectl get secret -n <ns> -o json | jq '.items[] | select(.type == "kubernetes.io/tls") | {name: .metadata.name, created: .metadata.creationTimestamp}'
```

For a specific TLS secret, check the certificate details:

```bash
kubectl get secret <secret-name> -n <ns> -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -text -noout | grep -E "Subject:|Issuer:|Not Before|Not After|DNS:"
```

Key fields:
- **Not After** — expiration date
- **Subject/DNS** — what domains the cert covers (SANs)
- **Issuer** — who issued the cert (Let's Encrypt, self-signed, internal CA)

### 3. Check if cert-manager is installed

```bash
kubectl get pods -n cert-manager
```

```bash
kubectl get crd | grep cert-manager
```

If cert-manager is installed, check Certificate resources:

```bash
kubectl get certificate -n <ns>
```

```bash
kubectl get certificate -n <ns> -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,EXPIRY:.status.notAfter,RENEWAL:.status.renewalTime'
```

### 4. Diagnose cert-manager Certificate

For a specific Certificate resource:

```bash
kubectl describe certificate <name> -n <ns>
```

Focus on:
- **Conditions** — `Ready: True/False` and the reason
- **Events** — issuance errors, renewal attempts
- **Not After** — current certificate expiration
- **Renewal Time** — when cert-manager will attempt renewal

Check the associated CertificateRequest:

```bash
kubectl get certificaterequest -n <ns> | grep <cert-name>
kubectl describe certificaterequest <cr-name> -n <ns>
```

### 5. Check the Issuer/ClusterIssuer

```bash
kubectl get issuer -n <ns>
kubectl get clusterissuer
```

```bash
kubectl describe issuer <name> -n <ns>
```

or:

```bash
kubectl describe clusterissuer <name>
```

Focus on:
- **Conditions** — `Ready: True/False`
- **Account** status (for ACME/Let's Encrypt issuers)
- **CA secret** reference (for CA issuers)

### 6. Check cert-manager controller logs

```bash
kubectl logs -n cert-manager -l app.kubernetes.io/component=controller --tail=200
```

Look for:
- `failed to ensure Certificate` — issuance failure
- `ACME challenge failed` — Let's Encrypt validation issue
- `secret not found` — CA secret or TLS secret missing
- `certificate has expired` — renewal too late

### 7. Match pattern and conclude

---

#### Certificate expired

The certificate's `Not After` date has passed. TLS connections using this cert will fail.

```bash
kubectl get secret <secret> -n <ns> -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -dates
```

If cert-manager manages this cert, check why renewal didn't happen (step 4).

If manually managed, advise the user to renew and update the secret.

---

#### cert-manager Certificate not Ready — issuance failed

The Certificate resource shows `Ready: False`. Check the CertificateRequest and events for the specific failure:

Common causes:
- **Issuer not ready** — the Issuer itself is misconfigured
- **ACME challenge failed** — DNS or HTTP challenge couldn't be completed (DNS propagation, firewall, ingress misconfiguration)
- **Rate limit** — Let's Encrypt rate limits exceeded
- **Invalid domain** — the requested domain doesn't match the issuer's allowed domains

---

#### ACME HTTP-01 challenge fails

For Let's Encrypt HTTP-01 challenges:

```bash
kubectl get challenge -n <ns>
kubectl describe challenge <name> -n <ns>
```

The challenge solver creates a temporary pod and ingress. If the ingress controller cannot route the challenge URL, validation fails.

Check:
- Is the ingress controller running?
- Can external traffic reach the challenge path (`/.well-known/acme-challenge/...`)?
- Is there a NetworkPolicy or firewall blocking the challenge?

---

#### ACME DNS-01 challenge fails

For DNS-01 challenges, cert-manager creates DNS TXT records.

```bash
kubectl get challenge -n <ns>
kubectl describe challenge <name> -n <ns>
```

Check:
- Does cert-manager have credentials to modify DNS records?
- Is the DNS provider API reachable?
- Check the DNS propagation: `dig TXT _acme-challenge.<domain>`

---

#### TLS secret exists but doesn't match the domain

The certificate's SANs (Subject Alternative Names) don't include the domain being accessed.

```bash
kubectl get secret <secret> -n <ns> -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -text | grep -A 1 "Subject Alternative Name"
```

Compare the SANs against the requested hostname.

---

#### Webhook caBundle mismatch

The webhook configuration's `caBundle` doesn't match the CA that signed the webhook's TLS certificate.

```bash
kubectl get validatingwebhookconfigurations <name> -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | base64 -d | openssl x509 -noout -subject -issuer
```

Compare with the actual certificate served by the webhook service. If cert-manager manages the injection, check the annotation:

```bash
kubectl get validatingwebhookconfigurations <name> -o jsonpath='{.metadata.annotations}'
```

Look for `cert-manager.io/inject-ca-from` annotation. If present, cert-manager should auto-update the caBundle.

---

#### Self-signed certificate not trusted

The service uses a self-signed or internal CA certificate. Clients need the CA certificate in their trust store.

For pods connecting to the service, the CA cert must be mounted and the application configured to trust it.

## Notes

- `openssl s_client -connect <host>:<port> -servername <hostname>` tests TLS from outside the cluster (requires `openssl` on the test host, not inside the cluster).
- cert-manager renews certificates 30 days before expiry by default. If `renewBefore` is set in the Certificate spec, it uses that duration.
- For kubeadm cluster certificates: control plane certs are separate from workload certs. Use `kubeadm certs check-expiration` on the control plane node.
- `kubectl get secret -A --field-selector type=kubernetes.io/tls` lists all TLS secrets cluster-wide.
- If a TLS secret was deleted and recreated, pods or ingress controllers using it may need to be restarted to pick up the new cert.
