import { Readable } from "node:stream";
import type http from "node:http";
import { expect, it, vi } from "vitest";
import { handlePrivateWorkspace } from "./private-workspace-api.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { RpcResponseError } from "../lib/error-envelope.js";
const identity: CertificateIdentity = { agentId: "agent", orgId: "org", boxId: "box", privateSpaceId: "space", privateUserId: "alice", privateSessionId: "session", issuedAt: new Date(), expiresAt: new Date(Date.now() + 10000) };
async function call(body: unknown, cert = identity, request = vi.fn().mockResolvedValue({ ok: true })) {
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

it.each([
  ["CONFLICT", false, 409], ["FORBIDDEN", false, 403], ["UNAUTHORIZED", false, 401],
  ["BAD_REQUEST", false, 400], ["SERVICE_UNAVAILABLE", true, 503], ["INTERNAL_ERROR", false, 409],
] as const)("preserves %s classification and scrubs upstream details", async (code, retriable, expected) => {
  const request = vi.fn().mockRejectedValue(new RpcResponseError({ code, retriable,
    message: "private database connection details", details: { hidden: "provider configuration" } }));
  const result = await call({ action: "renew", sessionId: "session", incarnation: "incarnation" }, identity, request);
  expect(result.status).toBe(expected);
  expect(JSON.parse(result.response).error).toMatchObject({ retriable, status: expected });
  expect(result.response).not.toMatch(/database|provider|hidden/);
  expect(request.mock.calls[0][2]).toBe(10_000);
});

it("reports a disconnected or timed-out RPC as a temporary outage", async () => {
  const request = vi.fn().mockRejectedValue(new Error("WebSocket disconnected"));
  const result = await call({ action: "renew", sessionId: "session", incarnation: "incarnation" }, identity, request);
  expect(result.status).toBe(503);
  expect(JSON.parse(result.response).error).toMatchObject({ code: "SERVICE_UNAVAILABLE", retriable: true });
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

it.each([
  { action: "memory_search", search: { queries: ["harbor"], max_results: 2 } },
  { action: "memory_read", read: { path: `memory/${"a".repeat(64)}.md`, line_offset: 2, max_lines: 3 } },
])("forwards the structured $action contract with certificate authority", async input => {
  const result = await call({ ...input, sessionId: "session", incarnation: "incarnation", agentId: "forged" });
  expect(result.status).toBe(200);
  expect(result.request.mock.calls[0][1]).toMatchObject({ ...input, agentId: "agent", spaceId: "space", boxId: "box" });
});
