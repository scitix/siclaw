/**
 * agent.syncStatus RPC — read the running box's observed inventory.
 *
 * Reload ACK only proves the RPC ran. This path GETs /api/sync-status from a
 * running box so the developer console can show what actually landed.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { BoxSyncStatus } from "../shared/agentbox-sync-status.js";

vi.mock("./chat-repo.js", () => ({
  validTraceId: (v: unknown) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : undefined),
  warnTraceBindFailure: vi.fn(),
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));

const clientCalls: Array<{ endpoint: string; timeoutMs: number; tlsOptions: unknown }> = [];
const getJsonCalls: Array<{ endpoint: string; path: string }> = [];
const getJsonByEndpoint = new Map<string, () => Promise<unknown>>();
const defaultSyncStatus = {
  schemaVersion: 2,
  knowledge: {
    syncedAt: "2026-08-18T08:00:00.000Z",
    repos: [{ id: "kb-1", name: "硬件", version: 2, sha256: "abc" }],
  },
  skills: { names: ["k8s-debug"] },
  mcp: { names: [] },
} satisfies BoxSyncStatus;
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string, timeoutMs = 30_000, tlsOptions?: unknown) {
      this.endpoint = endpoint;
      clientCalls.push({ endpoint, timeoutMs, tlsOptions });
    }
    getJson = vi.fn(async (path: string) => {
      getJsonCalls.push({ endpoint: this.endpoint, path });
      const impl = getJsonByEndpoint.get(this.endpoint);
      if (impl) return impl();
      return defaultSyncStatus;
    });
  },
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return {
    request: vi.fn(async () => ({})),
    onCommand: vi.fn(),
    emitEvent: vi.fn(),
    close: vi.fn(),
  } as any;
}

let listReturns: Array<{ boxId: string; agentId: string; status: string; endpoint: string }> = [];
function fakeAgentBoxManager() {
  return {
    setCertManager: vi.fn(),
    setSpawnEnvResolver: vi.fn(),
    setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => ({ endpoint: "https://fake.internal" })),
    getOrCreate: vi.fn(async () => ({ endpoint: "https://fake.internal" })),
    list: vi.fn(async () => listReturns),
    cleanup: vi.fn(async () => {}),
  } as any;
}

async function bootRuntime() {
  return startRuntime({
    config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
    agentBoxManager: fakeAgentBoxManager(),
    frontendClient: fakeFrontendClient(),
    credentialService: {} as any,
  });
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  clientCalls.length = 0;
  getJsonCalls.length = 0;
  getJsonByEndpoint.clear();
  listReturns = [];
  vi.clearAllMocks();
});

describe("agent.syncStatus RPC", () => {
  it("returns no_running_box when the agent has no running pod", async () => {
    listReturns = [
      { boxId: "b1", agentId: "other", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "preview", status: "pending", endpoint: "https://b2" },
    ];
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toEqual({
      schemaVersion: 2,
      ok: true,
      available: false,
      reason: "no_running_box",
      boxes: 1,
      runningBoxes: 0,
      observedBoxes: 0,
      consistent: false,
      observations: [],
    });
    expect(getJsonCalls).toEqual([]);
  });

  it("reports zero boxes when the agent has no box at all", async () => {
    listReturns = [
      { boxId: "b1", agentId: "other", status: "running", endpoint: "https://b1" },
    ];
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toEqual({
      schemaVersion: 2,
      ok: true,
      available: false,
      reason: "no_running_box",
      boxes: 0,
      runningBoxes: 0,
      observedBoxes: 0,
      consistent: false,
      observations: [],
    });
    expect(getJsonCalls).toEqual([]);
  });

  it("reads /api/sync-status from the running box", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "preview", status: "pending", endpoint: "https://b2" },
    ];
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toEqual({
      schemaVersion: 2,
      ok: true,
      available: true,
      boxes: 2,
      runningBoxes: 1,
      observedBoxes: 1,
      consistent: true,
      observations: [{
        boxId: "b1",
        available: true,
        status: defaultSyncStatus,
      }],
      knowledge: {
        syncedAt: "2026-08-18T08:00:00.000Z",
        repos: [{ id: "kb-1", name: "硬件", version: 2, sha256: "abc" }],
      },
      skills: { names: ["k8s-debug"] },
      mcp: { names: [] },
      harness: null,
      model: null,
    });
    expect(getJsonCalls).toEqual([{ endpoint: "https://b1", path: "/api/sync-status" }]);
    expect(clientCalls).toEqual([{
      endpoint: "https://b1",
      timeoutMs: 8_000,
      tlsOptions: server.agentBoxTlsOptions,
    }]);
  });

  it("returns a consistent observed Harness while ignoring evidence timestamps", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "preview", status: "running", endpoint: "https://b2" },
    ];
    const harness = {
      agentType: "sre",
      systemPromptTemplate: "personal prompt",
      skillNames: ["personal-probe"],
      skillDigests: { "personal-probe": "abc" },
      toolNames: ["preview_echo"],
    };
    getJsonByEndpoint.set("https://b1", async () => ({
      ...defaultSyncStatus,
      harness: { ...harness, observedAt: "2026-08-26T08:00:00.000Z" },
    }));
    getJsonByEndpoint.set("https://b2", async () => ({
      ...defaultSyncStatus,
      harness: { ...harness, observedAt: "2026-08-26T08:01:00.000Z" },
    }));
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toMatchObject({
      available: true,
      consistent: true,
      harness: { ...harness, observedAt: "2026-08-26T08:00:00.000Z" },
    });
  });

  it("normalizes a partial v1 wire payload without pretending it is v2", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://v1" },
    ];
    getJsonByEndpoint.set("https://v1", async () => ({
      schemaVersion: 1,
      knowledge: { repos: [] },
    }));
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toMatchObject({
      available: true,
      consistent: true,
      observations: [{
        boxId: "b1",
        available: true,
        status: {
          schemaVersion: 1,
          knowledge: { syncedAt: null, repos: [] },
          skills: { names: [] },
          mcp: { names: [] },
        },
      }],
    });
  });

  it("observes every running box and refuses a legacy model consensus when one box differs", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "preview", status: "running", endpoint: "https://b2" },
    ];
    getJsonByEndpoint.set("https://b1", async () => ({
      ...defaultSyncStatus,
      model: {
        releaseId: "release-2",
        modelFingerprint: "fingerprint-2",
        observedAt: "2026-08-26T08:00:00.000Z",
      },
    }));
    getJsonByEndpoint.set("https://b2", async () => ({
      ...defaultSyncStatus,
      model: {
        releaseId: "release-1",
        modelFingerprint: "fingerprint-1",
        observedAt: "2026-08-26T08:01:00.000Z",
      },
    }));
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toMatchObject({
      schemaVersion: 2,
      available: true,
      boxes: 2,
      runningBoxes: 2,
      observedBoxes: 2,
      consistent: false,
      model: null,
      observations: [
        {
          boxId: "b1",
          available: true,
          status: { model: { releaseId: "release-2", modelFingerprint: "fingerprint-2" } },
        },
        {
          boxId: "b2",
          available: true,
          status: { model: { releaseId: "release-1", modelFingerprint: "fingerprint-1" } },
        },
      ],
    });
    expect(getJsonCalls).toEqual([
      { endpoint: "https://b1", path: "/api/sync-status" },
      { endpoint: "https://b2", path: "/api/sync-status" },
    ]);
  });

  it("returns partial per-box evidence without exposing transport errors", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "preview", status: "running", endpoint: "https://secret.internal" },
    ];
    getJsonByEndpoint.set("https://secret.internal", async () => {
      throw new Error("connect ETIMEDOUT https://secret.internal?token=secret");
    });
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    const result = await syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any);
    expect(result).toMatchObject({
      schemaVersion: 2,
      available: true,
      runningBoxes: 2,
      observedBoxes: 1,
      consistent: false,
      model: null,
      observations: [
        { boxId: "b1", available: true },
        { boxId: "b2", available: false, reason: "query_failed" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret.internal");
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("marks an old box image as unsupported", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://old" },
    ];
    getJsonByEndpoint.set("https://old", async () => {
      throw new Error("GET /api/sync-status failed: 404");
    });
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toEqual({
      schemaVersion: 2,
      ok: true,
      available: false,
      reason: "unsupported",
      boxes: 1,
      runningBoxes: 1,
      observedBoxes: 0,
      consistent: false,
      observations: [{ boxId: "b1", available: false, reason: "unsupported" }],
    });
  });

  it("keeps the actionable unsupported reason when every running box fails", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://old" },
      { boxId: "b2", agentId: "preview", status: "running", endpoint: "https://broken" },
    ];
    getJsonByEndpoint.set("https://old", async () => {
      throw new Error("GET /api/sync-status failed: 404");
    });
    getJsonByEndpoint.set("https://broken", async () => {
      throw new Error("connect ETIMEDOUT");
    });
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toEqual({
      schemaVersion: 2,
      ok: true,
      available: false,
      reason: "unsupported",
      boxes: 2,
      runningBoxes: 2,
      observedBoxes: 0,
      consistent: false,
      observations: [
        { boxId: "b1", available: false, reason: "unsupported" },
        { boxId: "b2", available: false, reason: "query_failed" },
      ],
    });
    expect(getJsonCalls).toEqual([
      { endpoint: "https://old", path: "/api/sync-status" },
      { endpoint: "https://broken", path: "/api/sync-status" },
    ]);
  });
});

describe("agent.promptInspection RPC", () => {
  const inspection = {
    version: "prompt-inspection/v1",
    stage: "provider_wire",
    agentType: "knowledge_qa",
    mode: "web",
    prompt: { text: "exact effective prompt", chars: 22, sha256: "same-hash" },
    layers: [],
    tools: [],
    skills: [],
    design: { standard: "siclaw-prompt-design/v1", verdict: "pass", checks: [], references: [] },
  };

  it("returns one exact inspection and hash-only replica observations", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "preview", status: "running", endpoint: "https://b2" },
    ];
    getJsonByEndpoint.set("https://b1", async () => inspection);
    getJsonByEndpoint.set("https://b2", async () => ({ ...inspection }));
    server = await bootRuntime();
    const inspect = server.rpcMethods.get("agent.promptInspection")!;

    const result = await inspect({ agentId: "preview", sessionId: "session/1" }, { sendEvent: vi.fn() } as any);

    expect(result).toMatchObject({
      ok: true,
      available: true,
      consistent: true,
      inspection: { prompt: { text: "exact effective prompt", sha256: "same-hash" } },
      observations: [
        { boxId: "b1", available: true, promptSha256: "same-hash", stage: "provider_wire" },
        { boxId: "b2", available: true, promptSha256: "same-hash", stage: "provider_wire" },
      ],
    });
    expect(JSON.stringify(result.observations)).not.toContain("exact effective prompt");
    expect(getJsonCalls.map((call) => call.path)).toEqual([
      "/api/sessions/session%2F1/prompt-inspection",
      "/api/sessions/session%2F1/prompt-inspection",
    ]);
  });

  it("reports a released session without returning prompt text", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://b1" },
    ];
    getJsonByEndpoint.set("https://b1", async () => { throw { status: 404 }; });
    server = await bootRuntime();
    const inspect = server.rpcMethods.get("agent.promptInspection")!;

    await expect(inspect(
      { agentId: "preview", sessionId: "released" },
      { sendEvent: vi.fn() } as any,
    )).resolves.toEqual({
      ok: true,
      available: false,
      reason: "session_not_resident",
      observations: [{ boxId: "b1", available: false, reason: "session_not_resident" }],
    });
  });
});
