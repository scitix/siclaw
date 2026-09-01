import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    replaceNamespacedSecret: [],
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
    replaceNamespacedSecret: async () => ({}),
    deleteNamespacedSecret: async () => ({}),
    listNamespacedPod: async () => ({ items: [] }),
    listNamespacedSecret: async () => ({ items: [] }),
    deleteCollectionNamespacedPod: async () => ({}),
    deleteCollectionNamespacedSecret: async () => ({}),
  };

  // Pristine copy for resetCalls() to restore between tests.
  g.__k8sImplDefaults = { ...g.__k8sImpls };

  class FakeCoreV1Api {
    async readNamespacedPod(args: any) { g.__k8sCalls.readNamespacedPod.push(args); return g.__k8sImpls.readNamespacedPod(args); }
    async deleteNamespacedPod(args: any) { g.__k8sCalls.deleteNamespacedPod.push(args); return g.__k8sImpls.deleteNamespacedPod(args); }
    async createNamespacedPod(args: any) { g.__k8sCalls.createNamespacedPod.push(args); return g.__k8sImpls.createNamespacedPod(args); }
    async createNamespacedSecret(args: any) { g.__k8sCalls.createNamespacedSecret.push(args); return g.__k8sImpls.createNamespacedSecret(args); }
    async readNamespacedSecret(args: any) { g.__k8sCalls.readNamespacedSecret.push(args); return g.__k8sImpls.readNamespacedSecret(args); }
    async deleteNamespacedSecret(args: any) { g.__k8sCalls.deleteNamespacedSecret.push(args); return g.__k8sImpls.deleteNamespacedSecret(args); }
    async listNamespacedPod(args: any) { g.__k8sCalls.listNamespacedPod.push(args); return g.__k8sImpls.listNamespacedPod(args); }
    async listNamespacedSecret(args: any) { g.__k8sCalls.listNamespacedSecret.push(args); return g.__k8sImpls.listNamespacedSecret(args); }
    async replaceNamespacedSecret(args: any) { g.__k8sCalls.replaceNamespacedSecret.push(args); return g.__k8sImpls.replaceNamespacedSecret(args); }
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
import { K8sSpawner, parseK8sQuantity, clampRequestToLimit } from "./k8s-spawner.js";

// ── Fake cert manager ─────────────────────────────────────────────────

const FAKE_CA_FP = "fakecafp00000000";
/**
 * The certificate stamp a FakeCertManager mints, as the Secret/pod labels carry it.
 * Pod reuse is decided on the CA plus the cert-reload CAPABILITY, never on which
 * certificate a pod started with — a running pod re-reads its own material. These
 * stamps live on the SECRET, where they drive renewal and the sweep's still-valid
 * skip.
 */
const FAKE_CERT_NB = String(Math.floor(new Date("2026-09-01T00:00:00Z").getTime() / 1000));
/** Far future, so "fresh" in a test never depends on when the suite runs. */
const FAKE_CERT_NA = String(Math.floor(new Date("2099-01-01T00:00:00Z").getTime() / 1000));
const freshSecretLabels = {
  "siclaw.io/ca-fp": FAKE_CA_FP,
  "siclaw.io/cert-nb": FAKE_CERT_NB,
  "siclaw.io/cert-na": FAKE_CERT_NA,
};

class FakeCertManager {
  issuedCalls: any[] = [];
  fp = FAKE_CA_FP;
  /** Overridable so a test can mint a certificate with a chosen lifetime. */
  issuedAt = new Date("2026-09-01T00:00:00Z");
  validityDays = 30;
  /** Distinguishable per mint, so a test can tell NEW material from recycled bytes. */
  mintCount = 0;
  issueAgentBoxCertificate(...args: any[]) {
    this.issuedCalls.push(args);
    this.mintCount++;
    // `identity` is part of the CertificateBundle contract, not decoration: spawn
    // derives the certificate VERSION (notBefore) and EXPIRY from it to decide
    // whether a stored Secret and a running pod are still usable.
    return {
      cert: `CERT-${this.mintCount}`,
      key: `KEY-${this.mintCount}`,
      ca: "CA",
      identity: {
        agentId: args[0],
        orgId: args[1],
        boxId: args[2],
        issuedAt: this.issuedAt,
        expiresAt: new Date(this.issuedAt.getTime() + this.validityDays * 86_400_000),
      },
    };
  }
  caFingerprint() { return this.fp; }
  readAssertedIdentity(pem: string) {
    // The renewal path carries the subject forward from the stored certificate; the
    // fixture encodes it in the PEM so a test can assert it survives.
    const m = /SUBJECT:([^:]*):([^:]*):([^\s]*)/.exec(pem);
    return m ? { agentId: m[1], orgId: m[2], boxId: m[3] } : undefined;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function resetCalls() {
  for (const k of Object.keys(g.__k8sCalls)) g.__k8sCalls[k].length = 0;
  // ⚠️ THE STUBS TOO, not just the call logs. Tests assign into __k8sImpls to set
  // up a scenario and nothing used to put them back, so an impl leaked into every
  // later test in file order — a suite that passes only in the order it happens to
  // be written, and that reports the leak as a failure in an unrelated test.
  g.__k8sImpls = { ...g.__k8sImplDefaults };
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
    // Suffixed because the fixture now mints distinguishable material per call — the
    // renewal tests need to tell a fresh certificate from recycled bytes.
    expect(Buffer.from(secretBody.data["tls.crt"], "base64").toString()).toBe("CERT-1");
    expect(Buffer.from(secretBody.data["tls.key"], "base64").toString()).toBe("KEY-1");
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
    // 30 x 2s: the same 60s the manager waits before calling a box crashed, so the two
    // do not disagree about when a box has failed to come up.
    expect(container.startupProbe.periodSeconds! * container.startupProbe.failureThreshold!).toBe(60);
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
      metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP, "siclaw.io/cert-reload": "1" } },
    });
    // A fresh stored Secret, so this exercises pod reuse rather than the mint path.
    (globalThis as any).__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: freshSecretLabels } });

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

  it("tolerates a sibling having already deleted the Secret it was about to replace", async () => {
    // Was "reuses an existing Secret signed by the current CA". That scenario is now
    // covered twice over — "keeps a Secret ... far from expiry" (no write attempted at
    // all) and "adopts a Secret a sibling replica renewed" (409 then re-read) — and it
    // could no longer reach the 409 branch it claimed to test, because a fresh stored
    // Secret is skipped before any write. Repointed at the one concurrent path that
    // had a comment but no test: both replicas decide to replace, and the loser's
    // delete finds the Secret already gone.
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return { status: { phase: "Running", podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] }, metadata: { labels: {} } };
    };
    // Stale on both reads, so this spawn commits to replacing.
    g.__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: { "siclaw.io/ca-fp": "an-older-ca" } } });
    let creates = 0;
    g.__k8sImpls.createNamespacedSecret = async () => {
      creates++;
      if (creates === 1) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    };
    g.__k8sImpls.deleteNamespacedSecret = async () => { throw Object.assign(new Error("gone"), { code: 404 }); };

    // A 404 on the delete is the sibling having won the race, not a failure.
    await s.spawn({ agentId: "agent-x", profile: "agent", instance: 1 } as any);

    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(1);
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

