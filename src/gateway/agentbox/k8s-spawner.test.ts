import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import forge from "node-forge";
import type { AgentBoxInfo } from "./types.js";

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
    readNamespacedSecret: [],
    deleteNamespacedSecret: [],
    listNamespacedPod: [],
    listNamespacedSecret: [],
    deleteCollectionNamespacedPod: [],
    deleteCollectionNamespacedSecret: [],
  };
  g.__k8sImpls = {
    readNamespacedPod: async () => { throw Object.assign(new Error("not found"), { code: 404 }); },
    deleteNamespacedPod: async () => ({}),
    createNamespacedPod: async () => ({}),
    createNamespacedSecret: async () => ({}),
    readNamespacedSecret: async () => { throw Object.assign(new Error("nf"), { code: 404 }); },
    deleteNamespacedSecret: async () => ({}),
    listNamespacedPod: async () => ({ items: [] }),
    listNamespacedSecret: async () => ({ items: [] }),
    deleteCollectionNamespacedPod: async () => ({}),
    deleteCollectionNamespacedSecret: async () => ({}),
  };

  class FakeCoreV1Api {
    async readNamespacedPod(args: any) { g.__k8sCalls.readNamespacedPod.push(args); return g.__k8sImpls.readNamespacedPod(args); }
    async deleteNamespacedPod(args: any) { g.__k8sCalls.deleteNamespacedPod.push(args); return g.__k8sImpls.deleteNamespacedPod(args); }
    async createNamespacedPod(args: any) { g.__k8sCalls.createNamespacedPod.push(args); return g.__k8sImpls.createNamespacedPod(args); }
    async createNamespacedSecret(args: any) { g.__k8sCalls.createNamespacedSecret.push(args); return g.__k8sImpls.createNamespacedSecret(args); }
    async readNamespacedSecret(args: any) { g.__k8sCalls.readNamespacedSecret.push(args); return g.__k8sImpls.readNamespacedSecret(args); }
    async deleteNamespacedSecret(args: any) { g.__k8sCalls.deleteNamespacedSecret.push(args); return g.__k8sImpls.deleteNamespacedSecret(args); }
    async listNamespacedPod(args: any) { g.__k8sCalls.listNamespacedPod.push(args); return g.__k8sImpls.listNamespacedPod(args); }
    async listNamespacedSecret(args: any) { g.__k8sCalls.listNamespacedSecret.push(args); return g.__k8sImpls.listNamespacedSecret(args); }
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
  SICLAW_VISUAL_EXPORT_URL: process.env.SICLAW_VISUAL_EXPORT_URL,
  SICLAW_VISUAL_EXPORT_TIMEOUT_MS: process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS,
  SICLAW_VISUAL_EXPORT_THEME: process.env.SICLAW_VISUAL_EXPORT_THEME,
  SICLAW_VISUAL_EXPORT_CHROMIUM: process.env.SICLAW_VISUAL_EXPORT_CHROMIUM,
};

// Import SUT after mocks.
import {
  K8sSpawner,
  parseK8sQuantity,
  clampRequestToLimit,
  STARTUP_PROBE_WINDOW_MS,
} from "./k8s-spawner.js";

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

/**
 * A real self-signed PEM expiring at `notAfter`.
 *
 * The certificate has to be genuine: the spawner reads the expiry out of the certificate
 * BYTES rather than from a label beside them, so a placeholder string exercises only the
 * unparseable path. 512-bit keys keep this fast — nothing here verifies a signature.
 */
