import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ChannelManager,
  resolveBinding,
  handlePairingCode,
  resetBindingSession,
  resolvePersonalBinding,
  handlePersonalPairingCode,
  resetPersonalSession,
  type ChannelHandler,
} from "./channel-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { AgentBoxManager } from "./agentbox/manager.js";

// ── Stub the lark channel factory to return a controllable handler ──

interface FakeHandlerRecord {
  started: boolean;
  stopped: boolean;
  receivedChannel: Record<string, unknown> | null;
}

const fakeHandlerRegistry: FakeHandlerRecord[] = [];

function makeFakeFactory() {
  return (channel: Record<string, any>) => {
    const record: FakeHandlerRecord = { started: false, stopped: false, receivedChannel: channel };
    fakeHandlerRegistry.push(record);
    const handler: ChannelHandler = {
      async start() { record.started = true; },
      async stop() { record.stopped = true; },
    };
    return handler;
  };
}

vi.mock("./channels/lark.js", () => ({
  createLarkHandler: makeFakeFactory(),
}));

vi.mock("./channels/dingtalk.js", () => ({
  createDingTalkHandler: makeFakeFactory(),
}));

class FakeFrontendClient {
  connected = true;
  calls: Array<{ method: string; params: any }> = [];
  responses = new Map<string, unknown>();
  nextError: Error | null = null;
  request(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    if (this.nextError) {
      const err = this.nextError; this.nextError = null;
      return Promise.reject(err);
    }
    return Promise.resolve(this.responses.get(method) ?? {});
  }
}

let frontend: FakeFrontendClient;
const fakeManager = {} as unknown as AgentBoxManager;

beforeEach(() => {
  fakeHandlerRegistry.length = 0;
  frontend = new FakeFrontendClient();
});

// ── resolveBinding / handlePairingCode ───────────────────────

describe("resolveBinding", () => {
  it("returns the binding object from channel.resolveBinding RPC", async () => {
    const binding = { agentId: "a1", bindingId: "b1", sessionId: "s1", createdBy: "u1", routeType: "group" };
    frontend.responses.set("channel.resolveBinding", { binding });
    const b = await resolveBinding("ch", "key", frontend as unknown as FrontendWsClient);
    expect(b).toEqual(binding);
    expect(frontend.calls[0].method).toBe("channel.resolveBinding");
    expect(frontend.calls[0].params).toEqual({ channel_id: "ch", route_key: "key" });
  });

  it("returns null when RPC returns no binding", async () => {
    frontend.responses.set("channel.resolveBinding", {});
    expect(await resolveBinding("ch", "key", frontend as unknown as FrontendWsClient)).toBeNull();
  });

  it("passes session_key when resolving a participant-scoped binding session", async () => {
    const binding = { agentId: "a1", bindingId: "b1", sessionId: "s1", sessionKey: "open_id:ou_1", createdBy: "u1", routeType: "group" };
    frontend.responses.set("channel.resolveBinding", { binding });
    const b = await resolveBinding("ch", "key", frontend as unknown as FrontendWsClient, "open_id:ou_1");
    expect(b).toEqual(binding);
    expect(frontend.calls[0].params).toEqual({ channel_id: "ch", route_key: "key", session_key: "open_id:ou_1" });
  });
});

describe("resetBindingSession", () => {
  it("passes channel route info to channel.resetSession RPC", async () => {
    frontend.responses.set("channel.resetSession", { success: true, agentId: "a1", oldSessionId: "old", sessionId: "new" });
    const result = await resetBindingSession("ch", "chat-1", frontend as unknown as FrontendWsClient);
    expect(result).toEqual({ success: true, agentId: "a1", oldSessionId: "old", sessionId: "new" });
    expect(frontend.calls[0]).toEqual({
      method: "channel.resetSession",
      params: { channel_id: "ch", route_key: "chat-1" },
    });
  });

  it("passes session_key when resetting a participant-scoped binding session", async () => {
    frontend.responses.set("channel.resetSession", { success: true, agentId: "a1", oldSessionId: "old", sessionId: "new" });
    await resetBindingSession("ch", "chat-1", frontend as unknown as FrontendWsClient, "open_id:ou_1");
    expect(frontend.calls[0]).toEqual({
      method: "channel.resetSession",
      params: { channel_id: "ch", route_key: "chat-1", session_key: "open_id:ou_1" },
    });
  });
});

