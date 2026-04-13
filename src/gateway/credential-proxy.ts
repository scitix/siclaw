/**
 * Credential Proxy: forwards AgentBox credential requests to Upstream Adapter.
 *
 * Flow (from integration spec §5.3):
 *   AgentBox ──mTLS──→ Runtime (verify cert, extract identity)
 *     → HTTP POST → Upstream Adapter /api/internal/siclaw/adapter/credential-request
 *
 * Identity comes from the mTLS certificate (cannot be spoofed):
 *   CN = userId, OU = agentId, O = orgId
 *
 * The request body (source, source_id, purpose) comes from AgentBox —
 * it controls WHAT to request but not WHO is requesting.
 */

import http from "node:http";
import https from "node:https";
import type { RuntimeConfig } from "./config.js";
import type { CertificateIdentity } from "./security/cert-manager.js";

/** Proxy a credential request from AgentBox to Upstream Adapter. */
export function handleCredentialRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  config: RuntimeConfig,
): void {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", async () => {
    try {
      const result = await forwardToAdapter(
        `${config.serverUrl}/api/internal/siclaw/adapter/credential-request`,
        body,
        identity,
        config.portalSecret,
      );
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);
    } catch (err) {
      console.error("[credential-proxy] forward error:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to proxy credential request to Upstream" }));
    }
  });
}

interface ForwardResult {
  status: number;
  body: string;
}

async function forwardToAdapter(
  url: string,
  body: string,
  identity: CertificateIdentity,
  secret: string,
): Promise<ForwardResult> {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  const options: http.RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": secret,
      // Verified identity from mTLS certificate — Upstream trusts these headers
      "X-Cert-User-Id": identity.userId,
      "X-Cert-Agent-Id": identity.agentId,
      "X-Cert-Org-Id": identity.orgId || "",
      "X-Cert-Box-Id": identity.boxId,
    },
    timeout: 10_000,
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (resp) => {
      let data = "";
      resp.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      resp.on("end", () => {
        resolve({ status: resp.statusCode ?? 502, body: data });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}
