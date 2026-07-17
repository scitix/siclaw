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

const mockConfigState = vi.hoisted(() => ({
  modelRouting: undefined as unknown,
  memoryEnabled: true,
}));

// Silence metrics auth side effects.
vi.mock("../shared/metrics.js", () => ({
  checkMetricsAuth: () => true,
  metricsRegistry: {
    contentType: "text/plain",
    metrics: async () => "# HELP fake\n",
  },
  processIncarnation: "test-incarnation",
  getMetricsAsJSON: async () => [
    { name: "siclaw_tokens_total", type: "counter", values: [{ labels: { type: "input" }, value: 3 }] },
  ],
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
    modelRouting: mockConfigState.modelRouting,
  }),
  isMemoryEnabled: () => mockConfigState.memoryEnabled,
}));

// Make sync-handlers a no-op registry.
vi.mock("./sync-handlers.js", () => ({
  getSyncHandler: () => undefined,
  createClusterHandler: () => ({ type: "cluster", fetch: async () => 0, materialize: async (n: number) => n }),
  createHostHandler: () => ({ type: "host", fetch: async () => 0, materialize: async (n: number) => n }),
  createToolsHandler: (target: { allowedToolsState: string[] | null }) => ({
    type: "tools",
    fetch: async () => ({ allowedTools: null }),
    materialize: async (p: { allowedTools: string[] | null }) => {
      target.allowedToolsState = Array.isArray(p?.allowedTools) ? p.allowedTools : null;
      return target.allowedToolsState ? target.allowedToolsState.length : 0;
    },
    postReload: async () => {},
  }),
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
import { createHttpServer, resolveDelegation } from "./http-server.js";

// ── Helpers ───────────────────────────────────────────────────────────

async function startServer(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

function makeFakeBrain() {
  const { EventEmitter } = require("node:events");
  const emitter = new EventEmitter();
  const models = [
    { id: "gpt-4", provider: "openai", name: "GPT-4", contextWindow: 128000, maxTokens: 4096, reasoning: false },
    { id: "claude", provider: "anthropic", name: "Claude", contextWindow: 200000, maxTokens: 8192, reasoning: true },
    { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek", contextWindow: 64000, maxTokens: 4096, reasoning: false },
  ];
  let currentModel = models[0];
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
    getModel: vi.fn(() => currentModel),
    setModel: vi.fn(async (model: typeof currentModel) => { currentModel = model; }),
    findModel: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
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
    _lastSavedMessageCount: 0,
    _releaseTimer: null,
    _promptInflight: null,
    _syntheticPromptQueue: null,
    _backgroundWorkCount: 0,
    modelRouteState: { cooldowns: {}, attempts: [] },
    _routeBrainEventsThroughExtra: false,
    _extraEventSubs: new Set<(e: Record<string, unknown>) => void>(),
    _extraEventBuffer: [] as Record<string, unknown>[],
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
    stopSessionJobs: vi.fn(() => 0),
    markPendingAbort: vi.fn(),
    consumePendingAbort: vi.fn(() => false),
    discardPendingNotifications: vi.fn(),
    getOrCreate: async (id?: string, _mode?: unknown, _systemPromptTemplate?: unknown, activeMode?: unknown) => {
      getOrCreateCalls.push({ id, activeMode });
      const key = id ?? "default";
      let s = sessions.get(key);
      if (!s) {
        s = makeFakeSession(key);
        sessions.set(key, s);
      }
      return s;
    },
    close: async (id: string) => { sessions.delete(id); },
    closeAll: async () => { sessions.clear(); },
    resetMemory: async () => {},
    scheduleRelease: (_id: string) => {},
    setDelegationModel: vi.fn(),
    persistModelRouteState: vi.fn(),
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

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function modelConfigWithInput(input: string[]) {
  return {
    name: "test-provider",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    authHeader: false,
    models: [{
      id: "gpt-4",
      name: "GPT-4",
      reasoning: false,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

let server: http.Server | https.Server;
let port: number;
let sm: ReturnType<typeof makeFakeSessionManager>;
const origEnv = { SICLAW_GATEWAY_URL: process.env.SICLAW_GATEWAY_URL, SICLAW_CERT_PATH: process.env.SICLAW_CERT_PATH };

beforeEach(async () => {
  mockConfigState.modelRouting = undefined;
  mockConfigState.memoryEnabled = true;
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

  it("POST /api/prompt rejects missing text", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {});
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Missing.*text/);
  });

  it("POST /api/prompt forwards images to brain.prompt as vision input", async () => {
    const session = await sm.getOrCreate("img-1");
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "what is in this image?",
      sessionId: "img-1",
      modelProvider: "openai",
      modelId: "gpt-4",
      modelConfig: modelConfigWithInput(["text", "image"]),
      images: [{ mimeType: "image/png", data: "aW1n" }],
    });
    expect(r.status).toBe(200);
    expect(session.brain.prompt).toHaveBeenCalledWith(
      "what is in this image?",
      { images: [{ mimeType: "image/png", data: "aW1n" }] },
    );
  });

  it("POST /api/prompt accepts an image-only message and defaults the text", async () => {
    const session = await sm.getOrCreate("img-only");
    const r = await getJson(port, "/api/prompt", "POST", {
      sessionId: "img-only",
      modelProvider: "openai",
      modelId: "gpt-4",
      modelConfig: modelConfigWithInput(["text", "image"]),
      images: [{ mimeType: "image/png", data: "aW1n" }],
    });
    expect(r.status).toBe(200);
    expect(session.brain.prompt).toHaveBeenCalledWith(
      "Please analyze the attached image.",
      { images: [{ mimeType: "image/png", data: "aW1n" }] },
    );
  });

  // Regression: language-following must NOT be gated on memory. A memory-off agent
  // (e.g. the GPU-cloud sales-guide) still needs its reply to follow the user's
  // language; the `[System: respond in X]` directive is injected regardless of memory.
  it("POST /api/prompt injects the language directive even when memory is disabled", async () => {
    mockConfigState.memoryEnabled = false;
    const session = await sm.getOrCreate("lang-nomem");
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "你好",
      sessionId: "lang-nomem",
      modelProvider: "openai",
      modelId: "gpt-4",
      modelConfig: modelConfigWithInput(["text"]),
    });
    expect(r.status).toBe(200);
    expect(session.brain.prompt.mock.calls[0][0]).toBe("[System: respond in Chinese]\n你好");
  });

  it("POST /api/prompt leaves English prompts untouched when memory is disabled", async () => {
    mockConfigState.memoryEnabled = false;
    const session = await sm.getOrCreate("lang-en-nomem");
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hello there",
      sessionId: "lang-en-nomem",
      modelProvider: "openai",
      modelId: "gpt-4",
      modelConfig: modelConfigWithInput(["text"]),
    });
    expect(r.status).toBe(200);
    expect(session.brain.prompt.mock.calls[0][0]).toBe("hello there");
  });

  it("POST /api/prompt forwards large valid images to brain.prompt", async () => {
    const session = await sm.getOrCreate("img-large");
    const data = "A".repeat(3 * 1024 * 1024);
    const r = await getJson(port, "/api/prompt", "POST", {
      sessionId: "img-large",
      modelProvider: "openai",
      modelId: "gpt-4",
      modelConfig: modelConfigWithInput(["text", "image"]),
      images: [{ mimeType: "image/jpeg", data }],
    });
    expect(r.status).toBe(200);
    expect(session.brain.prompt).toHaveBeenCalledWith(
      "Please analyze the attached image.",
      { images: [{ mimeType: "image/jpeg", data }] },
    );
  });

  it("POST /api/prompt rejects malformed images instead of dropping them", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      images: [{ mimeType: "image/gif", data: "aW1n" }],
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/images\[0\]\.mimeType/);
  });

  it("POST /api/prompt rejects images whose data is not valid base64", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      images: [{ mimeType: "image/png", data: "not base64!!!" }],
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/images\[0\]\.data.*base64/);
  });

  it("POST /api/prompt rejects images that exceed the media item limit", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      images: [{ mimeType: "image/png", data: "A".repeat(8 * 1024 * 1024 + 4) }],
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/images\[0\]\.data exceeds 8 MiB/);
  });

  it("POST /api/prompt accepts PDF-only prompts and forwards files to the brain", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      sessionId: "pdf1",
      modelProvider: "openai",
      modelId: "gpt-4",
      modelConfig: modelConfigWithInput(["text", "pdf"]),
      files: [{ mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" }],
    });
    await flushAsync();

    expect(r.status).toBe(200);
    const s = sm.sessions.get("pdf1")!;
    expect(s.brain.prompt).toHaveBeenCalledWith("Please analyze the attached PDF.", {
      files: [{ mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" }],
    });
  });

  it("resolves the active operating mode from DP markers and passes it to getOrCreate", async () => {
    const lastMode = () => sm.getOrCreateCalls[sm.getOrCreateCalls.length - 1].activeMode;

    await getJson(port, "/api/prompt", "POST", { text: "[Deep Investigation]\nwhy is X failing", sessionId: "dp-a" });
    expect(lastMode()).toBe("dp");

    await getJson(port, "/api/prompt", "POST", { text: "[DP_EXIT]\nthanks", sessionId: "exit-a" });
    expect(lastMode()).toBe("normal");

    await getJson(port, "/api/prompt", "POST", { text: "plain question", sessionId: "plain-a" });
    expect(lastMode()).toBe("normal");
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

  it("PUT /api/sessions/:id/model marks a strict user model selection and clears route cooldowns", async () => {
    const s = await sm.getOrCreate("m5");
    s.modelRouteState.activeCandidateKey = "anthropic/claude";
    s.modelRouteState.activeCandidateSource = "auto";
    s.modelRouteState.cooldowns["openai/gpt-4"] = Date.now() + 60_000;

    const r = await getJson(port, "/api/sessions/m5/model", "PUT", { provider: "deepseek", modelId: "deepseek-chat" });

    expect(r.status).toBe(200);
    expect(s.modelRouteState.activeCandidateKey).toBe("deepseek/deepseek-chat");
    expect(s.modelRouteState.activeCandidateSource).toBe("user");
    expect(s.modelRouteState.cooldowns).toEqual({});
    expect(s.modelRouteState.lastSwitchReason).toBe("user_selection");
    expect(sm.persistModelRouteState).toHaveBeenCalledWith("m5", s.modelRouteState);
  });
});

describe("http-server — model routing", () => {
  const routePolicy = {
    enabled: true,
    strategy: "ordered_fallback" as const,
    cooldownMsByKind: {
      billing: 1000,
      rate_limit: 1000,
      timeout: 1000,
      server_error: 1000,
      model_not_found: 1000,
      network: 1000,
      empty_response: 1000,
    },
    candidates: [
      { provider: "openai", modelId: "gpt-4" },
      { provider: "anthropic", modelId: "claude" },
      { provider: "deepseek", modelId: "deepseek-chat" },
    ],
  };
  const compactAgentPolicy = {
    enabled: true,
    strategy: "ordered_fallback" as const,
    candidates: [
      { provider: "openai", modelId: "gpt-4" },
      { provider: "anthropic", modelId: "claude" },
    ],
  };

  it("falls back to the next candidate on a fallbackable model error", async () => {
    const s = await sm.getOrCreate("route-fallback");
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      if (model.provider === "openai") {
        s.brain.emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
          },
        });
        return;
      }
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "route me",
      sessionId: "route-fallback",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(s.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
    expect(s.modelRouteState.cooldowns["openai/gpt-4"]).toBeGreaterThan(0);
    expect(s._eventBuffer).toEqual([]);
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(true);
    // The primary now streams live, so its failed error message_end IS relayed
    // (the frontend renders it, then drops it on the rollback below).
    expect(s._extraEventBuffer.some((event) =>
      event.type === "message_end" && (event.message as any)?.stopReason === "error",
    )).toBe(true);
    // A rollback tells consumers to discard the failed primary's live output
    // before the fallback's reply arrives.
    const rollbackIdx = s._extraEventBuffer.findIndex((event) => event.type === "model_route_rollback");
    const okIdx = s._extraEventBuffer.findIndex((event) =>
      event.type === "message_end" && (event.message as any)?.content?.[0]?.text === "ok",
    );
    expect(rollbackIdx).toBeGreaterThanOrEqual(0);
    expect(okIdx).toBeGreaterThan(rollbackIdx);
    expect(sm.persistModelRouteState).toHaveBeenCalledWith("route-fallback", s.modelRouteState);
  });

  it("does not fallback by replaying the prompt after a tool has executed", async () => {
    const s = await sm.getOrCreate("route-tool-side-effect");
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      s.brain.emitter.emit("event", {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "README.md" },
      });
      s.brain.emitter.emit("event", {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      });
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 rate limit exceeded",
        },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "route me after tool",
      sessionId: "route-tool-side-effect",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4"]);
    expect(s.modelRouteState.activeCandidateKey).toBeUndefined();
    expect(s.modelRouteState.cooldowns["openai/gpt-4"]).toBeGreaterThan(0);
    expect(s.modelRouteState.attempts[0]).toMatchObject({
      failureKind: "rate_limit",
      fallbackBlockedReason: "tool_execution",
    });
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(false);
    expect(s._extraEventBuffer.find((event) => event.type === "model_route_exhausted")).toMatchObject({
      failureKind: "rate_limit",
      fallbackBlockedReason: "tool_execution",
    });
    expect(s._extraEventBuffer.some((event) => event.type === "tool_execution_end")).toBe(true);
    expect(s._extraEventBuffer.some((event) =>
      event.type === "message_end" && (event.message as any)?.stopReason === "error",
    )).toBe(true);
    expect(sm.persistModelRouteState).toHaveBeenCalledWith("route-tool-side-effect", s.modelRouteState);
  });

  it("does not fallback on context overflow", async () => {
    const s = await sm.getOrCreate("route-context");
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "context_length_exceeded: too many tokens",
        },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "too much history",
      sessionId: "route-context",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4"]);
    expect(s.modelRouteState.activeCandidateKey).toBeUndefined();
    expect(s._eventBuffer).toEqual([]);
    expect(s._extraEventBuffer.some((event) =>
      event.type === "message_end" && (event.message as any)?.stopReason === "error",
    )).toBe(true);
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(false);
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_exhausted")).toBe(true);
  });

  it("does not fallback on auth errors by default", async () => {
    const s = await sm.getOrCreate("route-auth");
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "401 invalid api key",
        },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "bad credentials",
      sessionId: "route-auth",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4"]);
    expect(s.modelRouteState.activeCandidateKey).toBeUndefined();
    expect(s.modelRouteState.cooldowns).toEqual({});
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(false);
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_exhausted")).toBe(true);
  });

  it("uses the persisted fallback candidate while the primary is cooling", async () => {
    const s = await sm.getOrCreate("route-cooldown");
    s.modelRouteState.activeCandidateKey = "anthropic/claude";
    s.modelRouteState.cooldowns["openai/gpt-4"] = Date.now() + 60_000;
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "stay on fallback",
      sessionId: "route-cooldown",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["anthropic/claude"]);
    expect(s.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
  });

  it("does not engage automatic fallback while a manual user model selection is active", async () => {
    const s = await sm.getOrCreate("route-user-strict");
    await getJson(port, "/api/sessions/route-user-strict/model", "PUT", { provider: "anthropic", modelId: "claude" });

    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "respect manual model",
      sessionId: "route-user-strict",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["anthropic/claude"]);
    expect(s.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
    expect(s.modelRouteState.activeCandidateSource).toBe("user");
    // Single entry: the pinned model runs through the runner as a lone candidate
    // (model_route_start/success appear), but automatic fallback never engages.
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(false);
  });

  it("clears manual strict selection when the next prompt explicitly targets a different primary model", async () => {
    const s = await sm.getOrCreate("route-user-overridden");
    await getJson(port, "/api/sessions/route-user-overridden/model", "PUT", { provider: "anthropic", modelId: "claude" });

    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      if (model.provider === "openai") {
        s.brain.emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
          },
        });
        return;
      }
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "explicit configured primary",
      sessionId: "route-user-overridden",
      modelProvider: "openai",
      modelId: "gpt-4",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(s.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
    expect(s.modelRouteState.activeCandidateSource).toBe("auto");
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(true);
  });

  it("uses modelRouting from loaded settings when request omits policy", async () => {
    mockConfigState.modelRouting = routePolicy;
    const s = await sm.getOrCreate("route-config-default");
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      if (model.provider === "openai") {
        s.brain.emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
          },
        });
        return;
      }
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "route by config",
      sessionId: "route-config-default",
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(true);
  });

  it("applies unified defaults to compact agent modelRouting from settings", async () => {
    mockConfigState.modelRouting = compactAgentPolicy;
    const s = await sm.getOrCreate("route-compact-agent-policy");
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      if (model.provider === "openai") {
        s.brain.emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
          },
        });
        return;
      }
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const beforePrompt = Date.now();
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "route by compact config",
      sessionId: "route-compact-agent-policy",
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(s.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
    expect(s.modelRouteState.cooldowns["openai/gpt-4"]).toBeGreaterThanOrEqual(beforePrompt + 60 * 1000);
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(true);
  });

  it("runs a lone candidate through the routing runner (single entry) with live streaming and no fallback", async () => {
    const s = await sm.getOrCreate("route-single");
    const singleCandidatePolicy = {
      enabled: true,
      strategy: "ordered_fallback" as const,
      candidates: [{ provider: "openai", modelId: "gpt-4" }],
    };
    const seenModels: string[] = [];
    s.brain.prompt.mockImplementation(async () => {
      const model = s.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "single candidate",
      sessionId: "route-single",
      modelRouting: singleCandidatePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-4"]);
    // Single entry: a lone candidate still runs through the runner. It streams
    // live (optimistic primary) on the extra channel and emits model_route_*
    // carrying the model identity, but never switches / falls back.
    // (_routeBrainEventsThroughExtra is transient — actuallyFinish resets it on
    // completion — so assert on the durable extra-channel buffer instead.)
    expect(s._extraEventBuffer.some((event: any) => event.type === "model_route_success")).toBe(true);
    expect(s._extraEventBuffer.some((event: any) => event.type === "model_route_switch")).toBe(false);
    expect(s._extraEventBuffer.some((event: any) => event.type === "message_end")).toBe(true);
  });

  it("single entry: a plain turn with routing disabled still emits model_route_* carrying the model identity (no switch)", async () => {
    const s = await sm.getOrCreate("route-plain");
    s.brain.prompt.mockImplementation(async () => {
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "plain turn",
      sessionId: "route-plain",
      modelRouting: { enabled: false },
    });
    await flushAsync();

    expect(r.status).toBe(200);
    // Every turn runs through the runner as a lone candidate built from the
    // current model, so downstream collection (Langfuse) always sees the model
    // identity — but a non-fallback success carries isFallback:false and no switch.
    const success = s._extraEventBuffer.find((event: any) => event.type === "model_route_success") as any;
    expect(success).toBeTruthy();
    expect(success.isFallback).toBe(false);
    expect(success.modelId).toBe("gpt-4");
    expect(s._extraEventBuffer.some((event: any) => event.type === "model_route_switch")).toBe(false);
  });

  it("enriches agent_end with token stats on the routed (buffered) flush path", async () => {
    const s = await sm.getOrCreate("route-enrich");
    s.brain.prompt.mockImplementation(async () => {
      s.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
      s.brain.emitter.emit("event", { type: "agent_end" });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "route enrich",
      sessionId: "route-enrich",
      modelRouting: routePolicy,
    });
    await flushAsync();

    expect(r.status).toBe(200);
    // The buffered flush path bypasses the live SSE subscription, so the
    // enrichment must be re-applied there — otherwise routed sessions emit a
    // bare agent_end with no token/cost badge.
    const agentEnd = s._extraEventBuffer.find((event) => event.type === "agent_end");
    expect(agentEnd).toBeDefined();
    expect((agentEnd as any).contextUsage).toMatchObject({
      tokens: 10,
      inputTokens: 1,
      outputTokens: 2,
      cost: 0.01,
    });
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

  it("POST /api/sessions/:id/steer forwards images to brain.steer", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st-img" });
    const s = sm.sessions.get("st-img")!;
    const r = await getJson(port, "/api/sessions/st-img/steer", "POST", {
      text: "这个呢",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(r.status).toBe(200);
    expect(s.brain.steer).toHaveBeenCalledWith("这个呢", {
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    });
  });

  it("POST /api/sessions/:id/steer rejects invalid images instead of dropping them", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st-img-invalid" });
    const s = sm.sessions.get("st-img-invalid")!;
    const r = await getJson(port, "/api/sessions/st-img-invalid/steer", "POST", {
      images: [{ mimeType: "image/png", data: "not base64!!!" }],
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/images\[0\]\.data.*base64/);
    expect(s.brain.steer).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/steer forwards PDF files to brain.steer", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st-pdf" });
    const s = sm.sessions.get("st-pdf")!;
    const r = await getJson(port, "/api/sessions/st-pdf/steer", "POST", {
      files: [{ mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" }],
    });
    expect(r.status).toBe(200);
    expect(s.brain.steer).toHaveBeenCalledWith("Please analyze the attached PDF.", {
      files: [{ mimeType: "application/pdf", filename: "runbook.pdf", data: "aGVsbG8=" }],
    });
  });

  it("POST /api/sessions/:id/abort calls brain.abort AND stops the session's background jobs", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "ab1" });
    const s = sm.sessions.get("ab1")!;
    const r = await getJson(port, "/api/sessions/ab1/abort", "POST");
    expect(r.status).toBe(200);
    expect(s.brain.abort).toHaveBeenCalled();
    expect(s._aborted).toBe(true);
    // Stop also halts the session's detached background jobs (not just the live turn).
    expect(sm.stopSessionJobs).toHaveBeenCalledWith("ab1");
  });

  it("POST /api/sessions/:id/abort returns pending when brain abort hangs", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "ab-hangs" });
    const s = sm.sessions.get("ab-hangs")!;
    s.brain.abort.mockImplementation(() => new Promise(() => {}));

    const r = await getJson(port, "/api/sessions/ab-hangs/abort", "POST");

    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, stoppedJobs: 0, pending: true });
    expect(s._aborted).toBe(true);
  });

  it("Stop clears the steer queue, discards pending notifications, and re-sweeps jobs after brain.abort", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "ab2" });
    const s = sm.sessions.get("ab2")!;
    const r = await getJson(port, "/api/sessions/ab2/abort", "POST");
    expect(r.status).toBe(200);
    expect(s.brain.clearQueue).toHaveBeenCalled();          // #2 steer queue dropped
    expect(sm.discardPendingNotifications).toHaveBeenCalledWith("ab2"); // #7 resurrection guard
    // #1: stopSessionJobs swept once before brain.abort AND once after the run drains.
    expect(sm.stopSessionJobs).toHaveBeenCalledTimes(2);
  });

  it("Stop before the session exists records a pending abort (200, not 404)", async () => {
    const r = await getJson(port, "/api/sessions/ghost-bg/abort", "POST");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, pending: true });
    expect(sm.markPendingAbort).toHaveBeenCalledWith("ghost-bg"); // #6 pre-spawn
  });

  it("a consumed pending abort short-circuits the next prompt (pre-prompt latch)", async () => {
    sm.consumePendingAbort.mockReturnValueOnce(true);          // #6 consume → #5 latch
    const r = await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "ab-pre" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ aborted: true });
    const s = sm.sessions.get("ab-pre")!;
    expect(s.brain.prompt).not.toHaveBeenCalled();             // never started the run
    expect(s._promptDone).toBe(true);                          // session unlocked
    expect(s._promptInflight).toBe(null);
  });

  it("POST /api/prompt returns 409 when _promptInflight is held even if _promptDone flipped back", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "first", sessionId: "lock1" });
    const s = sm.sessions.get("lock1")!;
    // Simulate the synth notify path holding the brain.prompt mutex even
    // though _promptDone is true (this is the exact TOCTOU window the
    // mutex closes — without _promptInflight, the second /prompt would
    // 200 and call brain.prompt() concurrently with synth).
    s._promptDone = true;
    s._promptInflight = new Promise<void>(() => {}); // never resolves

    const r = await getJson(port, "/api/prompt", "POST", { text: "second", sessionId: "lock1" });
    expect(r.status).toBe(409);
  });

  it("POST /api/prompt does not deadlock the session when setModel throws", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "first", sessionId: "stuck" });
    const s = sm.sessions.get("stuck")!;
    // Simulate a transient setModel failure on the next prompt — without the
    // deadlock fix, _promptDone would stay false and every subsequent prompt
    // would 409 forever.
    s._promptDone = true;
    s.brain.setModel.mockImplementationOnce(() => Promise.reject(new Error("transient")));

    const fail = await getJson(port, "/api/prompt", "POST", {
      text: "second",
      sessionId: "stuck",
      modelProvider: "anthropic",
      modelId: "claude",
    });
    expect(fail.status).toBe(500);
    expect(s._promptDone).toBe(true);
    // Both locks must be released — _promptInflight was set synchronously
    // before setModel and the setup-failure path must clear it too.
    expect(s._promptInflight).toBe(null);

    // Session must accept a follow-up prompt; pre-fix it returned 409 here.
    const recover = await getJson(port, "/api/prompt", "POST", { text: "third", sessionId: "stuck" });
    expect(recover.status).toBe(200);
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