describe("handlePairingCode", () => {
  it("passes code and route info to channel.pair RPC", async () => {
    frontend.responses.set("channel.pair", { success: true, agentName: "SRE Bot" });
    const result = await handlePairingCode("ABC123", "ch", "chat-1", "group", frontend as unknown as FrontendWsClient);
    expect(result).toEqual({ success: true, agentName: "SRE Bot" });
    expect(frontend.calls[0].params).toEqual({
      code: "ABC123",
      channel_id: "ch",
      route_key: "chat-1",
      route_type: "group",
    });
  });
});

describe("personal binding RPC wrappers", () => {
  it("resolves a personal binding by sender open_id", async () => {
    const binding = { agentId: "a1", bindingId: "pb1", sessionId: "s1", sessionKey: "open_id:ou_1", createdBy: "owner", routeType: "user" };
    frontend.responses.set("channel.resolvePersonalBinding", { binding });
    const result = await resolvePersonalBinding("pb1", "ou_1", frontend as unknown as FrontendWsClient);
    expect(result).toEqual(binding);
    expect(frontend.calls[0]).toEqual({
      method: "channel.resolvePersonalBinding",
      params: { channel_id: "pb1", sender_open_id: "ou_1" },
    });
  });

  it("pairs a personal Sicore user binding", async () => {
    frontend.responses.set("channel.pairPersonal", { success: true, agentName: "Agent" });
    const result = await handlePersonalPairingCode("ABC123", "pb1", "ou_1", frontend as unknown as FrontendWsClient);
    expect(result).toEqual({ success: true, agentName: "Agent" });
    expect(frontend.calls[0]).toEqual({
      method: "channel.pairPersonal",
      params: { code: "ABC123", channel_id: "pb1", sender_open_id: "ou_1" },
    });
  });

  it("resets a personal session by session_key", async () => {
    frontend.responses.set("channel.resetPersonalSession", { success: true, agentId: "a1", oldSessionId: "old", sessionId: "new" });
    const result = await resetPersonalSession("pb1", "sicore_user:u1", frontend as unknown as FrontendWsClient);
    expect(result).toEqual({ success: true, agentId: "a1", oldSessionId: "old", sessionId: "new" });
    expect(frontend.calls[0]).toEqual({
      method: "channel.resetPersonalSession",
      params: { channel_id: "pb1", session_key: "sicore_user:u1" },
    });
  });
});

// ── ChannelManager ──────────────────────────────────────────

