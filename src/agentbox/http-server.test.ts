import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AGENT_SYNC_STATUS_SCHEMA_VERSION } from "../shared/agentbox-sync-status.js";
import { hasAcceptedTurn, readTurnLedger, recordAcceptedTurn, TURN_LEDGER_MAX } from "./turn-ledger.js";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  skillsDir: "skills",
  knowledgeDir: "knowledge",
  mcpServers: {} as Record<string, unknown>,
}));

// Captures the options createHttpServer passes when building its per-server
// knowledge handler, so tests can pin the afterMaterialize wiring.
const knowledgeHandlerState = vi.hoisted(() => ({
  lastOptions: null as null | { knowledgeDir?: string; afterMaterialize?: () => void | Promise<void> },
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
      skillsDir: mockConfigState.skillsDir,
      knowledgeDir: mockConfigState.knowledgeDir,
      credentialsDir: ".siclaw/credentials",
    },
    providers: {
      openai: {
        models: [{ id: "gpt-4", name: "GPT-4", contextWindow: 128000, maxTokens: 4096, reasoning: false }],
      },
    },
    modelRouting: mockConfigState.modelRouting,
    mcpServers: mockConfigState.mcpServers,
  }),
  isMemoryEnabled: () => mockConfigState.memoryEnabled,
}));

// Make sync-handlers a no-op registry.
vi.mock("./sync-handlers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sync-handlers.js")>()),
  getSyncHandler: () => undefined,
  createClusterHandler: () => ({ type: "cluster", fetch: async () => 0, materialize: async (n: number) => n }),
  createHostHandler: () => ({ type: "host", fetch: async () => 0, materialize: async (n: number) => n }),
  createKnowledgeHandler: (options: { knowledgeDir?: string; afterMaterialize?: () => void | Promise<void> } = {}) => {
    knowledgeHandlerState.lastOptions = options;
    return {
      type: "knowledge",
      fetch: async () => ({ repos: [] }),
      // The real handler awaits afterMaterialize on EVERY materialize path
      // (empty-wipe and normal) — the fake must model that, or the reload
      // route test cannot see whether the wiring passed the hook at all.
      materialize: async () => { await options.afterMaterialize?.(); return 0; },
      getLastKnowledgeSyncStatus: () => null,
    };
  },
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
  // Thinking-level state modelled on pi 0.80.7 (agent-session.js: setThinkingLevel
  // ~1253, setModel ~1176, _getThinkingLevelForModelSwitch ~1302), because the
  // ORDER of setModel vs applyModelParams only matters through these semantics:
  //  - setThinkingLevel CLAMPS to the current model (non-reasoning → "off");
  //  - a clamp to "off" on a non-reasoning model is NOT persisted as the default;
  //  - setModel restores from that persisted default when the OLD model could not
  //    think, then re-clamps against the new one.
  // Together they mean an effort applied BEFORE a non-reasoning → reasoning switch
  // is discarded. A fake that just records the last call cannot see that, which is
  // why this models the behaviour instead. If pi changes these, this fake is what
  // has to be revisited.
  let thinkingLevel = "medium";
  let persistedDefaultLevel = "medium";
  const supportsThinking = () => !!currentModel.reasoning;
  const setThinkingLevel = (level: string) => {
    const effective = supportsThinking() ? level : "off";
    const changed = effective !== thinkingLevel;
    thinkingLevel = effective;
    if (changed && (supportsThinking() || effective !== "off")) persistedDefaultLevel = effective;
  };
  return {
    emitter,
    getThinkingLevel: () => thinkingLevel,
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
    setModel: vi.fn(async (model: typeof currentModel) => {
      // Level chosen against the OLD model, then re-clamped against the new one.
      const carried = supportsThinking() ? thinkingLevel : persistedDefaultLevel;
      currentModel = model;
      setThinkingLevel(carried);
    }),
    applyModelParams: vi.fn((params: { reasoningEffort?: string }) => {
      if (params.reasoningEffort) setThinkingLevel(params.reasoningEffort);
    }),
    findModel: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
    getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 1000, percent: 1 })),
    getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 })),
    registerProvider: vi.fn(),
  };
}

