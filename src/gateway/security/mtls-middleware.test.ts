import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type http from "node:http";
import forge from "node-forge";
import {
  createMtlsMiddleware,
  authorizeUserId,
  authorizeAgent,
} from "./mtls-middleware.js";
import { CertificateManager, type CertificateIdentity } from "./cert-manager.js";

// mTLS is K8s-mode only per CLAUDE.md invariant §3 — these tests isolate the
// middleware logic without reaching into actual K8s/network.

// ── Response stub ───────────────────────────────────────────────────

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  ended = false;
  writeHead(code: number, headers: Record<string, string>) {
    this.statusCode = code;
    this.headers = headers;
  }
  end(body?: string) {
    if (body) this.body = body;
    this.ended = true;
  }
}

/** Build a minimal IncomingMessage-like object with an optional peer cert. */
function makeReq(opts: {
  url: string;
  method?: string;
  peerCert?: { raw?: Buffer } | null;
}): http.IncomingMessage {
  const socket = {
    getPeerCertificate: () => opts.peerCert ?? undefined,
  };
  return {
    url: opts.url,
    method: opts.method ?? "GET",
    socket,
    headers: {},
  } as unknown as http.IncomingMessage;
}

let manager: CertificateManager;
let validCertDER: Buffer;

beforeAll(async () => {
  manager = await CertificateManager.create();
  const bundle = manager.issueAgentBoxCertificate("u-1", "a-1", "o-1", "b-1", "prod");
  const der = forge.asn1.toDer(
    forge.pki.certificateToAsn1(forge.pki.certificateFromPem(bundle.cert))
  ).getBytes();
  validCertDER = Buffer.from(der, "binary");
}, 60_000);

// ── middleware — unprotected paths ─────────────────────────────────

describe("mTLS middleware — unprotected paths", () => {
  it("skips auth for paths outside protectedPaths and calls next()", () => {
    const mw = createMtlsMiddleware({ certManager: manager });
    const req = makeReq({ url: "/public/health" });
    const res = new FakeRes();
    let nextCalled = false;
    mw(req, res as any, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.ended).toBe(false);
  });

  it("defaults protectedPaths to ['/api/internal/']", () => {
    const mw = createMtlsMiddleware({ certManager: manager });
    const req = makeReq({ url: "/api/public/ping" });
    const res = new FakeRes();
    let nextCalled = false;
    mw(req, res as any, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("applies custom protectedPaths when provided", () => {
    const mw = createMtlsMiddleware({
      certManager: manager,
      protectedPaths: ["/secure/"],
    });
    const req = makeReq({ url: "/api/internal/anything" });
    const res = new FakeRes();
    let nextCalled = false;
    mw(req, res as any, () => { nextCalled = true; });
    // /api/internal is NOT protected under this custom config
    expect(nextCalled).toBe(true);
  });
});

// ── middleware — protected paths ───────────────────────────────────

describe("mTLS middleware — protected paths", () => {
  let mw: ReturnType<typeof createMtlsMiddleware>;

  beforeEach(() => {
    mw = createMtlsMiddleware({ certManager: manager });
  });

  it("returns 401 when no client cert is presented", () => {
    const req = makeReq({ url: "/api/internal/foo", peerCert: null });
    const res = new FakeRes();
    let nextCalled = false;
    mw(req, res as any, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Client certificate required");
  });

  it("returns 401 when peerCert is present but raw bytes are missing", () => {
    const req = makeReq({ url: "/api/internal/foo", peerCert: {} });
    const res = new FakeRes();
    mw(req, res as any, () => {});
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when cert cannot be verified by this CA", async () => {
    // Cert from an independent CA
    const other = await CertificateManager.create();
    const foreign = other.issueAgentBoxCertificate("x", "y", "z", "w");
    const foreignDER = Buffer.from(
      forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(foreign.cert))).getBytes(),
      "binary",
    );
    const req = makeReq({ url: "/api/internal/foo", peerCert: { raw: foreignDER } });
    const res = new FakeRes();
    mw(req, res as any, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Invalid certificate");
  }, 60_000);

  it("attaches certIdentity and calls next() for a valid cert", () => {
    const req = makeReq({ url: "/api/internal/list", peerCert: { raw: validCertDER } });
    const res = new FakeRes();
    let nextCalled = false;
    mw(req, res as any, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.ended).toBe(false);
    expect(req.certIdentity).toBeDefined();
    expect(req.certIdentity!.userId).toBe("u-1");
    expect(req.certIdentity!.agentId).toBe("a-1");
  });

  it("returns 500 when cert extraction throws", () => {
    // Simulate socket that throws when cert is accessed
    const socket = {
      getPeerCertificate: () => { throw new Error("tls boom"); },
    };
    const req = {
      url: "/api/internal/explode",
      method: "GET",
      socket,
      headers: {},
    } as unknown as http.IncomingMessage;
    const res = new FakeRes();
    mw(req, res as any, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("Authentication error");
  });
});

// ── authorizeUserId ────────────────────────────────────────────────

describe("authorizeUserId", () => {
  const identity: CertificateIdentity = {
    userId: "alice",
    agentId: "ag-1",
    orgId: "o",
    boxId: "b",
    env: "prod",
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 10_000),
  };

  it("returns true when identity.userId matches requested", () => {
    expect(authorizeUserId(identity, "alice")).toBe(true);
  });

  it("returns false when userIds mismatch", () => {
    expect(authorizeUserId(identity, "bob")).toBe(false);
  });

  it("returns false when identity is undefined", () => {
    expect(authorizeUserId(undefined, "alice")).toBe(false);
  });
});

// ── authorizeAgent ─────────────────────────────────────────────────

describe("authorizeAgent", () => {
  const identity: CertificateIdentity = {
    userId: "alice",
    agentId: "agent-x",
    orgId: "",
    boxId: "box-1",
    env: "dev",
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 10_000),
  };

  it("returns true when agentId matches", () => {
    expect(authorizeAgent(identity, "agent-x")).toBe(true);
  });

  it("returns false when agentIds mismatch", () => {
    expect(authorizeAgent(identity, "agent-y")).toBe(false);
  });

  it("returns false when identity is undefined", () => {
    expect(authorizeAgent(undefined, "agent-x")).toBe(false);
  });
});