// ── Certificate expiry: renewal and the pods left behind by one ────────
//
// AgentBox certificates live 30 days while a resident pod runs indefinitely, and
// both reuse checks used to compare only the CA fingerprint — which answers who
// signed a certificate, never whether it is still valid or still the current one.
// The result was an agent that went permanently dark 30 days after its Secret was
// minted, unrecoverable without a human deleting that Secret by hand.

describe("K8sSpawner — certificate renewal", () => {
  const g = globalThis as any;
  const secondsFromNow = (days: number) => String(Math.floor((Date.now() + days * 86_400_000) / 1000));

  /**
   * A spawner whose pod reads follow the shape every successful spawn has: absent
   * first (so spawn creates one), Running afterwards (so waitForPodReady settles).
   */
  function spawnerWithCerts() {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    let reads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.0.0.8", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };
    return s;
  }

  it("keeps a Secret that is signed by the current CA and far from expiry", async () => {
    const s = spawnerWithCerts();
    g.__k8sImpls.readNamespacedSecret = async () => ({
      metadata: { labels: { ...freshSecretLabels, "siclaw.io/cert-na": secondsFromNow(20) } },
    });

    await s.spawn({ agentId: "steady" } as any);

    // Not rewritten, and — the part that used to be wrong the other way round —
    // not even attempted, so there is no 409 to mishandle.
    expect(g.__k8sCalls.createNamespacedSecret).toHaveLength(0);
    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(0);
  });

  it("replaces a Secret whose certificate is inside the renewal window", async () => {
    const s = spawnerWithCerts();
    g.__k8sImpls.readNamespacedSecret = async () => ({
      // Same CA, 3 days left: the exact state the old check called reusable and
      // that went on to expire with no path back.
      metadata: { labels: { ...freshSecretLabels, "siclaw.io/cert-na": secondsFromNow(3) } },
    });
    g.__k8sImpls.createNamespacedSecret = async () => { throw Object.assign(new Error("exists"), { code: 409 }); };

    await s.spawn({ agentId: "expiring" } as any);

    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(1);
  });

  it("replaces a Secret that predates the certificate stamps", async () => {
    const s = spawnerWithCerts();
    // Only ca-fp: every Secret in a cluster upgrading to this build. It must converge
    // on the next spawn rather than be grandfathered into the bug forever.
    g.__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: { "siclaw.io/ca-fp": FAKE_CA_FP } } });
    g.__k8sImpls.createNamespacedSecret = async () => { throw Object.assign(new Error("exists"), { code: 409 }); };

    await s.spawn({ agentId: "legacy" } as any);

    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(1);
  });

  it("stamps the Secret with the certificate's validity, and the pod with neither", async () => {
    const s = spawnerWithCerts();
    await s.spawn({ agentId: "stamped" } as any);

    const secretLabels = g.__k8sCalls.createNamespacedSecret[0].body.metadata.labels;
    expect(secretLabels["siclaw.io/cert-nb"]).toBe(FAKE_CERT_NB);
    expect(Number(secretLabels["siclaw.io/cert-na"])).toBeGreaterThan(Number(FAKE_CERT_NB));

    // The pod gets NO certificate stamp. Its certificate is whatever the mounted
    // Secret currently holds — cert-reloader.ts keeps the process level with it — so a
    // copy taken at creation would go out of date and then be believed.
    const podLabels = g.__k8sCalls.createNamespacedPod[0].body.metadata.labels;
    expect(podLabels["siclaw.io/cert-nb"]).toBeUndefined();
    expect(podLabels["siclaw.io/cert-na"]).toBeUndefined();
  });

  it("reuses a Running pod across a renewal instead of recycling it", async () => {
    // The counterpart of the P1 reloader, and the opposite of what an earlier draft
    // did. A renewal happens a week BEFORE expiry, so the pod's current certificate is
    // still valid while it picks the new one off the mounted volume. Destroying it
    // would trade a free swap for a cold start and a dropped turn.
    const s = spawnerWithCerts();
    g.__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: freshSecretLabels } });
    g.__k8sImpls.readNamespacedPod = async () => ({
      status: { phase: "Running", podIP: "10.0.0.7", conditions: [{ type: "Ready", status: "True" }] },
      metadata: { labels: { "siclaw.io/agent": "resident", "siclaw.io/ca-fp": FAKE_CA_FP, "siclaw.io/cert-reload": "1" } },
    });

    await s.spawn({ agentId: "resident" } as any);

    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(0);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(0);
  });

  it("still recycles a Running pod whose CA has rotated", async () => {
    // A rotated CA is the one case re-reading cannot fix: the Secret the pod would
    // re-read is signed by the same dead CA until it is replaced.
    const s = spawnerWithCerts();
    let podReads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      podReads++;
      if (podReads === 1) {
        return {
          status: { phase: "Running", podIP: "10.0.0.7", conditions: [{ type: "Ready", status: "True" }] },
          metadata: { labels: { "siclaw.io/agent": "rotated", "siclaw.io/ca-fp": "an-older-ca" } },
        };
      }
      if (podReads === 2) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.0.0.7", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };

    await s.spawn({ agentId: "rotated" } as any);

    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(1);
    expect(g.__k8sCalls.createNamespacedPod).toHaveLength(1);
  });

  it("adopts a Secret a sibling replica renewed instead of renewing it again", async () => {
    // Two replicas of one agent decide to renew at the same moment. Without the
    // re-read, the loser deletes the winner's brand-new certificate and mints a
    // second one seconds later, forcing another recycle of pods that were correct.
    const s = spawnerWithCerts();
    let secretReads = 0;
    g.__k8sImpls.readNamespacedSecret = async () => {
      secretReads++;
      return secretReads === 1
        // First read: stale, so this spawn decides to renew.
        ? { metadata: { labels: { ...freshSecretLabels, "siclaw.io/cert-na": secondsFromNow(2) } } }
        // Re-read after the 409: a sibling got there first and it is fresh now.
        : { metadata: { labels: { ...freshSecretLabels, "siclaw.io/cert-nb": "1893456000", "siclaw.io/cert-na": secondsFromNow(29) } } };
    };
    g.__k8sImpls.createNamespacedSecret = async () => { throw Object.assign(new Error("exists"), { code: 409 }); };

    await s.spawn({ agentId: "raced" } as any);

    // The sibling's Secret stands; this spawn's bundle is dropped rather than
    // replacing a certificate that is already current.
    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(0);
  });
});