function pemValidUntil(notAfter: Date): string {
  const keys = forge.pki.rsa.generateKeyPair(512);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(notAfter.getTime() - 30 * 24 * 60 * 60 * 1000);
  cert.validity.notAfter = notAfter;
  const attrs = [{ name: "commonName", value: "agent-x" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return forge.pki.certificateToPem(cert);
}

/** Whole-second precision, matching what X.509 stores and the label round-trips. */
function daysFromNow(days: number): Date {
  return new Date(Math.floor((Date.now() + days * 24 * 60 * 60 * 1000) / 1000) * 1000);
}

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
  g.__k8sImpls.listNamespacedSecret = async () => ({ items: [] });
  g.__k8sCalls.listNamespacedSecret.length = 0;
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
        metadata: { name: "agentbox-default-0", labels: {} },
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
    expect(handle.boxId).toBe("agentbox-agent-with-weird-chars-0");
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

  it("forwards the sub-agent OPS ROLLBACK knobs, which are read inside the box", async () => {
    // Both are read in the AgentBox process (getSubagentModelTierOverride,
    // isSubagentGroupEnabled) and both are documented as the way to turn their
    // feature off during an incident. Neither was on the allowlist, so setting
    // them on the Runtime deployment did nothing at all in K8s mode — a switch
    // that silently does nothing, which is worse than an absent one.
    process.env.SICLAW_SUBAGENT_MODEL_TIER = "off";
    process.env.SICLAW_SUBAGENT_GROUP_ENABLED = "false";

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
      expect(env).toContainEqual({ name: "SICLAW_SUBAGENT_MODEL_TIER", value: "off" });
      expect(env).toContainEqual({ name: "SICLAW_SUBAGENT_GROUP_ENABLED", value: "false" });
    } finally {
      delete process.env.SICLAW_SUBAGENT_MODEL_TIER;
      delete process.env.SICLAW_SUBAGENT_GROUP_ENABLED;
    }
  });

  it("does not invent the sub-agent knobs when the runtime has not set them", async () => {
    // The paired negative: without it the test above passes on a spawner that
    // forwards the entire environment, which is a different (and unsafe) thing.
    delete process.env.SICLAW_SUBAGENT_MODEL_TIER;
    delete process.env.SICLAW_SUBAGENT_GROUP_ENABLED;

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.11", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "default" });
    const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
    expect(env.some((e: any) => e.name === "SICLAW_SUBAGENT_MODEL_TIER")).toBe(false);
    expect(env.some((e: any) => e.name === "SICLAW_SUBAGENT_GROUP_ENABLED")).toBe(false);
  });

  it("forwards the visual export contract from the runtime into the AgentBox", async () => {
    process.env.SICLAW_VISUAL_EXPORT_URL = "https://console.example.com/siclaw-visual-export";
    process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS = "15000";
    process.env.SICLAW_VISUAL_EXPORT_THEME = "dark";
    process.env.SICLAW_VISUAL_EXPORT_CHROMIUM = "/opt/chromium";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "agentbox.example.test", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "default" });
    const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "SICLAW_VISUAL_EXPORT_URL",
      value: "https://console.example.com/siclaw-visual-export",
    });
    expect(env).toContainEqual({ name: "SICLAW_VISUAL_EXPORT_TIMEOUT_MS", value: "15000" });
    expect(env).toContainEqual({ name: "SICLAW_VISUAL_EXPORT_THEME", value: "dark" });
    expect(env).toContainEqual({ name: "SICLAW_VISUAL_EXPORT_CHROMIUM", value: "/opt/chromium" });
  });

  it("kb profile forwards KBC_* runtime env by prefix into the box pod, deduped, skipping empties", async () => {
    process.env.KBC_PK_MODE = "off";
    process.env.KBC_MEDIA_VERIFY = "on";
    process.env.KBC_SMOKE = ""; // empty ⇒ not forwarded
    process.env.ANTHROPIC_BASE_URL = "https://model-gateway.example.com/model-api";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      // reads 1 (legacy agentbox-name probe) + 2 (new kbc-box name) both absent → create.
      if (reads <= 2) throw Object.assign(new Error("nf"), { code: 404 });
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

  it("keeps agent-only embedding credentials out of lean KB PodSpecs", async () => {
    process.env.SICLAW_EMBEDDING_BASE_URL = "https://embedding.example/v1";
    process.env.SICLAW_EMBEDDING_API_KEY = "embedding-secret";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads % 2 === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.24", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    try {
      await s.spawn({ agentId: "normal-agent" });
      await s.spawn({ agentId: "kb-compile-run", profile: "kb-compile" });
      await s.spawn({ agentId: "kb-test-run", profile: "kb-test" });
      const agentEnv = calls.createNamespacedPod[0].body.spec.containers[0].env;
      const capabilityEnvs = calls.createNamespacedPod
        .slice(1)
        .map((call: any) => call.body.spec.containers[0].env);

      expect(agentEnv).toContainEqual({ name: "SICLAW_EMBEDDING_BASE_URL", value: "https://embedding.example/v1" });
      expect(agentEnv).toContainEqual({ name: "SICLAW_EMBEDDING_API_KEY", value: "embedding-secret" });
      for (const env of capabilityEnvs) {
        expect(env.some((entry: any) => entry.name.startsWith("SICLAW_EMBEDDING_"))).toBe(false);
      }
    } finally {
      delete process.env.SICLAW_EMBEDDING_BASE_URL;
      delete process.env.SICLAW_EMBEDDING_API_KEY;
    }
  });

  it("allows nested Bubblewrap only for Codex compile boxes", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads % 2 === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.25", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "normal-agent" });
    await s.spawn({ agentId: "claude-compile", profile: "kb-compile" });
    await s.spawn({ agentId: "codex-compile", profile: "kb-compile-codex" });
    await s.spawn({ agentId: "codex-test", profile: "kb-test" });

    const [agentPod, claudePod, codexPod, testPod] = calls.createNamespacedPod.map((call: any) => call.body);
    for (const pod of [agentPod, claudePod, testPod]) {
      expect(pod.spec.securityContext.seccompProfile).toEqual({ type: "RuntimeDefault" });
      expect(pod.metadata.annotations?.["container.apparmor.security.beta.kubernetes.io/agentbox"]).toBeUndefined();
    }
    expect(codexPod.spec.securityContext.seccompProfile).toEqual({ type: "Unconfined" });
    expect(codexPod.metadata.annotations).toMatchObject({
      "container.apparmor.security.beta.kubernetes.io/agentbox": "unconfined",
    });
    expect(codexPod.spec.automountServiceAccountToken).toBe(false);
    expect(codexPod.spec.containers[0].securityContext).toEqual({
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("uses in-container exec probes for KB boxes so NetworkPolicy need not admit kubelet traffic", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      // reads 1 (legacy agentbox-name probe) + 2 (new kbc-box name) both absent → create.
      if (reads <= 2) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.23", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "kb-probe", profile: "kb-compile" });
    const container = calls.createNamespacedPod[0].body.spec.containers[0];
    expect(container.readinessProbe.httpGet).toBeUndefined();
    expect(container.livenessProbe.httpGet).toBeUndefined();
    expect(container.readinessProbe.exec.command.join(" ")).toContain("/health");
    expect(container.livenessProbe.exec.command).toEqual(container.readinessProbe.exec.command);
    expect(container.readinessProbe.timeoutSeconds).toBe(3);
    expect(container.livenessProbe.timeoutSeconds).toBe(3);
    // The startup gate has to speak the same dialect, or it is the one probe kubelet
    // cannot run through the NetworkPolicy and the box never starts at all.
    expect(container.startupProbe.httpGet).toBeUndefined();
    expect(container.startupProbe.exec.command).toEqual(container.readinessProbe.exec.command);
  });

  it("gates a box's probes on a startup probe, so coming up is not reported as unhealthy", async () => {
    // Readiness used to open fire 2s in, against a process still fetching settings — and,
    // because instance names are reused, sometimes against a pod with no IP yet. Every
    // rolled box published Warning events on the way up while nothing was wrong.
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);
    readPodImpl.fn = async () => { throw Object.assign(new Error("nf"), { code: 404 }); };

    await s.spawn({ agentId: "probe-gate" }).catch(() => {});
    const container = calls.createNamespacedPod[0].body.spec.containers[0];
    expect(container.startupProbe.httpGet).toMatchObject({ path: "/health", scheme: "HTTPS" });
    // Assert the RELATION, not the number, so the emitted window cannot drift from the one
    // the module exports. (It was a literal 60, justified by a comment claiming the manager
    // waits the same 60s before calling a box crashed — it does not; `exitedUnexpectedly` is
    // pod phase `Failed`. Raising the window after a production outage surfaced the claim.)
    expect(container.startupProbe.periodSeconds! * container.startupProbe.failureThreshold! * 1000)
      .toBe(STARTUP_PROBE_WINDOW_MS);
    expect(container.startupProbe.initialDelaySeconds).toBeUndefined();
  });

  it("refuses to forward secret-shaped names through the prefix glob (ops knobs only)", async () => {
    process.env.KBC_PK_MODE = "off";                       // knob → forwarded
    process.env.KBC_MODEL_PROXY_TOKEN = "sk-parked";       // secret-shaped → refused
    process.env.KBC_WEBHOOK_SECRET = "hush";               // secret-shaped → refused
    process.env.KBC_SIGNING_API_KEY = "k";                 // secret-shaped → refused

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      // reads 1 (legacy agentbox-name probe) + 2 (new kbc-box name) both absent → create.
      if (reads <= 2) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.22", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    try {
      await s.spawn({ agentId: "kbrun2", profile: "kb-compile" });
      const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
      expect(env).toContainEqual({ name: "KBC_PK_MODE", value: "off" });
      for (const leaked of ["KBC_MODEL_PROXY_TOKEN", "KBC_WEBHOOK_SECRET", "KBC_SIGNING_API_KEY"]) {
        expect(env.some((e: any) => e.name === leaked)).toBe(false);
      }
    } finally {
      delete process.env.KBC_PK_MODE;
      delete process.env.KBC_MODEL_PROXY_TOKEN;
      delete process.env.KBC_WEBHOOK_SECRET;
      delete process.env.KBC_SIGNING_API_KEY;
    }
  });

  it("forwards SICLAW_TRACING_ENVIRONMENT from the runtime into the pod (allowlist)", async () => {
    process.env.SICLAW_TRACING_ENVIRONMENT = "prod";

    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.13", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    try {
      await s.spawn({ agentId: "default" });
      const env = calls.createNamespacedPod[0].body.spec.containers[0].env;
      expect(env).toContainEqual({ name: "SICLAW_TRACING_ENVIRONMENT", value: "prod" });
    } finally {
      delete process.env.SICLAW_TRACING_ENVIRONMENT;
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

describe("K8sSpawner — pod-name prefix (compile boxes vs chat) + upgrade migration", () => {
  // First read of any given pod name → 404 (absent), subsequent reads → Running.
  // Keyed per-name so a legacy lookup and a fresh spawn can interleave.
  function perNameFirst404ThenRunning(podIP = "10.0.0.30") {
    const seen = new Map<string, number>();
    return async (args: any) => {
      const n = (seen.get(args.name) ?? 0) + 1;
      seen.set(args.name, n);
      if (n === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP, conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
  }

  it("names compile pods with the kbc-box prefix while chat pods keep agentbox", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    readPodImpl.fn = perNameFirst404ThenRunning();

    await s.spawn({ agentId: "chatty" });
    await s.spawn({ agentId: "kbrun", profile: "kb-compile" });

    const bodies = calls.createNamespacedPod.map((c: any) => c.body);
    const names = bodies.map((b: any) => b.metadata.name);
    expect(names).toContain("agentbox-chatty-0");
    expect(names).toContain("kbc-box-kbrun-0");
    // Resources derived from the pod name follow the prefix.
    const compilePod = bodies.find((b: any) => b.metadata.name === "kbc-box-kbrun-0");
    expect(compilePod.spec.hostname).toBe("kbc-box-kbrun-0");
    const secretNames = calls.createNamespacedSecret.map((c: any) => c.body.metadata.name);
    expect(secretNames).toContain("kbc-box-kbrun-cert");
  });

  it("reaps the legacy agentbox-named compile pod (+ its cert Secret) when spawning under kbc-box", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    let legacyDeleted = false;
    deletePodImpl.fn = async (args: any) => {
      if (args.name === "agentbox-migrated") legacyDeleted = true;
      return {};
    };
    const newName = perNameFirst404ThenRunning();
    readPodImpl.fn = async (args: any) => {
      if (args.name === "agentbox-migrated") {
        if (legacyDeleted) throw Object.assign(new Error("nf"), { code: 404 }); // waitForPodDeleted sees it gone
        return {
          status: { phase: "Running", podIP: "10.0.0.31", conditions: [{ type: "Ready", status: "True" }] },
          metadata: { labels: { "siclaw.io/boxType": "kb-compile" } },
        };
      }
      return newName(args);
    };

    await s.spawn({ agentId: "migrated", profile: "kb-compile" });

    expect(calls.deleteNamespacedPod.some((c: any) => c.name === "agentbox-migrated")).toBe(true);
    // The legacy pod's Secret is left to the sweep — stop() no longer owns Secret lifetime.
    expect(calls.deleteNamespacedSecret).toHaveLength(0);
    // The new box is created under the renamed prefix, not the old one.
    expect(calls.createNamespacedPod.map((c: any) => c.body.metadata.name)).toEqual(["kbc-box-migrated-0"]);
  });

  it("never reaps a legacy agentbox-named CHAT pod that happens to share the agentId", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);

    const newName = perNameFirst404ThenRunning();
    readPodImpl.fn = async (args: any) => {
      if (args.name === "agentbox-shared") {
        // A chat box under this name owns its own idle-destruct lifecycle.
        return {
          status: { phase: "Running", podIP: "10.0.0.32", conditions: [{ type: "Ready", status: "True" }] },
          metadata: { labels: { "siclaw.io/boxType": "agent" } },
        };
      }
      return newName(args);
    };

    await s.spawn({ agentId: "shared", profile: "kb-compile" });

    expect(calls.deleteNamespacedPod.some((c: any) => c.name === "agentbox-shared")).toBe(false);
    expect(calls.createNamespacedPod.map((c: any) => c.body.metadata.name)).toEqual(["kbc-box-shared-0"]);
  });
});

describe("K8sSpawner — stop", () => {
  it("deletes the pod and leaves the cert Secret to the sweep", async () => {
    // The Secret belongs to the AGENT, not this pod, so stopping one box says nothing
    // about whether it is still in use — and any sibling check here is a point-in-time
    // read that races a replacement's spawn, which creates the Secret BEFORE its pod.
    // Deleting it then would strand the new pod in ContainerCreating forever.
    const s = new K8sSpawner();
    await s.stop("agentbox-default-0");
    expect(calls.deleteNamespacedPod).toHaveLength(1);
    expect(calls.deleteNamespacedPod[0].name).toBe("agentbox-default-0");
    expect(calls.deleteNamespacedSecret).toHaveLength(0);
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
        metadata: { name: "agentbox-default-0", labels: {} },
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
        metadata: { name: "agentbox-default-0", labels: {} },
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

describe("K8sSpawner — capability-box orphan sweep + burstable resources (audit batch B)", () => {
  const g = globalThis as any;
  const mkPod = (name: string, boxType: string, phase: string) => ({
    metadata: { name, labels: { "siclaw.io/app": "agentbox", "siclaw.io/boxType": boxType } },
    status: { phase },
  });

  it("sweep removes terminal + run-dead capability pods and orphaned Secrets; never touches chat boxes or live runs", async () => {
    g.__k8sImpls.listNamespacedPod = async () => ({
      items: [
        mkPod("agentbox-live-run", "kb-compile", "Running"),   // run live → keep
        mkPod("agentbox-dead-run", "kb-compile", "Running"),   // pod alive, run ended → the NORMAL-completion leak shape
        mkPod("agentbox-done-run", "kb-test", "Succeeded"),    // terminal phase
        mkPod("agentbox-chat-1", "agent", "Running"),          // chat box: own lifecycle, never ours
      ],
    });
    const oldTs = new Date(Date.now() - 3600_000).toISOString();
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [
        { metadata: { name: "agentbox-live-run-cert", creationTimestamp: oldTs, labels: { "siclaw.io/boxType": "kb-compile" } } },
        // Secrets of pods this sweep is about to remove. stop() no longer deletes them, so
        // the Secret pass must collect them — and must not be fooled by the pre-sweep pod
        // snapshot, which still lists their (now deleted) pods.
        { metadata: { name: "agentbox-dead-run-cert", creationTimestamp: oldTs, labels: { "siclaw.io/boxType": "kb-compile" } } },
        { metadata: { name: "agentbox-done-run-cert", creationTimestamp: oldTs, labels: { "siclaw.io/boxType": "kb-test" } } },
        { metadata: { name: "agentbox-ghost-cert", creationTimestamp: oldTs, labels: { "siclaw.io/boxType": "kb-compile" } } }, // no pod at all → orphan
        { metadata: { name: "agentbox-chat-gone-cert", creationTimestamp: oldTs, labels: { "siclaw.io/boxType": "agent" } } },  // chat box that no longer exists → orphan
        { metadata: { name: "agentbox-fresh-cert", creationTimestamp: new Date().toISOString(), labels: { "siclaw.io/boxType": "kb-compile" } } }, // just spawning (Secret precedes pod): TOCTOU guard
      ],
    });
    const s = new K8sSpawner();
    // async oracle (the production oracle is store-backed and async)
    await (s as any).sweepOrphans(async (boxId: string) => boxId === "agentbox-live-run");

    const deletedPods = g.__k8sCalls.deleteNamespacedPod.map((c: any) => c.name);
    expect(deletedPods).toEqual(expect.arrayContaining(["agentbox-dead-run", "agentbox-done-run"]));
    expect(deletedPods).not.toContain("agentbox-live-run");
    expect(deletedPods).not.toContain("agentbox-chat-1");
    const deletedSecrets = g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name);
    expect(deletedSecrets).toEqual(expect.arrayContaining(["agentbox-dead-run-cert", "agentbox-done-run-cert", "agentbox-ghost-cert"]));
    expect(deletedSecrets).not.toContain("agentbox-live-run-cert");
    expect(deletedSecrets).not.toContain("agentbox-chat-1-cert"); // its box is running
    expect(deletedSecrets).toContain("agentbox-chat-gone-cert");  // its box is gone; nothing else collects it
    expect(deletedSecrets).not.toContain("agentbox-fresh-cert");  // Secret-before-pod TOCTOU guarded by age
  });

  it("sweep reaps a TERMINAL chat box but never a running one", async () => {
    // restartPolicy:Never + the clean exit idle self-destruct performs leaves the
    // pod Succeeded forever. A running one belongs to that self-destruct, and the
    // isLive oracle only speaks for capability runs — so it is never consulted here.
    let oracleCalls = 0;
    g.__k8sImpls.listNamespacedPod = async () => ({
      items: [
        mkPod("agentbox-chat-running", "agent", "Running"),
        mkPod("agentbox-chat-done", "agent", "Succeeded"),
        mkPod("agentbox-chat-crashed", "agent", "Failed"),
      ],
    });
    g.__k8sImpls.listNamespacedSecret = async () => ({ items: [] });
    const s = new K8sSpawner();
    await (s as any).sweepOrphans(async () => { oracleCalls++; return false; });

    const deletedPods = g.__k8sCalls.deleteNamespacedPod.map((c: any) => c.name);
    expect(deletedPods).toEqual(expect.arrayContaining(["agentbox-chat-done", "agentbox-chat-crashed"]));
    expect(deletedPods).not.toContain("agentbox-chat-running");
    expect(oracleCalls).toBe(0);
  });

  it("collects a cert Secret predating the boxType label once its pod is gone", async () => {
    // The oldest orphans in a long-lived namespace carry no boxType label at all.
    // Reading a missing label as "agent" (as the pod pass does) is what lets them
    // be collected instead of pinned forever; the list is already scoped to
    // app=agentbox, and a fresh certificate is minted on the next spawn.
    g.__k8sImpls.listNamespacedPod = async () => ({ items: [] });
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [
        { metadata: { name: "agentbox-ancient-cert", creationTimestamp: new Date(Date.now() - 99 * 86400_000).toISOString(), labels: {} } },
      ],
    });
    const s = new K8sSpawner();
    await (s as any).sweepOrphans(async () => false);
    expect(g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name)).toContain("agentbox-ancient-cert");
  });

  it("sweep hands the oracle the RAW run id from the pod's agent label (non-UUID ids survive)", async () => {
    // podName() would have lowercased/sanitized this id — a prefix-strip of the
    // pod name can never recover it, and a mis-keyed oracle reaps a LIVE box.
    const rawId = "Adopted_Run.7";
    g.__k8sImpls.listNamespacedPod = async () => ({
      items: [
        {
          metadata: {
            name: "agentbox-adopted-run-7",
            labels: { "siclaw.io/app": "agentbox", "siclaw.io/boxType": "kb-compile", "siclaw.io/agent": rawId },
          },
          status: { phase: "Running" },
        },
        mkPod("agentbox-labelless", "kb-compile", "Running"), // legacy debris: falls back to the pod name
      ],
    });
    g.__k8sImpls.listNamespacedSecret = async () => ({ items: [] });
    const seen: string[] = [];
    const s = new K8sSpawner();
    await (s as any).sweepOrphans(async (ref: string) => { seen.push(ref); return ref === rawId; });
    expect(seen).toEqual(expect.arrayContaining([rawId, "agentbox-labelless"]));
    const deletedPods = g.__k8sCalls.deleteNamespacedPod.map((c: any) => c.name);
    expect(deletedPods).not.toContain("agentbox-adopted-run-7"); // live by RAW id → kept
    expect(deletedPods).toContain("agentbox-labelless");
  });

  it("Secret age guard treats a missing creationTimestamp as young, not ancient", async () => {
    g.__k8sImpls.listNamespacedPod = async () => ({ items: [] });
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [
        { metadata: { name: "agentbox-no-ts-cert", labels: { "siclaw.io/boxType": "kb-compile" } } }, // no creationTimestamp
      ],
    });
    const s = new K8sSpawner();
    await (s as any).sweepOrphans(async () => false);
    const deletedSecrets = g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name);
    expect(deletedSecrets).not.toContain("agentbox-no-ts-cert"); // TOCTOU guard NOT bypassed
  });

  it("clamps a request above the (default) limit instead of shipping an API-rejected pod", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    await s.spawn({ agentId: "clamp-test", profile: "agent", resources: { memoryRequest: "16Gi", cpuRequest: "4" } } as any);
    const created = g.__k8sCalls.createNamespacedPod.at(-1);
    const res = created.body.spec.containers[0].resources;
    expect(res.requests.memory).toBe("8Gi"); // clamped to the default limit
    expect(res.requests.cpu).toBe("2000m");  // clamped to the default limit
    expect(res.limits.memory).toBe("8Gi");
  });

  it("parseK8sQuantity + clampRequestToLimit cover the profile shapes", () => {
    expect(parseK8sQuantity("500m")).toBeCloseTo(0.5);
    expect(parseK8sQuantity("2")).toBe(2);
    expect(parseK8sQuantity("1Gi")).toBe(2 ** 30);
    expect(parseK8sQuantity("256Mi")).toBe(256 * 2 ** 20);
    expect(Number.isNaN(parseK8sQuantity("weird"))).toBe(true);
    expect(clampRequestToLimit("1Gi", "4Gi", "p", "memory")).toBe("1Gi");
    expect(clampRequestToLimit("8Gi", "4Gi", "p", "memory")).toBe("4Gi");
    expect(clampRequestToLimit("junk", "4Gi", "p", "memory")).toBe("junk"); // API server stays the authority
  });

  it("memoryRequest splits the request from the limit (burstable compile shape)", async () => {
    const cm = new FakeCertManager();
    const s = new K8sSpawner();
    s.setCertManager(cm as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      // reads 1 (legacy agentbox-name probe) + 2 (new kbc-box name) both absent → create.
      if (reads <= 2) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    process.env.SICLAW_COMPILE_BOX_IMAGE = "siclaw-kbc-box:test";
    try {
      await s.spawn({ agentId: "res-test", profile: "kb-compile" });
    } finally {
      delete process.env.SICLAW_COMPILE_BOX_IMAGE;
    }
    const created = g.__k8sCalls.createNamespacedPod.at(-1);
    const res = created.body.spec.containers[0].resources;
    expect(res.requests.memory).toBe("1Gi");
    expect(res.limits.memory).toBe("8Gi");   // limit stays at the default
    expect(res.requests.cpu).toBe("100m");
  });
});

