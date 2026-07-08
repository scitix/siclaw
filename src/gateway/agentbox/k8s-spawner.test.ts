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

const originalGatewayEnv = {
  SICLAW_GATEWAY_INTERNAL_URL: process.env.SICLAW_GATEWAY_INTERNAL_URL,
  SICLAW_GATEWAY_HOSTNAME: process.env.SICLAW_GATEWAY_HOSTNAME,
  SICLAW_INTERNAL_PORT: process.env.SICLAW_INTERNAL_PORT,
  SICLAW_MEMORY_ENABLED: process.env.SICLAW_MEMORY_ENABLED,
};

// Import SUT after mocks.
import { K8sSpawner } from "./k8s-spawner.js";

// ── Fake cert manager ─────────────────────────────────────────────────

const FAKE_CA_FP = "fakecafp00000000";

class FakeCertManager {
  issuedCalls: any[] = [];
  fp = FAKE_CA_FP;
  issueAgentBoxCertificate(...args: any[]) {
    this.issuedCalls.push(args);
    return { cert: "CERT", key: "KEY", ca: "CA" };
  }
  caFingerprint() { return this.fp; }
}

// ── Helpers ───────────────────────────────────────────────────────────

function resetCalls() {
  for (const k of Object.keys(g.__k8sCalls)) g.__k8sCalls[k].length = 0;
}

beforeEach(() => {
  resetCalls();
  for (const key of Object.keys(originalGatewayEnv) as Array<keyof typeof originalGatewayEnv>) {
    if (originalGatewayEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalGatewayEnv[key];
    }
  }
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
    await expect(s.spawn({ agentId: "default" })).rejects.toThrow(/CertificateManager not initialized/);
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
        metadata: { name: "agentbox-default", labels: {} },
      };
    };

    const handle = await s.spawn({ agentId: "default" });
    expect(handle.endpoint).toBe("https://10.1.2.3:3000");
    expect(cm.issuedCalls).toHaveLength(1);
    // CN=agentId (no userId leaked into cert) — see spec 2026-04-18.
    expect(cm.issuedCalls[0]).toEqual(["default", "", "agentbox-default"]);

    // Secret created with kubernetes.io/tls type + base64 cert fields
    expect(calls.createNamespacedSecret).toHaveLength(1);
    const secretBody = calls.createNamespacedSecret[0].body;
    expect(secretBody.type).toBe("kubernetes.io/tls");
    expect(Buffer.from(secretBody.data["tls.crt"], "base64").toString()).toBe("CERT");
    expect(Buffer.from(secretBody.data["tls.key"], "base64").toString()).toBe("KEY");
    expect(Buffer.from(secretBody.data["ca.crt"], "base64").toString()).toBe("CA");
  });

  it("sanitizes forbidden chars in agentId and caps the pod name", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let r = 0;
    readPodImpl.fn = async () => {
      r++;
      if (r === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.1", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    // Uppercase → lowercase; "_" → "-"; 50-char cap keeps full name ≤ 63 chars.
    const handle = await s.spawn({ agentId: "Agent_With.Weird/Chars" });
    expect(handle.boxId).toBe("agentbox-agent-with-weird-chars");
  });
});

