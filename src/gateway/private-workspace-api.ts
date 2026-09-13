import type http from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { validPrivateId } from "../shared/private-workspace.js";

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
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (!body || !validPrivateId(body.sessionId) || body.sessionId !== identity.privateSessionId || typeof body.incarnation !== "string" ||
      !["acquire", "renew", "release", "put", "get", "commit", "learn", "memory_search"].includes(String(body.action))) {
      send(400, { error: "Invalid workspace request" }); return;
    }
    const result = await client.request("workspace.exchange", {
      ...body,
      agentId: identity.agentId,
      spaceId: identity.privateSpaceId,
      boxId: identity.boxId,
    }, 90_000);
    send(200, result);
  } catch {
    // Don't expose upstream DB/provider errors, credentials or foreign IDs.
    send(409, { error: "Private workspace is unavailable or its execution changed" });
  }
}