describe("K8sSpawner — replica identity and the shared certificate", () => {
  const g = globalThis as any;

  /** Spawn once, returning the created PodSpec. */
  async function spawnOnce(config: any) {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    const handle = await s.spawn(config);
    return { handle, created: g.__k8sCalls.createNamespacedPod.at(-1) };
  }

  it("leaves instance 0 unsuffixed so no existing pod is renamed", async () => {
    const { handle, created } = await spawnOnce({ agentId: "agent-x", profile: "agent" });
    expect(created.body.metadata.name).toBe("agentbox-agent-x-0");
    expect(handle.boxId).toBe("agentbox-agent-x-0");
    expect(created.body.metadata.labels["siclaw.io/instance"]).toBe("0");
  });

  it("suffixes replicas above 0 and records the index in a label", async () => {
    const { created } = await spawnOnce({ agentId: "agent-x", profile: "agent", instance: 2 });
    expect(created.body.metadata.name).toBe("agentbox-agent-x-2");
    // The label is the record; nothing parses the index back out of the name.
    expect(created.body.metadata.labels["siclaw.io/instance"]).toBe("2");
  });

  it("names the cert Secret after the agent, not the replica, so all boxes share one", async () => {
    await spawnOnce({ agentId: "agent-x", profile: "agent", instance: 3 });
    const secret = g.__k8sCalls.createNamespacedSecret.at(-1);
    expect(secret.body.metadata.name).toBe("agentbox-agent-x-cert");
  });

  it("tells the box which pod it is, via the downward API", async () => {
    // Sibling replicas present the same certificate, so the box has to name itself for
    // its per-box metrics to stay distinct.
    const { created } = await spawnOnce({ agentId: "agent-x", profile: "agent" });
    const podNameEnv = created.body.spec.containers[0].env.find((e: any) => e.name === "SICLAW_POD_NAME");
    expect(podNameEnv?.valueFrom?.fieldRef?.fieldPath).toBe("metadata.name");
  });

  it("stopping one replica never touches the certificate its siblings mount", async () => {
    const s = new K8sSpawner();
    await s.stop("agentbox-agent-x-1");
    expect(g.__k8sCalls.deleteNamespacedPod.map((c: any) => c.name)).toContain("agentbox-agent-x-1");
    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(0);
  });

  it("refuses to reuse or replace a pod belonging to a DIFFERENT agent", async () => {
    // podName() sanitizes and truncates, so distinct agentIds can collide — and the
    // instance suffix adds the pair X / X-<n>: agent "foo" instance 1 and agent "foo-1"
    // instance 0 are both `agentbox-foo-1`. Reusing it would serve one agent's sessions
    // from a box holding the other's certificate and PVC subPath.
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    g.__k8sImpls.readNamespacedPod = async () => ({
      status: { phase: "Running", podIP: "10.0.0.9" },
      metadata: { labels: { "siclaw.io/agent": "foo-1", "siclaw.io/boxType": "agent", "siclaw.io/ca-fp": FAKE_CA_FP } },
    });
    await expect(s.spawn({ agentId: "foo", profile: "agent", instance: 1 } as any)).rejects.toThrow(/collision/i);
    // Loudly, not destructively — that is someone else's live box.
    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(0);
  });
});

