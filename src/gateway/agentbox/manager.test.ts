import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentBoxManager } from "./manager.js";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";

/**
 * Tests for AgentBoxManager — agent-scoped pod identity (see 2026-04-18 spec).
 * Every AgentBox is keyed by `agentId` alone; callers do NOT pass userId.
 * Two branches to cover: K8s (stateless) and Local (in-memory cache).
 */

// ── Fake spawner ──────────────────────────────────────────────────────

class FakeSpawner implements BoxSpawner {
  constructor(public readonly name: string) {}
  spawnCalls: AgentBoxConfig[] = [];
  stopCalls: string[] = [];
  getReturns = new Map<string, AgentBoxInfo | null>();
  listReturns: AgentBoxInfo[] = [];
  cleanupCalls = 0;

  async spawn(config: AgentBoxConfig): Promise<AgentBoxHandle> {
    this.spawnCalls.push(config);
    return {
      boxId: `box-${config.agentId}`,
      endpoint: "http://127.0.0.1:4000",
      agentId: config.agentId,
    };
  }
  async stop(boxId: string): Promise<void> { this.stopCalls.push(boxId); }
  async get(boxId: string): Promise<AgentBoxInfo | null> {
    return this.getReturns.get(boxId) ?? null;
  }
  async list(): Promise<AgentBoxInfo[]> { return this.listReturns; }
  async cleanup(): Promise<void> { this.cleanupCalls++; }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── getOrCreate contract ──────────────────────────────────────────────

describe("AgentBoxManager.getOrCreate — requires agentId", () => {
  it("throws when called with an empty agentId", async () => {
    const mgr = new AgentBoxManager(new FakeSpawner("local"));
    await expect(mgr.getOrCreate("")).rejects.toThrow(/agentId/);
  });
});

// ── Local-mode tests ───────────────────────────────────────────────────

describe("AgentBoxManager — Local mode", () => {
  it("spawns a new box the first time and caches it by agentId", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    const handle = await mgr.getOrCreate("agent-a");
    expect(handle.boxId).toBe("box-agent-a");
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(mgr.stats()).toEqual({ total: 1, agentIds: ["agent-a"] });
  });

  it("reuses the cached box on second call for the same agent", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");

    // Simulate spawner.get reporting the cached pod is still running.
    spawner.getReturns.set("box-agent-a", {
      boxId: "box-agent-a", agentId: "agent-a", status: "running",
      endpoint: "x", createdAt: new Date(), lastActiveAt: new Date(),
    });

    const h2 = await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls).toHaveLength(1); // no re-spawn
    expect(h2.boxId).toBe("box-agent-a");
  });

  it("evicts and re-spawns when the cached box is gone", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    spawner.getReturns.set("box-agent-a", null);
    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls).toHaveLength(2);
  });

  it("different agents get different pods; same agent reuses the pod", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    await mgr.getOrCreate("agent-b");
    // Simulate both pods being alive so the cache-hit path is taken.
    spawner.getReturns.set("box-agent-a", {
      boxId: "box-agent-a", agentId: "agent-a", status: "running",
      endpoint: "x", createdAt: new Date(), lastActiveAt: new Date(),
    });
    spawner.getReturns.set("box-agent-b", {
      boxId: "box-agent-b", agentId: "agent-b", status: "running",
      endpoint: "x", createdAt: new Date(), lastActiveAt: new Date(),
    });
    await mgr.getOrCreate("agent-a");  // cache hit — no new spawn
    expect(spawner.spawnCalls).toHaveLength(2);
    expect(mgr.activeAgentIds().sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("stop removes the box from cache and calls spawner.stop", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    await mgr.stop("agent-a");
    expect(spawner.stopCalls).toEqual(["box-agent-a"]);
    expect(mgr.stats().total).toBe(0);
  });

  it("touch updates lastActiveAt without spawning", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    const first = (mgr as any).boxes.get("agent-a").lastActiveAt;
    await new Promise((r) => setTimeout(r, 5));
    mgr.touch("agent-a");
    const second = (mgr as any).boxes.get("agent-a").lastActiveAt;
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it("get returns cached handle and returns undefined for unknown agents", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    expect(mgr.get("agent-a")?.boxId).toBe("box-agent-a");
    expect(mgr.get("nobody")).toBeUndefined();
  });
});

