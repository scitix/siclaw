import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GatewaySyncClientLike } from "../shared/gateway-sync.js";

// ── Mock sync-handlers before importing resource-sync ─────────────────
// resource-sync imports getSyncHandler from sync-handlers.js at module load
// time; mocking the module gives tests a handle to inject per-test behavior.

const handlerRegistry = new Map<string, any>();

vi.mock("./sync-handlers.js", () => ({
  getSyncHandler: (type: string) => handlerRegistry.get(type),
}));

// Import the SUT *after* the mock is declared. vi.mock is hoisted so this is safe.
import { syncResource, syncAllResources } from "./resource-sync.js";

// Fake client is unused by our handlers — just a placeholder.
const fakeClient: GatewaySyncClientLike = {
  request: async () => ({}),
};

/** Build a handler with instrumented hooks. */
function makeHandler(opts: {
  type: string;
  fetchImpl?: (client: unknown) => Promise<unknown>;
  materializeImpl?: (payload: unknown) => Promise<number>;
  postReloadImpl?: () => Promise<void>;
}) {
  return {
    type: opts.type,
    fetch: vi.fn(opts.fetchImpl ?? (async () => ({}))),
    materialize: vi.fn(opts.materializeImpl ?? (async () => 1)),
    postReload: opts.postReloadImpl ? vi.fn(opts.postReloadImpl) : undefined,
  };
}

beforeEach(() => {
  handlerRegistry.clear();
  // Silence the console.log/warn noise from resource-sync during tests
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncResource — happy path", () => {
  it("calls fetch → materialize → postReload in order and returns the count", async () => {
    const order: string[] = [];
    const handler = {
      type: "mcp" as const,
      fetch: vi.fn(async () => {
        order.push("fetch");
        return { payload: 1 };
      }),
      materialize: vi.fn(async () => {
        order.push("materialize");
        return 42;
      }),
      postReload: vi.fn(async () => {
        order.push("postReload");
      }),
    };
    handlerRegistry.set("mcp", handler);

    const count = await syncResource("mcp", fakeClient);
    expect(count).toBe(42);
    expect(order).toEqual(["fetch", "materialize", "postReload"]);
    expect(handler.postReload).toHaveBeenCalledWith({});
  });

  it("skips postReload gracefully when handler doesn't define it", async () => {
    handlerRegistry.set("mcp", makeHandler({ type: "mcp", materializeImpl: async () => 3 }));
    const count = await syncResource("mcp", fakeClient);
    expect(count).toBe(3);
  });
});

describe("syncResource — error paths", () => {
  it("throws when no handler is registered", async () => {
    await expect(syncResource("mcp", fakeClient)).rejects.toThrow(/No handler registered/);
  });

  it("retries on fetch failure and returns on eventual success", async () => {
    let attempts = 0;
    handlerRegistry.set(
      "mcp",
      makeHandler({
        type: "mcp",
        fetchImpl: async () => {
          attempts++;
          if (attempts < 2) throw new Error("transient");
          return { ok: true };
        },
        materializeImpl: async () => 7,
      }),
    );

    // Fake timers so we don't wait a full backoff interval.
    vi.useFakeTimers();
    const promise = syncResource("mcp", fakeClient);
    await vi.runAllTimersAsync();
    const count = await promise;
    vi.useRealTimers();

    expect(count).toBe(7);
    expect(attempts).toBe(2);
  });

  it("throws after exhausting all retries", async () => {
    const handler = makeHandler({
      type: "mcp",
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    handlerRegistry.set("mcp", handler);

    vi.useFakeTimers();
    const promise = syncResource("mcp", fakeClient).catch((e) => e);
    await vi.runAllTimersAsync();
    const result = (await promise) as Error;
    vi.useRealTimers();

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("boom");
    // mcp descriptor says maxRetries=3
    expect(handler.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("syncAllResources", () => {
  it("attempts every initialSync=true type and returns succeeded/failed buckets", async () => {
    // mcp/skills/knowledge have initialSync=true; cluster/host have false.
    handlerRegistry.set("mcp", makeHandler({ type: "mcp", materializeImpl: async () => 1 }));
    handlerRegistry.set("skills", makeHandler({ type: "skills", materializeImpl: async () => 2 }));
    handlerRegistry.set(
      "knowledge",
      makeHandler({
        type: "knowledge",
        fetchImpl: async () => {
          throw new Error("kn-boom");
        },
      }),
    );

    vi.useFakeTimers();
    const promise = syncAllResources(fakeClient);
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.succeeded.sort()).toEqual(["mcp", "skills"]);
    expect(result.failed).toEqual(["knowledge"]);
  });

  it("does NOT attempt types flagged initialSync=false (cluster, host)", async () => {
    const clusterHandler = makeHandler({ type: "cluster" });
    const hostHandler = makeHandler({ type: "host" });
    // Mcp must succeed so syncAllResources finishes cleanly.
    handlerRegistry.set("mcp", makeHandler({ type: "mcp", materializeImpl: async () => 1 }));
    handlerRegistry.set("skills", makeHandler({ type: "skills", materializeImpl: async () => 0 }));
    handlerRegistry.set("knowledge", makeHandler({ type: "knowledge", materializeImpl: async () => 0 }));
    handlerRegistry.set("cluster", clusterHandler);
    handlerRegistry.set("host", hostHandler);

    vi.useFakeTimers();
    const promise = syncAllResources(fakeClient);
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(clusterHandler.fetch).not.toHaveBeenCalled();
    expect(hostHandler.fetch).not.toHaveBeenCalled();
  });
});