function makeFakeSession(id: string) {
  const promptInspection = {
    version: "prompt-inspection/v1",
    stage: "session_ready",
    agentType: "sre",
    mode: "web",
    prompt: { text: "exact prompt", chars: 12, sha256: "prompt-hash" },
    layers: [],
    tools: [],
    skills: [],
    design: { standard: "siclaw-prompt-design/v1", verdict: "pass", checks: [], references: [] },
  };
  return {
    id,
    brain: makeFakeBrain(),
    toolNames: ["bash", "preview_echo"],
    skillNames: ["personal-probe", "skill-authoring"],
    skillDigests: { "personal-probe": "abc", "skill-authoring": "def" },
    getSkillSnapshot: undefined as (() => { skillNames: string[]; skillDigests: Record<string, string> }) | undefined,
    getPromptInspection: vi.fn(() => promptInspection),
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
    _invalidated: false,
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

function makeFakeSessionManager(ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-ledger-"))) {
  const sessions = new Map<string, ReturnType<typeof makeFakeSession>>();
  const getOrCreateCalls: any[] = [];
  return {
    sessions,
    getOrCreateCalls,
    ledgerDir,
    userId: "u",
    agentId: "a",
    // The REAL file-backed ledger, so these tests exercise the durability that
    // the cross-restart de-duplication depends on rather than a stub of it.
    hasAcceptedTurn: (sessionId: string, turnId: string) =>
      hasAcceptedTurn(path.join(ledgerDir, sessionId), turnId),
    recordAcceptedTurn: (sessionId: string, turnId: string) =>
      recordAcceptedTurn(path.join(ledgerDir, sessionId), turnId),
    agentTypeState: "sre",
    activeCount: () => sessions.size,
    // Resident is not the same as busy — box-status reports both.
    inFlightCount: () => Array.from(sessions.values()).filter((s) => !s._promptDone).length,
    subagentStats: () => ({ active: 0, pending: 0, limit: 50 }),
    list: () => Array.from(sessions.values()),
    get: (id: string) => sessions.get(id),
    hasRestorableSessionContext: (id?: string) => Boolean(id && sessions.has(id)),
    stopSessionJobs: vi.fn(() => 0),
    markPendingAbort: vi.fn(),
    consumePendingAbort: vi.fn(() => false),
    discardPendingNotifications: vi.fn(),
    getOrCreate: async (
      id?: string,
      _mode?: unknown,
      _systemPromptTemplate?: unknown,
      activeMode?: unknown,
      _delegation?: unknown,
      userId?: string,
      allowInputRequest?: boolean,
    ) => {
      getOrCreateCalls.push({ id, activeMode, userId, allowInputRequest });
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
    invalidate: (_id: string) => {},
    setDelegationModel: vi.fn(),
    persistModelRouteState: vi.fn(),
    getPersistedDpState: (_id: string): { active: boolean } | null => null,
    onSessionRelease: undefined as undefined | (() => void),
    credentialBroker: undefined,
    credentialsDir: undefined,
    // K8s shape: knowledgeDir stays unset (only LocalSpawner assigns it).
    syncKnowledgeIndex: vi.fn(async () => {}),
  };
}

async function getJson(port: number, path: string, method = "GET", body?: unknown): Promise<{ status: number; data: any; headers: Headers }> {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: resp.status, data, headers: resp.headers };
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

  it("GET /api/sync-status uses the box's agent-scoped knowledge directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "http-sync-status-"));
    const knowledgeDir = path.join(root, "knowledge");
    const sharedKnowledgeDir = path.join(root, "shared-knowledge");
    const skillsDir = path.join(root, "skills");
    fs.mkdirSync(path.join(skillsDir, "resolved", "k8s-debug"), { recursive: true });
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, ".sync-manifest.json"), JSON.stringify({
      syncedAt: "2026-08-18T08:00:00.000Z",
      repos: [{ id: "kb-1", name: "hardware", version: 2, sha256: "abc", fileCount: 12 }],
    }));
    mockConfigState.knowledgeDir = sharedKnowledgeDir;
    mockConfigState.skillsDir = skillsDir;
    mockConfigState.mcpServers = { incidents: { transport: "http" } };
    try {
      await new Promise<void>((resolve) => (server as http.Server).close(() => resolve()));
      (sm as any).knowledgeDir = knowledgeDir;
      server = createHttpServer(sm as any);
      port = await startServer(server);

      const r = await getJson(port, "/api/sync-status");
      expect(r.status).toBe(200);
      expect(r.data).toEqual({
        schemaVersion: AGENT_SYNC_STATUS_SCHEMA_VERSION,
        knowledge: {
          syncedAt: "2026-08-18T08:00:00.000Z",
          repos: [{ id: "kb-1", name: "hardware", version: 2, sha256: "abc", fileCount: 12 }],
        },
        skills: { names: ["k8s-debug"] },
        mcp: { names: ["incidents"] },
        harness: null,
        model: null,
        // null = no successful turn observed yet, which is NOT the same as a turn
        // that ran without tiers ({menuRevision: null, candidatesRevision: null}).
        // Same convention as harness/model above.
        tiers: null,
      });
    } finally {
      mockConfigState.knowledgeDir = "knowledge";
      mockConfigState.skillsDir = "skills";
      mockConfigState.mcpServers = {};
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a release model only after a successful turn completes", async () => {
    const session = await sm.getOrCreate("observed-model");
    session.getSkillSnapshot = vi.fn(() => ({
      skillNames: ["personal-probe-v2", "skill-authoring"],
      skillDigests: { "personal-probe-v2": "v2", "skill-authoring": "def" },
    }));
    session.brain.prompt.mockImplementation(async () => {
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const before = await getJson(port, "/api/sync-status");
    expect(before.data.model).toBeNull();
    expect(before.data.harness).toBeNull();

    const prompt = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "observed-model",
      modelProvider: "openai",
      modelId: "gpt-4",
      releaseId: "release-2",
      modelFingerprint: "fingerprint-2",
      systemPromptTemplate: "You are the personal preview.",
    });
    expect(prompt.status).toBe(200);
    await flushAsync();

    const after = await getJson(port, "/api/sync-status");
    expect(after.data.model).toMatchObject({
      releaseId: "release-2",
      modelFingerprint: "fingerprint-2",
    });
    expect(new Date(after.data.model.observedAt).toString()).not.toBe("Invalid Date");
    expect(after.data.harness).toMatchObject({
      agentType: "sre",
      systemPromptTemplate: "You are the personal preview.",
      skillNames: ["personal-probe-v2", "skill-authoring"],
      skillDigests: { "personal-probe-v2": "v2", "skill-authoring": "def" },
      toolNames: ["bash", "preview_echo"],
    });
    expect(session.getSkillSnapshot).toHaveBeenCalledOnce();
    expect(new Date(after.data.harness.observedAt).toString()).not.toBe("Invalid Date");
  });

  it("does not verify the release model when a fallback answered the turn", async () => {
    const session = await sm.getOrCreate("observed-fallback");
    session.brain.prompt.mockImplementation(async () => {
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });
    const prompt = await getJson(port, "/api/prompt", "POST", {
      text: "hi", sessionId: "observed-fallback",
      modelProvider: "missing-provider", modelId: "missing-model",
      modelConfig: modelConfigWithInput(["text"]),
      releaseId: "release-2", modelFingerprint: "fingerprint-2",
      modelRouting: {
        enabled: true, strategy: "ordered_fallback",
        candidates: [
          { provider: "missing-provider", modelId: "missing-model", modelConfig: modelConfigWithInput(["text"]) },
          { provider: "anthropic", modelId: "claude" },
        ],
      },
    });
    expect(prompt.status).toBe(200);
    await flushAsync();
    expect((await getJson(port, "/api/sync-status")).data.model).toBeNull();
  });

  it("does not verify the release model when the successful turn has no observed candidate", async () => {
    const session = await sm.getOrCreate("unidentified-model");
    session.brain.getModel.mockReturnValue(undefined);

    const prompt = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "unidentified-model",
      releaseId: "release-2",
      modelFingerprint: "fingerprint-2",
    });
    expect(prompt.status).toBe(200);
    await flushAsync();

    expect((await getJson(port, "/api/sync-status")).data.model).toBeNull();
  });

  it("GET /api/internal/box-status reports drained when the box holds nothing", async () => {
    // The Runtime routes on this: `drained` must come FROM the box, because a session can
    // have no in-flight turn while a background sub-agent still runs under it.
    const r = await getJson(port, "/api/internal/box-status");
    expect(r.status).toBe(200);
    expect(r.data.drained).toBe(true);
    expect(r.data.sessionIds).toEqual([]);
    expect(r.data.turnsInFlight).toBe(0);
    expect(r.data.backgroundWork).toBe(0);
    expect(r.data.subagents).toMatchObject({ active: 0, pending: 0 });
  });

  it("GET /api/models returns models from config.providers", async () => {
    const r = await getJson(port, "/api/models");
    expect(r.status).toBe(200);
    expect(r.data.models).toEqual([
      { id: "gpt-4", name: "GPT-4", provider: "openai", contextWindow: 128000, maxTokens: 4096, reasoning: false },
    ]);
  });
});