describe("K8sSpawner — concurrent replica spawns share one certificate Secret", () => {
  const g = globalThis as any;

  it("reuses an existing Secret signed by the current CA instead of replacing it", async () => {
    // Two replicas of one agent spawn at the same time and both reach the 409 branch.
    // Replacing would delete a certificate the sibling pod is already mounting — observed
    // in a live cluster as a 404 on the second delete, with the spawn then failing.
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    g.__k8sImpls.createNamespacedSecret = async () => { throw Object.assign(new Error("exists"), { code: 409 }); };
    g.__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP } } });

    await s.spawn({ agentId: "agent-x", profile: "agent", instance: 1 } as any);

    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(0);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(1); // spawn still completes
  });

  it("still replaces the Secret when the CA has rotated", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    let creates = 0;
    g.__k8sImpls.createNamespacedSecret = async () => {
      creates++;
      if (creates === 1) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    };
    g.__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: { "siclaw.io/ca-fp": "an-older-ca" } } });

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);
    expect(g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name)).toEqual(["agentbox-agent-x-cert"]);
  });

  it("tolerates a sibling winning the replace race", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    g.__k8sImpls.createNamespacedSecret = async () => { throw Object.assign(new Error("exists"), { code: 409 }); };
    g.__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: { "siclaw.io/ca-fp": "an-older-ca" } } });
    g.__k8sImpls.deleteNamespacedSecret = async () => { throw Object.assign(new Error("nf"), { code: 404 }); };

    // Neither the 404 on delete nor the 409 on re-create may fail the spawn.
    await expect(s.spawn({ agentId: "agent-x", profile: "agent" } as any)).resolves.toBeTruthy();
  });
});

