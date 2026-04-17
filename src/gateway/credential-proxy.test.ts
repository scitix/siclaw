import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import { handleCredentialRequest, handleCredentialList } from "./credential-proxy.js";
import { CredentialService, CredentialNotFoundError } from "./credential-service.js";
import type { CertificateIdentity } from "./security/cert-manager.js";

// ── Fakes ──────────────────────────────────────────────────

class FakeReq extends EventEmitter {
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return (async function* (self: FakeReq): AsyncGenerator<Buffer> {
      for (const chunk of self._chunks) yield chunk;
    })(this);
  }
  _chunks: Buffer[] = [];
  constructor(body: string) {
    super();
    if (body) this._chunks.push(Buffer.from(body));
  }
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  end(data?: string): void { if (data) this.body = data; }
}

function asHttpReq(r: FakeReq): http.IncomingMessage {
  return r as unknown as http.IncomingMessage;
}
function asHttpRes(r: FakeRes): http.ServerResponse {
  return r as unknown as http.ServerResponse;
}

const goodIdentity: CertificateIdentity = {
  userId: "u1",
  agentId: "a1",
  orgId: "o1",
  boxId: "b1",
  env: "dev",
  issuedAt: new Date(),
  expiresAt: new Date(),
};

class FakeService {
  getClusterCredential = vi.fn();
  getHostCredential = vi.fn();
  listClusters = vi.fn();
  listHosts = vi.fn();
}

let service: FakeService;

beforeEach(() => {
  service = new FakeService();
});

// ── handleCredentialRequest ────────────────────────────────

describe("handleCredentialRequest", () => {
  it("200 with cluster payload when body.source=cluster", async () => {
    service.getClusterCredential.mockResolvedValue({ credential: { name: "c1", type: "kubeconfig", files: [] } });
    const req = new FakeReq(JSON.stringify({ source: "cluster", source_id: "c1", purpose: "diag" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).credential.name).toBe("c1");
    expect(service.getClusterCredential).toHaveBeenCalled();
  });

  it("200 with host payload when body.source=host", async () => {
    service.getHostCredential.mockResolvedValue({ credential: { name: "h1", type: "ssh", files: [] } });
    const req = new FakeReq(JSON.stringify({ source: "host", source_id: "h1" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(200);
    expect(service.getHostCredential).toHaveBeenCalled();
  });

  it("400 for unsupported source", async () => {
    const req = new FakeReq(JSON.stringify({ source: "bogus", source_id: "x" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Unsupported source/);
  });

  it("400 for missing source_id", async () => {
    const req = new FakeReq(JSON.stringify({ source: "cluster" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/source_id is required/);
  });

  it("400 for malformed JSON body", async () => {
    const req = new FakeReq("not-json-at-all");
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Invalid JSON body");
  });

  it("404 when service throws CredentialNotFoundError", async () => {
    service.getClusterCredential.mockRejectedValue(new CredentialNotFoundError("cluster x missing"));
    const req = new FakeReq(JSON.stringify({ source: "cluster", source_id: "x" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(404);
  });

  it("502 when service throws some other error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    service.getClusterCredential.mockRejectedValue(new Error("upstream is burning"));
    const req = new FakeReq(JSON.stringify({ source: "cluster", source_id: "x" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe("upstream is burning");
    errSpy.mockRestore();
  });

  it("rejects an identity with CRLF in userId (character whitelist)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad: CertificateIdentity = { ...goodIdentity, userId: "u\r\nX" };
    const req = new FakeReq(JSON.stringify({ source: "cluster", source_id: "x" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), bad, service as unknown as CredentialService);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/Invalid userId/);
    errSpy.mockRestore();
  });

  it("rejects an identity with control characters in agentId", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad: CertificateIdentity = { ...goodIdentity, agentId: "a; rm -rf /" };
    const req = new FakeReq(JSON.stringify({ source: "cluster", source_id: "x" }));
    const res = new FakeRes();
    await handleCredentialRequest(asHttpReq(req), asHttpRes(res), bad, service as unknown as CredentialService);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/Invalid agentId/);
    errSpy.mockRestore();
  });
});

// ── handleCredentialList ───────────────────────────────────

describe("handleCredentialList", () => {
  it("200 with clusters array", async () => {
    service.listClusters.mockResolvedValue([{ name: "c", is_production: true }]);
    const req = new FakeReq(JSON.stringify({ kind: "cluster" }));
    const res = new FakeRes();
    await handleCredentialList(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).clusters).toHaveLength(1);
  });

  it("200 with hosts array", async () => {
    service.listHosts.mockResolvedValue([{ name: "h", ip: "1.2.3.4", port: 22, username: "u", auth_type: "key", is_production: true }]);
    const req = new FakeReq(JSON.stringify({ kind: "host" }));
    const res = new FakeRes();
    await handleCredentialList(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).hosts).toHaveLength(1);
  });

  it("400 when kind is unsupported", async () => {
    const req = new FakeReq(JSON.stringify({ kind: "pizza" }));
    const res = new FakeRes();
    await handleCredentialList(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(400);
  });

  it("400 when body is not JSON", async () => {
    const req = new FakeReq("{no");
    const res = new FakeRes();
    await handleCredentialList(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(400);
  });

  it("502 on service error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    service.listClusters.mockRejectedValue(new Error("boom"));
    const req = new FakeReq(JSON.stringify({ kind: "cluster" }));
    const res = new FakeRes();
    await handleCredentialList(asHttpReq(req), asHttpRes(res), goodIdentity, service as unknown as CredentialService);
    expect(res.statusCode).toBe(502);
    errSpy.mockRestore();
  });
});