describe("http-server — sub-agent tier turn state", () => {
  const REV = "a".repeat(64);
  const tiers = {
    revision: REV,
    candidates: [{
      tier: "fast",
      provider: "p",
      modelId: "m",
      modelConfig: { apiKey: "tier-secret", baseUrl: "https://tier.invalid", models: [] },
    }],
  };

  it("installs candidates for the turn and CLEARS them when it ends", async () => {
    // Credential-bearing turn state. A later SYNTHETIC turn carries no HTTP body,
    // so anything left behind would be silently reused — the previous turn's model
    // and its apiKey, past a rotation.
    const r = await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "tier-1", subagentTiers: tiers });
    expect(r.status).toBe(200);
    const managed = sm.sessions.get("tier-1");
    expect(managed).toBeDefined();
    expect(managed!.subagentTierCandidates).toBeNull();
    expect(managed!.effectiveModelCandidate).toBeNull();
  });

  /** A turn that actually SUCCEEDS: the routing runner reports failure on an
   *  empty response, and the observation block only runs on success. */
  async function succeedingSession(id: string) {
    const session = await sm.getOrCreate(id);
    session.brain.prompt.mockImplementation(async () => {
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });
    return session;
  }

  it("reports the turn's tier revisions on /api/sync-status, recorded before the clear", async () => {
    // The box implements tiering entirely on the turn path; without this field it
    // ran correctly while being unable to state that it had, and every way the
    // two channels fail to pair is silent.
    //
    // The ordering is the whole risk: `actuallyFinish` nulls the candidates at the
    // end of every turn, so an observation taken after it would report
    // `candidatesRevision: null` always — a self-report that permanently claims
    // the feature is broken is worse than no self-report.
    await succeedingSession("tier-obs");
    await getJson(port, "/api/prompt", "POST", {
      text: "hi", sessionId: "tier-obs", subagentTiers: tiers,
      modelProvider: "openai", modelId: "gpt-4",
    });
    await flushAsync();

    const status = await getJson(port, "/api/sync-status");
    expect(status.data.tiers).toMatchObject({ candidatesRevision: REV });
    // ...and the turn state really was cleared afterwards. The report is a record
    // of what ran, not the credential-bearing state staying alive to be read.
    expect(sm.sessions.get("tier-obs")!.subagentTierCandidates).toBeNull();
    expect(JSON.stringify(status.data)).not.toContain("tier-secret");
  });

  it("still reports the object when a turn carried no tiers at all", async () => {
    // Emitted with both revisions null rather than omitted. A field that appeared
    // only when tiering worked would make a box that LOST its tiers look identical
    // to one released before this field existed — the exact ambiguity it exists to
    // remove, and the reason a consumer cannot use "validate if present, skip if
    // absent".
    await succeedingSession("tier-none");
    await getJson(port, "/api/prompt", "POST", {
      text: "hi", sessionId: "tier-none", modelProvider: "openai", modelId: "gpt-4",
    });
    await flushAsync();

    const status = await getJson(port, "/api/sync-status");
    expect(status.data.tiers).toMatchObject({ menuRevision: null, candidatesRevision: null });
    expect(typeof status.data.tiers.observedAt).toBe("string");
  });

  it("clears them on a turn that never carried any", async () => {
    // Absent means "no tiers this turn", which must overwrite rather than preserve.
    await getJson(port, "/api/prompt", "POST", { text: "one", sessionId: "tier-2", subagentTiers: tiers });
    await getJson(port, "/api/prompt", "POST", { text: "two", sessionId: "tier-2" });
    expect(sm.sessions.get("tier-2")!.subagentTierCandidates).toBeNull();
  });

  it("ignores a malformed payload instead of failing the turn", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "tier-3",
      subagentTiers: { revision: "not-hex", candidates: [] },
    });
    expect(r.status).toBe(200);
    expect(sm.sessions.get("tier-3")!.subagentTierCandidates).toBeNull();
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

  it("POST /api/prompt keeps a multibyte character split across two TCP writes intact", async () => {
    // The body reader used to do `body += chunk` on raw Buffers, which decodes
    // every data event on its own: a character straddling the boundary became two
    // U+FFFD. Prompts arrive through this reader, so that silently rewrote user
    // text — the same defect corrupted an em dash inside a synced SKILL.md.
    const session = await sm.getOrCreate("split-1");
    const text = "查一下 kubelet — 日志";
    const payload = Buffer.from(JSON.stringify({ text, sessionId: "split-1" }), "utf8");
    // Split inside the em dash (3 bytes in UTF-8): one byte before the boundary,
    // two after, so neither half is a valid sequence on its own.
    const emDashAt = payload.indexOf(Buffer.from("—", "utf8"));
    expect(emDashAt).toBeGreaterThan(0);
    const splitAt = emDashAt + 1;

    const nodeHttp = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = nodeHttp.request(
        {
          host: "127.0.0.1", port, path: "/api/prompt", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": payload.length },
        },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
      );
      req.on("error", reject);
      req.write(payload.subarray(0, splitAt));
      // A gap the server cannot coalesce — two data events, boundary mid-character.
      setTimeout(() => req.end(payload.subarray(splitAt)), 20);
    });

    expect(status).toBe(200);
    expect(session.brain.prompt).toHaveBeenCalledWith(text, undefined);
    const seen = (session.brain.prompt as any).mock.calls[0][0] as string;
    expect(seen).not.toContain("�");
  });

  it("POST /api/prompt forwards a strict result-tool requirement only when supplied", async () => {
    const session = await sm.getOrCreate("strict-result");
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "strict-result",
      requiredResultToolName: "mcp__result__submit",
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(session.brain.prompt).toHaveBeenCalledWith(
      "hi",
      undefined,
      { requiredResultToolName: "mcp__result__submit" },
    );
  });

  it("POST /api/prompt rejects a non-string strict result-tool requirement", async () => {
    const session = await sm.getOrCreate("invalid-strict-result");
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "invalid-strict-result",
      requiredResultToolName: { name: "mcp__result__submit" },
    });

    expect(r.status).toBe(400);
    expect(session.brain.prompt).not.toHaveBeenCalled();
  });

  it("POST /api/prompt falls back to a healthy secondary when the bound primary is missing", async () => {
    // The binding is handed to the routing runner as the primary candidate rather
    // than resolved before it, so a primary that cannot be found is an ordinary
    // model_not_found — a default fallback condition — and the secondary still
    // gets its turn. Resolving it beforehand and failing the request outright is
    // what took this away.
    const session = await sm.getOrCreate("bound-missing-fallback");
    const seenModels: string[] = [];
    session.brain.prompt.mockImplementation(async () => {
      const model = session.brain.getModel();
      seenModels.push(`${model.provider}/${model.id}`);
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "bound-missing-fallback",
      modelProvider: "sicore-custom-x",
      modelId: "claude-fable-5",
      modelConfig: modelConfigWithInput(["text"]),
      modelRouting: {
        enabled: true,
        strategy: "ordered_fallback",
        candidates: [
          { provider: "sicore-custom-x", modelId: "claude-fable-5", modelConfig: modelConfigWithInput(["text"]) },
          { provider: "anthropic", modelId: "claude" },
        ],
      },
    });
    await flushAsync();

    expect(r.status).toBe(200);
    // The missing primary never ran; the healthy secondary answered.
    expect(seenModels).toEqual(["anthropic/claude"]);
    expect(session._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(true);
  });

  it("POST /api/prompt does not answer on the previous model when the bound model is missing and there is no fallback", async () => {
    // With one candidate there is nothing to fall back to, so the run exhausts and
    // reports it. What must NOT happen is the old silent behaviour: skipping the
    // binding and answering on whichever model the session was already on.
    const session = await sm.getOrCreate("bound-missing-exhaust");

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "bound-missing-exhaust",
      modelProvider: "sicore-custom-x",
      modelId: "claude-fable-5",
      modelConfig: modelConfigWithInput(["text"]),
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(session.brain.prompt).not.toHaveBeenCalled();
    const exhausted = session._extraEventBuffer.find((event) => event.type === "model_route_exhausted");
    expect(exhausted).toBeDefined();
    expect(JSON.stringify(exhausted)).toContain("sicore-custom-x/claude-fable-5");
  });

  it("POST /api/prompt surfaces a provider config pi refused, and does not fall back on it by default", async () => {
    // pi's validateProviderConfig throws BEFORE registering anything, so the
    // provider does not exist afterwards. Registration now happens per candidate
    // inside the runner, so the throw becomes that candidate's setup failure with
    // pi's own message attached — where it used to be a console.warn and the turn
    // carried on, failing later as an upstream 4xx two layers from the cause.
    //
    // It classifies as `unknown`, which is deliberately NOT a default fallback
    // kind: a refused config is a misconfiguration, not a transient condition, and
    // silently answering from a second provider would hide it. An operator who
    // wants that behaviour adds the kind to the policy's `fallbackOn` — the
    // decision stays in the policy rather than being hardcoded upstream of it.
    const session = await sm.getOrCreate("reg-fail");
    session.brain.registerProvider = vi.fn(() => {
      throw new Error('Provider p: "apiKey" or "oauth" is required when defining models.');
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "reg-fail",
      modelProvider: "sicore-custom-x",
      modelId: "claude-fable-5",
      modelConfig: modelConfigWithInput(["text"]),
      modelRouting: {
        enabled: true,
        strategy: "ordered_fallback",
        candidates: [
          { provider: "sicore-custom-x", modelId: "claude-fable-5", modelConfig: modelConfigWithInput(["text"]) },
          { provider: "anthropic", modelId: "claude" },
        ],
      },
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(session.brain.prompt).not.toHaveBeenCalled();
    expect(session._extraEventBuffer.some((event) => event.type === "model_route_switch")).toBe(false);
    const exhausted = session._extraEventBuffer.find((event) => event.type === "model_route_exhausted");
    expect(exhausted).toBeDefined();
    // pi's own reason has to reach the failure, or the operator is told only that
    // "a model was not found" for what is actually a missing apiKey.
    expect(JSON.stringify(exhausted)).toContain("apiKey");
  });

  it("POST /api/prompt registers the bound primary when the policy carries identities only", async () => {
    // ModelRouteCandidate.modelConfig is OPTIONAL, and the top-level modelConfig is
    // the documented registration config for the turn — so a policy naming only
    // provider/model is valid at this boundary. Both control planes in tree hydrate
    // every candidate, which is exactly why dropping the binding here would be
    // invisible from their side: the primary's provider would go unregistered and
    // the candidate skipped as model_not_found.
    const session = await sm.getOrCreate("unhydrated-policy");
    const config = modelConfigWithInput(["text"]);
    session.brain.prompt.mockImplementation(async () => {
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "unhydrated-policy",
      modelProvider: "anthropic",
      modelId: "claude",
      modelConfig: config,
      modelRouting: {
        enabled: true,
        strategy: "ordered_fallback",
        candidates: [
          { provider: "anthropic", modelId: "claude" },
          { provider: "deepseek", modelId: "deepseek-chat" },
        ],
      },
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(session.brain.registerProvider).toHaveBeenCalledWith("anthropic", config);
    // The fallback candidate is NOT handed the primary's config — it may be a
    // different provider entirely.
    expect(session.brain.registerProvider).toHaveBeenCalledTimes(1);
    expect(session.brain.getModel().id).toBe("claude");
  });

  it("POST /api/prompt keeps the requested reasoning effort across a non-reasoning → reasoning switch", async () => {
    // The session is on a NON-reasoning model and the turn binds a reasoning one
    // with reasoning_effort=high. Applied before the switch, pi clamps high to off
    // on the current model, does not persist it, and setModel then restores the
    // previous default — so the effort the caller asked for is silently lost on the
    // first turn. Params must be applied after the candidate's setModel.
    const session = await sm.getOrCreate("effort-switch");
    expect(session.brain.getModel().reasoning).toBe(false);

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "think hard",
      sessionId: "effort-switch",
      modelProvider: "anthropic",
      modelId: "claude",
      modelConfig: { ...modelConfigWithInput(["text"]), params: { reasoning_effort: "high" } },
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(session.brain.getModel().id).toBe("claude");
    expect(session.brain.getThinkingLevel()).toBe("high");
  });

  it("POST /api/prompt applies the turn's reasoning effort to a fallback candidate too", async () => {
    // Candidates are hydrated with their PROVIDER config, which carries no params,
    // so a fallback that read only its own config would run at whatever level the
    // failed primary left behind rather than the effort the caller asked for.
    const session = await sm.getOrCreate("effort-fallback");
    const levels: string[] = [];
    session.brain.prompt.mockImplementation(async () => {
      const model = session.brain.getModel();
      levels.push(`${model.id}:${session.brain.getThinkingLevel()}`);
      if (model.provider === "openai") {
        session.brain.emitter.emit("event", {
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" },
        });
        return;
      }
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "think hard",
      sessionId: "effort-fallback",
      modelConfig: { params: { reasoning_effort: "high" } },
      modelRouting: {
        enabled: true,
        strategy: "ordered_fallback",
        candidates: [
          { provider: "openai", modelId: "gpt-4" },
          { provider: "anthropic", modelId: "claude" },
        ],
      },
    });
    await flushAsync();

    expect(r.status).toBe(200);
    // gpt-4 cannot think, so "off" there is correct — the point is claude gets high.
    expect(levels).toEqual(["gpt-4:off", "claude:high"]);
  });

  it("POST /api/prompt still tolerates an unknown model when no modelConfig was sent", async () => {
    // Without a modelConfig there is nothing to register, so the caller is naming
    // a model it expects to already exist. If it does not, the session stays on its
    // current model — a tolerance that predates routing and is deliberately kept,
    // which is why the binding is dropped rather than routed on.
    const session = await sm.getOrCreate("no-config");
    // Only the named model is missing. Stubbing findModel to return nothing for
    // EVERY id (as this test used to) also breaks resolution of the model the
    // session falls back to, so the turn exhausted and the assertions below could
    // not tell that apart from the tolerance working.
    const realFindModel = session.brain.findModel;
    session.brain.findModel = vi.fn((provider: string, id: string) =>
      id === "gpt-4-does-not-exist" ? undefined : realFindModel(provider, id),
    );

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "hi",
      sessionId: "no-config",
      modelProvider: "openai",
      modelId: "gpt-4-does-not-exist",
    });
    await flushAsync();

    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.error).toBeUndefined();
    expect(session.brain.setModel).not.toHaveBeenCalled();
    expect(session.brain.prompt).toHaveBeenCalled();
  });

  it("POST /api/prompt keeps forwarding brain events while a deferred compaction finishes", async () => {
    // Brain events are diverted to the routing runner only while a fallback could
    // still discard the attempt. Once the prompt resolves nothing can be
    // discarded — but runAttempt has also unsubscribed by then, so leaving the
    // diversion on drops everything in the window this branch exists to wait for.
    // auto_compaction_end is the sharp case: it is the ONLY thing that clears the
    // frontend's compacting state, so losing it pins the UI there for good.
    const session = await sm.getOrCreate("compact-window");
    session.brain.prompt.mockImplementation(async () => {
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
      // Compaction kicked off during the turn and is still running as it resolves.
      session.isCompacting = true;
    });

    const r = await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "compact-window" });
    await flushAsync();

    expect(r.status).toBe(200);
    // Close is deferred, so the consumer is still attached and must still be fed.
    expect(session._promptDone).toBe(false);
    expect(session._routeBrainEventsThroughExtra).toBe(false);

    session._eventBuffer.length = 0;
    session.isCompacting = false;
    session.brain.emitter.emit("event", { type: "auto_compaction_end" });
    // The live subscription and this buffer share the same gate, so landing here
    // is what proves the event is no longer dropped on the floor.
    expect(session._eventBuffer.some((e: any) => e?.type === "auto_compaction_end")).toBe(true);
  });

  it("POST /api/prompt has the live path open the moment the runner lets go", async () => {
    // The window is not observable from a prompt-scoped mock: an event queued
    // from inside brain.prompt still fires while the runner is subscribed (so it
    // travels the runner's own channel), and anything scheduled as a macrotask
    // lands after .then, which the old code also survived. What is observable —
    // and what the gap consisted of — is WHEN the gate opens: with the handoff
    // driven from inside the attempt it is already open when brain.prompt
    // returns, so nothing can fall between the two owners. The ordering itself is
    // pinned in model-routing.test.ts ("gives delivery back before unsubscribing").
    const session = await sm.getOrCreate("compact-race");
    let gateWhenPromptReturned: boolean | undefined;
    session.brain.prompt.mockImplementation(async () => {
      session.brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
      session.isCompacting = true;
      queueMicrotask(() => { gateWhenPromptReturned = session._routeBrainEventsThroughExtra; });
    });

    const r = await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "compact-race" });
    await flushAsync();

    expect(r.status).toBe(200);
    // Still deferred (compaction was in flight), so the consumer is attached…
    expect(session._promptDone).toBe(false);
    // …and an event arriving now reaches it rather than being dropped.
    session._eventBuffer.length = 0;
    session.isCompacting = false;
    session.brain.emitter.emit("event", { type: "auto_compaction_end" });
    expect(session._eventBuffer.some((e: any) => e?.type === "auto_compaction_end")).toBe(true);
    // Recorded for the record: the runner's own channel covered the earlier
    // instant, which is why that timing was never the lossy one.
    expect(gateWhenPromptReturned).toBe(true);
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

  it("passes the prompt user identity into session creation", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "inspect the cluster",
      sessionId: "owned-session",
      userId: "user-42",
    });

    expect(r.status).toBe(200);
    expect(sm.getOrCreateCalls.at(-1)?.userId).toBe("user-42");
  });

  it("passes allowInputRequest into session creation", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "inspect the cluster",
      sessionId: "a2a-new",
      allowInputRequest: true,
    });

    expect(r.status).toBe(200);
    expect(r.data.resumed).toBe(false);
    expect(sm.getOrCreateCalls.at(-1)?.allowInputRequest).toBe(true);
  });

  it("fails closed when a required session context is unavailable", async () => {
    const r = await getJson(port, "/api/prompt", "POST", {
      text: "the cluster is sh-1",
      sessionId: "missing-session",
      requireExistingSession: true,
    });

    expect(r.status).toBe(412);
    expect(r.data.error).toEqual({
      code: "SESSION_CONTEXT_UNAVAILABLE",
      message: "The requested session context is unavailable and cannot be resumed",
      retriable: false,
      status: 412,
    });
    expect(sm.getOrCreateCalls).toHaveLength(0);
  });

  it("marks an accepted continuation as resumed", async () => {
    await sm.getOrCreate("existing-session");
    sm.getOrCreateCalls.length = 0;

    const r = await getJson(port, "/api/prompt", "POST", {
      text: "the cluster is sh-1",
      sessionId: "existing-session",
      allowInputRequest: true,
      requireExistingSession: true,
    });

    expect(r.status).toBe(200);
    expect(r.data.resumed).toBe(true);
    expect(sm.getOrCreateCalls.at(-1)?.allowInputRequest).toBe(true);
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

  it("GET /api/sessions/:id/prompt-inspection returns exact data only for a resident session", async () => {
    const session = await sm.getOrCreate("s-prompt");

    const resident = await getJson(port, "/api/sessions/s-prompt/prompt-inspection");
    const missing = await getJson(port, "/api/sessions/ghost/prompt-inspection");

    expect(resident.status).toBe(200);
    expect(resident.headers.get("cache-control")).toBe("no-store");
    expect(resident.data.prompt.text).toBe("exact prompt");
    expect(session.getPromptInspection).toHaveBeenCalledOnce();
    expect(missing.status).toBe(404);
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
    const s = await sm.getOrCreate("st2");
    let finishPrompt!: () => void;
    s.brain.prompt.mockImplementation(() => new Promise<void>((resolve) => { finishPrompt = resolve; }));
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "st2" });
    const r = await getJson(port, "/api/sessions/st2/steer", "POST", { text: "stop" });
    expect(r.status).toBe(200);
    expect(r.data.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.brain.steer).toHaveBeenCalledWith("stop");
    finishPrompt();
    await flushAsync();
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
    // #6 pre-spawn. A Stop that names no turn arms the latch session-wide, which is
    // what the Stop button means; a turn-scoped caller narrows it (see the turnId tests).
    expect(sm.markPendingAbort).toHaveBeenCalledWith("ghost-bg", undefined);
  });

  it("does not stop the running turn for an abort that names another one", async () => {
    // A session id names a conversation, and a delegated peer session is reused
    // across turns, so a supervisor's late abort would otherwise stop a successor.
    await getJson(port, "/api/prompt", "POST", { text: "hi", sessionId: "turns", turnId: "turn-2" });
    const s = sm.sessions.get("turns")!;

    const other = await getJson(port, "/api/sessions/turns/abort", "POST", { turnId: "turn-1" });
    expect(other.status).toBe(200);
    expect(s.brain.clearQueue).not.toHaveBeenCalled();
    expect(s._aborted).toBe(false);
    // Not "already finished": a named turn that is not running may equally be one
    // whose prompt is still in flight, so the intent is recorded for that turn.
    expect(other.data).toMatchObject({ ok: true, pending: true });
    expect(sm.markPendingAbort).toHaveBeenCalledWith("turns", "turn-1");

    const current = await getJson(port, "/api/sessions/turns/abort", "POST", { turnId: "turn-2" });
    expect(current.status).toBe(200);
    expect(s._aborted).toBe(true);
  });

  it("scopes a pre-spawn latch to the turn that armed it", async () => {
    await getJson(port, "/api/sessions/ghost-turn/abort", "POST", { turnId: "turn-1" });
    expect(sm.markPendingAbort).toHaveBeenCalledWith("ghost-turn", "turn-1");
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
    // 200, not 500: setModel now runs inside the routing runner (per candidate),
    // so a throw there is that candidate's setup failure and is reported through
    // the route events, not as a rejected HTTP request. What this test is about is
    // unchanged — the locks below must still be free, or the session 409s forever.
    expect(fail.status).toBe(200);
    await flushAsync();
    expect(s._extraEventBuffer.some((event) => event.type === "model_route_exhausted")).toBe(true);
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

  it("POST /api/reload-knowledge re-syncs the label index even when sessionManager.knowledgeDir is unset (K8s shape)", async () => {
    // K8s boxes never set sessionManager.knowledgeDir (only LocalSpawner does),
    // and the per-server knowledge handler used to be gated on it — so a hot
    // update materialized new files while knowledge_search kept serving the
    // label index built at pod start. Pin the wiring: the handler exists
    // without the dir, and its materialize drives syncKnowledgeIndex.
    process.env.SICLAW_GATEWAY_URL = "http://gateway.test";
    const r = await getJson(port, "/api/reload-knowledge", "POST");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, type: "knowledge" });
    expect(knowledgeHandlerState.lastOptions?.knowledgeDir).toBeUndefined();
    expect(sm.syncKnowledgeIndex).toHaveBeenCalledTimes(1);
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

describe("http-server — Skill handler wiring", () => {
  it("does not disable empty-bundle preservation on the K8s/hot-reload path", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "http-server.ts"), "utf8");
    expect(src).toContain("createSkillsHandler");
    expect(src).not.toContain("preserveExistingOnEmpty");
  });
});