describe("http-server — session status (liveness)", () => {
  it("returns running:false for an idle loaded session", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st1" });
    const s = sm.sessions.get("st1")!;
    s.isAgentActive = false; s.isCompacting = false; s.isRetrying = false;
    const r = await getJson(port, "/api/sessions/st1/status");
    expect(r.status).toBe(200);
    expect(r.data.running).toBe(false);
  });

  it("returns running:true when any activity flag is set", async () => {
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st2" });
    for (const flag of ["isAgentActive", "isCompacting", "isRetrying"] as const) {
      const s = sm.sessions.get("st2")!;
      s.isAgentActive = false; s.isCompacting = false; s.isRetrying = false;
      s[flag] = true;
      const r = await getJson(port, "/api/sessions/st2/status");
      expect(r.status).toBe(200);
      expect(r.data.running).toBe(true);
    }
  });

  it("returns running:false for an unknown (never-created / released) session", async () => {
    const r = await getJson(port, "/api/sessions/ghost/status");
    expect(r.status).toBe(200);
    expect(r.data.running).toBe(false);
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

  it("GET /api/internal/metrics-snapshot returns { incarnation, prom }", async () => {
    const r = await getJson(port, "/api/internal/metrics-snapshot");
    expect(r.status).toBe(200);
    expect(r.data.incarnation).toBe("test-incarnation");
    expect(r.data.prom).toEqual([
      { name: "siclaw_tokens_total", type: "counter", values: [{ labels: { type: "input" }, value: 3 }] },
    ]);
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

  it("POST /api/reload-tools is wired (descriptor loop) and short-circuits without a gateway URL", async () => {
    const r = await getJson(port, "/api/reload-tools", "POST");
    // tools is requiresGatewayClient:true; with no SICLAW_GATEWAY_URL the route
    // short-circuits to 200 count:0 before ever calling the per-box handler.
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, count: 0, type: "tools" });
  });

  it("POST /api/reload-tracing is wired standalone and is a clean no-op without a gateway URL", async () => {
    // The tracing reload route is registered OUTSIDE the GATEWAY_SYNC_DESCRIPTORS
    // loop (tracing never lands on disk). With no SICLAW_GATEWAY_URL there is
    // nothing to pull, so it short-circuits to a 200 skip rather than erroring.
    const r = await getJson(port, "/api/reload-tracing", "POST");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, skipped: true });
  });
});

