import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import memoryFlushExtension from "./memory-flush.js";

type Handler = (...args: any[]) => unknown;

function makeApi() {
  const handlers = new Map<string, Handler>();
  const api = {
    on: vi.fn((event: string, h: Handler) => {
      handlers.set(event, h);
    }),
  } as any;
  return { api, handlers };
}

describe("memoryFlushExtension", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers agent_end, session_compact, session_shutdown handlers when indexer provided", () => {
    const { api, handlers } = makeApi();
    const indexer = { sync: vi.fn().mockResolvedValue(undefined) };
    memoryFlushExtension(api, indexer as any);
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    // 3 separate api.on calls
    expect(api.on).toHaveBeenCalledTimes(3);
  });

  it("only registers session_compact when indexer is undefined", () => {
    const { api, handlers } = makeApi();
    memoryFlushExtension(api);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("agent_end")).toBe(false);
    expect(handlers.has("session_shutdown")).toBe(false);
    expect(api.on).toHaveBeenCalledTimes(1);
  });

  it("agent_end handler invokes memoryIndexer.sync()", () => {
    const { api, handlers } = makeApi();
    const sync = vi.fn().mockResolvedValue(undefined);
    memoryFlushExtension(api, { sync } as any);
    const result = handlers.get("agent_end")!();
    expect(sync).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("session_compact handler invokes sync() when indexer present", () => {
    const { api, handlers } = makeApi();
    const sync = vi.fn().mockResolvedValue(undefined);
    memoryFlushExtension(api, { sync } as any);
    handlers.get("session_compact")!();
    expect(sync).toHaveBeenCalled();
  });

  it("session_compact is a no-op when indexer is undefined", () => {
    const { api, handlers } = makeApi();
    memoryFlushExtension(api);
    // Handler should exist and not throw
    expect(() => handlers.get("session_compact")!()).not.toThrow();
  });

  it("logs a warning when agent_end sync rejects", async () => {
    const { api, handlers } = makeApi();
    const sync = vi.fn().mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn");
    memoryFlushExtension(api, { sync } as any);
    handlers.get("agent_end")!();
    // Wait a microtask for the promise to reject and .catch() to run
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("Post-turn sync failed");
  });

  it("logs a warning when session_compact sync rejects", async () => {
    const { api, handlers } = makeApi();
    const sync = vi.fn().mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn");
    memoryFlushExtension(api, { sync } as any);
    handlers.get("session_compact")!();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("Post-compaction sync failed");
  });

  it("logs a warning when session_shutdown sync rejects", async () => {
    const { api, handlers } = makeApi();
    const sync = vi.fn().mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn");
    memoryFlushExtension(api, { sync } as any);
    handlers.get("session_shutdown")!();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("Shutdown sync failed");
  });
});