// ── Authority envelope binding + the turn ledger ──────────────────────────────

describe("http-server — authority envelope binding", () => {
  const SECRET = "test-authority-secret";
  const origSecret = process.env.SICLAW_AUTHORITY_SECRET;

  function sign(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims));
    const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
    return `${payload.toString("base64url")}.${sig}`;
  }
  const baseClaims = (extra: Record<string, unknown> = {}) => ({
    authorityId: "authz_1",
    issuer: "control-plane",
    subject: "workload/w1",
    targetAgentId: "a", // the fake session manager's own agentId
    effectCeiling: "observe",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    nonce: "n1",
    ...extra,
  });

  let envServer: http.Server | https.Server;
  let envPort: number;
  let envSm: ReturnType<typeof makeFakeSessionManager>;

  beforeEach(async () => {
    process.env.SICLAW_AUTHORITY_SECRET = SECRET;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SICLAW_CERT_PATH = "/tmp/nonexistent-cert-path-for-siclaw-tests";
    envSm = makeFakeSessionManager();
    envServer = createHttpServer(envSm as any);
    envPort = await startServer(envServer);
  });

  afterEach(async () => {
    await new Promise<void>((r) => (envServer as http.Server).close(() => r()));
    vi.restoreAllMocks();
    if (origSecret === undefined) delete process.env.SICLAW_AUTHORITY_SECRET;
    else process.env.SICLAW_AUTHORITY_SECRET = origSecret;
  });

  it("accepts an envelope issued for THIS agent", async () => {
    const r = await getJson(envPort, "/api/prompt", "POST", {
      text: "hi", sessionId: "bound-ok", authorityEnvelope: sign(baseClaims()),
    });
    expect(r.status).toBe(200);
  });

  it("answers 403 AUTHORITY_ENVELOPE_MISBOUND for a wrong-agent envelope", async () => {
    // The signature verifies — it is a real envelope — but it was minted for
    // another agent. Without this check a valid envelope for a low-privilege
    // agent could be replayed on a dispatch to a high-privilege one.
    const r = await getJson(envPort, "/api/prompt", "POST", {
      text: "hi", sessionId: "bound-bad",
      authorityEnvelope: sign(baseClaims({ targetAgentId: "some-other-agent" })),
    });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe("AUTHORITY_ENVELOPE_MISBOUND");
    expect(r.data.error.retriable).toBe(false);
    expect(envSm.sessions.has("bound-bad")).toBe(false);
  });

  it("answers 403 MISBOUND on a segment or task the request does not carry", async () => {
    const segment = await getJson(envPort, "/api/prompt", "POST", {
      text: "hi", sessionId: "seg-bad", authorityEnvelope: sign(baseClaims({ segmentId: "seg1" })),
    });
    expect(segment.status).toBe(403);
    expect(segment.data.error.code).toBe("AUTHORITY_ENVELOPE_MISBOUND");

    const task = await getJson(envPort, "/api/prompt", "POST", {
      text: "hi", sessionId: "task-bad", authorityEnvelope: sign(baseClaims({ taskId: "task1" })),
    });
    expect(task.status).toBe(403);

    // ...and accepts them when the request DOES carry the matching context.
    const ok = await getJson(envPort, "/api/prompt", "POST", {
      text: "hi", sessionId: "seg-ok", segmentId: "seg1", taskId: "task1",
      authorityEnvelope: sign(baseClaims({ segmentId: "seg1", taskId: "task1" })),
    });
    expect(ok.status).toBe(200);
  });

  it("still answers 403 INVALID for a tampered envelope", async () => {
    const r = await getJson(envPort, "/api/prompt", "POST", {
      text: "hi", sessionId: "bad-sig", authorityEnvelope: `${sign(baseClaims()).slice(0, -2)}zz`,
    });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe("AUTHORITY_ENVELOPE_INVALID");
  });

  it("runs a prompt with no envelope exactly as before", async () => {
    const r = await getJson(envPort, "/api/prompt", "POST", { text: "hi", sessionId: "ungoverned" });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
  });
});

