import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Tests for K8sSpawner.
 *
 * We fully mock @kubernetes/client-node so no real K8s API is hit. The focus
 * is behavior contracts, not serialisation: how spawn reacts to existing
 * pods / stale secrets / concurrent 409s, how status maps, how identifiers
 * are sanitised, how cert Secret is built.
 *
 * mTLS (invariant §3) is exercised indirectly — issueAgentBoxCertificate is
 * called and the returned bundle is base64-packed into a kubernetes.io/tls
 * Secret. That's the full mTLS surface area this module owns.
 */

// ── Mock @kubernetes/client-node ──────────────────────────────────────
// vi.mock is hoisted: factory must be self-contained. We expose call logs
// and per-test impls on globalThis so tests can mutate them.

vi.mock("@kubernetes/client-node", () => {
  const g = globalThis as any;
  g.__k8sCalls = {
    readNamespacedPod: [],
    deleteNamespacedPod: [],
    createNamespacedPod: [],
    createNamespacedSecret: [],
    deleteNamespacedSecret: [],
    listNamespacedPod: [],
    deleteCollectionNamespacedPod: [],
    deleteCollectionNamespacedSecret: [],
  };
  g.__k8sImpls = {
    readNamespacedPod: async () => { throw Object.assign(new Error("not found"), { code: 404 }); },
    deleteNamespacedPod: async () => ({}),
    createNamespacedPod: async () => ({}),
    createNamespacedSecret: async () => ({}),
    deleteNamespacedSecret: async () => ({}),
    listNamespacedPod: async () => ({ items: [] }),
    deleteCollectionNamespacedPod: async () => ({}),
    deleteCollectionNamespacedSecret: async () => ({}),
  };

  class FakeCoreV1Api {
    async readNamespacedPod(args: any) { g.__k8sCalls.readNamespacedPod.push(args); return g.__k8sImpls.readNamespacedPod(args); }
    async deleteNamespacedPod(args: any) { g.__k8sCalls.deleteNamespacedPod.push(args); return g.__k8sImpls.deleteNamespacedPod(args); }
    async createNamespacedPod(args: any) { g.__k8sCalls.createNamespacedPod.push(args); return g.__k8sImpls.createNamespacedPod(args); }
    async createNamespacedSecret(args: any) { g.__k8sCalls.createNamespacedSecret.push(args); return g.__k8sImpls.createNamespacedSecret(args); }
    async deleteNamespacedSecret(args: any) { g.__k8sCalls.deleteNamespacedSecret.push(args); return g.__k8sImpls.deleteNamespacedSecret(args); }
    async listNamespacedPod(args: any) { g.__k8sCalls.listNamespacedPod.push(args); return g.__k8sImpls.listNamespacedPod(args); }
    async deleteCollectionNamespacedPod(args: any) { g.__k8sCalls.deleteCollectionNamespacedPod.push(args); return g.__k8sImpls.deleteCollectionNamespacedPod(args); }
    async deleteCollectionNamespacedSecret(args: any) { g.__k8sCalls.deleteCollectionNamespacedSecret.push(args); return g.__k8sImpls.deleteCollectionNamespacedSecret(args); }
  }
  class FakeKubeConfig {
    loadFromDefault() {}
    makeApiClient<T>(_cls: any): T { return new FakeCoreV1Api() as unknown as T; }
  }
  return { KubeConfig: FakeKubeConfig, CoreV1Api: FakeCoreV1Api };
});

// Mock fs.mkdirSync used by ensureUserDir (persistence enabled).
vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...real,
    default: {
      ...real,
      mkdirSync: vi.fn((_p: string, _o?: any) => undefined as any),
    },
    mkdirSync: vi.fn((_p: string, _o?: any) => undefined as any),
  };
});