// ── The renewal pass: the mechanism that actually keeps certificates alive ──
//
// spawn()'s freshness check is only a backstop. AgentBoxManager.getOrCreateK8s warm-
// reuses a running box without ever calling the spawner, so a resident pod — the
// normal shape for an agent with live sessions — can run the whole 30-day life of its
// certificate with the spawn path never executing. Expiry is driven by the clock, so
// renewal is too.

describe("K8sSpawner — renewExpiringCertificates", () => {
  const g = globalThis as any;
  const secondsFromNow = (days: number) => String(Math.floor((Date.now() + days * 86_400_000) / 1000));
  const pemFor = (agentId: string, orgId: string, boxId: string) => `SUBJECT:${agentId}:${orgId}:${boxId}`;

  function secretItem(name: string, agentId: string, labels: Record<string, string>, orgId = "org-7") {
    return {
      metadata: { name, labels: { "siclaw.io/app": "agentbox", "siclaw.io/agent": agentId, ...labels } },
      data: { "tls.crt": Buffer.from(pemFor(agentId, orgId, name.slice(0, -"-cert".length))).toString("base64") },
    };
  }

  function spawnerWithCerts() {
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    return s;
  }

  /** Renewal only touches agents that still have a pod, so a fixture must supply one. */
  function podsFor(...agentIds: string[]) {
    g.__k8sImpls.listNamespacedPod = async () => ({
      items: agentIds.map((a) => ({
        metadata: { name: `agentbox-${a}`, labels: { "siclaw.io/agent": a } },
        status: { phase: "Running" },
      })),
    });
  }

  it("renews a certificate inside the renewal window", async () => {
    const s = spawnerWithCerts();
    podsFor("resident");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [secretItem("agentbox-resident-cert", "resident", {
        "siclaw.io/ca-fp": FAKE_CA_FP,
        "siclaw.io/cert-nb": FAKE_CERT_NB,
        "siclaw.io/cert-na": secondsFromNow(3),
      })],
    });

    await s.renewExpiringCertificates();

    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(1);
    const body = g.__k8sCalls.replaceNamespacedSecret[0].body;
    // Replaced in place: same name, so every pod already mounting it just sees new
    // bytes at the same path. Nothing is rescheduled and nothing is deleted.
    expect(g.__k8sCalls.replaceNamespacedSecret[0].name).toBe("agentbox-resident-cert");
    expect(Number(body.metadata.labels["siclaw.io/cert-na"])).toBeGreaterThan(Number(secondsFromNow(20)));

    // 🔴 THE BYTES, not just the labels. Writing a +30d cert-na over the OLD
    // certificate is the worst outcome this code can produce and it is invisible from
    // the metadata alone: the Secret would advertise a month of validity around a
    // certificate dying in days, renewal would never look at it again, and
    // certStampIsFresh would assure spawn everything is fine — an agent that goes
    // dark and that deleting the pod cannot fix. Strictly worse than the original bug.
    const writtenCert = Buffer.from(body.data["tls.crt"], "base64").toString();
    const writtenKey = Buffer.from(body.data["tls.key"], "base64").toString();
    expect(writtenCert).toMatch(/^CERT-\d+$/);        // freshly minted, not the stored PEM
    expect(writtenCert).not.toBe(pemFor("resident", "org-7", "agentbox-resident"));
    // And the pair must belong together — a swapped cert/key fails the handshake with
    // an error naming neither.
    expect(writtenKey).toBe(writtenCert.replace("CERT-", "KEY-"));
    expect(g.__k8sCalls.deleteNamespacedSecret).toHaveLength(0);
    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(0);
  });

  it("leaves a certificate that is nowhere near expiry alone", async () => {
    const s = spawnerWithCerts();
    podsFor("fine");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [secretItem("agentbox-fine-cert", "fine", {
        "siclaw.io/ca-fp": FAKE_CA_FP,
        "siclaw.io/cert-na": secondsFromNow(20),
      })],
    });

    await s.renewExpiringCertificates();

    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(0);
  });

  it("renews one that has already lapsed", async () => {
    // The state the incident left behind. verifyCertificate refuses to speak about an
    // expired certificate, so the subject has to be read without the validity check —
    // otherwise the agents most in need of renewal are exactly the ones skipped.
    const s = spawnerWithCerts();
    podsFor("dead");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [secretItem("agentbox-dead-cert", "dead", {
        "siclaw.io/ca-fp": FAKE_CA_FP,
        "siclaw.io/cert-na": secondsFromNow(-2),
      })],
    });

    await s.renewExpiringCertificates();

    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(1);
  });

  it("carries the certificate's subject forward instead of reconstructing it", async () => {
    // The org is recorded nowhere on the Secret. Minting a renewal without it would
    // silently rewrite the identity every box of the agent presents.
    const s = spawnerWithCerts();
    const cm = new FakeCertManager();
    s.setCertManager(cm as any);
    podsFor("owned");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [secretItem("agentbox-owned-cert", "owned", {
        "siclaw.io/ca-fp": FAKE_CA_FP,
        "siclaw.io/cert-na": secondsFromNow(1),
      }, "org-org-42")],
    });

    await s.renewExpiringCertificates();

    expect(cm.issuedCalls).toHaveLength(1);
    // agentId, orgId, boxId — all three from the certificate being replaced.
    expect(cm.issuedCalls[0]).toEqual(["owned", "org-org-42", "agentbox-owned"]);
  });

  it("refuses to sign a subject that disagrees with the Secret's own label", async () => {
    // 🔴 PRIVILEGE ESCALATION. The subject is read from the Secret's DATA with no
    // signature or validity check (readAssertedIdentity says so in its own docstring),
    // and the only gate on renewal is a LABEL. Anyone able to write this Secret's data
    // — namespace Secret write, which does not require reading the CA key — could
    // plant a certificate claiming another agent's identity and have the next tick
    // sign that identity with the real CA, into a Secret they control. The label is
    // set by the spawner and is the independent witness.
    const s = spawnerWithCerts();
    const cm = new FakeCertManager();
    s.setCertManager(cm as any);
    podsFor("victim");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [{
        metadata: {
          name: "agentbox-victim-cert",
          labels: {
            "siclaw.io/app": "agentbox",
            "siclaw.io/agent": "victim",
            "siclaw.io/ca-fp": FAKE_CA_FP,
            "siclaw.io/cert-na": secondsFromNow(1),
          },
        },
        // Planted: claims a different agent and org than the Secret's label.
        data: { "tls.crt": Buffer.from("SUBJECT:attacker:evil-org:agentbox-attacker").toString("base64") },
      }],
    });

    await s.renewExpiringCertificates();

    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(0);
    // And crucially the CA was never asked to sign the planted identity.
    expect(cm.issuedCalls).toHaveLength(0);
  });

  it("does not count a finished pod as keeping its agent alive", async () => {
    // A Succeeded box holds nothing open. Renewing for it would refresh a certificate
    // about to be collected and — through the still-valid skip in sweepOrphans —
    // postpone that collection by a whole certificate lifetime.
    const s = spawnerWithCerts();
    g.__k8sImpls.listNamespacedPod = async () => ({
      items: [{ metadata: { name: "agentbox-done", labels: { "siclaw.io/agent": "done" } }, status: { phase: "Succeeded" } }],
    });
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [secretItem("agentbox-done-cert", "done", {
        "siclaw.io/ca-fp": FAKE_CA_FP,
        "siclaw.io/cert-na": secondsFromNow(1),
      })],
    });

    await s.renewExpiringCertificates();

    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(0);
  });

  it("does not touch a certificate signed by a rotated CA", async () => {
    // Replacing it here would hand a live pod material signed by a CA it cannot
    // chain. Rotation is spawn()'s job, because it also recreates the pods.
    const s = spawnerWithCerts();
    podsFor("oldca");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [secretItem("agentbox-old-ca-cert", "oldca", {
        "siclaw.io/ca-fp": "an-older-ca",
        "siclaw.io/cert-na": secondsFromNow(1),
      })],
    });

    await s.renewExpiringCertificates();

    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(0);
  });

  it("keeps going after one Secret fails to renew", async () => {
    // A conflict with a concurrent spawn must not abandon every other agent for the
    // next ten minutes.
    const s = spawnerWithCerts();
    podsFor("a", "b");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [
        secretItem("agentbox-a-cert", "a", { "siclaw.io/ca-fp": FAKE_CA_FP, "siclaw.io/cert-na": secondsFromNow(1) }),
        secretItem("agentbox-b-cert", "b", { "siclaw.io/ca-fp": FAKE_CA_FP, "siclaw.io/cert-na": secondsFromNow(1) }),
      ],
    });
    let calls = 0;
    g.__k8sImpls.replaceNamespacedSecret = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("conflict"), { code: 409 });
      return {};
    };

    await s.renewExpiringCertificates();

    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(2);
  });

  it("renews a Secret that predates the validity stamps", async () => {
    // 🔴 THE UPGRADE CASE, and the one an earlier draft got backwards by deferring it
    // to "the agent's next cold start" — which contradicts why this method exists: a
    // resident agent never cold-starts. EVERY Secret written before this build is
    // unstamped, including the one from the outage, so skipping them meant renewal
    // never looked at the pods that actually went dark.
    const s = spawnerWithCerts();
    podsFor("legacy");
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [secretItem("agentbox-legacy-cert", "legacy", { "siclaw.io/ca-fp": FAKE_CA_FP })],
    });

    await s.renewExpiringCertificates();

    // Self-clearing: the renewal stamps it, so it never lands in this branch again.
    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(1);
    expect(g.__k8sCalls.replaceNamespacedSecret[0].body.metadata.labels["siclaw.io/cert-na"]).toBeDefined();
  });

  it("recycles a Running pod from a build that cannot reload its certificate", async () => {
    // Renewal only spares a pod because the pod re-reads its certificate. One from
    // before cert-reloader.ts shipped cannot, and nothing else removes it —
    // isStaleImage compares image STRINGS and the default deployment pins
    // `tag: latest`, so a rebuilt image never rolls the pod. It would survive the
    // upgrade, have its Secret renewed underneath it, and go dark a week later.
    const s = spawnerWithCerts();
    g.__k8sImpls.readNamespacedSecret = async () => ({ metadata: { labels: freshSecretLabels } });
    let podReads = 0;
    g.__k8sImpls.readNamespacedPod = async () => {
      podReads++;
      if (podReads === 1) {
        return {
          status: { phase: "Running", podIP: "10.0.0.5", conditions: [{ type: "Ready", status: "True" }] },
          // Current CA, no cert-reload label: a pre-upgrade pod.
          metadata: { labels: { "siclaw.io/agent": "preP1", "siclaw.io/ca-fp": FAKE_CA_FP } },
        };
      }
      if (podReads === 2) throw Object.assign(new Error("nf"), { code: 404 });
      return {
        status: { phase: "Running", podIP: "10.0.0.5", conditions: [{ type: "Ready", status: "True" }] },
        metadata: { labels: {} },
      };
    };

    await s.spawn({ agentId: "preP1" } as any);

    expect(g.__k8sCalls.deleteNamespacedPod).toHaveLength(1);
    // And the replacement advertises the capability, so this never fires for it again.
    expect(g.__k8sCalls.createNamespacedPod[0].body.metadata.labels["siclaw.io/cert-reload"]).toBe("1");
  });
});

