import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { resolveAgentModelBinding, type ResolvedModelBinding } from "./agent-model-binding.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";

class FakeFrontendWsClient {
  calls: Array<{ method: string; params: unknown }> = [];
  responses = new Map<string, unknown>();
  nextError: Error | null = null;

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      return Promise.reject(err);
    }
    if (this.responses.has(method)) return Promise.resolve(this.responses.get(method));
    return Promise.resolve({});
  }
}

let fake: FakeFrontendWsClient;

beforeEach(() => {
  fake = new FakeFrontendWsClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAgentModelBinding", () => {
  it("calls config.getModelBinding with the supplied agentId", async () => {
    fake.responses.set("config.getModelBinding", { binding: null });
    await resolveAgentModelBinding("agent-xyz", fake as unknown as FrontendWsClient);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe("config.getModelBinding");
    expect(fake.calls[0].params).toEqual({ agentId: "agent-xyz" });
  });

  it("returns the binding payload when present", async () => {
    const binding: ResolvedModelBinding = {
      modelProvider: "anthropic",
      modelId: "claude-4.5",
      modelConfig: {
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-123",
        api: "anthropic",
        authHeader: true,
        models: [
          {
            id: "claude-4.5", name: "Claude 4.5", reasoning: false,
            input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000, maxTokens: 8192,
          },
        ],
      },
    };
    fake.responses.set("config.getModelBinding", { binding });
    const result = await resolveAgentModelBinding("agent-1", fake as unknown as FrontendWsClient);
    expect(result).toEqual(binding);
  });

  it("returns null when the payload binding is null", async () => {
    fake.responses.set("config.getModelBinding", { binding: null });
    const result = await resolveAgentModelBinding("agent-1", fake as unknown as FrontendWsClient);
    expect(result).toBeNull();
  });

  it("swallows RPC errors and returns null", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.nextError = new Error("rpc exploded");
    const result = await resolveAgentModelBinding("agent-1", fake as unknown as FrontendWsClient);
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});
