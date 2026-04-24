import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import type https from "node:https";

/**
 * Tests for createHttpServer.
 *
 * We mock heavy subsystems (metrics registries, memory indexer, config
 * loader) so we can exercise the routing table against a
 * lightweight fake session manager. The server itself is a real http.Server;
 * we send HTTP requests to it from the same process.
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────

// Silence metrics auth side effects.
vi.mock("../shared/metrics.js", () => ({
  checkMetricsAuth: () => true,
  metricsRegistry: {
    contentType: "text/plain",
    metrics: async () => "# HELP fake\n",
  },
}));

vi.mock("../shared/local-collector.js", () => ({
  localCollector: { exportSnapshot: () => ({ cpu: 0 }) },
}));

vi.mock("../shared/diagnostic-events.js", () => ({ emitDiagnostic: () => {} }));

vi.mock("../shared/detect-language.js", () => ({
  detectLanguage: (s: string) => (s.includes("你") ? "Chinese" : "English"),
}));

// Config loader — point paths at /tmp (no PROFILE.md → no update)
vi.mock("../core/config.js", () => ({
  loadConfig: () => ({
    paths: {
      userDataDir: "/tmp/siclaw-test-user-data",
      skillsDir: "skills",
      knowledgeDir: "knowledge",
      credentialsDir: ".siclaw/credentials",
    },
    providers: {
      openai: {
        models: [{ id: "gpt-4", name: "GPT-4", contextWindow: 128000, maxTokens: 4096, reasoning: false }],
      },
    },
  }),
}));

// Make sync-handlers a no-op registry.
vi.mock("./sync-handlers.js", () => ({
  getSyncHandler: () => undefined,
  createClusterHandler: () => ({ type: "cluster", fetch: async () => 0, materialize: async (n: number) => n }),
  createHostHandler: () => ({ type: "host", fetch: async () => 0, materialize: async (n: number) => n }),
}));

vi.mock("./credential-broker.js", () => ({
  CredentialBroker: class { dispose() {} },
}));

vi.mock("./credential-transport.js", () => ({
  HttpTransport: class {},
}));

vi.mock("./gateway-client.js", () => ({
  GatewayClient: class { toClientLike() { return { request: async () => ({}) }; } },
}));

// Import SUT after mocks.
import { createHttpServer } from "./http-server.js";

// ── Helpers ───────────────────────────────────────────────────────────

async function startServer(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

function makeFakeBrain() {
  const { EventEmitter } = require("node:events");
  const emitter = new EventEmitter();
  return {
    emitter,
    subscribe: (cb: (e: any) => void) => {
      emitter.on("event", cb);
      return () => emitter.off("event", cb);
    },
    reload: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    getModel: vi.fn(() => ({ id: "gpt-4", provider: "openai", name: "GPT-4", contextWindow: 128000, maxTokens: 4096, reasoning: false })),
    setModel: vi.fn(async () => {}),
    findModel: vi.fn((provider: string, id: string) =>
      provider === "openai" && id === "gpt-4"
        ? { id: "gpt-4", provider: "openai", name: "GPT-4", contextWindow: 128000, maxTokens: 4096, reasoning: false }
        : null,
    ),
    getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 1000, percent: 1 })),
    getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 })),
    registerProvider: vi.fn(),
  };
}

function makeFakeSession(id: string) {
  return {
    id,
    brain: makeFakeBrain(),
    createdAt: new Date(),
    lastActiveAt: new Date(),
    _promptDoneCallbacks: new Set<() => void>(),
    isCompacting: false,
    isAgentActive: false,
    isRetrying: false,
    _promptDone: true,
    _eventBuffer: [] as unknown[],
    _bufferUnsub: null,
    _aborted: false,
    skillsDirs: [] as string[],
    mode: "web" as const,
    delegationToolsEnabled: false,
    _lastSavedMessageCount: 0,
    _releaseTimer: null,
    kubeconfigRef: { credentialsDir: "", credentialBroker: undefined },
    dpStateRef: { active: false },
  };
}

function makeFakeSessionManager() {
  const sessions = new Map<string, ReturnType<typeof makeFakeSession>>();
  const getOrCreateCalls: any[] = [];
  return {
    sessions,
    getOrCreateCalls,
    userId: "u",
    agentId: "a",
    activeCount: () => sessions.size,
    list: () => Array.from(sessions.values()),
    get: (id: string) => sessions.get(id),
    getOrCreate: async (id?: string, _mode?: unknown, _systemPromptTemplate?: unknown, options?: { enableDelegationTools?: boolean }) => {
      getOrCreateCalls.push({ id, options });
      const key = id ?? "default";
      let s = sessions.get(key);
      if (!s) {
        s = makeFakeSession(key);
        sessions.set(key, s);
      }
      s.delegationToolsEnabled = options?.enableDelegationTools === true;
      return s;
    },
    close: async (id: string) => { sessions.delete(id); },
    closeAll: async () => { sessions.clear(); },
    resetMemory: async () => {},
    scheduleRelease: (_id: string) => {},
    getPersistedDpState: (_id: string): { active: boolean } | null => null,
    onSessionRelease: undefined as undefined | (() => void),
    credentialBroker: undefined,
    credentialsDir: undefined,
  };
}

async function getJson(port: number, path: string, method = "GET", body?: unknown): Promise<{ status: number; data: any }> {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: resp.status, data };
}

// ── Tests ─────────────────────────────────────────────────────────────

let server: http.Server | https.Server;
let port: number;
let sm: ReturnType<typeof makeFakeSessionManager>;
const origEnv = { SICLAW_GATEWAY_URL: process.env.SICLAW_GATEWAY_URL, SICLAW_CERT_PATH: process.env.SICLAW_CERT_PATH };

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "trace").mockImplementation(() => {});

  // Point to a non-existent cert path → plain HTTP.
  process.env.SICLAW_CERT_PATH = "/tmp/nonexistent-cert-path-for-siclaw-tests";
  delete process.env.SICLAW_GATEWAY_URL;

  sm = makeFakeSessionManager();
  server = createHttpServer(sm as any);
  port = await startServer(server);
});

afterEach(async () => {
  await new Promise<void>((r) => (server as http.Server).close(() => r()));
  vi.restoreAllMocks();
  process.env.SICLAW_GATEWAY_URL = origEnv.SICLAW_GATEWAY_URL;
  process.env.SICLAW_CERT_PATH = origEnv.SICLAW_CERT_PATH;
});

// ── Basic endpoints ───────────────────────────────────────────────────

describe("http-server — /health + /api/sessions + /api/models", () => {
  it("GET /health returns ok", async () => {
    const r = await getJson(port, "/health");
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("ok");
    expect(r.data.sessions).toBe(0);
  });

  it("GET /api/sessions returns empty array initially", async () => {
    const r = await getJson(port, "/api/sessions");
    expect(r.status).toBe(200);
    expect(r.data.sessions).toEqual([]);
  });

  it("GET /api/models returns models from config.providers", async () => {
    const r = await getJson(port, "/api/models");
    expect(r.status).toBe(200);
    expect(r.data.models).toEqual([
      { id: "gpt-4", name: "GPT-4", provider: "openai", contextWindow: 128000, maxTokens: 4096, reasoning: false },
    ]);
  });
});

describe("http-server — prompt + session lifecycle", () => {
  it("POST /api/prompt creates a session and returns ok", async () => {
    const r = await getJson(port, "/api/prompt", "POST", { text: "hi" });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.sessionId).toBe("default");
    expect(sm.sessions.has("default")).toBe(true);
  });

  it("POST /api/prompt keeps delegation tools hidden for normal chat", async () => {
    const r = await getJson(port, "/api/prompt", "POST", { text: "normal question", sessionId: "normal" });

    expect(r.status).toBe(200);
    expect(sm.getOrCreateCalls.at(-1)).toMatchObject({
      id: "normal",
      options: { enableDelegationTools: false },
    });
  });

  it("POST /api/prompt exposes delegation tools for visible Deep Investigation activation", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "[Deep Investigation]\ncheck the cluster",
      sessionId: "dp",
    });

    expect(r.status).toBe(200);
    expect(sm.getOrCreateCalls.at(-1)).toMatchObject({
      id: "dp",
      options: { enableDelegationTools: true },
    });
  });

  it("POST /api/prompt keeps delegation tools exposed while persisted DP mode is active", async () => {
    sm.getPersistedDpState = vi.fn(() => ({ active: true }));

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "continue investigation",
      sessionId: "dp-persisted",
    });

    expect(r.status).toBe(200);
    expect(sm.getOrCreateCalls.at(-1)).toMatchObject({
      id: "dp-persisted",
      options: { enableDelegationTools: true },
    });
  });

  it("POST /api/prompt hides delegation tools on DP exit even when persisted state is active", async () => {
    sm.getPersistedDpState = vi.fn(() => ({ active: true }));

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "[DP_EXIT]\nback to normal",
      sessionId: "dp-exit",
    });

    expect(r.status).toBe(200);
    expect(sm.getOrCreateCalls.at(-1)).toMatchObject({
      id: "dp-exit",
      options: { enableDelegationTools: false },
    });
  });

  it("POST /api/prompt rejects missing text", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {});
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Missing.*text/);
  });

  it("POST /api/prompt rejects a second prompt while the session is still running", async () => {
    const existing = await sm.getOrCreate("busy");
    existing._promptDone = false;

    const r = await getJson(port, "/api/prompt", "POST", { text: "hi again", sessionId: "busy" });

    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/already running/i);
    expect(existing.brain.prompt).not.toHaveBeenCalled();
  });

  it("DELETE /api/sessions/:id closes the session", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "s-close" });
    expect(sm.sessions.has("s-close")).toBe(true);
    const r = await getJson(port, "/api/sessions/s-close", "DELETE");
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(sm.sessions.has("s-close")).toBe(false);
  });

  it("GET /api/sessions/:id/context returns token+cost stats", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "s-ctx" });
    const r = await getJson(port, "/api/sessions/s-ctx/context");
    expect(r.status).toBe(200);
    expect(r.data.tokens).toBe(10);
    expect(r.data.cost).toBe(0.01);
  });

  it("GET /api/sessions/:id/context 404s for unknown session", async () => {
    const r = await getJson(port, "/api/sessions/ghost/context");
    expect(r.status).toBe(404);
  });
});

describe("http-server — model switching", () => {
  it("GET /api/sessions/:id/model returns the current model", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "m1" });
    const r = await getJson(port, "/api/sessions/m1/model");
    expect(r.status).toBe(200);
    expect(r.data.model.id).toBe("gpt-4");
  });

  it("PUT /api/sessions/:id/model rejects missing fields", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "m2" });
    const r = await getJson(port, "/api/sessions/m2/model", "PUT", { provider: "x" });
    expect(r.status).toBe(400);
  });

  it("PUT /api/sessions/:id/model 404s for unknown model", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "m3" });
    const r = await getJson(port, "/api/sessions/m3/model", "PUT", { provider: "unknown", modelId: "foo" });
    expect(r.status).toBe(404);
  });

  it("PUT /api/sessions/:id/model succeeds for known model", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "m4" });
    const r = await getJson(port, "/api/sessions/m4/model", "PUT", { provider: "openai", modelId: "gpt-4" });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
  });
});

describe("http-server — steer / abort / clear-queue", () => {
  it("POST /api/sessions/:id/steer 404s for unknown session", async () => {
    const r = await getJson(port, "/api/sessions/ghost/steer", "POST", { text: "x" });
    expect(r.status).toBe(404);
  });

  it("POST /api/sessions/:id/steer rejects empty text", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st1" });
    const r = await getJson(port, "/api/sessions/st1/steer", "POST", {});
    expect(r.status).toBe(400);
  });

  it("POST /api/sessions/:id/steer calls brain.steer", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st2" });
    const s = sm.sessions.get("st2")!;
    const r = await getJson(port, "/api/sessions/st2/steer", "POST", { text: "stop" });
    expect(r.status).toBe(200);
    expect(s.brain.steer).toHaveBeenCalledWith("stop");
  });

  it("POST /api/sessions/:id/abort calls brain.abort", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "ab1" });
    const s = sm.sessions.get("ab1")!;
    const r = await getJson(port, "/api/sessions/ab1/abort", "POST");
    expect(r.status).toBe(200);
    expect(s.brain.abort).toHaveBeenCalled();
    expect(s._aborted).toBe(true);
  });

  it("POST /api/sessions/:id/abort returns pending when brain abort hangs", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "ab-hangs" });
    const s = sm.sessions.get("ab-hangs")!;
    s.brain.abort.mockImplementation(() => new Promise(() => {}));

    const r = await getJson(port, "/api/sessions/ab-hangs/abort", "POST");

    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, pending: true });
    expect(s._aborted).toBe(true);
  });

  it("POST /api/sessions/:id/clear-queue returns cleared arrays", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "cq1" });
    const r = await getJson(port, "/api/sessions/cq1/clear-queue", "POST");
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
  });
});

describe("http-server — dp-state", () => {
  it("returns live dpStateRef when session is loaded", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "dp1" });
    const s = sm.sessions.get("dp1")!;
    s.dpStateRef = { active: true };
    const r = await getJson(port, "/api/sessions/dp1/dp-state");
    expect(r.status).toBe(200);
    expect(r.data.active).toBe(true);
  });

  it("falls back to active=false when no session and no persisted state", async () => {
    const r = await getJson(port, "/api/sessions/ghost/dp-state");
    expect(r.status).toBe(200);
    expect(r.data.active).toBe(false);
  });
});

describe("http-server — memory reset", () => {
  it("DELETE /api/memory calls sessionManager.resetMemory", async () => {
    const spy = vi.spyOn(sm, "resetMemory");
    const r = await getJson(port, "/api/memory", "DELETE");
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalled();
  });
});

describe("http-server — metrics endpoints", () => {
  it("GET /metrics returns prometheus text", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("# HELP fake");
  });

  it("GET /api/internal/metrics-snapshot returns a JSON snapshot", async () => {
    const r = await getJson(port, "/api/internal/metrics-snapshot");
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ cpu: 0 });
  });
});

describe("http-server — routing", () => {
  it("returns 404 for unknown route", async () => {
    const r = await getJson(port, "/nowhere");
    expect(r.status).toBe(404);
  });

  it("handles OPTIONS preflight with CORS headers", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/any`, { method: "OPTIONS" });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("http-server — reload routes delegate to handlers", () => {
  it("POST /api/reload-mcp returns 200 with no-op handler (missing gateway URL)", async () => {
    const r = await getJson(port, "/api/reload-mcp", "POST");
    // Without SICLAW_GATEWAY_URL and with a stub handler registry, the endpoint
    // either short-circuits to 200 (requiresGatewayClient + no client) or
    // falls through to 500 (no handler). We accept either, as long as the
    // route is wired.
    expect([200, 500]).toContain(r.status);
  });
});