describe("ChannelManager.bootFromDb", () => {
  it("gives up after retries when FrontendWsClient is never connected", async () => {
    frontend.connected = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient, { bootRetryBaseMs: 1 });
    await mgr.bootFromDb();
    expect(frontend.calls).toHaveLength(0);
    expect(mgr.size).toBe(0);
  });

  it("retries channel.list on startup race and succeeds on the second attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // First call throws (WS reconnected mid-request), second call returns data.
    let calls = 0;
    frontend.request = vi.fn(async (method: string) => {
      frontend.calls.push({ method, params: undefined });
      if (++calls === 1) throw new Error("FrontendWsClient disconnected");
      return { data: [{ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } }] };
    }) as typeof frontend.request;
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient, { bootRetryBaseMs: 1 });
    await mgr.bootFromDb();
    expect(calls).toBe(2);  // proves retry
    expect(mgr.size).toBe(1);
  });

  it("gives up after all retries when channel.list keeps failing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.nextError = new Error("list unavailable");
    // Reset nextError each call so every attempt fails
    const origRequest = frontend.request.bind(frontend);
    frontend.request = vi.fn(async (method: string, params?: any) => {
      frontend.nextError = new Error("still unavailable");
      return origRequest(method, params);
    }) as typeof frontend.request;
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient, { bootRetryBaseMs: 1, bootRetryAttempts: 3 });
    await mgr.bootFromDb();
    expect((frontend.request as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mgr.size).toBe(0);
  });

  it("starts a handler for each active lark channel", async () => {
    frontend.responses.set("channel.list", {
      data: [
        { id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } },
        { id: "c2", type: "lark", config: { app_id: "b", app_secret: "s2" } },
      ],
    });
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    expect(fakeHandlerRegistry).toHaveLength(2);
    expect(fakeHandlerRegistry[0].started).toBe(true);
    expect(mgr.size).toBe(2);
  });

  it("logs and skips channels with unknown types", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    frontend.responses.set("channel.list", {
      data: [
        { id: "c1", type: "unknown", config: {} },
        { id: "c2", type: "lark", config: { app_id: "a", app_secret: "s" } },
      ],
    });
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    expect(mgr.size).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("reloadFromDb starts newly added channels without touching unchanged handlers", async () => {
    frontend.responses.set("channel.list", {
      data: [{ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } }],
    });
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    const first = fakeHandlerRegistry[0];

    frontend.responses.set("channel.list", {
      data: [
        { id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } },
        { id: "c2", type: "lark", config: { app_id: "b", app_secret: "s2" } },
      ],
    });
    const result = await mgr.reloadFromDb();

    expect(result).toEqual({ started: 1, restarted: 0, stopped: 0, unchanged: 1 });
    expect(first.stopped).toBe(false);
    expect(fakeHandlerRegistry).toHaveLength(2);
    expect(fakeHandlerRegistry[1].started).toBe(true);
    expect(mgr.size).toBe(2);
  });

  it("reloadFromDb restarts changed channels and stops removed channels", async () => {
    frontend.responses.set("channel.list", {
      data: [
        { id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } },
        { id: "c2", type: "lark", config: { app_id: "b", app_secret: "s2" } },
      ],
    });
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    const first = fakeHandlerRegistry[0];
    const removed = fakeHandlerRegistry[1];

    frontend.responses.set("channel.list", {
      data: [{ id: "c1", type: "lark", config: { app_id: "a", app_secret: "rotated" } }],
    });
    const result = await mgr.reloadFromDb();

    expect(result).toEqual({ started: 0, restarted: 1, stopped: 2, unchanged: 0 });
    expect(first.stopped).toBe(true);
    expect(removed.stopped).toBe(true);
    expect(fakeHandlerRegistry).toHaveLength(3);
    expect(fakeHandlerRegistry[2].started).toBe(true);
    expect(mgr.size).toBe(1);
  });

});

describe("ChannelManager.startChannel / stopChannel", () => {
  it("starts a channel and stores its handler", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    expect(mgr.size).toBe(1);
    expect(fakeHandlerRegistry[0].started).toBe(true);
  });

  it("starts a dingtalk channel via its factory", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "d1", type: "dingtalk", config: { client_id: "k", client_secret: "s" } });
    expect(mgr.size).toBe(1);
    expect(fakeHandlerRegistry[0].started).toBe(true);
  });

  it("skips starting a channel that is already running", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    expect(fakeHandlerRegistry).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stopChannel calls handler.stop and drops it", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    await mgr.stopChannel("c1");
    expect(fakeHandlerRegistry[0].stopped).toBe(true);
    expect(mgr.size).toBe(0);
  });

  it("stopChannel is a no-op for unknown id", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await expect(mgr.stopChannel("missing")).resolves.toBeUndefined();
  });

  it("stopAll stops every running handler", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, frontend as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    await mgr.startChannel({ id: "c2", type: "lark", config: { app_id: "b", app_secret: "s" } });
    await mgr.stopAll();
    expect(fakeHandlerRegistry.every((h) => h.stopped)).toBe(true);
    expect(mgr.size).toBe(0);
  });
});