// Shortcut aliases for readability in tests.
const g = globalThis as any;
const calls = new Proxy({} as any, { get: (_t, k) => g.__k8sCalls[k as string] });
const readPodImpl = { set fn(f: (a: any) => Promise<any>) { g.__k8sImpls.readNamespacedPod = f; }, get fn() { return g.__k8sImpls.readNamespacedPod; } };
const createPodImpl = { set fn(f: (a: any) => Promise<any>) { g.__k8sImpls.createNamespacedPod = f; }, get fn() { return g.__k8sImpls.createNamespacedPod; } };
const deletePodImpl = { set fn(f: (a: any) => Promise<any>) { g.__k8sImpls.deleteNamespacedPod = f; }, get fn() { return g.__k8sImpls.deleteNamespacedPod; } };
const createSecretImpl = { set fn(f: (a: any) => Promise<any>) { g.__k8sImpls.createNamespacedSecret = f; }, get fn() { return g.__k8sImpls.createNamespacedSecret; } };
const listPodImpl = { set fn(f: (a: any) => Promise<any>) { g.__k8sImpls.listNamespacedPod = f; }, get fn() { return g.__k8sImpls.listNamespacedPod; } };

// Import SUT after mocks.
import { K8sSpawner } from "./k8s-spawner.js";

// ── Fake cert manager ─────────────────────────────────────────────────

