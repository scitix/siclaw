import type http from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { validPrivateId } from "../shared/private-workspace.js";
import { ErrorCodes, isErrorDetail } from "../lib/error-envelope.js";

/** All routing/owner fields are replaced with the authenticated certificate. */
export async function handlePrivateWorkspace(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  client: FrontendWsClient,
): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (!identity.privateSpaceId || !identity.privateUserId || !identity.privateSessionId) { send(403, { error: "A private execution identity is required" }); return; }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 6 * 1024 * 1024) { send(413, { error: "Workspace request is too large" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { send(400, { error: "Invalid workspace request" }); return; }
    if (!body || !validPrivateId(body.sessionId) || body.sessionId !== identity.privateSessionId || typeof body.incarnation !== "string" ||
      !["acquire", "renew", "release", "put", "get", "commit", "learn", "memory_search"].includes(String(body.action))) {
      send(400, { error: "Invalid workspace request" }); return;
    }
    const result = await client.request("workspace.exchange", {
      ...body,
      agentId: identity.agentId,
      spaceId: identity.privateSpaceId,
      boxId: identity.boxId,
    }, body.action === "renew" ? 10_000 : 90_000);
    send(200, result);
  } catch (error) {
    // Don't expose upstream DB/provider errors, credentials or foreign IDs.
    // Legacy negative RPC replies are non-retriable; connection failures have
    // no envelope. Only a classified temporary failure may preserve the lease.
    const detail = isErrorDetail(error) ? error : undefined;
    const status = detail?.code === ErrorCodes.FORBIDDEN ? 403
      : detail?.code === ErrorCodes.UNAUTHORIZED ? 401
      : detail?.code === ErrorCodes.BAD_REQUEST ? 400
      : detail?.code === ErrorCodes.CONFLICT ? 409
      : detail && !detail.retriable ? 409 : 503;
    const code = status === 403 ? ErrorCodes.FORBIDDEN : status === 401 ? ErrorCodes.UNAUTHORIZED
      : status === 400 ? ErrorCodes.BAD_REQUEST : status === 409 ? ErrorCodes.CONFLICT : ErrorCodes.SERVICE_UNAVAILABLE;
    send(status, { error: { code, retriable: status === 503, status,
      message: "Private workspace is unavailable or its execution changed" } });
  }
}
