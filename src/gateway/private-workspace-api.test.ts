import { Readable } from "node:stream";
import type http from "node:http";
import { expect, it, vi } from "vitest";
import { handlePrivateWorkspace } from "./private-workspace-api.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
const identity: CertificateIdentity = { agentId: "agent", orgId: "org", boxId: "box", privateSpaceId: "space", privateUserId: "alice", privateSessionId: "session", issuedAt: new Date(), expiresAt: new Date(Date.now() + 10000) };
async function call(body: unknown, cert = identity) {
  const request = vi.fn().mockResolvedValue({ ok: true });
  let status = 0, response = "";
  await handlePrivateWorkspace(Readable.from([Buffer.from(JSON.stringify(body))]) as http.IncomingMessage, {
    writeHead(code: number) { status = code; }, end(value: string) { response = value; },
  } as http.ServerResponse, cert, { request } as unknown as FrontendWsClient);
  return { request, status, response };
}
it("replaces caller-selected authority with the certificate", async () => {
  const result = await call({ action: "acquire", sessionId: "session", incarnation: "unique-incarnation", agentId: "other", spaceId: "foreign", boxId: "foreign" });
  expect(result.status).toBe(200);
  expect(result.request.mock.calls[0][1]).toMatchObject({ agentId: "agent", spaceId: "space", boxId: "box" });
});
it("rejects another session, legacy certificates and unknown actions before any RPC", async () => {
  for (const [body, cert] of [
    [{ action: "get", sessionId: "other", incarnation: "incarnation" }, identity],
    [{ action: "get", sessionId: "session", incarnation: "incarnation" }, { ...identity, privateSessionId: undefined }],
    [{ action: "register_skill", sessionId: "session", incarnation: "incarnation" }, identity],
  ] as const) {
    const result = await call(body, cert);
    expect(result.status).toBeGreaterThanOrEqual(400); expect(result.request).not.toHaveBeenCalled();
  }
});