describe("certificate lifetime and the renewal threshold", () => {
  it("leaves room between the certificate's life and the renewal window", async () => {
    const { AGENTBOX_CERT_VALIDITY_DAYS } = await import("../security/cert-manager.js");
    const { CERT_RENEW_THRESHOLD_MS } = await import("./k8s-spawner.js");
    const validityMs = AGENTBOX_CERT_VALIDITY_DAYS * 86_400_000;

    // 🔴 A threshold at or above the validity makes every certificate permanently
    // "expiring": re-minted on every renewal tick AND on every cold spawn, forever.
    // The two constants live in different files with nothing else tying them
    // together, so shortening the validity for a security policy would silently turn
    // renewal into a hot loop. Half is an arbitrary but comfortable bound — what
    // matters is that the relationship is asserted somewhere.
    expect(CERT_RENEW_THRESHOLD_MS).toBeLessThan(validityMs / 2);
  });
});

describe("K8sSpawner — renewal and the orphan sweep must not deadlock", () => {
  const g = globalThis as any;
  const secondsFromNow = (days: number) => String(Math.floor((Date.now() + days * 86_400_000) / 1000));

  it("does not renew a certificate no pod is mounting", async () => {
    // 🔴 THE IMMORTAL SECRET. The sweep now skips anything still valid (so a cold
    // spawn's Secret cannot be swept out from under the pod being created). If
    // renewal also refreshed orphans, the two rules would trap each other: renewal
    // keeps pushing the expiry out, the sweep never sees an expired Secret to
    // collect, and the orphan lives forever — precisely the accumulation the sweep
    // was built to stop.
    const s = new K8sSpawner();
    s.setCertManager(new FakeCertManager() as any);
    g.__k8sImpls.listNamespacedPod = async () => ({ items: [] }); // agent has no pods
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [{
        metadata: {
          name: "agentbox-gone-cert",
          labels: {
            "siclaw.io/app": "agentbox",
            "siclaw.io/agent": "gone",
            "siclaw.io/ca-fp": FAKE_CA_FP,
            "siclaw.io/cert-na": secondsFromNow(1),
          },
        },
        data: { "tls.crt": Buffer.from("SUBJECT:gone:org-7:agentbox-gone").toString("base64") },
      }],
    });

    await s.renewExpiringCertificates();

    // Left to lapse, which is what lets the sweep collect it.
    expect(g.__k8sCalls.replaceNamespacedSecret).toHaveLength(0);
  });
});

