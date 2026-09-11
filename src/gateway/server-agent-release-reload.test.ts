import { afterEach, describe, expect, it, vi } from "vitest";

const reloadCalls: string[] = [];
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    constructor(_endpoint: string) {}
    reloadResource = vi.fn(async (type: string) => { reloadCalls.push(type); });
  },
}));

const { startRuntime } = await import("./server.js");

const binding = {
  releaseId: "release-2",
  modelFingerprint: "fingerprint-2",
  modelSelectionVersion: 3,
  modelProvider: "openai",
  modelId: "gpt-4",
  modelConfig: { name: "openai", baseUrl: "", apiKey: "", api: "openai-responses", authHeader: true, models: [] },
};

function fakeFrontendClient() {
  return {
    request: vi.fn(async (method: string) => method === "config.getModelBinding" ? { binding } : null),
    onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn(),
  } as any;
}

function fakeAgentBoxManager(running = true) {
  return {
    setCertManager: vi.fn(), setSpawnEnvResolver: vi.fn(), setPersistenceResolver: vi.fn(),
    list: vi.fn(async () => running ? [{ agentId: "agent-1", boxId: "box-1", endpoint: "http://box", status: "running" }] : []),
    cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  reloadCalls.length = 0;
});

async function boot(running = true, frontendClient = fakeFrontendClient()) {
  server = await startRuntime({
    config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
    agentBoxManager: fakeAgentBoxManager(running),
    frontendClient,
    credentialService: {} as any,
  });
  return server.rpcMethods.get("agent.reload")!;
}

describe("agent.reload release model identity", () => {
  it("invalidates model sessions and returns the exact prepared release", async () => {
    const reload = await boot();
    const result = await reload({
      agentId: "agent-1", resources: ["model"],
      releaseId: "release-2", modelFingerprint: "fingerprint-2",
    }) as any;

    expect(reloadCalls).toEqual(["model"]);
    expect(result).toMatchObject({
      ok: true, boxes: 1,
      preparedReleaseId: "release-2",
      preparedModelFingerprint: "fingerprint-2",
    });
    expect(result).not.toHaveProperty("observedReleaseId");
    expect(result).not.toHaveProperty("observedModelFingerprint");
  });

  it("rejects a stale delivery before touching a box", async () => {
    const reload = await boot();
    await expect(reload({
      agentId: "agent-1", resources: ["model"],
      releaseId: "release-1", modelFingerprint: "fingerprint-1",
    })).rejects.toThrow(/does not match expected release-1/);
    expect(reloadCalls).toEqual([]);
  });

  it("reports cold-start preparation without claiming a running box", async () => {
    const reload = await boot(false);
    const result = await reload({
      agentId: "agent-1", resources: ["model"],
      releaseId: "release-2", modelFingerprint: "fingerprint-2",
    }) as any;
    expect(result).toMatchObject({ boxes: 0, preparedReleaseId: "release-2" });
    expect(reloadCalls).toEqual([]);
  });
});

describe("agent.reload model selection within one release", () => {
  it.each(["3", null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid version %s as an input error", async (modelSelectionVersion) => {
    const frontend = fakeFrontendClient();
    const reload = await boot(true, frontend);
    await expect(reload({ agentId: "agent-1", resources: ["model"], modelSelectionVersion })).rejects.toThrow("modelSelectionVersion must be a non-negative safe integer");
    expect(frontend.request).not.toHaveBeenCalledWith("config.getModelBinding", expect.anything());
    expect(reloadCalls).toEqual([]);
  });

  it("requires control-plane version support before acknowledging nonzero selections", async () => {
    const frontend = fakeFrontendClient();
    frontend.request.mockResolvedValue({ binding: { ...binding, modelSelectionVersion: undefined } });
    const reload = await boot(true, frontend);
    await expect(reload({ agentId: "agent-1", resources: ["model"], modelSelectionVersion: 1 })).rejects.toThrow(/model selection version/);
    expect(reloadCalls).toEqual([]);
    await expect(reload({ agentId: "agent-1", resources: ["model"], modelSelectionVersion: 0 })).resolves.toMatchObject({ preparedModelSelectionVersion: 0 });
  });

  it("rejects an old A -> B -> A receipt even when the model fingerprint matches", async () => {
    const reload = await boot();
    await expect(reload({agentId: "agent-1", resources: ["model"], releaseId: "release-2", modelFingerprint: "fingerprint-2", modelSelectionVersion: 1})).rejects.toThrow(/model selection version/);
    expect(reloadCalls).toEqual([]);
    const prepared = await reload({agentId: "agent-1", resources: ["model"], releaseId: "release-2", modelFingerprint: "fingerprint-2", modelSelectionVersion: 3});
    expect(prepared).toMatchObject({preparedModelSelectionVersion: 3, preparedModelFingerprint: "fingerprint-2"});
  });
});