describe("K8sSpawner — a cert Secret is stale when the LEAF expires, not only when the CA rotates", () => {
  const g = globalThis as any;

  /** A cert manager whose issued certificate is a real PEM with a chosen expiry. */
  class PemCertManager extends FakeCertManager {
    constructor(private readonly notAfter: Date) { super(); }
    override issueAgentBoxCertificate(...args: any[]) {
      this.issuedCalls.push(args);
      return { cert: pemValidUntil(this.notAfter), key: "KEY", ca: "CA" };
    }
  }

  function newPodThenRunning() {
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };
  }

  function existingSecret(caFp: string, leafNotAfter: Date) {
    g.__k8sImpls.createNamespacedSecret = async () => { throw Object.assign(new Error("exists"), { code: 409 }); };
    g.__k8sImpls.readNamespacedSecret = async () => ({
      metadata: { labels: { "siclaw.io/ca-fp": caFp } },
      data: { "tls.crt": Buffer.from(pemValidUntil(leafNotAfter)).toString("base64") },
    });
  }

  /**
   * 🔴 The bug this whole area exists for. A fresh certificate is minted on every spawn,
   * but the 409 branch used to discard it whenever the CA still matched — so the Secret was
   * written once and never again, and past its 30-day lifetime every box of the agent failed
   * mTLS in both directions while recreating the pod changed nothing.
   */
  it("replaces a Secret whose certificate is near expiry even though the CA still matches", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new PemCertManager(daysFromNow(30)) as any);
    newPodThenRunning();
    let creates = 0;
    g.__k8sImpls.createNamespacedSecret = async () => {
      creates++;
      if (creates === 1) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    };
    g.__k8sImpls.readNamespacedSecret = async () => ({
      metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP } },
      data: { "tls.crt": Buffer.from(pemValidUntil(daysFromNow(2))).toString("base64") },
    });

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    expect(g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name)).toEqual(["agentbox-agent-x-cert"]);
  });

  it("still reuses a Secret whose certificate has plenty of life left", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new PemCertManager(daysFromNow(30)) as any);
    newPodThenRunning();
    existingSecret(FAKE_CA_FP, daysFromNow(25));

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(0);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(1);
  });

  /**
   * 🔴 An UNPARSEABLE certificate must NOT trigger a replace, even though an unreadable
   * SECRET does. The two look similar and are not:
   *
   *  - Secret cannot be read at all ⇒ nothing is known, replace (pre-existing contract).
   *  - Secret reads fine, its certificate does not parse ⇒ leave it alone.
   *
   * Replacing on a parse failure makes every blind spot in the parser a Secret-replacement
   * storm: the Secret is per-agent, so each spawn would delete and recreate a certificate
   * its siblings are mounting, forever, for a certificate that may well be valid. A
   * genuinely corrupt certificate does not need this path — the pod fails to start, the
   * spawn fails, and the retry cooldown bounds it.
   */
  it("leaves a Secret alone when its certificate cannot be parsed", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new PemCertManager(daysFromNow(30)) as any);
    newPodThenRunning();
    g.__k8sImpls.createNamespacedSecret = async () => { throw Object.assign(new Error("exists"), { code: 409 }); };
    g.__k8sImpls.readNamespacedSecret = async () => ({
      metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP } },
      data: { "tls.crt": Buffer.from("not a certificate").toString("base64") },
    });

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(0);
  });

  it("replaces the Secret when it cannot be read at all", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new PemCertManager(daysFromNow(30)) as any);
    newPodThenRunning();
    let creates = 0;
    g.__k8sImpls.createNamespacedSecret = async () => {
      creates++;
      if (creates === 1) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    };
    g.__k8sImpls.readNamespacedSecret = async () => { throw Object.assign(new Error("boom"), { code: 500 }); };

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(1);
  });

  it("stamps the pod with the expiry of the certificate it actually mounts", async () => {
    // The REUSED Secret's expiry, not the freshly minted certificate's — the pod mounts the
    // former. Getting this backwards would tell the manager a dying box is fine.
    const s = new K8sSpawner();
    s.setCertManager(new PemCertManager(daysFromNow(30)) as any);
    newPodThenRunning();
    const reused = daysFromNow(25);
    existingSecret(FAKE_CA_FP, reused);

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    const labels = g.__k8sCalls.createNamespacedPod[0].body.metadata.labels;
    expect(labels["siclaw.io/cert-exp"]).toBe(String(Math.floor(reused.getTime() / 1000)));
  });

  it("omits the expiry label when the expiry is unknown, rather than guessing one", async () => {
    // FakeCertManager's "CERT" is not a PEM. An ABSENT label reads as "no answer" and the
    // manager treats it as fresh; a wrong label would recycle a healthy box.
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    newPodThenRunning();

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    const labels = g.__k8sCalls.createNamespacedPod[0].body.metadata.labels;
    expect(labels).not.toHaveProperty("siclaw.io/cert-exp");
  });

  it("recycles a RUNNING pod whose stamped certificate is near expiry", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new PemCertManager(daysFromNow(30)) as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      // First read: the live pod, current CA but a certificate about to die.
      if (reads === 1) {
        return {
          status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
          metadata: {
            labels: {
              "siclaw.io/agent": "agent-x",
              "siclaw.io/ca-fp": FAKE_CA_FP,
              "siclaw.io/cert-exp": String(Math.floor(daysFromNow(1).getTime() / 1000)),
              "siclaw.io/boxType": "agent",
            },
          },
        };
      }
      // After the delete: gone, then the replacement comes up.
      if (reads === 2) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(1);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(1);
  });

  it("keeps reusing a RUNNING pod that carries no expiry label at all", async () => {
    // Pods created before the label existed. Reading a missing label as stale is exactly how
    // an earlier version of the CA check drained every box on sight.
    const s = new K8sSpawner();
    s.setCertManager(new PemCertManager(daysFromNow(30)) as any);
    g.__k8sImpls.readNamespacedPod = async () => ({
      status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
      metadata: {
        labels: { "siclaw.io/agent": "agent-x", "siclaw.io/ca-fp": FAKE_CA_FP, "siclaw.io/boxType": "agent" },
      },
    });

    const handle = await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    expect(handle.endpoint).toBe("https://10.0.0.9:3000");
    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(0);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(0);
  });
});

