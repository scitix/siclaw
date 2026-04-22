/**
 * Trusted Proxy authentication for Upstream → Runtime WS connections.
 *
 * Upstream backend connects via:
 *   ws://siclaw-runtime:3001/ws
 *   Headers:
 *     X-Auth-Token: <shared secret>
 *     X-Agent-Id:    <agent id>
 */

import type http from "node:http";

export interface ProxyIdentity {
  agentId: string;
}

/**
 * Validate trusted proxy headers on an incoming HTTP request.
 * Returns the proxy identity if valid, null otherwise.
 */
export function authenticateProxy(
  req: http.IncomingMessage,
  secret: string,
): ProxyIdentity | null {
  if (!secret) {
    console.warn("[trusted-proxy] SICLAW_RUNTIME_SECRET is not configured — rejecting all proxy connections");
    return null;
  }

  const token = req.headers["x-auth-token"] as string | undefined;
  const agentId = req.headers["x-agent-id"] as string | undefined;

  if (!token || token !== secret) {
    return null;
  }

  if (!agentId) {
    return null;
  }

  return { agentId };
}
