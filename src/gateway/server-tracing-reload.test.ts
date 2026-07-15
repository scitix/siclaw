/**
 * tracing.reloadAll RPC — global tracing hot-reload broadcast.
 *
 * Contract (DESIGN module 3): enumerate ALL boxes, filter to status==="running"
 * (no agentId filter — tracing is a single global fan-out set), then POST
 * /api/reload-tracing to each via the generic AgentBoxClient.post (NOT
 * reloadResource). Each box is contained in its own try/catch so one
 * unreachable box does not block the rest; failures are counted.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("./chat-repo.js", () => ({
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));

// Capture every AgentBoxClient.post(path) call (endpoint + path), and let the
// test mark specific endpoints as failing to exercise the per-box try/catch.
const postCalls: Array<{ endpoint: string; path: string }> = [];
const failingEndpoints = new Set<string>();
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    post = vi.fn(async (path: string) => {
      postCalls.push({ endpoint: this.endpoint, path });
      if (failingEndpoints.has(this.endpoint)) throw new Error("unreachable");
      return { ok: true };
    });
    // reloadResource must NOT be used by tracing.reloadAll — assert via spy.
    reloadResource = vi.fn(async () => ({}));
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
  postCalls.length = 0;
  failingEndpoints.clear();
  listReturns = [];
  vi.clearAllMocks();
});

describe("tracing.reloadAll RPC", () => {
  it("POSTs /api/reload-tracing to EVERY running box, ignoring agentId", async () => {
    listReturns = [
      { boxId: "b1", agentId: "a1", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "a2", status: "running", endpoint: "https://b2" },
    ];
    server = await bootRuntime();
    const reloadAll = server.rpcMethods.get("tracing.reloadAll")!;

    const res = await reloadAll({}, { sendEvent: vi.fn() } as any);

    expect(res).toMatchObject({ ok: true, reloaded: 2, failed: [], boxes: 2 });
    // Both endpoints hit, with the standalone path (not a descriptor reloadPath).
    expect(postCalls.sort((a, b) => a.endpoint.localeCompare(b.endpoint))).toEqual([
      { endpoint: "https://b1", path: "/api/reload-tracing" },
      { endpoint: "https://b2", path: "/api/reload-tracing" },
    ]);
  });

  it("skips non-running boxes (Pending/Terminating have no/stale podIP)", async () => {
    listReturns = [
      { boxId: "b1", agentId: "a1", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "a2", status: "pending", endpoint: "https://b2" },
      { boxId: "b3", agentId: "a3", status: "terminating", endpoint: "https://b3" },
    ];
    server = await bootRuntime();
    const reloadAll = server.rpcMethods.get("tracing.reloadAll")!;

    const res = await reloadAll({}, { sendEvent: vi.fn() } as any);

    expect(res).toMatchObject({ ok: true, reloaded: 1, boxes: 1 });
    expect(postCalls).toEqual([{ endpoint: "https://b1", path: "/api/reload-tracing" }]);
  });

  it("contains a failing box without blocking the rest (counts failed)", async () => {
    listReturns = [
      { boxId: "b1", agentId: "a1", status: "running", endpoint: "https://b1" },
      { boxId: "b2", agentId: "a2", status: "running", endpoint: "https://b2" },
    ];
    failingEndpoints.add("https://b1");
    server = await bootRuntime();
    const reloadAll = server.rpcMethods.get("tracing.reloadAll")!;

    const res = await reloadAll({}, { sendEvent: vi.fn() } as any);

    expect(res).toMatchObject({ ok: true, reloaded: 1, failed: ["b1"], boxes: 2 });
    // The healthy box was still reached.
    expect(postCalls.some((c) => c.endpoint === "https://b2")).toBe(true);
  });

  it("returns boxes:0 when no boxes are running (no posts)", async () => {
    listReturns = [{ boxId: "b1", agentId: "a1", status: "pending", endpoint: "https://b1" }];
    server = await bootRuntime();
    const reloadAll = server.rpcMethods.get("tracing.reloadAll")!;

    const res = await reloadAll({}, { sendEvent: vi.fn() } as any);

    expect(res).toMatchObject({ ok: true, reloaded: 0, failed: [], boxes: 0 });
    expect(postCalls).toEqual([]);
  });
});
