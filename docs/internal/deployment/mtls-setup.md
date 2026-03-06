# mTLS Setup Guide

This guide explains how to deploy Siclaw with mTLS authentication between Gateway and AgentBox.

## Overview

The mTLS implementation provides mutual authentication between Gateway and AgentBox instances:

- **Gateway** acts as Certificate Authority (CA)
- Each **AgentBox Pod** receives a unique client certificate
- Certificates contain identity: `userId`, `workspaceId`, `boxId`
- Protected endpoints (`/api/internal/*`) require valid certificates

## Architecture

```
┌─────────────────┐                    ┌──────────────────┐
│  Gateway (CA)   │                    │   AgentBox Pod   │
│                 │                    │                  │
│  1. Generate CA │                    │                  │
│  2. Issue cert  │──────────────────▶ │  3. Load cert    │
│     for AgentBox│  K8s Secret        │     from Secret  │
│                 │                    │                  │
│  5. Verify cert │◀──────────────────│  4. Make request │
│     Extract ID  │  mTLS handshake    │     with cert    │
│                 │                    │                  │
└─────────────────┘                    └──────────────────┘
```

## Prerequisites

1. **Kubernetes cluster** (for AgentBox deployment)
2. **Node.js 18+** with TypeScript support
3. **node-forge** dependency (already in package.json)

## Installation Steps

### 1. Install Dependencies

```bash
npm install
```

The `node-forge` package is required for certificate generation and verification.

### 2. Gateway Certificate Initialization

When Gateway starts for the first time, it automatically:

1. Creates `.siclaw/certs/` directory
2. Generates CA certificate and private key:
   - `ca.crt` - CA certificate (public)
   - `ca.key` - CA private key (PROTECTED - mode 0600)

**IMPORTANT**: Keep `ca.key` secure! Anyone with this key can issue valid certificates.

### 3. Configure Gateway for mTLS

The Gateway automatically enables mTLS middleware when the CertificateManager is initialized.

**Key configuration:**
- Protected paths: `/api/internal/*` (configurable in middleware)
- Certificate validity: 30 days (configurable in CertificateManager)

### 4. Deploy Gateway to Kubernetes

Ensure the Gateway deployment has:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: siclaw-gateway
spec:
  template:
    spec:
      containers:
      - name: gateway
        volumeMounts:
        - name: certs
          mountPath: /.siclaw/certs
      volumes:
      - name: certs
        persistentVolumeClaim:
          claimName: siclaw-gateway-certs
```

**Why persistent storage?**
- CA certificate must remain consistent
- Regenerating CA invalidates all issued certificates
- AgentBox instances verify server certificate against this CA

### 5. AgentBox Certificate Provisioning

When spawning an AgentBox Pod, K8sSpawner automatically:

1. Generates client certificate with identity embedded
2. Creates Kubernetes Secret with:
   - `tls.crt` - Client certificate
   - `tls.key` - Client private key
   - `ca.crt` - CA certificate for server verification
3. Mounts Secret to `/etc/siclaw/certs` in Pod

**Example K8s Secret:**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: agentbox-user123-default-cert
type: kubernetes.io/tls
data:
  tls.crt: <base64-encoded-client-cert>
  tls.key: <base64-encoded-client-key>
  ca.crt: <base64-encoded-ca-cert>
```

### 6. AgentBox Configuration

AgentBox automatically loads certificates from `/etc/siclaw/certs` (configurable via `SICLAW_CERT_PATH`).

**Environment variables:**

```bash
SICLAW_GATEWAY_URL=https://siclaw-gateway.siclaw.svc.cluster.local
SICLAW_CERT_PATH=/etc/siclaw/certs
```

**Note**: Gateway URL must use `https://` for mTLS to work.

## Protected Endpoints

### `/api/internal/settings` - GET

Fetch Gateway configuration (providers, models, embedding config).

**Authentication:**
- Requires valid client certificate
- No additional authorization (any valid AgentBox can fetch settings)

**Usage in AgentBox:**

```typescript
const gatewayClient = new GatewayClient({
  gatewayUrl: process.env.SICLAW_GATEWAY_URL,
});

const settings = await gatewayClient.fetchSettings();
```

### `/api/internal/cron-list` - GET

List cron jobs for a user.

**Authentication:**
- Requires valid client certificate

**Authorization:**
- Certificate `userId` must match requested `userId` parameter

**Usage in AgentBox:**

```typescript
const gatewayClient = new GatewayClient({
  gatewayUrl: process.env.SICLAW_GATEWAY_URL,
});

const jobs = await gatewayClient.listCronJobs(userId);
```

**Tool usage (manage_schedule):**

The `manage_schedule` tool with action `"list"` automatically uses GatewayClient with mTLS.

## Certificate Lifecycle

### Certificate Issuance

```typescript
// Gateway code
const certBundle = certManager.issueAgentBoxCertificate(
  userId,        // e.g., "user@example.com"
  workspaceId,   // e.g., "workspace123"
  boxId,         // e.g., "agentbox-user-ws123"
);

// Returns:
// - cert: Client certificate (PEM)
// - key: Client private key (PEM)
// - ca: CA certificate (PEM)
// - identity: { userId, workspaceId, boxId, issuedAt, expiresAt }
```

### Certificate Verification

```typescript
// Gateway middleware code
const identity = certManager.verifyCertificate(clientCertPEM);

// Returns null if:
// - Certificate not signed by CA
// - Certificate expired
// - Missing required identity fields

// Otherwise returns:
// { userId, workspaceId, boxId, issuedAt, expiresAt }
```

