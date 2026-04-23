# mTLS API Reference

Quick reference for developers working with mTLS-authenticated internal APIs.

## Table of Contents

- [Overview](#overview)
- [Client Usage](#client-usage)
- [API Endpoints](#api-endpoints)
- [Error Handling](#error-handling)
- [Testing](#testing)

## Overview

Internal APIs (`/api/internal/*`) require mTLS authentication:

- **Client**: AgentBox (with client certificate)
- **Server**: Gateway (validates certificate)
- **Authentication**: Mutual TLS with client certificates
- **Authorization**: Certificate identity checked against requested resources

## Client Usage

### GatewayClient

The `GatewayClient` class handles mTLS authentication automatically.

**Import:**

```typescript
import { GatewayClient } from "../agentbox/gateway-client.js";
```

**Initialize:**

```typescript
const gatewayClient = new GatewayClient({
  gatewayUrl: process.env.SICLAW_GATEWAY_URL, // e.g., "https://siclaw-runtime.siclaw.svc.cluster.local"
  certPath: "/etc/siclaw/certs", // Optional, defaults to SICLAW_CERT_PATH or "/etc/siclaw/certs"
});
```

**Certificate Auto-detection:**

GatewayClient automatically:
1. Checks if certificates exist at `certPath`
2. Loads `tls.crt`, `tls.key`, `ca.crt`
3. Uses HTTPS with client certificate
4. Falls back to plain HTTP if certificates not found (with warning)

### API Methods

#### `fetchSettings()`

Fetch Gateway configuration (providers, models, embedding).

```typescript
const settings = await gatewayClient.fetchSettings();

// Returns:
// {
//   providers: [...],
//   models: [...],
//   embedding: { ... }
// }
```

**Authentication**: Required
**Authorization**: None (any valid AgentBox)

**Use case**: AgentBox startup configuration sync

#### `listCronJobs(userId)`

List cron jobs for a specific user.

```typescript
const jobs = await gatewayClient.listCronJobs("user@example.com");

// Returns:
// [
//   {
//     id: "cron-123",
//     name: "Daily health check",
//     schedule: "0 9 * * *",
//     status: "active",
//     description: "Check service health",
//     lastRunAt: "2026-03-03T09:00:00Z",
//     lastResult: "success"
//   }
// ]
```

**Authentication**: Required
**Authorization**: Certificate `userId` must match requested `userId`

**Use case**: `manage_schedule` tool with action `"list"`

## API Endpoints

### `GET /api/internal/settings`

Fetch Gateway settings configuration.

**Request:**

```http
GET /api/internal/settings HTTP/1.1
Host: siclaw-runtime.siclaw.svc.cluster.local
```

**Response (200 OK):**

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "status": "enabled",
      "apiKey": "sk-ant-..."
    }
  ],
  "models": [
    {
      "id": "claude-sonnet-4.5",
      "name": "Claude Sonnet 4.5",
      "providerId": "anthropic",
      "maxTokens": 200000
    }
  ],
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small"
  }
}
```

**Errors:**

- `401`: Client certificate required
- `403`: Invalid certificate
- `500`: Internal server error

### `GET /api/internal/cron-list?userId={userId}`

List cron jobs for a user.

**Request:**

```http
GET /api/internal/cron-list?userId=user@example.com HTTP/1.1
Host: siclaw-runtime.siclaw.svc.cluster.local
```

**Query Parameters:**

- `userId` (required): User ID to query jobs for

**Response (200 OK):**

```json
{
  "jobs": [
    {
      "id": "cron-abc123",
      "name": "Daily report",
      "schedule": "0 9 * * *",
      "status": "active",
      "description": "Generate daily status report",
      "lastRunAt": "2026-03-03T09:00:00Z",
      "lastResult": "success"
    },
    {
      "id": "cron-def456",
      "name": "Weekly cleanup",
      "schedule": "0 2 * * 0",
      "status": "paused",
      "description": "Clean up old logs",
      "lastRunAt": null,
      "lastResult": null
    }
  ]
}
```

**Errors:**

- `400`: Missing userId parameter
- `401`: Client certificate required
- `403`: Invalid certificate or userId mismatch
- `500`: Internal server error

**Authorization Check:**

```typescript
// Server-side validation
if (certIdentity.userId !== requestedUserId) {
  return 403; // Forbidden
}
```

## Error Handling

### Certificate Errors

**No certificate provided (401):**

```json
{
  "error": "Client certificate required",
  "message": "This endpoint requires mTLS authentication"
}
```

**Invalid certificate (403):**

```json
{
  "error": "Invalid certificate",
  "message": "Certificate verification failed"
}
```

### Authorization Errors

**userId mismatch (403):**

```json
{
  "error": "Forbidden: userId mismatch"
}
```

### Client-Side Error Handling

```typescript
try {
  const jobs = await gatewayClient.listCronJobs(userId);
} catch (err) {
  if (err.message.includes("401")) {
    console.error("Certificate not configured");
  } else if (err.message.includes("403")) {
    console.error("Authorization failed - check userId");
  } else if (err.message.includes("timeout")) {
    console.error("Gateway unavailable");
  } else {
    console.error("Unexpected error:", err);
  }
}
```

## Testing

### Unit Testing (Mock GatewayClient)

```typescript
import { GatewayClient } from "../agentbox/gateway-client.js";

// Mock for testing
const mockClient = {
  fetchSettings: jest.fn().mockResolvedValue({ providers: [], models: [] }),
  listCronJobs: jest.fn().mockResolvedValue([]),
};

// Use in tests
const settings = await mockClient.fetchSettings();
expect(settings.providers).toEqual([]);
```

### Integration Testing (Real Certificates)

```typescript
import { GatewayClient } from "../agentbox/gateway-client.js";

describe("GatewayClient Integration", () => {
  it("should fetch settings with valid certificate", async () => {
    const client = new GatewayClient({
      gatewayUrl: "https://localhost:3001",
      certPath: "./test/fixtures/certs",
    });

    const settings = await client.fetchSettings();
    expect(settings).toHaveProperty("providers");
  });

  it("should list cron jobs with authorization", async () => {
    const client = new GatewayClient({
      gatewayUrl: "https://localhost:3001",
      certPath: "./test/fixtures/certs",
    });

    // Certificate issued for userId="test@example.com"
    const jobs = await client.listCronJobs("test@example.com");
    expect(Array.isArray(jobs)).toBe(true);
  });

  it("should reject userId mismatch", async () => {
    const client = new GatewayClient({
      gatewayUrl: "https://localhost:3001",
      certPath: "./test/fixtures/certs",
    });

    // Certificate for userId="test@example.com", requesting different user
    await expect(
      client.listCronJobs("other@example.com")
    ).rejects.toThrow("403");
  });
});
```

### Testing with curl

```bash
# Fetch settings
curl https://siclaw-runtime.siclaw.svc.cluster.local/api/internal/settings \
  --cert /etc/siclaw/certs/tls.crt \
  --key /etc/siclaw/certs/tls.key \
  --cacert /etc/siclaw/certs/ca.crt

# List cron jobs
curl "https://siclaw-runtime.siclaw.svc.cluster.local/api/internal/cron-list?userId=user@example.com" \
  --cert /etc/siclaw/certs/tls.crt \
  --key /etc/siclaw/certs/tls.key \
  --cacert /etc/siclaw/certs/ca.crt
```

## Certificate Identity Structure

### Certificate Subject Fields

Certificates encode identity in X.509 subject fields:

- **CN (Common Name)**: `userId`
- **OU (Organizational Unit)**: `workspaceId`
- **serialNumber**: `boxId`

### Extracting Identity Server-Side

```typescript
import type { IncomingMessage } from "http";

// In mTLS middleware
const identity = req.certIdentity; // Set by createMtlsMiddleware()

// Type: CertificateIdentity
// {
//   userId: string;
//   workspaceId: string;
//   boxId: string;
//   issuedAt: Date;
//   expiresAt: Date;
// }
```

### Authorization Helpers

```typescript
import { authorizeUserId, authorizeWorkspace } from "../security/mtls-middleware.js";

// Check if certificate userId matches requested userId
if (!authorizeUserId(req.certIdentity, requestedUserId)) {
  res.writeHead(403);
  res.end(JSON.stringify({ error: "Forbidden" }));
  return;
}

// Check if certificate workspaceId matches requested workspace
if (!authorizeWorkspace(req.certIdentity, requestedWorkspaceId)) {
  res.writeHead(403);
  res.end(JSON.stringify({ error: "Forbidden" }));
  return;
}
```

## Adding New Internal APIs

### Server-Side (Gateway)

1. Add endpoint handler in `src/gateway/server.ts`:

```typescript
// After existing /api/internal/* endpoints
if (url.startsWith("/api/internal/my-endpoint") && method === "GET") {
  if (!db) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Database not available" }));
    return;
  }

  (async () => {
    try {
      // Get certificate identity (set by mTLS middleware)
      const identity = (req as any).certIdentity;
      if (!identity) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Client certificate required" }));
        return;
      }

      // Parse request parameters
      const urlObj = new URL(url, `http://${req.headers.host}`);
      const param = urlObj.searchParams.get("param");

      // Add authorization check if needed
      if (identity.userId !== param) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      // Business logic
      const data = await someRepository.queryData(param);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data }));
    } catch (err) {
      console.error("[gateway] my-endpoint error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  })();
  return;
}
```

2. Protected by default: All `/api/internal/*` paths require mTLS (configured in `createMtlsMiddleware`)

### Client-Side (AgentBox)

1. Add method to `GatewayClient` (`src/agentbox/gateway-client.ts`):

```typescript
async myEndpoint(param: string): Promise<any> {
  return this.request(`/api/internal/my-endpoint?param=${encodeURIComponent(param)}`, "GET");
}
```

2. Use in tools or AgentBox code:

```typescript
const gatewayClient = new GatewayClient({
  gatewayUrl: config.server.gatewayUrl,
});

const data = await gatewayClient.myEndpoint("value");
```

## Best Practices

1. **Always verify certificate identity**
   - Check `req.certIdentity` exists
   - Compare certificate fields against requested resources

2. **Use GatewayClient, not fetch()**
   - GatewayClient handles certificate loading
   - Automatic HTTPS vs HTTP detection
   - Consistent error handling

3. **Log authentication events**
   - Log successful authentications with identity
   - Log authorization failures with reason
   - Monitor for unusual patterns

4. **Design for authorization**
   - Internal APIs should validate access rights
   - Don't rely only on authentication
   - Certificate identity provides basis for authorization

5. **Test both success and failure cases**
   - Valid certificate + valid userId
   - Valid certificate + wrong userId (403)
   - Invalid certificate (403)
   - No certificate (401)

## Troubleshooting

### "Failed to parse JSON response"

**Cause**: Gateway returned HTML error page instead of JSON

**Check**: Gateway logs for actual error
**Fix**: Ensure Gateway properly catches exceptions and returns JSON errors

### "Gateway request timeout"

**Cause**: Default 5-second timeout exceeded

**Check**:
- Gateway running and healthy
- Network connectivity from AgentBox to Gateway
- Gateway not under heavy load

**Adjust timeout if needed:**

```typescript
// In gateway-client.ts, increase timeout
req.setTimeout(10000, () => { // 10 seconds
  req.destroy();
  reject(new Error("Gateway request timeout"));
});
```

### "ECONNREFUSED"

**Cause**: Gateway not reachable at configured URL

**Check**:
- Gateway Service exists in Kubernetes
- DNS resolution works: `nslookup siclaw-runtime.siclaw.svc.cluster.local`
- Network policies allow traffic

### Certificate verification errors in logs

**Example**: `[cert-manager] Certificate verification failed: not signed by CA`

**Cause**: Certificate not signed by Gateway's CA

**Check**:
- CA certificate matches between Gateway and AgentBox
- Gateway CA not rotated since certificate issued
- Certificate Secret correctly mounted in Pod

## Performance Tips

1. **Reuse GatewayClient instances**
   - Create once per AgentBox process
   - HTTP agent connection pooling

2. **Batch requests when possible**
   - Reduce number of API calls
   - Consider adding batch endpoints if needed

3. **Cache responses appropriately**
   - Settings: Cache for AgentBox lifetime (refreshed on restart)
   - Cron jobs: Don't cache (dynamic data)

4. **Monitor latency**
   - mTLS handshake: one-time cost per connection
   - Request processing: depends on business logic
   - Alert on p99 > 500ms

## See Also

- [mTLS Setup Guide](../deployment/mtls-setup.md)
- [mTLS Security Design](../architecture/mtls-security.md)
- [CertificateManager API](../../src/gateway/security/cert-manager.ts)
- [GatewayClient API](../../src/agentbox/gateway-client.ts)