describe("K8sSpawner — get() and the listings must report the SAME shape", () => {
  const g = globalThis as any;

  /**
   * 🔴 ONE MAPPER, and this is the test that enforces it rather than the comment saying so.
   *
   * Two projections of a pod have now caused the same class of bug twice. First list()
   * omitted the CA fingerprint, so the reaper read every fresh box as signed by a CA it no
   * longer trusted and replaced it — a spawn loop. Then get() omitted the certificate
   * expiry, so the SINGLE-BOX acquisition path (getOrCreateK8s reads through get()) saw
   * "unknown", read that as usable, and kept handing out an endpoint mTLS could not
   * complete — making the certificate fix inert for every one-box agent.
   *
   * Comparing KEY SETS rather than named fields is deliberate: a test that lists the fields
   * it knows about cannot fail for the field somebody forgets next.
   */
  const podWithEverything = (name: string) => ({
    metadata: {
      name,
      creationTimestamp: new Date("2026-09-01T00:00:00Z"),
      labels: {
        "siclaw.io/app": "agentbox",
        "siclaw.io/agent": "agent-x",
        "siclaw.io/ca-fp": FAKE_CA_FP,
        "siclaw.io/cert-exp": String(Math.floor(daysFromNow(20).getTime() / 1000)),
        "siclaw.io/boxType": "agent",
        "siclaw.io/instance": "0",
      },
    },
    status: { phase: "Running", podIP: "10.0.0.5", conditions: [{ type: "Ready", status: "True" }] },
    spec: { containers: [{ image: "img:v1" }] },
  });

  it("reports the certificate expiry through get(), not only through the listings", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    g.__k8sImpls.readNamespacedPod = async () => podWithEverything("agentbox-agent-x-0");

    const info = await s.get("agentbox-agent-x-0");

    expect(info?.certExpiresAt).toBeInstanceOf(Date);
    expect(info?.caFingerprint).toBe(FAKE_CA_FP);
  });

  it("returns the same fields from get() as from listForAgent()", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    const pod = podWithEverything("agentbox-agent-x-0");
    g.__k8sImpls.readNamespacedPod = async () => pod;
    g.__k8sImpls.listNamespacedPod = async () => ({ items: [pod] });

    const viaGet = await s.get("agentbox-agent-x-0");
    const [viaList] = await s.listForAgent("agent-x");

    expect(Object.keys(viaGet ?? {}).sort()).toEqual(Object.keys(viaList ?? {}).sort());
  });

  it("keeps get() answering about the name it was asked for", async () => {
    // The pod's own metadata.name is authoritative for the listings; a lookup by name must
    // still describe the name the caller used.
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    g.__k8sImpls.readNamespacedPod = async () => podWithEverything("something-else");

    const info = await s.get("agentbox-agent-x-0");

    expect(info?.boxId).toBe("agentbox-agent-x-0");
  });
});