// ── Idle self-destruct ────────────────────────────────────────────────
//
// createHttpServer arms an idle timer at construction time and tears the pod
// down when no SSE connections / sessions remain for the configured window.
// We drive it with fake timers and a spied onIdleShutdown callback (so nothing
// actually calls process.exit), and a fresh fake session manager per test so
// the global listening server doesn't interfere.
describe("http-server — idle self-destruct", () => {
  let idleServer: http.Server | https.Server | undefined;

  afterEach(() => {
    // createHttpServer doesn't listen here, but close defensively + restore timers.
    try { (idleServer as http.Server | undefined)?.close(); } catch { /* not listening */ }
    idleServer = undefined;
    vi.useRealTimers();
  });

  function arm(opts: { idleTimeoutMs?: number; disableIdleShutdown?: boolean }) {
    const onIdleShutdown = vi.fn();
    const sm2 = makeFakeSessionManager();
    vi.useFakeTimers();
    idleServer = createHttpServer(sm2 as any, { ...opts, onIdleShutdown });
    return { onIdleShutdown, sm: sm2 };
  }

  it("fires onIdleShutdown after the configured window when idle", () => {
    const { onIdleShutdown } = arm({ idleTimeoutMs: 1000 });
    expect(onIdleShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onIdleShutdown).toHaveBeenCalledTimes(1);
  });

  it("respects the configured window exactly (not before)", () => {
    const { onIdleShutdown } = arm({ idleTimeoutMs: 5000 });
    vi.advanceTimersByTime(4999);
    expect(onIdleShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdleShutdown).toHaveBeenCalledTimes(1);
  });

  it("falls back to the 5-minute default when no window is provided", () => {
    const { onIdleShutdown } = arm({});
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(onIdleShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdleShutdown).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire when a session is active before the window elapses (re-check guard)", () => {
    const { onIdleShutdown, sm: sm2 } = arm({ idleTimeoutMs: 1000 });
    // A session becomes active after the timer was armed but before it fires.
    sm2.sessions.set("live", makeFakeSession("live"));
    vi.advanceTimersByTime(1000);
    expect(onIdleShutdown).not.toHaveBeenCalled();
  });

  it("is resident (never fires) when the window is 0", () => {
    const { onIdleShutdown } = arm({ idleTimeoutMs: 0 });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onIdleShutdown).not.toHaveBeenCalled();
  });

  it("is resident (never fires) when the window is negative", () => {
    const { onIdleShutdown } = arm({ idleTimeoutMs: -1 });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onIdleShutdown).not.toHaveBeenCalled();
  });

  it("never fires when disableIdleShutdown is set", () => {
    const { onIdleShutdown } = arm({ idleTimeoutMs: 1000, disableIdleShutdown: true });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onIdleShutdown).not.toHaveBeenCalled();
  });
});

