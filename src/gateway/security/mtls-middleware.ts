/**
 * mTLS Authentication Middleware
 *
 * Validates client certificates and extracts identity information.
 * Used to secure internal APIs that should only be accessible by AgentBox instances.
 */

import type http from "node:http";
import type { CertificateManager, CertificateIdentity } from "./cert-manager.js";

// Extend IncomingMessage with certIdentity
declare module "http" {
  interface IncomingMessage {
    certIdentity?: CertificateIdentity;
  }
}

export interface MtlsMiddlewareOptions {
  certManager: CertificateManager;
  /**
   * Paths that require client certificate authentication
   * Default: ["/api/internal/"]
   */
  protectedPaths?: string[];
}

/**
 * Create mTLS authentication middleware
 */
export function createMtlsMiddleware(options: MtlsMiddlewareOptions) {
  const { certManager, protectedPaths = ["/api/internal/"] } = options;

  return function mtlsMiddleware(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: () => void
  ): void {
    const url = req.url || "/";

    // Check if this path requires authentication
    const isProtected = protectedPaths.some(path => url.startsWith(path));
    if (!isProtected) {
      // Not a protected path, skip authentication
      return next();
    }

    try {
      // Extract client certificate from TLS socket
      const socket = req.socket as any;
      const peerCert = socket.getPeerCertificate?.(false);

      if (!peerCert || !peerCert.raw) {
        console.warn(`[mtls] No client certificate provided for ${req.method} ${url}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Client certificate required",
          message: "This endpoint requires mTLS authentication"
        }));
        return;
      }

      // Convert certificate to PEM format
      const certDER = peerCert.raw;
      const certPEM = `-----BEGIN CERTIFICATE-----\n${certDER.toString("base64").match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----`;

      // Verify certificate and extract identity
      const identity = certManager.verifyCertificate(certPEM);

      if (!identity) {
        console.warn(`[mtls] Invalid certificate for ${req.method} ${url}`);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Invalid certificate",
          message: "Certificate verification failed"
        }));
        return;
      }

      // Attach identity to request
      req.certIdentity = identity;

      console.log(`[mtls] Authenticated ${req.method} ${url} - userId=${identity.userId} workspaceId=${identity.workspaceId} boxId=${identity.boxId}`);

      // Continue to next handler
      next();
    } catch (err) {
      console.error(`[mtls] Authentication error for ${req.method} ${url}:`, err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Authentication error",
        message: "Internal server error during certificate verification"
      }));
    }
  };
}

/**
 * Authorization helper: Check if certificate identity matches requested userId
 */
export function authorizeUserId(
  identity: CertificateIdentity | undefined,
  requestedUserId: string
): boolean {
  if (!identity) {
    return false;
  }

  if (identity.userId !== requestedUserId) {
    console.warn(`[mtls-authz] userId mismatch: cert=${identity.userId} requested=${requestedUserId}`);
    return false;
  }

  return true;
}

/**
 * Authorization helper: Check if certificate identity matches requested workspace
 */
export function authorizeWorkspace(
  identity: CertificateIdentity | undefined,
  requestedWorkspaceId: string
): boolean {
  if (!identity) {
    return false;
  }

  if (identity.workspaceId !== requestedWorkspaceId) {
    console.warn(`[mtls-authz] workspaceId mismatch: cert=${identity.workspaceId} requested=${requestedWorkspaceId}`);
    return false;
  }

  return true;
}