describe("K8sSpawner — an explicit rebuild request", () => {
  const g = globalThis as any;

  const healthyPending = (name: string) => ({
    metadata: {
      name,
      creationTimestamp: new Date(),
      labels: {
        "siclaw.io/agent": "agent-x",
        "siclaw.io/ca-fp": FAKE_CA_FP,
        "siclaw.io/cert-exp": String(Math.floor(daysFromNow(25).getTime() / 1000)),
        "siclaw.io/boxType": "agent",
        "siclaw.io/instance": "0",
      },
    },
    // Pending with a perfectly good certificate: every check the spawner makes passes.
    status: { phase: "Pending" },
  });

  /**
   * 🔴 Classification alone changes NOTHING. A Pending pod that will never be scheduled has
   * a fine phase, a fine profile and a fine certificate, so the reuse branch hands it back
   * and waits POD_READY_TIMEOUT_MS again. The manager calling such a slot "rebuildable" and
   * spending drain budget on it therefore achieved nothing at all — same stuck pod, once per
   * request, with the fuse draining. The intent has to reach the spawner.
   */
  it("reuses a healthy Pending pod when no rebuild was asked for", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) return healthyPending("agentbox-agent-x-0");
      return {
        status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };

    await s.spawn({ agentId: "agent-x", profile: "agent" } as any);

    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(0);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(0); // reused, as before
  });

  it("deletes and recreates that same pod when the caller asks for a rebuild", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) return healthyPending("agentbox-agent-x-0");
      if (reads === 2) throw Object.assign(new Error("nf"), { code: 404 }); // gone after delete
      return {
        status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };

    await s.spawn({ agentId: "agent-x", profile: "agent", recreate: true } as any);

    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(1);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(1);
  });

  /**
   * 🔴 A pod with NO phase yet. The manager maps that to `error` and therefore asks for a
   * rebuild — but while the rebuild was handled inside the Running/Pending arm, such a pod
   * matched neither arm, fell through to create, hit 409, and the original pod was reused.
   * Budget spent, nothing rebuilt. The caller's decision cannot depend on which phase the
   * pod happens to report.
   */
  it("honours a rebuild for a pod that reports no phase at all", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) {
        return {
          metadata: {
            name: "agentbox-agent-x-0",
            creationTimestamp: new Date(),
            labels: { "siclaw.io/agent": "agent-x", "siclaw.io/ca-fp": FAKE_CA_FP, "siclaw.io/boxType": "agent" },
          },
          status: {}, // no phase
        };
      }
      if (reads === 2) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };

    await s.spawn({ agentId: "agent-x", profile: "agent", recreate: true } as any);

    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(1);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(1);
  });

  it("names the caller's request as the reason, so a log reader can tell it apart", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: any) => { logs.push(String(m)); });
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) return healthyPending("agentbox-agent-x-0");
      if (reads === 2) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };

    await s.spawn({ agentId: "agent-x", profile: "agent", recreate: true } as any);

    // Not "unusable certificate" — that would send the reader looking at the wrong thing.
    expect(logs.some((l) => /caller asked for a rebuild/.test(l))).toBe(true);
  });
});