describe("resolveDelegation (worker autonomy — readOnly is explicit opt-in)", () => {
  it("returns undefined for a non-delegated turn", () => {
    expect(resolveDelegation(undefined, "web")).toBeUndefined();
    // A malformed marker without a delegationId is treated as non-delegated.
    expect(resolveDelegation({ delegationId: "", readOnly: false }, "web")).toBeUndefined();
  });

  it("does NOT downgrade the worker: readOnly=false survives from ANY origin", () => {
    expect(resolveDelegation({ delegationId: "d1", readOnly: false }, "web")).toEqual({ delegationId: "d1", readOnly: false });
    // Non-interactive origins no longer force read-only — the worker runs under its own config.
    for (const origin of ["task", "a2a", "api", "channel"] as const) {
      expect(resolveDelegation({ delegationId: "d1", readOnly: false }, origin)?.readOnly).toBe(false);
    }
  });

  it("defaults to NOT read-only when the flag is omitted (worker autonomous)", () => {
    expect(resolveDelegation({ delegationId: "d1" } as any, "web")?.readOnly).toBe(false);
    expect(resolveDelegation({ delegationId: "d1" } as any, "api")?.readOnly).toBe(false);
  });

  it("honors an EXPLICIT read-only=true opt-in (future read-only tier)", () => {
    expect(resolveDelegation({ delegationId: "d1", readOnly: true }, "web")?.readOnly).toBe(true);
    expect(resolveDelegation({ delegationId: "d1", readOnly: true }, "api")?.readOnly).toBe(true);
  });
});