describe("K8sSpawner — the sweep must not collect a certificate still in use", () => {
  const g = globalThis as any;
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  const secondsFromNow = (days: number) => String(Math.floor((Date.now() + days * 86_400_000) / 1000));

  it("spares an orphaned chat Secret whose certificate is still valid", async () => {
    // 🔴 THE COLD-SPAWN TOCTOU. spawn() leaves a current Secret untouched rather than
    // rewriting it, so the 10-minute age guard — which assumes a spawning box's Secret
    // was just created — stops covering it. An agent with no pods yet is exactly the
    // state a cold spawn begins from, so without this the sweep could delete a good
    // Secret out from under the pod being created, leaving it on a missing volume
    // forever (restartPolicy is Never).
    g.__k8sImpls.listNamespacedPod = async () => ({ items: [] });
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [{
        metadata: {
          name: "agentbox-idle-cert",
          creationTimestamp: old,
          labels: { "siclaw.io/agent": "idle", "siclaw.io/boxType": "agent", "siclaw.io/cert-na": secondsFromNow(20) },
        },
      }],
    });

    const s = new K8sSpawner();
    await (s as any).sweepOrphans(async () => false);

    expect(g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name)).not.toContain("agentbox-idle-cert");
  });

  it("still collects the same Secret once its certificate has lapsed", async () => {
    // The other half: sparing valid certificates must not become sparing everything,
    // or orphans accumulate — which is what this sweep exists to stop.
    g.__k8sImpls.listNamespacedPod = async () => ({ items: [] });
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [{
        metadata: {
          name: "agentbox-idle-cert",
          creationTimestamp: old,
          labels: { "siclaw.io/agent": "idle", "siclaw.io/boxType": "agent", "siclaw.io/cert-na": secondsFromNow(-1) },
        },
      }],
    });

    const s = new K8sSpawner();
    await (s as any).sweepOrphans(async () => false);

    expect(g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name)).toContain("agentbox-idle-cert");
  });

  it("collects a finished capability run's Secret even though its certificate is valid", async () => {
    // A capability Secret is per-RUN (`kbc-box-<runId>-cert`) and freshly written on
    // every spawn, so the age guard always covered it and it never needed the
    // still-valid protection. Extending that protection here would pin every finished
    // run's Secret for a full certificate lifetime — a busy KB-compile cluster would
    // hold thousands instead of roughly none.
    g.__k8sImpls.listNamespacedPod = async () => ({ items: [] });
    g.__k8sImpls.listNamespacedSecret = async () => ({
      items: [{
        metadata: {
          name: "kbc-box-run-9-cert",
          creationTimestamp: old,
          labels: { "siclaw.io/agent": "run-9", "siclaw.io/boxType": "kb-compile", "siclaw.io/cert-na": secondsFromNow(25) },
        },
      }],
    });

    const s = new K8sSpawner();
    await (s as any).sweepOrphans(async () => false);

    expect(g.__k8sCalls.deleteNamespacedSecret.map((c: any) => c.name)).toContain("kbc-box-run-9-cert");
  });
});
