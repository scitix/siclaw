import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentBoxManager } from "./manager.js";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";

/**
 * Tests for AgentBoxManager — the high-level facade that knits userId + agentId
 * into BoxSpawner calls. Two branches to cover: K8s mode (stateless — queries
 * spawner each time) and Local mode (in-memory cache).
 *
 * The spawner's `name` is how the manager distinguishes modes:
 *   name === "k8s"   → K8s branch
 *   anything else    → Local branch
 */

// ── Fake spawners ──────────────────────────────────────────────────────

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
      boxId: `box-${config.userId}-${config.agentId ?? "default"}`,
      endpoint: "http://127.0.0.1:4000",
      userId: config.userId,
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

// ── Local-mode tests ───────────────────────────────────────────────────

describe("AgentBoxManager — Local mode", () => {
  it("getOrCreate spawns a new box the first time and caches it", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    const handle = await mgr.getOrCreate("alice", "default");
    expect(handle.boxId).toBe("box-alice-default");
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(mgr.stats()).toEqual({ total: 1, userIds: ["alice:default"] });
  });

  it("getOrCreate reuses the cached box on second call when still running", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice");

    const boxId = "box-alice-default";
    spawner.getReturns.set(boxId, {
      boxId, userId: "alice", status: "running", endpoint: "x",
      createdAt: new Date(), lastActiveAt: new Date(),
    });

    const handle2 = await mgr.getOrCreate("alice");
    expect(spawner.spawnCalls).toHaveLength(1); // no re-spawn
    expect(handle2.boxId).toBe(boxId);
  });

  it("getOrCreate evicts and re-spawns when cached box is not running", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice");
    spawner.getReturns.set("box-alice-default", null); // gone
    await mgr.getOrCreate("alice");
    expect(spawner.spawnCalls).toHaveLength(2);
  });

  it("activeUserIds returns unique userIds derived from cache keys", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice", "agent-a");
    await mgr.getOrCreate("alice", "agent-b");
    await mgr.getOrCreate("bob");
    expect(mgr.activeUserIds().sort()).toEqual(["alice", "bob"]);
  });

  it("getForUser returns handles whose key starts with userId:", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice", "a1");
    await mgr.getOrCreate("alicia", "a1"); // prefix collision
    const handles = mgr.getForUser("alice");
    expect(handles).toHaveLength(1);
    expect(handles[0].boxId).toBe("box-alice-a1");
  });

  it("stop removes the box from cache and calls spawner.stop", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice");
    await mgr.stop("alice");
    expect(spawner.stopCalls).toEqual(["box-alice-default"]);
    expect(mgr.stats().total).toBe(0);
  });

  it("stopAll(userId) stops only the specified user's boxes", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice", "a1");
    await mgr.getOrCreate("alice", "a2");
    await mgr.getOrCreate("bob", "a1");
    await mgr.stopAll("alice");
    expect(spawner.stopCalls.sort()).toEqual(["box-alice-a1", "box-alice-a2"]);
    expect(mgr.activeUserIds()).toEqual(["bob"]);
  });

  it("touch updates lastActiveAt without spawning", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice");
    const firstActive = (mgr as any).boxes.get("alice:default").lastActiveAt;
    await new Promise((r) => setTimeout(r, 5));
    mgr.touch("alice");
    const secondActive = (mgr as any).boxes.get("alice:default").lastActiveAt;
    expect(secondActive.getTime()).toBeGreaterThanOrEqual(firstActive.getTime());
  });

  it("get returns cached handle and returns undefined for unknown keys", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice");
    expect(mgr.get("alice")?.boxId).toBe("box-alice-default");
    expect(mgr.get("nobody")).toBeUndefined();
  });
});

// ── K8s-mode tests ─────────────────────────────────────────────────────

describe("AgentBoxManager — K8s mode", () => {
  it("getOrCreate returns existing pod info if already running", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-alice-default", {
      boxId: "agentbox-alice-default", userId: "alice", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });

    const handle = await mgr.getOrCreate("alice");
    expect(handle.boxId).toBe("agentbox-alice-default");
    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it("getOrCreate creates a new pod when none exists", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    // spawner.get returns null by default
    await mgr.getOrCreate("alice", "a1");
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].userId).toBe("alice");
    expect(spawner.spawnCalls[0].agentId).toBe("a1");
  });

  it("podName sanitizes userId and truncates agentId (matches K8sSpawner)", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-user-name-abcdefgh", {
      boxId: "agentbox-user-name-abcdefgh", userId: "User.Name",
      status: "running", endpoint: "https://x", createdAt: new Date(), lastActiveAt: new Date(),
    });
    // Underscore sanitized to dash, agentId truncated to 8 chars, special chars stripped.
    const handle = await mgr.getOrCreate("User.Name", "abcdefghXX");
    // "User.Name" → lower → "user.name" → [^a-z0-9-] → "-" → "user-name"
    // agent "abcdefghXX" → strip non-[a-z0-9] → "abcdefghXX" → slice(0,8) → "abcdefgh"
    expect(handle.boxId).toBe("agentbox-user-name-abcdefgh");
  });

  it("activeUserIds, getForUser, get (sync), stats all return empty in K8s mode", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice");
    expect(mgr.activeUserIds()).toEqual([]);
    expect(mgr.getForUser("alice")).toEqual([]);
    expect(mgr.get("alice")).toBeUndefined();
    expect(mgr.stats().total).toBe(0);
  });

  it("stopAll(userId) enumerates all boxes from spawner.list and stops matching users", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.listReturns = [
      { boxId: "agentbox-alice-a1", userId: "alice", status: "running", endpoint: "", createdAt: new Date(), lastActiveAt: new Date() },
      { boxId: "agentbox-alice-a2", userId: "alice", status: "running", endpoint: "", createdAt: new Date(), lastActiveAt: new Date() },
      { boxId: "agentbox-bob-a1", userId: "bob", status: "running", endpoint: "", createdAt: new Date(), lastActiveAt: new Date() },
    ];
    await mgr.stopAll("alice");
    expect(spawner.stopCalls.sort()).toEqual(["agentbox-alice-a1", "agentbox-alice-a2"]);
  });

  it("getAsync returns a handle when the pod is running", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-alice-default", {
      boxId: "agentbox-alice-default", userId: "alice", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });
    const handle = await mgr.getAsync("alice");
    expect(handle?.boxId).toBe("agentbox-alice-default");
  });

  it("getAsync returns undefined when the pod is absent", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    const handle = await mgr.getAsync("ghost");
    expect(handle).toBeUndefined();
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
    // Should not throw
    mgr.setCertManager({ fake: true });
  });
});

describe("AgentBoxManager — cleanup", () => {
  it("stops all cached boxes and calls spawner.cleanup", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("alice");
    await mgr.getOrCreate("bob");
    await mgr.cleanup();
    expect(spawner.stopCalls.sort()).toEqual(["box-alice-default", "box-bob-default"]);
    expect(spawner.cleanupCalls).toBe(1);
    expect(mgr.stats().total).toBe(0);
  });
});