class FakeCertManager {
  issuedCalls: any[] = [];
  issueAgentBoxCertificate(...args: any[]) {
    this.issuedCalls.push(args);
    return { cert: "CERT", key: "KEY", ca: "CA" };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function resetCalls() {
  for (const k of Object.keys(g.__k8sCalls)) g.__k8sCalls[k].length = 0;
}

beforeEach(() => {
  resetCalls();
  // Reset impls to defaults
  g.__k8sImpls.readNamespacedPod = async () => { throw Object.assign(new Error("not found"), { code: 404 }); };
  g.__k8sImpls.createNamespacedPod = async () => ({});
  g.__k8sImpls.deleteNamespacedPod = async () => ({});
  g.__k8sImpls.createNamespacedSecret = async () => ({});
  g.__k8sImpls.deleteNamespacedSecret = async () => ({});
  g.__k8sImpls.listNamespacedPod = async () => ({ items: [] });
  g.__k8sImpls.deleteCollectionNamespacedPod = async () => ({});
  g.__k8sImpls.deleteCollectionNamespacedSecret = async () => ({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────

describe("K8sSpawner — metadata + setCertManager", () => {
  it("exposes name 'k8s'", () => {
    const s = new K8sSpawner();
    expect(s.name).toBe("k8s");
  });

  it("spawn throws when setCertManager hasn't been called", async () => {
    const s = new K8sSpawner();
    await expect(s.spawn({ userId: "alice" })).rejects.toThrow(/CertificateManager not initialized/);
  });
});

describe("K8sSpawner — pod name sanitization + invariant §3 (mTLS K8s-only)", () => {
  it("issues a client cert via certManager and stores it as a tls Secret", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    // Make readNamespacedPod return 404 (new pod) then running pod after create
    let readCount = 0;
    readPodImpl.fn = async () => {
      readCount++;
      if (readCount === 1) {
        // 404 → Pod does not exist
        throw Object.assign(new Error("not found"), { code: 404 });
      }
      return {
        status: { phase: "Running", podIP: "10.1.2.3", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { name: "agentbox-alice-default", labels: {} },
      };
    };

    const handle = await s.spawn({ userId: "alice" });
    expect(handle.endpoint).toBe("https://10.1.2.3:3000");
    expect(cm.issuedCalls).toHaveLength(1);
    expect(cm.issuedCalls[0]).toEqual(["alice", "default", "", "agentbox-alice-default", "prod"]);

    // Secret created with kubernetes.io/tls type + base64 cert fields
    expect(calls.createNamespacedSecret).toHaveLength(1);
    const secretBody = calls.createNamespacedSecret[0].body;
    expect(secretBody.type).toBe("kubernetes.io/tls");
    expect(Buffer.from(secretBody.data["tls.crt"], "base64").toString()).toBe("CERT");
    expect(Buffer.from(secretBody.data["tls.key"], "base64").toString()).toBe("KEY");
    expect(Buffer.from(secretBody.data["ca.crt"], "base64").toString()).toBe("CA");
  });

  it("podEnv defaults to 'prod' but can be overridden", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let r = 0;
    readPodImpl.fn = async () => {
      r++;
      if (r === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.1", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ userId: "bob", podEnv: "dev" });
    expect(cm.issuedCalls[0][4]).toBe("dev");
  });

  it("sanitizes userId (lowercase, [^a-z0-9-]→'-', slice(0,30)) and agentId (strip non-alnum, slice(0,8))", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let r = 0;
    readPodImpl.fn = async () => {
      r++;
      if (r === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.1", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    const handle = await s.spawn({ userId: "User.Name", agentId: "a1-b2-c3-d4-extra" });
    // "user.name" → "user-name"; "a1-b2-c3-d4-extra" → strip non-alnum → "a1b2c3d4extra" → slice 8 → "a1b2c3d4"
    expect(handle.boxId).toBe("agentbox-user-name-a1b2c3d4");
  });
});

describe("K8sSpawner — spawn branches", () => {
  it("reuses a Running pod without creating a new one", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    readPodImpl.fn = async () => ({
      status: { phase: "Running", podIP: "10.9.9.9", conditions: [{ type: "Ready", status: "True" }] },
      metadata: { labels: {} },
    });

    const handle = await s.spawn({ userId: "alice" });
    expect(handle.endpoint).toBe("https://10.9.9.9:3000");
    expect(calls.createNamespacedPod).toHaveLength(0);
    expect(calls.createNamespacedSecret).toHaveLength(0);
  });

  it("removes stale Failed pod before recreating", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) {
        return { status: { phase: "Failed" }, metadata: { labels: {} } };
      }
      if (reads === 2) {
        // called by waitForPodDeleted
        throw Object.assign(new Error("nf"), { code: 404 });
      }
      // Subsequent reads from waitForPodReady — running
      return { status: { phase: "Running", podIP: "10.0.0.5", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    const handle = await s.spawn({ userId: "alice" });
    expect(calls.deleteNamespacedPod).toHaveLength(1);
    expect(calls.createNamespacedPod).toHaveLength(1);
    expect(handle.endpoint).toBe("https://10.0.0.5:3000");
  });

  it("replaces cert Secret on 409 conflict (stale secret handling)", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.6", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    let secretCreates = 0;
    createSecretImpl.fn = async () => {
      secretCreates++;
      if (secretCreates === 1) throw Object.assign(new Error("conflict"), { code: 409 });
      return {};
    };

    await s.spawn({ userId: "alice" });
    expect(calls.deleteNamespacedSecret).toHaveLength(1);
    expect(calls.createNamespacedSecret).toHaveLength(2); // retry after delete
  });

  it("handles concurrent pod-create 409 by reusing instead of erroring", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.7", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    createPodImpl.fn = async () => { throw Object.assign(new Error("conflict"), { code: 409 }); };

    const handle = await s.spawn({ userId: "alice" });
    expect(handle.endpoint).toBe("https://10.0.0.7:3000");
  });

  it("rethrows non-404 errors during initial pod lookup", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    readPodImpl.fn = async () => { throw Object.assign(new Error("bad"), { code: 500 }); };
    await expect(s.spawn({ userId: "alice" })).rejects.toThrow(/bad/);
  });

  it("throws when waitForPodReady observes a Failed phase", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Failed" }, metadata: { labels: {} } };
    };
    await expect(s.spawn({ userId: "alice" })).rejects.toThrow(/failed to start: Failed/);
  });
});

describe("K8sSpawner — stop", () => {
  it("deletes pod + cert Secret", async () => {
    const s = new K8sSpawner();
    await s.stop("agentbox-alice-default");
    expect(calls.deleteNamespacedPod).toHaveLength(1);
    expect(calls.deleteNamespacedPod[0].name).toBe("agentbox-alice-default");
    expect(calls.deleteNamespacedSecret).toHaveLength(1);
    expect(calls.deleteNamespacedSecret[0].name).toBe("agentbox-alice-default-cert");
  });

  it("swallows 404 on stop (pod already gone)", async () => {
    deletePodImpl.fn = async () => { throw Object.assign(new Error("nf"), { code: 404 }); };
    const s = new K8sSpawner();
    await expect(s.stop("gone")).resolves.toBeUndefined();
  });

  it("rethrows non-404 errors on stop", async () => {
    deletePodImpl.fn = async () => { throw Object.assign(new Error("bad"), { code: 500 }); };
    const s = new K8sSpawner();
    await expect(s.stop("bad-pod")).rejects.toThrow(/bad/);
  });
});

describe("K8sSpawner — get", () => {
  it("maps Running+Ready → status='running'", async () => {
    readPodImpl.fn = async () => ({
      status: { phase: "Running", podIP: "1.2.3.4", conditions: [{ type: "Ready", status: "True" }] },
      metadata: { labels: { "siclaw.io/user": "alice", "siclaw.io/agent": "a1" }, creationTimestamp: "2025-01-01T00:00:00Z" },
    });
    const s = new K8sSpawner();
    const info = await s.get("box-1");
    expect(info?.status).toBe("running");
    expect(info?.userId).toBe("alice");
    expect(info?.agentId).toBe("a1");
    expect(info?.endpoint).toBe("https://1.2.3.4:3000");
  });

  it("maps Pending → status='starting'", async () => {
    readPodImpl.fn = async () => ({ status: { phase: "Pending" }, metadata: { labels: {} } });
    const s = new K8sSpawner();
    const info = await s.get("box-1");
    expect(info?.status).toBe("starting");
  });

  it("maps Succeeded/Failed → 'stopped'", async () => {
    readPodImpl.fn = async () => ({ status: { phase: "Failed" }, metadata: { labels: {} } });
    const s = new K8sSpawner();
    expect((await s.get("x"))?.status).toBe("stopped");

    readPodImpl.fn = async () => ({ status: { phase: "Succeeded" }, metadata: { labels: {} } });
    expect((await s.get("x"))?.status).toBe("stopped");
  });

  it("maps unknown phase → 'error'", async () => {
    readPodImpl.fn = async () => ({ status: { phase: "WeirdPhase" }, metadata: { labels: {} } });
    const s = new K8sSpawner();
    expect((await s.get("x"))?.status).toBe("error");
  });

  it("returns null on 404", async () => {
    readPodImpl.fn = async () => { throw Object.assign(new Error("nf"), { code: 404 }); };
    const s = new K8sSpawner();
    expect(await s.get("ghost")).toBeNull();
  });

  it("rethrows non-404 on get", async () => {
    readPodImpl.fn = async () => { throw Object.assign(new Error("bad"), { code: 500 }); };
    const s = new K8sSpawner();
    await expect(s.get("x")).rejects.toThrow(/bad/);
  });
});

describe("K8sSpawner — list + cleanup", () => {
  it("list() maps pod items through the same status mapper", async () => {
    listPodImpl.fn = async () => ({
      items: [
        {
          status: { phase: "Running", podIP: "1.1.1.1", conditions: [{ type: "Ready", status: "True" }] },
          metadata: { name: "p1", labels: { "siclaw.io/user": "alice" }, creationTimestamp: "2025-01-01T00:00:00Z" },
        },
        {
          status: { phase: "Pending" },
          metadata: { name: "p2", labels: { "siclaw.io/user": "bob" } },
        },
      ],
    });
    const s = new K8sSpawner();
    const all = await s.list();
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe("running");
    expect(all[1].status).toBe("starting");
  });

  it("cleanup() deletes pod + secret collections", async () => {
    const s = new K8sSpawner();
    await s.cleanup();
    expect(calls.deleteCollectionNamespacedPod).toHaveLength(1);
    expect(calls.deleteCollectionNamespacedSecret).toHaveLength(1);
    expect(calls.deleteCollectionNamespacedPod[0].labelSelector).toBe("siclaw.io/app=agentbox");
  });
});
