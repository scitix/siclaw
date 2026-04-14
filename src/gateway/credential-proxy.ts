/**
 * HTTP handlers for AgentBox credential APIs (mTLS server, port 3002).
 *
 * Both handlers delegate to CredentialService, which — depending on config —
 * either queries the local clusters/agent_clusters DB or forwards to an
 * external credential provider. Identity is extracted from the mTLS client
 * certificate and cannot be spoofed.
 *
 *   POST /api/internal/credential-request  → one cluster's kubeconfig
 *   POST /api/internal/credential-list     → metadata for all bound clusters
 */

import http from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { CredentialService, Identity } from "./credential-service.js";
import { CredentialNotFoundError } from "./credential-service.js";

interface CredentialRequestBody {
  source?: string;
  source_id?: string;
  purpose?: string;
}

// Keep identity fields to a safe charset before they land in SQL params or
// outbound HTTP headers. Node will reject CRLF in headers anyway, but we
// narrow further to prevent surprises (e.g. a non-UUID agentId slipping
// through and causing an unbounded DB scan).
const IDENTITY_CHARS = /^[A-Za-z0-9._\-@]{1,128}$/;

function assertSafeIdField(value: string, field: string): void {
  if (!IDENTITY_CHARS.test(value)) {
    throw new Error(`Invalid ${field} in client certificate`);
  }
}

function toIdentity(cert: CertificateIdentity): Identity {
  assertSafeIdField(cert.userId, "userId");
  assertSafeIdField(cert.agentId, "agentId");
  if (cert.orgId) assertSafeIdField(cert.orgId, "orgId");
  if (cert.boxId) assertSafeIdField(cert.boxId, "boxId");
  return {
    userId: cert.userId,
    agentId: cert.agentId,
    orgId: cert.orgId,
    boxId: cert.boxId,
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  return body;
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export async function handleCredentialRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  service: CredentialService,
): Promise<void> {
  const raw = await readBody(req);
  let body: CredentialRequestBody;
  try {
    body = raw ? (JSON.parse(raw) as CredentialRequestBody) : {};
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  if (body.source !== "cluster") {
    sendError(res, 400, `Unsupported source: ${body.source ?? "(missing)"}`);
    return;
  }
  if (!body.source_id) {
    sendError(res, 400, "source_id is required");
    return;
  }

  try {
    const payload = await service.getClusterCredential(
      toIdentity(identity),
      body.source_id,
      body.purpose ?? "",
    );
    sendJson(res, 200, payload);
  } catch (err) {
    if (err instanceof CredentialNotFoundError) {
      sendError(res, 404, err.message);
      return;
    }
    console.error("[credential-proxy] getClusterCredential failed:", err);
    sendError(res, 502, err instanceof Error ? err.message : "Unknown error");
  }
}

export async function handleCredentialList(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  service: CredentialService,
): Promise<void> {
  try {
    const clusters = await service.listClusters(toIdentity(identity));
    sendJson(res, 200, { clusters });
  } catch (err) {
    console.error("[credential-proxy] listClusters failed:", err);
    sendError(res, 502, err instanceof Error ? err.message : "Unknown error");
  }
}