### Certificate Expiration

**Default validity**: 30 days

**Renewal strategy:**
- AgentBox Pods are ephemeral (short-lived)
- New certificate issued each time Pod is created
- No manual renewal needed

**For long-running AgentBoxes:**
- Monitor certificate expiration
- Implement auto-renewal before expiration
- Or restart AgentBox to get new certificate

## Troubleshooting

### "Client certificate required" (401)

**Cause**: AgentBox not sending certificate

**Check:**
1. Certificate files exist at `/etc/siclaw/certs/`
2. Files are readable by AgentBox process
3. Gateway URL uses `https://` scheme

**Debug:**
```bash
# Inside AgentBox Pod
ls -la /etc/siclaw/certs/
cat /etc/siclaw/certs/tls.crt | openssl x509 -text -noout
```

### "Invalid certificate" (403)

**Cause**: Certificate verification failed

**Check:**
1. Certificate signed by correct CA
2. Certificate not expired
3. CA certificate matches Gateway's CA

**Debug:**
```bash
# Verify certificate
openssl verify -CAfile ca.crt tls.crt

# Check expiration
openssl x509 -in tls.crt -noout -dates
```

### "Forbidden: userId mismatch" (403)

**Cause**: Certificate userId doesn't match requested userId

**This is expected behavior** - certificates are scoped to specific users for security.

**Check:**
1. AgentBox is requesting correct user's data
2. Certificate issued for correct userId

### Gateway CA regenerated

**Symptom**: All AgentBox instances fail with "Invalid certificate"

**Cause**: Gateway CA certificate changed (e.g., `.siclaw/certs/` deleted)

**Solution**:
1. Delete all AgentBox Pods (will get new certificates on restart)
2. Delete all certificate Secrets: `kubectl delete secret -l siclaw.io/app=agentbox`
3. New Pods will receive certificates from new CA

## Security Best Practices

1. **Protect CA private key (`ca.key`)**
   - Use restrictive file permissions (0600)
   - Store in persistent, encrypted volume
   - Never commit to version control

2. **Use short certificate validity**
   - Default 30 days reduces exposure if compromised
   - AgentBox Pods are ephemeral, no renewal burden

3. **Monitor certificate usage**
   - Log all mTLS authentication attempts
   - Alert on unusual access patterns
   - Review certificate identity in logs

4. **Rotate CA periodically**
   - Plan for CA rotation (requires coordinated deployment)
   - Keep old CA for transition period
   - Test rotation procedure in staging

5. **Network isolation**
   - Keep internal APIs (`/api/internal/*`) on internal network
   - Use Kubernetes NetworkPolicies
   - Don't expose internal endpoints to public internet

## Testing mTLS

### Manual Certificate Test

Generate test certificate and make request:

```bash
# 1. Extract CA from Gateway
kubectl exec -it siclaw-gateway-xxx -- cat /.siclaw/certs/ca.crt > ca.crt

# 2. Generate test client certificate (using Gateway's issueAgentBoxCertificate)
# (This requires running code in Gateway context - see test scripts)

# 3. Make request with certificate
curl https://siclaw-gateway.siclaw.svc.cluster.local/api/internal/settings \
  --cert tls.crt \
  --key tls.key \
  --cacert ca.crt
```

### Automated Integration Test

See `test/integration/mtls.test.ts` for automated test suite.

## Migration from Plain HTTP

If migrating from non-mTLS deployment:

1. **Deploy new Gateway with mTLS support**
   - Gateway supports both plain HTTP and HTTPS simultaneously
   - Old AgentBoxes continue working with HTTP

2. **Update AgentBox image**
   - Include GatewayClient with mTLS support
   - Set `SICLAW_GATEWAY_URL=https://...`

3. **Gradually roll out new AgentBoxes**
   - New Pods get certificates automatically
   - Monitor for certificate errors

4. **Disable plain HTTP (optional)**
   - Once all AgentBoxes migrated
   - Update middleware to require mTLS for all paths

## Performance Considerations

### mTLS Overhead

- **TLS handshake**: ~50-100ms per connection
- **Certificate verification**: ~1-5ms per request
- **Connection reuse**: Amortizes handshake cost

### Optimization Tips

1. **Keep connections alive**
   - GatewayClient reuses HTTP agent
   - Enable keep-alive in Node.js

2. **Cache CA certificate**
   - CA cert loaded once per GatewayClient instance
   - Avoid reading from disk on every request

3. **Short certificate chains**
   - Single-level CA (no intermediate CAs)
   - Faster verification

## Kubernetes Deployment Example

Complete example with mTLS:

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: siclaw-gateway-certs
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: siclaw-gateway
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: gateway
        image: siclaw-gateway:latest
        volumeMounts:
        - name: certs
          mountPath: /.siclaw/certs
      volumes:
      - name: certs
        persistentVolumeClaim:
          claimName: siclaw-gateway-certs

---
apiVersion: v1
kind: Service
metadata:
  name: siclaw-gateway
spec:
  selector:
    app: siclaw-gateway
  ports:
  - port: 443
    targetPort: 3001
  type: ClusterIP
```

AgentBox Pods are created by K8sSpawner with certificates automatically.

## Further Reading

- [mTLS Security Design](../architecture/mtls-security.md)
- [AgentBox-Gateway Communication](../architecture/agentbox-gateway-communication.md)
- [API Direction Analysis](../architecture/api-direction-analysis.md)