describe("K8sSpawner — waitForPodReady", () => {
  const g = globalThis as any;

  /**
   * 🔴 A pod recycled by a concurrent spawn of the same slot used to surface as a raw
   * @kubernetes/client-node ApiException — HTTP headers, audit ids and all — as the reason a
   * box could not be created. The fact is simple and belongs in the message.
   */
  it("reports a pod that vanished mid-wait as exactly that", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 }); // pre-create check
      // The readiness wait then finds it gone.
      throw Object.assign(new Error("pods \"x\" not found"), { code: 404 });
    };

    await expect(s.spawn({ agentId: "agent-x", profile: "agent" } as any))
      .rejects.toThrow(/disappeared while waiting for it to become ready/);
  });

  it("propagates a non-404 API error untouched", async () => {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      throw Object.assign(new Error("forbidden"), { code: 403 });
    };

    await expect(s.spawn({ agentId: "agent-x", profile: "agent" } as any)).rejects.toThrow(/forbidden/);
  });
});

describe("K8sSpawner — spreading a pool over nodes", () => {
  it("asks the scheduler to keep an agent's boxes apart, as a preference", async () => {
    // Preferred, never required: a cluster with one eligible node — a nodeSelector that
    // admits one, say — must still be able to place the pod. Spreading is worth a lot
    // when it succeeds; refusing to schedule would cost everything.
    const cm = new FakeCertManager();
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    s.setCertManager(cm as any);

    let reads = 0;
    readPodImpl.fn = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };

    await s.spawn({ agentId: "agent-a", instance: 1 });

    const affinity = calls.createNamespacedPod[0].body.spec.affinity.podAntiAffinity;
    expect(affinity.requiredDuringSchedulingIgnoredDuringExecution).toBeUndefined();
    const term = affinity.preferredDuringSchedulingIgnoredDuringExecution[0];
    expect(term.podAffinityTerm.topologyKey).toBe("kubernetes.io/hostname");
    expect(term.podAffinityTerm.labelSelector.matchLabels).toMatchObject({
      "siclaw.io/agent": "agent-a",
      "siclaw.io/app": "agentbox",
    });
  });
});

describe("K8sSpawner — every listing carries what staleness is judged on", () => {
  it("reports the CA fingerprint and image from list(), not only from listForAgent()", async () => {
    // list() used to return a lighter projection. That was harmless while only acquisition
    // judged staleness, and became a spawn loop the moment the reaper judged it too: a box
    // with no fingerprint reads as signed by a CA we no longer trust, so every fresh box
    // was drained on sight and replaced by one that met the same fate.
    const s = new K8sSpawner({ namespace: "siclaw-debug" });
    g.__k8sImpls.listNamespacedPod = async () => ({
      items: [{
        metadata: {
          name: "agentbox-a-0",
          labels: { "siclaw.io/app": "agentbox", "siclaw.io/agent": "a", "siclaw.io/ca-fp": "fp-1", "siclaw.io/instance": "0" },
        },
        spec: { containers: [{ image: "agentbox:v9" }] },
        status: { phase: "Running", podIP: "10.0.0.1", conditions: [{ type: "Ready", status: "True" }] },
      }],
    });

    const [fromList] = await s.list();
    expect(fromList.caFingerprint).toBe("fp-1");
    expect(fromList.image).toBe("agentbox:v9");
    expect(fromList.instance).toBe(0);

    // One mapper, one answer. Compared without the timestamps: both are stamped at call
    // time, so they differ by however long the two calls are apart — which on a slow
    // machine is enough to fail an equality that has nothing to do with what is being
    // tested.
    const [forAgent] = await s.listForAgent("a");
    const withoutClock = ({ createdAt: _c, lastActiveAt: _l, ...rest }: AgentBoxInfo) => rest;
    expect(withoutClock(forAgent)).toEqual(withoutClock(fromList));
  });
});