describe("K8sSpawner — spawn branches", () => {
  it("injects AgentBox gateway URL from the configured runtime hostname", async () => {
    process.env.SICLAW_GATEWAY_HOSTNAME = "siclaw-debug-runtime.siclaw-debug.svc.cluster.local";
    process.env.SICLAW_INTERNAL_PORT = "3002";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.8", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "default" });

    const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "SICLAW_GATEWAY_URL",
      value: "https://siclaw-debug-runtime.siclaw-debug.svc.cluster.local:3002",
    });
  });

  it("forwards SICLAW_SUBAGENT_CONCURRENCY from the runtime into the pod (allowlist), skipping it when unset", async () => {
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "2";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.11", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    try {
      await s.spawn({ agentId: "default" });
      const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
      expect(env).toContainEqual({ name: "SICLAW_SUBAGENT_CONCURRENCY", value: "2" });
    } finally {
      delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
    }
  });

  it("kb profile forwards KBC_* runtime env by prefix into the box pod, deduped, skipping empties", async () => {
    process.env.KBC_PK_MODE = "off";
    process.env.KBC_MEDIA_VERIFY = "on";
    process.env.KBC_SMOKE = ""; // empty ⇒ not forwarded
    process.env.ANTHROPIC_BASE_URL = "https://massapi.example/model-api";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.21", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    try {
      await s.spawn({ agentId: "kbrun", profile: "kb-compile" });
      const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
      expect(env).toContainEqual({ name: "KBC_PK_MODE", value: "off" });
      expect(env).toContainEqual({ name: "KBC_MEDIA_VERIFY", value: "on" });
      expect(env.some((e: any) => e.name === "KBC_SMOKE")).toBe(false);
      // no duplicates from wildcard + explicit entries overlapping
      expect(env.filter((e: any) => e.name === "ANTHROPIC_BASE_URL").length).toBe(1);
    } finally {
      delete process.env.KBC_PK_MODE;
      delete process.env.KBC_MEDIA_VERIFY;
      delete process.env.KBC_SMOKE;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it("refuses to forward secret-shaped names through the prefix glob (ops knobs only)", async () => {
    process.env.KBC_PK_MODE = "off";                       // knob → forwarded
    process.env.KBC_MASSAPI_TOKEN = "sk-parked";           // secret-shaped → refused
    process.env.KBC_WEBHOOK_SECRET = "hush";               // secret-shaped → refused
    process.env.KBC_SIGNING_API_KEY = "k";                 // secret-shaped → refused

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.22", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    try {
      await s.spawn({ agentId: "kbrun2", profile: "kb-compile" });
      const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
      expect(env).toContainEqual({ name: "KBC_PK_MODE", value: "off" });
      for (const leaked of ["KBC_MASSAPI_TOKEN", "KBC_WEBHOOK_SECRET", "KBC_SIGNING_API_KEY"]) {
        expect(env.some((e: any) => e.name === leaked)).toBe(false);
      }
    } finally {
      delete process.env.KBC_PK_MODE;
      delete process.env.KBC_MASSAPI_TOKEN;
      delete process.env.KBC_WEBHOOK_SECRET;
      delete process.env.KBC_SIGNING_API_KEY;
    }
  });

  it("does not inject SICLAW_SUBAGENT_CONCURRENCY when unset on the runtime", async () => {
    delete process.env.SICLAW_SUBAGENT_CONCURRENCY;

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.12", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "default" });
    const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
    expect(env.some((e: any) => e.name === "SICLAW_SUBAGENT_CONCURRENCY")).toBe(false);
  });

  it("lets explicit SICLAW_GATEWAY_INTERNAL_URL override the runtime hostname", async () => {
    process.env.SICLAW_GATEWAY_INTERNAL_URL = "https://custom-runtime.svc:3002";
    process.env.SICLAW_GATEWAY_HOSTNAME = "siclaw-debug-runtime.siclaw-debug.svc.cluster.local";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "default" });

    const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "SICLAW_GATEWAY_URL",
      value: "https://custom-runtime.svc:3002",
    });
  });

  it("passes the runtime memory flag into AgentBox pods", async () => {
    process.env.SICLAW_MEMORY_ENABLED = "false";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.10", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "default" });

    const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "SICLAW_MEMORY_ENABLED",
      value: "false",
    });
  });

  it("reuses a Running pod whose CA fingerprint matches, without creating a new one", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    readPodImpl.fn = async () => ({
      status: { phase: "Running", podIP: "10.9.9.9", conditions: [{ type: "Ready", status: "True" }] },
      metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP } },
    });

    const handle = await s.spawn({ agentId: "default" });
    expect(handle.endpoint).toBe("https://10.9.9.9:3000");
    expect(calls.createNamespacedPod).toHaveLength(0);
    expect(calls.createNamespacedSecret).toHaveLength(0);
    expect(calls.deleteNamespacedPod).toHaveLength(0);
  });

  it("recreates a Running pod whose CA fingerprint is stale (CA rotated)", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      // 1st read: existing Running pod stamped with an OLD CA fingerprint.
      if (reads === 1) {
        return {
          status: { phase: "Running", podIP: "10.9.9.9", conditions: [{ type: "Ready", status: "True" }] },
          metadata: { labels: { "siclaw.io/ca-fp": "stale-old-ca-fp" } },
        };
      }
      // 2nd read: waitForPodDeleted sees it gone.
      if (reads === 2) throw Object.assign(new Error("nf"), { code: 404 });
      // Subsequent: the freshly recreated pod.
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP } } };
    };

    const handle = await s.spawn({ agentId: "default" });
    expect(calls.deleteNamespacedPod).toHaveLength(1); // stale pod recycled
    expect(calls.createNamespacedPod).toHaveLength(1); // recreated with current CA
    expect(handle.endpoint).toBe("https://10.0.0.9:3000");
  });

  it("recreates a Running pod with no ca-fp label (legacy pod predating the feature)", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) {
        return { status: { phase: "Running", podIP: "10.9.9.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
      }
      if (reads === 2) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP } } };
    };

    await s.spawn({ agentId: "default" });
    expect(calls.deleteNamespacedPod).toHaveLength(1);
    expect(calls.createNamespacedPod).toHaveLength(1);
  });

  it("stamps the pod and its cert Secret with the current CA fingerprint", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.8", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "default" });
    expect(calls.createNamespacedPod[0].body.metadata.labels["siclaw.io/ca-fp"]).toBe(FAKE_CA_FP);
    expect(calls.createNamespacedSecret[0].body.metadata.labels["siclaw.io/ca-fp"]).toBe(FAKE_CA_FP);
  });

  it("caFingerprint() reflects the cert manager (undefined before setCertManager)", () => {
    const s = new K8sSpawner();
    expect(s.caFingerprint()).toBeUndefined();
    s.setCertManager(new FakeCertManager() as any);
    expect(s.caFingerprint()).toBe(FAKE_CA_FP);
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

    const handle = await s.spawn({ agentId: "default" });
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

    await s.spawn({ agentId: "default" });
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

    const handle = await s.spawn({ agentId: "default" });
    expect(handle.endpoint).toBe("https://10.0.0.7:3000");
  });

  it("rethrows non-404 errors during initial pod lookup", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    readPodImpl.fn = async () => { throw Object.assign(new Error("bad"), { code: 500 }); };
    await expect(s.spawn({ agentId: "default" })).rejects.toThrow(/bad/);
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
    await expect(s.spawn({ agentId: "default" })).rejects.toThrow(/failed to start: Failed/);
  });
});