describe("http-server — turn ledger (cross-restart dispatch idempotency)", () => {
  let ledgerServer: http.Server | https.Server;
  let ledgerPort: number;
  let ledgerSm: ReturnType<typeof makeFakeSessionManager>;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SICLAW_CERT_PATH = "/tmp/nonexistent-cert-path-for-siclaw-tests";
    ledgerSm = makeFakeSessionManager();
    ledgerServer = createHttpServer(ledgerSm as any);
    ledgerPort = await startServer(ledgerServer);
  });

  afterEach(async () => {
    await new Promise<void>((r) => (ledgerServer as http.Server).close(() => r()));
    vi.restoreAllMocks();
  });

  it("records an accepted turnId and answers a repeat with duplicate:true, without prompting", async () => {
    const first = await getJson(ledgerPort, "/api/prompt", "POST", { text: "hi", sessionId: "L1", turnId: "turn-1" });
    expect(first.status).toBe(200);
    expect(first.data.duplicate).toBeUndefined();
    const session = ledgerSm.sessions.get("L1")!;
    const promptsAfterFirst = session.brain.prompt.mock.calls.length;

    const repeat = await getJson(ledgerPort, "/api/prompt", "POST", { text: "hi", sessionId: "L1", turnId: "turn-1" });
    expect(repeat.status).toBe(200);
    expect(repeat.data).toMatchObject({ ok: true, sessionId: "L1", turnId: "turn-1", duplicate: true });
    // The whole point: no second turn was started.
    expect(session.brain.prompt.mock.calls.length).toBe(promptsAfterFirst);
  });

  it("treats a DIFFERENT turnId on the same session as a new turn", async () => {
    await getJson(ledgerPort, "/api/prompt", "POST", { text: "hi", sessionId: "L2", turnId: "turn-1" });
    const other = await getJson(ledgerPort, "/api/prompt", "POST", { text: "hi", sessionId: "L2", turnId: "turn-2" });
    expect(other.data.duplicate).toBeUndefined();
  });

  it("survives a fresh session-manager instance — this is the cross-restart case", async () => {
    await getJson(ledgerPort, "/api/prompt", "POST", { text: "hi", sessionId: "L3", turnId: "turn-restart" });

    // Everything in memory is gone; only the volume remains. A new manager and a
    // new server over the SAME session directory must still recognise the turn,
    // which is exactly what a Runtime restart looks like from the box's side.
    await new Promise<void>((r) => (ledgerServer as http.Server).close(() => r()));
    const revivedSm = makeFakeSessionManager(ledgerSm.ledgerDir);
    ledgerServer = createHttpServer(revivedSm as any);
    ledgerPort = await startServer(ledgerServer);

    const repeat = await getJson(ledgerPort, "/api/prompt", "POST", { text: "hi", sessionId: "L3", turnId: "turn-restart" });
    expect(repeat.data).toMatchObject({ duplicate: true, turnId: "turn-restart" });
    // No session was even created on the revived instance.
    expect(revivedSm.sessions.has("L3")).toBe(false);
  });

  it("keeps only the most recent TURN_LEDGER_MAX entries", async () => {
    const dir = path.join(ledgerSm.ledgerDir, "bounded");
    for (let i = 0; i < TURN_LEDGER_MAX + 25; i += 1) recordAcceptedTurn(dir, `t-${i}`);
    const kept = readTurnLedger(dir);
    expect(kept).toHaveLength(TURN_LEDGER_MAX);
    expect(kept.at(-1)).toBe(`t-${TURN_LEDGER_MAX + 24}`);
    // The oldest fell off; the newest are all still recognised.
    expect(hasAcceptedTurn(dir, "t-0")).toBe(false);
    expect(hasAcceptedTurn(dir, `t-${TURN_LEDGER_MAX + 24}`)).toBe(true);
  });

  it("treats a corrupt or missing ledger as empty rather than failing the turn", async () => {
    const dir = path.join(ledgerSm.ledgerDir, "corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".turn-ledger.json"), "{not json", "utf8");
    expect(readTurnLedger(dir)).toEqual([]);
    expect(hasAcceptedTurn(dir, "anything")).toBe(false);
    // And it recovers: a later record rewrites a valid file.
    recordAcceptedTurn(dir, "t-after-corruption");
    expect(hasAcceptedTurn(dir, "t-after-corruption")).toBe(true);
    // A directory that does not exist at all is simply empty.
    expect(readTurnLedger(path.join(ledgerSm.ledgerDir, "never-used"))).toEqual([]);
  });
});
