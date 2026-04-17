import { describe, it, expect, beforeEach } from "vitest";
import {
  CredentialService,
  createCredentialService,
  CredentialNotFoundError,
} from "./credential-service.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { Identity } from "../shared/credential-types.js";

/**
 * Minimal fake FrontendWsClient that records every `request` invocation
 * and returns canned payloads.
 */
class FakeFrontendWsClient {
  calls: Array<{ method: string; params: any }> = [];
  responses = new Map<string, unknown>();
  nextError: Error | null = null;

  request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      return Promise.reject(err);
    }
    const key = `${method}:${(params as any).kind ?? (params as any).source ?? ""}`;
    if (this.responses.has(key)) return Promise.resolve(this.responses.get(key));
    if (this.responses.has(method)) return Promise.resolve(this.responses.get(method));
    return Promise.resolve({});
  }
}

const identity: Identity = {
  userId: "u1",
  agentId: "a1",
  orgId: "o1",
  boxId: "b1",
};

let fake: FakeFrontendWsClient;
let svc: CredentialService;

beforeEach(() => {
  fake = new FakeFrontendWsClient();
  svc = new CredentialService(fake as unknown as FrontendWsClient);
});

describe("CredentialService.listClusters", () => {
  it("issues credential.list with kind=cluster and identity fields, returns the clusters array", async () => {
    fake.responses.set("credential.list:cluster", {
      clusters: [{ name: "c1", is_production: true }],
    });

    const result = await svc.listClusters(identity);
    expect(result).toEqual([{ name: "c1", is_production: true }]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe("credential.list");
    expect(fake.calls[0].params).toEqual({
      kind: "cluster",
      userId: "u1",
      agentId: "a1",
      orgId: "o1",
      boxId: "b1",
    });
  });

  it("defaults missing orgId/boxId to empty string", async () => {
    fake.responses.set("credential.list:cluster", { clusters: [] });
    await svc.listClusters({ userId: "u", agentId: "a" });
    expect(fake.calls[0].params.orgId).toBe("");
    expect(fake.calls[0].params.boxId).toBe("");
  });

  it("throws when adapter returns malformed payload (not an array)", async () => {
    fake.responses.set("credential.list:cluster", { clusters: "oops" });
    await expect(svc.listClusters(identity)).rejects.toThrow(/malformed/);
  });

  it("throws when payload is missing the clusters field entirely", async () => {
    fake.responses.set("credential.list:cluster", {});
    await expect(svc.listClusters(identity)).rejects.toThrow(/malformed/);
  });
});

describe("CredentialService.listHosts", () => {
  it("issues credential.list with kind=host and returns the hosts array", async () => {
    fake.responses.set("credential.list:host", {
      hosts: [{ name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true }],
    });
    const result = await svc.listHosts(identity);
    expect(result).toHaveLength(1);
    expect(fake.calls[0].params.kind).toBe("host");
  });

  it("throws when hosts payload is malformed", async () => {
    fake.responses.set("credential.list:host", { hosts: null });
    await expect(svc.listHosts(identity)).rejects.toThrow(/malformed/);
  });
});

describe("CredentialService.getClusterCredential", () => {
  it("issues credential.get with source=cluster, purpose, and identity", async () => {
    const payload = {
      credential: { name: "c1", type: "kubeconfig" as const, files: [] },
    };
    fake.responses.set("credential.get:cluster", payload);

    const result = await svc.getClusterCredential(identity, "c1", "diagnose");
    expect(result).toEqual(payload);
    expect(fake.calls[0].method).toBe("credential.get");
    expect(fake.calls[0].params.source).toBe("cluster");
    expect(fake.calls[0].params.source_id).toBe("c1");
    expect(fake.calls[0].params.purpose).toBe("diagnose");
    expect(fake.calls[0].params.userId).toBe("u1");
  });

  it("propagates transport errors unchanged", async () => {
    fake.nextError = new Error("rpc timeout");
    await expect(svc.getClusterCredential(identity, "c1", "diag")).rejects.toThrow("rpc timeout");
  });
});

describe("CredentialService.getHostCredential", () => {
  it("issues credential.get with source=host", async () => {
    const payload = {
      credential: { name: "h1", type: "ssh" as const, files: [] },
    };
    fake.responses.set("credential.get:host", payload);
    const result = await svc.getHostCredential(identity, "h1", "debug");
    expect(result).toEqual(payload);
    expect(fake.calls[0].params.source).toBe("host");
    expect(fake.calls[0].params.source_id).toBe("h1");
    expect(fake.calls[0].params.purpose).toBe("debug");
  });
});

describe("CredentialNotFoundError", () => {
  it("is an Error subclass with the right name", () => {
    const err = new CredentialNotFoundError("missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CredentialNotFoundError");
    expect(err.message).toBe("missing");
  });
});

describe("createCredentialService factory", () => {
  it("returns a CredentialService wrapping the passed upstream client", () => {
    const svc2 = createCredentialService(fake as unknown as FrontendWsClient);
    expect(svc2).toBeInstanceOf(CredentialService);
  });
});
