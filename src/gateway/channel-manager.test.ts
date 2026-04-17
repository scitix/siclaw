import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ChannelManager,
  resolveBinding,
  handlePairingCode,
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

vi.mock("./channels/lark.js", () => ({
  createLarkHandler: (channel: Record<string, any>) => {
    const record: FakeHandlerRecord = { started: false, stopped: false, receivedChannel: channel };
    fakeHandlerRegistry.push(record);
    const handler: ChannelHandler = {
      async start() { record.started = true; },
      async stop() { record.stopped = true; },
    };
    return handler;
  },
}));

class FakeFrontendWsClient {
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

let upstream: FakeFrontendWsClient;
const fakeManager = {} as unknown as AgentBoxManager;

beforeEach(() => {
  fakeHandlerRegistry.length = 0;
  upstream = new FakeFrontendWsClient();
});

// ── resolveBinding / handlePairingCode ───────────────────────

describe("resolveBinding", () => {
  it("returns the binding object from channel.resolveBinding RPC", async () => {
    upstream.responses.set("channel.resolveBinding", { binding: { agentId: "a1", bindingId: "b1" } });
    const b = await resolveBinding("ch", "key", upstream as unknown as FrontendWsClient);
    expect(b).toEqual({ agentId: "a1", bindingId: "b1" });
    expect(upstream.calls[0].method).toBe("channel.resolveBinding");
    expect(upstream.calls[0].params).toEqual({ channel_id: "ch", route_key: "key" });
  });

  it("returns null when RPC returns no binding", async () => {
    upstream.responses.set("channel.resolveBinding", {});
    expect(await resolveBinding("ch", "key", upstream as unknown as FrontendWsClient)).toBeNull();
  });
});

describe("handlePairingCode", () => {
  it("passes code and route info to channel.pair RPC", async () => {
    upstream.responses.set("channel.pair", { success: true, agentName: "SRE Bot" });
    const result = await handlePairingCode("ABC123", "ch", "chat-1", "group", upstream as unknown as FrontendWsClient);
    expect(result).toEqual({ success: true, agentName: "SRE Bot" });
    expect(upstream.calls[0].params).toEqual({
      code: "ABC123",
      channel_id: "ch",
      route_key: "chat-1",
      route_type: "group",
    });
  });
});

// ── ChannelManager ──────────────────────────────────────────

describe("ChannelManager.bootFromDb", () => {
  it("skips booting when FrontendWsClient is not connected", async () => {
    upstream.connected = false;
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    expect(upstream.calls).toHaveLength(0);
    expect(mgr.size).toBe(0);
  });

  it("starts a handler for each active lark channel", async () => {
    upstream.responses.set("channel.list", {
      data: [
        { id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } },
        { id: "c2", type: "lark", config: { app_id: "b", app_secret: "s2" } },
      ],
    });
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    expect(fakeHandlerRegistry).toHaveLength(2);
    expect(fakeHandlerRegistry[0].started).toBe(true);
    expect(mgr.size).toBe(2);
  });

  it("logs and skips channels with unknown types", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream.responses.set("channel.list", {
      data: [
        { id: "c1", type: "unknown", config: {} },
        { id: "c2", type: "lark", config: { app_id: "a", app_secret: "s" } },
      ],
    });
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    expect(mgr.size).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not throw when channel.list RPC itself fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    upstream.nextError = new Error("list unavailable");
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.bootFromDb();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("ChannelManager.startChannel / stopChannel", () => {
  it("starts a channel and stores its handler", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    expect(mgr.size).toBe(1);
    expect(fakeHandlerRegistry[0].started).toBe(true);
  });

  it("skips starting a channel that is already running", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    expect(fakeHandlerRegistry).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stopChannel calls handler.stop and drops it", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    await mgr.stopChannel("c1");
    expect(fakeHandlerRegistry[0].stopped).toBe(true);
    expect(mgr.size).toBe(0);
  });

  it("stopChannel is a no-op for unknown id", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await expect(mgr.stopChannel("missing")).resolves.toBeUndefined();
  });

  it("stopAll stops every running handler", async () => {
    const mgr = new ChannelManager(fakeManager, undefined, upstream as unknown as FrontendWsClient);
    await mgr.startChannel({ id: "c1", type: "lark", config: { app_id: "a", app_secret: "s" } });
    await mgr.startChannel({ id: "c2", type: "lark", config: { app_id: "b", app_secret: "s" } });
    await mgr.stopAll();
    expect(fakeHandlerRegistry.every((h) => h.stopped)).toBe(true);
    expect(mgr.size).toBe(0);
  });
});
