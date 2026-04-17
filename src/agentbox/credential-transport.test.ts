import { describe, it, expect, vi } from "vitest";
import { HttpTransport } from "./credential-transport.js";
import type { ClusterMeta, HostMeta, CredentialPayload } from "./credential-transport.js";

/**
 * Tests for HttpTransport — the thin adapter that wraps GatewayClient (or any
 * object exposing a `request()` method) and calls the gateway's credential
 * endpoints. Covers happy paths, malformed-response detection, and the
 * toClientLike() preference.
 */

// ── GatewayClientLike stub ─────────────────────────────────────────────

function makeClient(impl: (path: string, method: string, body?: unknown) => Promise<unknown>) {
  return { request: vi.fn(impl) };
}

describe("HttpTransport — constructor", () => {
  it("uses GatewayClient.toClientLike() when available (preserves encapsulation)", async () => {
    const innerClient = makeClient(async () => ({ clusters: [] }));
    const gatewayLike = {
      toClientLike: () => innerClient,
      // An unused `request` is present to prove toClientLike() takes priority
      request: vi.fn(async () => {
        throw new Error("should not be called — toClientLike should be preferred");
      }),
    };

    const t = new HttpTransport(gatewayLike as any);
    await t.listClusters();

    expect(innerClient.request).toHaveBeenCalledTimes(1);
    expect(gatewayLike.request).not.toHaveBeenCalled();
  });

  it("falls back to using the passed object directly if no toClientLike()", async () => {
    const client = makeClient(async () => ({ clusters: [] }));
    const t = new HttpTransport(client);
    await t.listClusters();
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport — listClusters", () => {
  it("POSTs to /api/internal/credential-list with kind=cluster", async () => {
    const fakeMeta: ClusterMeta = { name: "c1", is_production: true };
    const client = makeClient(async (path, method, body) => {
      expect(path).toBe("/api/internal/credential-list");
      expect(method).toBe("POST");
      expect(body).toEqual({ kind: "cluster" });
      return { clusters: [fakeMeta] };
    });

    const t = new HttpTransport(client);
    const result = await t.listClusters();
    expect(result).toEqual([fakeMeta]);
  });

  it("returns empty array when gateway returns empty list", async () => {
    const client = makeClient(async () => ({ clusters: [] }));
    const t = new HttpTransport(client);
    expect(await t.listClusters()).toEqual([]);
  });

  it("throws on malformed response (missing clusters field)", async () => {
    const client = makeClient(async () => ({})); // no clusters key
    const t = new HttpTransport(client);
    await expect(t.listClusters()).rejects.toThrow(/malformed credential-list/);
  });

  it("throws when clusters is not an array", async () => {
    const client = makeClient(async () => ({ clusters: "not-an-array" as any }));
    const t = new HttpTransport(client);
    await expect(t.listClusters()).rejects.toThrow(/malformed credential-list/);
  });
});

describe("HttpTransport — listHosts", () => {
  it("POSTs to /api/internal/credential-list with kind=host", async () => {
    const fakeHost: HostMeta = {
      name: "h1",
      ip: "10.0.0.1",
      port: 22,
      username: "root",
      auth_type: "key",
      is_production: true,
    };
    const client = makeClient(async (path, method, body) => {
      expect(path).toBe("/api/internal/credential-list");
      expect(method).toBe("POST");
      expect(body).toEqual({ kind: "host" });
      return { hosts: [fakeHost] };
    });

    const t = new HttpTransport(client);
    const result = await t.listHosts();
    expect(result).toEqual([fakeHost]);
  });

  it("throws on malformed response (missing hosts field)", async () => {
    const client = makeClient(async () => ({}));
    const t = new HttpTransport(client);
    await expect(t.listHosts()).rejects.toThrow(/malformed credential-list/);
  });
});

describe("HttpTransport — getClusterCredential", () => {
  it("POSTs to /api/internal/credential-request with source=cluster", async () => {
    const payload: CredentialPayload = {
      credential: {
        name: "prod",
        type: "kubeconfig",
        files: [{ name: "prod.kubeconfig", content: "---" }],
        ttl_seconds: 300,
      },
    };
    const client = makeClient(async (path, method, body) => {
      expect(path).toBe("/api/internal/credential-request");
      expect(method).toBe("POST");
      expect(body).toEqual({ source: "cluster", source_id: "prod", purpose: "diagnostic" });
      return payload;
    });

    const t = new HttpTransport(client);
    const result = await t.getClusterCredential("prod", "diagnostic");
    expect(result).toBe(payload);
  });
});

describe("HttpTransport — getHostCredential", () => {
  it("POSTs with source=host", async () => {
    const payload: CredentialPayload = {
      credential: {
        name: "node-a",
        type: "ssh",
        files: [{ name: "node-a.key", content: "KEY" }],
        metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: false },
        ttl_seconds: 300,
      },
    };
    const client = makeClient(async (_path, _method, body) => {
      expect(body).toEqual({ source: "host", source_id: "node-a", purpose: "ssh" });
      return payload;
    });

    const t = new HttpTransport(client);
    const result = await t.getHostCredential("node-a", "ssh");
    expect(result).toBe(payload);
  });

  it("propagates errors from the underlying client", async () => {
    const client = makeClient(async () => {
      throw new Error("network error");
    });
    const t = new HttpTransport(client);
    await expect(t.getHostCredential("h", "p")).rejects.toThrow(/network error/);
  });
});
