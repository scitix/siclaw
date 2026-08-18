/**
 * agent.syncStatus RPC — read the running box's observed inventory.
 *
 * Reload ACK only proves the RPC ran. This path GETs /api/sync-status from a
 * running box so the developer console can show what actually landed.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));

const getJsonCalls: Array<{ endpoint: string; path: string }> = [];
const getJsonByEndpoint = new Map<string, () => Promise<unknown>>();
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    getJson = vi.fn(async (path: string) => {
      getJsonCalls.push({ endpoint: this.endpoint, path });
      const impl = getJsonByEndpoint.get(this.endpoint);
      if (impl) return impl();
      return {
        knowledge: { syncedAt: "2026-08-18T08:00:00.000Z", repos: [{ id: "kb-1", name: "硬件", version: 2 }] },
        skills: { names: ["k8s-debug"] },
        mcp: { names: [] },
      };
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
      ok: true,
      available: false,
      reason: "no_running_box",
      boxes: 0,
    });
    expect(getJsonCalls).toEqual([]);
  });

  it("reads /api/sync-status from the running box", async () => {
    listReturns = [
      { boxId: "b1", agentId: "preview", status: "running", endpoint: "https://b1" },
    ];
    server = await bootRuntime();
    const syncStatus = server.rpcMethods.get("agent.syncStatus")!;

    await expect(syncStatus({ agentId: "preview" }, { sendEvent: vi.fn() } as any)).resolves.toEqual({
      ok: true,
      available: true,
      boxes: 1,
      knowledge: { syncedAt: "2026-08-18T08:00:00.000Z", repos: [{ id: "kb-1", name: "硬件", version: 2 }] },
      skills: { names: ["k8s-debug"] },
      mcp: { names: [] },
    });
    expect(getJsonCalls).toEqual([{ endpoint: "https://b1", path: "/api/sync-status" }]);
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
      ok: true,
      available: false,
      reason: "unsupported",
      boxes: 1,
    });
  });
});
