import { describe, it, expect } from "vitest";
import type http from "node:http";
import { authenticateProxy } from "./trusted-proxy.js";

/** Build a minimal IncomingMessage-like object with the given headers. */
function makeReq(headers: Record<string, string | undefined>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

const SECRET = "shared-secret-xyz";

describe("authenticateProxy", () => {
  it("returns identity when token matches and agent id is present", () => {
    const req = makeReq({ "x-auth-token": SECRET, "x-agent-id": "agent-42" });
    expect(authenticateProxy(req, SECRET)).toEqual({ agentId: "agent-42" });
  });

  it("returns null when token is missing", () => {
    const req = makeReq({ "x-agent-id": "agent-42" });
    expect(authenticateProxy(req, SECRET)).toBeNull();
  });

  it("returns null when token does not match secret", () => {
    const req = makeReq({ "x-auth-token": "wrong", "x-agent-id": "agent-42" });
    expect(authenticateProxy(req, SECRET)).toBeNull();
  });

  it("returns null when x-agent-id header is missing", () => {
    const req = makeReq({ "x-auth-token": SECRET });
    expect(authenticateProxy(req, SECRET)).toBeNull();
  });

  it("returns null when the configured secret is empty — rejects all proxy connections", () => {
    const req = makeReq({ "x-auth-token": "anything", "x-agent-id": "agent-42" });
    expect(authenticateProxy(req, "")).toBeNull();
  });

  it("returns null when both secret and token are empty (treats missing secret as disabled)", () => {
    const req = makeReq({});
    expect(authenticateProxy(req, "")).toBeNull();
  });

  it("rejects when agent id header is present but empty string", () => {
    const req = makeReq({ "x-auth-token": SECRET, "x-agent-id": "" });
    expect(authenticateProxy(req, SECRET)).toBeNull();
  });
});