describe("K8sSpawner — stop", () => {
  it("deletes pod + cert Secret", async () => {
    const s = new K8sSpawner();
    await s.stop("agentbox-default");
    expect(calls.deleteNamespacedPod).toHaveLength(1);
    expect(calls.deleteNamespacedPod[0].name).toBe("agentbox-default");
    expect(calls.deleteNamespacedSecret).toHaveLength(1);
    expect(calls.deleteNamespacedSecret[0].name).toBe("agentbox-default-cert");
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
  it("maps Running+Ready → status='running' and reads agentId from the pod label", async () => {
    readPodImpl.fn = async () => ({
      status: { phase: "Running", podIP: "1.2.3.4", conditions: [{ type: "Ready", status: "True" }] },
      metadata: { labels: { "siclaw.io/agent": "a1" }, creationTimestamp: "2025-01-01T00:00:00Z" },
    });
    const s = new K8sSpawner();
    const info = await s.get("box-1");
    expect(info?.status).toBe("running");
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
  it("list() returns every pod and maps status correctly (including terminating → stopped)", async () => {
    // list() must NOT pre-filter — callers like agent.terminate need to see
    // zombie pods so they can reap them. Callers like agent.reload filter on
    // status === "running" at the call site instead. Terminating pods are
    // mapped to "stopped" because their podIP is already draining.
    // See bug report siclaw-agent-reload-stale-pods-and-serial-blocking.
    listPodImpl.fn = async () => ({
      items: [
        {
          status: { phase: "Running", podIP: "1.1.1.1", conditions: [{ type: "Ready", status: "True" }] },
          metadata: { name: "p-live", labels: { "siclaw.io/agent": "a1" }, creationTimestamp: "2025-01-01T00:00:00Z" },
        },
        {
          status: { phase: "Pending" },
          metadata: { name: "p-pending", labels: { "siclaw.io/agent": "a2" } },
        },
        {
          status: { phase: "Succeeded", podIP: "1.1.1.3" },
          metadata: { name: "p-completed", labels: { "siclaw.io/agent": "a3" } },
        },
        {
          status: { phase: "Failed", podIP: "1.1.1.4" },
          metadata: { name: "p-failed", labels: { "siclaw.io/agent": "a4" } },
        },
        {
          status: { phase: "Running", podIP: "1.1.1.5", conditions: [{ type: "Ready", status: "False" }] },
          metadata: { name: "p-not-ready", labels: { "siclaw.io/agent": "a5" } },
        },
        {
          // Running + Ready but Terminating — must map to "stopped"
          status: { phase: "Running", podIP: "1.1.1.6", conditions: [{ type: "Ready", status: "True" }] },
          metadata: { name: "p-terminating", labels: { "siclaw.io/agent": "a6" }, deletionTimestamp: "2025-01-01T00:00:00Z" },
        },
      ],
    });
    const s = new K8sSpawner();
    const all = await s.list();
    expect(all).toHaveLength(6);
    const byId = Object.fromEntries(all.map((b) => [b.boxId, b.status]));
    expect(byId["p-live"]).toBe("running");
    expect(byId["p-pending"]).toBe("starting");
    expect(byId["p-completed"]).toBe("stopped");
    expect(byId["p-failed"]).toBe("stopped");
    expect(byId["p-not-ready"]).toBe("starting");
    expect(byId["p-terminating"]).toBe("stopped");
  });

  it("cleanup() deletes pod + secret collections", async () => {
    const s = new K8sSpawner();
    await s.cleanup();
    expect(calls.deleteCollectionNamespacedPod).toHaveLength(1);
    expect(calls.deleteCollectionNamespacedSecret).toHaveLength(1);
    expect(calls.deleteCollectionNamespacedPod[0].labelSelector).toBe("siclaw.io/app=agentbox");
  });
});

describe("K8sSpawner — per-agent persistence (PVC override)", () => {
  // Drive readNamespacedPod: first call 404 (new pod), then a Running pod so
  // spawn() resolves. Lets us inspect the createNamespacedPod body.
  function readReturnsRunningAfter404() {
    let r = 0;
    readPodImpl.fn = async () => {
      r++;
      if (r === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.9.9.9", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { name: "agentbox-default", labels: {} },
      };
    };
  }

  function userDataVolume() {
    const body = calls.createNamespacedPod[0].body;
    const vols = body.spec.volumes as any[];
    return vols.find((v) => v.name === "user-data");
  }

  function userDataMount() {
    const body = calls.createNamespacedPod[0].body;
    const mounts = body.spec.containers[0].volumeMounts as any[];
    return mounts.find((m) => m.name === "user-data");
  }

  it("boxConfig.persistence=true mounts the shared PVC with a per-agent subPath", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ persistence: { enabled: false, claimName: "siclaw-data" } });
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "diagnose-1", persistence: true });

    expect(userDataVolume().persistentVolumeClaim).toEqual({ claimName: "siclaw-data" });
    expect(userDataVolume().emptyDir).toBeUndefined();
    expect(userDataMount().subPath).toBe("agents/diagnose-1");
  });

  it("boxConfig.persistence=false uses emptyDir even when global persistence is enabled", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ persistence: { enabled: true, claimName: "siclaw-data" } });
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "shopping-1", persistence: false });

    expect(userDataVolume().emptyDir).toEqual({});
    expect(userDataVolume().persistentVolumeClaim).toBeUndefined();
    expect(userDataMount().subPath).toBeUndefined();
  });

  it("undefined boxConfig.persistence falls back to the spawner's global config (enabled)", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ persistence: { enabled: true, claimName: "siclaw-data" } });
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "legacy-1" });

    expect(userDataVolume().persistentVolumeClaim).toEqual({ claimName: "siclaw-data" });
    expect(userDataMount().subPath).toBe("agents/legacy-1");
  });

  it("undefined boxConfig.persistence falls back to the spawner's global config (disabled)", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner(); // no persistence config at all
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "legacy-2" });

    expect(userDataVolume().emptyDir).toEqual({});
    expect(userDataMount().subPath).toBeUndefined();
  });

  it("persistence requested but no claimName configured → falls back to emptyDir (no broken mount)", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner(); // global persistence undefined → no claimName
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "diagnose-2", persistence: true });

    // Must not emit a PVC volume that can never bind.
    expect(userDataVolume().persistentVolumeClaim).toBeUndefined();
    expect(userDataVolume().emptyDir).toEqual({});
    expect(userDataMount().subPath).toBeUndefined();
  });
});

describe("K8sSpawner — nodeSelector", () => {
  // Drive readNamespacedPod: first call 404 (new pod), then a Running pod so
  // spawn() resolves. Lets us inspect the createNamespacedPod body.
  function readReturnsRunningAfter404() {
    let r = 0;
    readPodImpl.fn = async () => {
      r++;
      if (r === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.7.7.7", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { name: "agentbox-default", labels: {} },
      };
    };
  }

  function podSpec() {
    return calls.createNamespacedPod[0].body.spec;
  }

  it("applies the configured nodeSelector onto the pod spec", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ nodeSelector: { disktype: "ssd", pool: "agents" } });
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "default" });

    expect(podSpec().nodeSelector).toEqual({ disktype: "ssd", pool: "agents" });
  });

  it("omits nodeSelector when not configured", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "default" });

    expect(podSpec().nodeSelector).toBeUndefined();
  });

  it("omits nodeSelector when configured as an empty map", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ nodeSelector: {} });
    s.setCertManager(cm as any);
    readReturnsRunningAfter404();

    await s.spawn({ agentId: "default" });

    expect(podSpec().nodeSelector).toBeUndefined();
  });
});
