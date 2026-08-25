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

async function boot(running = true) {
  server = await startRuntime({
    config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
    agentBoxManager: fakeAgentBoxManager(running),
    frontendClient: fakeFrontendClient(),
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
      observedReleaseId: "release-2",
      observedModelFingerprint: "fingerprint-2",
    });
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
    expect(result).toMatchObject({ boxes: 0, observedReleaseId: "release-2" });
    expect(reloadCalls).toEqual([]);
  });
});