// ── K8s-mode tests ─────────────────────────────────────────────────────

describe("AgentBoxManager — K8s mode", () => {
  it("returns existing pod info if already running", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a", {
      boxId: "agentbox-agent-a", agentId: "agent-a", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });

    const handle = await mgr.getOrCreate("agent-a");
    expect(handle.boxId).toBe("agentbox-agent-a");
    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it("creates a new pod when none exists", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].agentId).toBe("agent-a");
  });

  it("podName sanitizes forbidden characters in agentId", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    // Underscores and capitals → lowercase + dash. This is the exact class of
    // input that broke the old design (Lark chat_ids prefixed "oc_").
    spawner.getReturns.set("agentbox-agent-oc-xyz", {
      boxId: "agentbox-agent-oc-xyz", agentId: "Agent_OC_XYZ",
      status: "running", endpoint: "https://x",
      createdAt: new Date(), lastActiveAt: new Date(),
    });
    const handle = await mgr.getOrCreate("Agent_OC_XYZ");
    expect(handle.boxId).toBe("agentbox-agent-oc-xyz");
  });

  it("active* / get / stats return empty in K8s mode (stateless)", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    expect(mgr.activeAgentIds()).toEqual([]);
    expect(mgr.get("agent-a")).toBeUndefined();
    expect(mgr.stats().total).toBe(0);
  });

  it("getAsync returns a handle when the pod is running", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a", {
      boxId: "agentbox-agent-a", agentId: "agent-a", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });
    const handle = await mgr.getAsync("agent-a");
    expect(handle?.boxId).toBe("agentbox-agent-a");
  });

  it("getAsync returns undefined when the pod is absent", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    const handle = await mgr.getAsync("ghost");
    expect(handle).toBeUndefined();
  });

  it("stop(agentId) stops the pod by podName", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.stop("agent-a");
    expect(spawner.stopCalls).toEqual(["agentbox-agent-a"]);
  });
});

// ── Health-check timer (local only) ────────────────────────────────────

describe("AgentBoxManager — health check timer", () => {
  it("startHealthCheck is a no-op in K8s mode", () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner, { healthCheckIntervalMs: 50 });
    mgr.startHealthCheck();
    expect((mgr as any).healthCheckTimer).toBeUndefined();
  });

  it("startHealthCheck registers a timer in local mode and stopHealthCheck clears it", () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner, { healthCheckIntervalMs: 1000 });
    mgr.startHealthCheck();
    expect((mgr as any).healthCheckTimer).toBeDefined();
    mgr.stopHealthCheck();
    expect((mgr as any).healthCheckTimer).toBeUndefined();
  });
});

describe("AgentBoxManager — setCertManager passthrough", () => {
  it("forwards to spawner when spawner exposes setCertManager", () => {
    const spawner = new FakeSpawner("k8s") as any;
    spawner.setCertManager = vi.fn();
    const mgr = new AgentBoxManager(spawner);
    const cm = { fake: true };
    mgr.setCertManager(cm);
    expect(spawner.setCertManager).toHaveBeenCalledWith(cm);
  });

  it("silently no-ops when spawner lacks setCertManager", () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    mgr.setCertManager({ fake: true });
  });
});

describe("AgentBoxManager — cleanup", () => {
  it("stops all cached boxes and calls spawner.cleanup", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    await mgr.getOrCreate("agent-b");
    await mgr.cleanup();
    expect(spawner.stopCalls.sort()).toEqual(["box-agent-a", "box-agent-b"]);
    expect(spawner.cleanupCalls).toBe(1);
    expect(mgr.stats().total).toBe(0);
  });
});
