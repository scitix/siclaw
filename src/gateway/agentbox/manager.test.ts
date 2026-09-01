import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentBoxManager } from "./manager.js";
import { getBoxProfile } from "./box-profile.js";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";
// The same deadline the manager bounds its patience by — asserted against, not restated.
import { POD_READY_TIMEOUT_MS } from "./k8s-spawner.js";

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
  /** Profiles last passed into boxIdFor — proves naming uses real profiles, not prefixes. */
  boxIdForProfiles: Array<string | undefined> = [];
  /** When set, the manager enforces CA-fingerprint matching for pod reuse. */
  fingerprint: string | undefined = undefined;
  caFingerprint(): string | undefined { return this.fingerprint; }

  /**
   * Same contract as K8sSpawner.boxIdFor: second arg is a **BoxProfile name**,
   * never a podNamePrefix. Without this method the manager uses a local fallback
   * that never calls getBoxProfile — which hid the v0.3.2 production bug.
   */
  boxIdFor(agentId: string, profile?: string, instance = 0): string {
    this.boxIdForProfiles.push(profile);
    const prefix = getBoxProfile(profile).podNamePrefix ?? "agentbox";
    const sanitized = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    return `${prefix}-${sanitized}-${instance}`;
  }

  async spawn(config: AgentBoxConfig): Promise<AgentBoxHandle> {
    this.spawnCalls.push(config);
    return {
      boxId: `box-${config.agentId}`,
      endpoint: "http://127.0.0.1:4000",
      agentId: config.agentId,
    };
  }
  stopThrows = false;
  async stop(boxId: string): Promise<void> {
    this.stopCalls.push(boxId);
    if (this.stopThrows) throw new Error("k8s API said no");
  }
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

  it("reports whether local setup created or reused the box", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    const first = await mgr.getOrCreateWithDisposition("agent-a");
    expect(first.created).toBe(true);

    spawner.getReturns.set("box-agent-a", {
      boxId: "box-agent-a", agentId: "agent-a", status: "running",
      endpoint: "x", createdAt: new Date(), lastActiveAt: new Date(),
    });
    const second = await mgr.getOrCreateWithDisposition("agent-a");
    expect(second).toMatchObject({ created: false, handle: { boxId: "box-agent-a" } });
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
    spawner.getReturns.set("agentbox-agent-a-0", {
      boxId: "agentbox-agent-a-0", agentId: "agent-a", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });

    const handle = await mgr.getOrCreate("agent-a");
    expect(handle.boxId).toBe("agentbox-agent-a-0");
    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it("reports whether K8s setup created or adopted the pod", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    const created = await mgr.getOrCreateWithDisposition("new-run", { profile: "kb-compile" });
    expect(created.created).toBe(true);

    // A kb-compile box spawns under the "kbc-box-" prefix, not "agentbox-".
    spawner.getReturns.set("kbc-box-live-run-0", {
      boxId: "kbc-box-live-run-0", agentId: "live-run", status: "running",
      endpoint: "https://10.0.0.9:3000", createdAt: new Date(), lastActiveAt: new Date(),
      profile: "kb-compile",
    });
    const adopted = await mgr.getOrCreateWithDisposition("live-run", { profile: "kb-compile" });
    expect(adopted).toMatchObject({
      created: false,
      handle: { boxId: "kbc-box-live-run-0", endpoint: "https://10.0.0.9:3000" },
    });
  });

  it("creates a new pod when none exists", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].agentId).toBe("agent-a");
  });

  it("reuses a running pod when the requested profile matches", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("kbc-box-run-1-0", {
      boxId: "kbc-box-run-1-0", agentId: "run-1", status: "running",
      endpoint: "https://10.0.0.9:3000", createdAt: new Date(), lastActiveAt: new Date(),
      profile: "kb-compile",
    });
    const handle = await mgr.getOrCreate("run-1", { profile: "kb-compile" });
    expect(handle.endpoint).toBe("https://10.0.0.9:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
    expect(spawner.stopCalls).toHaveLength(0);
  });

  it("stops and respawns when the running pod's profile no longer matches", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    // A pod is running as kb-compile, but the same id is now requested as
    // kb-compile-codex — a realistic same-prefix ("kbc-box-") profile switch.
    spawner.getReturns.set("kbc-box-run-1-0", {
      boxId: "kbc-box-run-1-0", agentId: "run-1", status: "running",
      endpoint: "https://10.0.0.9:3000", createdAt: new Date(), lastActiveAt: new Date(),
      profile: "kb-compile",
    });
    const handle = await mgr.getOrCreate("run-1", { profile: "kb-compile-codex" });
    // Old-shaped pod stopped; a fresh box spawned with the requested profile.
    expect(spawner.stopCalls).toEqual(["kbc-box-run-1-0"]);
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].profile).toBe("kb-compile-codex");
    expect(handle.boxId).toBe("box-run-1");
  });

  it("podName sanitizes forbidden characters in agentId", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    // Underscores and capitals → lowercase + dash. This is the exact class of
    // input that broke the old design (Lark chat_ids prefixed "oc_").
    spawner.getReturns.set("agentbox-agent-oc-xyz-0", {
      boxId: "agentbox-agent-oc-xyz-0", agentId: "Agent_OC_XYZ",
      status: "running", endpoint: "https://x",
      createdAt: new Date(), lastActiveAt: new Date(),
    });
    const handle = await mgr.getOrCreate("Agent_OC_XYZ");
    expect(handle.boxId).toBe("agentbox-agent-oc-xyz-0");
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
    spawner.getReturns.set("agentbox-agent-a-0", {
      boxId: "agentbox-agent-a-0", agentId: "agent-a", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });
    const handle = await mgr.getAsync("agent-a");
    expect(handle?.boxId).toBe("agentbox-agent-a-0");
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
    expect(spawner.stopCalls).toEqual(["agentbox-agent-a-0"]);
  });

  it("stop(runId, 'kb-compile') targets the kbc-box-prefixed pod (reap must not leak it)", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.stop("run-1", "kb-compile");
    expect(spawner.stopCalls).toEqual(["kbc-box-run-1-0"]);
  });

  it("getAsync(runId, 'kb-compile') finds the kbc-box-prefixed live box (adopt re-attach)", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("kbc-box-run-1-0", {
      boxId: "kbc-box-run-1-0", agentId: "run-1", status: "running",
      endpoint: "https://10.0.0.9:3000", createdAt: new Date(), lastActiveAt: new Date(),
      profile: "kb-compile",
    });
    const handle = await mgr.getAsync("run-1", "kb-compile");
    expect(handle?.boxId).toBe("kbc-box-run-1-0");
    // Without the profile it would look under "agentbox-run-1" and miss.
    expect(await mgr.getAsync("run-1")).toBeUndefined();
  });

  it("names kb-compile boxes via profile, never treating podNamePrefix as a profile (v0.3.2 regression)", async () => {
    // Production bug: podName(prefix) → profileForPrefix("kbc-box") → "kbc-box"
    // → boxIdFor(..., "kbc-box") → getBoxProfile("kbc-box") → throw.
    // Naming must stay profile → prefix only; kb-compile and kb-compile-codex
    // share the kbc-box prefix so prefix→profile is not invertible.
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);

    await expect(
      mgr.getOrCreateWithDisposition("cap-run-1", { profile: "kb-compile" }),
    ).resolves.toMatchObject({ created: true });
    expect(spawner.boxIdForProfiles).toContain("kb-compile");
    expect(spawner.boxIdForProfiles).not.toContain("kbc-box");

    spawner.boxIdForProfiles = [];
    await mgr.stop("cap-run-1", "kb-compile");
    expect(spawner.stopCalls).toEqual(["kbc-box-cap-run-1-0"]);
    expect(spawner.boxIdForProfiles).toEqual(["kb-compile"]);

    spawner.boxIdForProfiles = [];
    spawner.getReturns.set("kbc-box-cap-run-2-0", {
      boxId: "kbc-box-cap-run-2-0", agentId: "cap-run-2", status: "running",
      endpoint: "https://10.0.0.9:3000", createdAt: new Date(), lastActiveAt: new Date(),
      profile: "kb-compile-codex",
    });
    await expect(mgr.getAsync("cap-run-2", "kb-compile-codex")).resolves.toMatchObject({
      boxId: "kbc-box-cap-run-2-0",
    });
    expect(spawner.boxIdForProfiles).toEqual(["kb-compile-codex"]);
    expect(spawner.boxIdForProfiles).not.toContain("kbc-box");
  });
});

// ── Per-agent persistence is anchored at cold spawn ────────────────────
//
// chat.send carries `persistence` per request, but the volume mode is fixed
// when the pod is created (K8s cannot hot-change a running pod's mounts). A
// warm pod is reused by agentId WITHOUT spawning, so a changed persistence
// value must NOT recycle it or reach a new pod spec — it only applies on the
// next cold spawn. These tests pin that contract. (Cold-spawn volume selection
// from boxConfig.persistence is covered by k8s-spawner.test.ts.)

describe("AgentBoxManager — persistence anchored at cold spawn (warm reuse ignores it)", () => {
  it("K8s: a running pod is reused without re-spawning when persistence flips", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", {
      boxId: "agentbox-agent-a-0", agentId: "agent-a", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });

    // Pod already running: neither a true nor a (changed) false value spawns.
    await mgr.getOrCreate("agent-a", { persistence: true });
    await mgr.getOrCreate("agent-a", { persistence: false });

    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it("Local: cached running box is reused without re-spawning when persistence flips", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);

    // Cold spawn anchors the value; the spawner records exactly one spawn.
    await mgr.getOrCreate("agent-a", { persistence: true });
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].persistence).toBe(true);

    // Cached box still running → reused; the new false value never re-spawns.
    spawner.getReturns.set("box-agent-a", {
      boxId: "box-agent-a", agentId: "agent-a", status: "running",
      endpoint: "x", createdAt: new Date(), lastActiveAt: new Date(),
    });
    await mgr.getOrCreate("agent-a", { persistence: false });

    expect(spawner.spawnCalls).toHaveLength(1); // still just the cold spawn
  });
});

// ── Per-agent persistence resolved by agentId (entry-point independent) ─
//
// The injected persistenceResolver makes persistence a true agent property:
// any cold-spawn entry point (chat, channel, cron, abort) that passes NO
// per-request value still gets the agent's resolved mode. An explicit config
// value (e.g. task-coordinator's binding.persistence) wins; the resolver is
// consulted only on a cold spawn, never on warm reuse.

describe("AgentBoxManager — persistence resolved by agentId via resolver", () => {
  it("K8s: cold spawn with no config uses the resolver's value", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    mgr.setPersistenceResolver(async () => true);

    await mgr.getOrCreate("agent-a"); // no config — mirrors lark/dingtalk/abort
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].persistence).toBe(true);
  });

  it("Local: cold spawn with no config uses the resolver's value", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    mgr.setPersistenceResolver(async () => true);

    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls[0].persistence).toBe(true);
  });

  it("explicit config.persistence wins over the resolver", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    mgr.setPersistenceResolver(async () => false);

    await mgr.getOrCreate("agent-a", { persistence: true });
    expect(spawner.spawnCalls[0].persistence).toBe(true);
  });

  it("no resolver and no config → persistence undefined (global fallback)", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);

    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls[0].persistence).toBeUndefined();
  });

  it("resolver is NOT consulted on warm reuse (only cold spawn)", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    let resolverCalls = 0;
    mgr.setPersistenceResolver(async () => { resolverCalls++; return true; });

    // Pod already running → warm reuse, resolver must not fire.
    spawner.getReturns.set("agentbox-agent-a-0", {
      boxId: "agentbox-agent-a-0", agentId: "agent-a", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });
    await mgr.getOrCreate("agent-a");

    expect(spawner.spawnCalls).toHaveLength(0);
    expect(resolverCalls).toBe(0);
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

describe("AgentBoxManager — orphan-sweep timer lifecycle", () => {
  it("survives setSpawnEnvResolver and dies with cleanup() (review: the clear was misplaced)", async () => {
    vi.useFakeTimers();
    try {
      const spawner = new FakeSpawner("k8s") as any;
      let sweeps = 0;
      spawner.sweepOrphans = async () => { sweeps++; };
      const mgr = new AgentBoxManager(spawner);
      mgr.startOrphanSweep(() => true, 10_000);
      await vi.advanceTimersByTimeAsync(60_000); // boot pass + interval ticks
      const afterBoot = sweeps;
      expect(afterBoot).toBeGreaterThan(0);
      // Re-setting the spawn-env resolver must NOT silently disable GC
      mgr.setSpawnEnvResolver(async () => undefined);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sweeps).toBeGreaterThan(afterBoot);
      // cleanup() owns the clear
      await mgr.cleanup();
      const afterCleanup = sweeps;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweeps).toBe(afterCleanup);
      expect((mgr as any).orphanSweepTimer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  it("shutdown preserves K8s boxes for another Runtime replica to adopt", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.shutdown();
    expect(spawner.stopCalls).toEqual([]);
    expect(spawner.cleanupCalls).toBe(0);
  });

  it("shutdown still cleans up process-local boxes", async () => {
    const spawner = new FakeSpawner("local");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    await mgr.shutdown();
    expect(spawner.stopCalls).toEqual(["box-agent-a"]);
    expect(spawner.cleanupCalls).toBe(1);
  });
});

describe("AgentBoxManager — K8s CA-fingerprint self-heal", () => {
  const runningPod = (caFingerprint?: string): AgentBoxInfo => ({
    boxId: "agentbox-agent-a-0", agentId: "agent-a", status: "running",
    endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    caFingerprint,
  });

  it("reuses a running pod whose CA fingerprint matches the spawner's current CA", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v2";
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", runningPod("ca-v2"));

    const handle = await mgr.getOrCreate("agent-a");
    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0); // reused, not recreated
  });

  it("recreates a running pod whose CA fingerprint is stale (rotated CA)", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v2";
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", runningPod("ca-v1-old"));

    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls).toHaveLength(1); // stale → respawn with current CA
  });

  it("recreates a running pod with no fingerprint label (legacy pod)", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v2";
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", runningPod(undefined));

    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls).toHaveLength(1);
  });

  it("ignores fingerprint and reuses on running when the spawner reports no CA (non-mTLS)", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = undefined; // spawner can't report a CA → nothing to validate
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", runningPod("whatever"));

    const handle = await mgr.getOrCreate("agent-a");
    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
  });

  /**
   * The acquisition path asks "is mTLS possible RIGHT NOW", which is a WEAKER question than
   * the one the drain path asks. A certificate approaching expiry still authenticates, so
   * rebuilding here would make a user's turn wait out a full cold start for a box that
   * works — replacement is the background roll's job.
   */
  it("serves from a running pod whose certificate is near expiry but still valid", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v2";
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", {
      ...runningPod("ca-v2"),
      certExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // inside the renewal window
    });

    const handle = await mgr.getOrCreate("agent-a");
    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it("recreates a running pod whose certificate has already expired", async () => {
    // Past this point mTLS fails in BOTH directions, so the endpoint is worthless — serving
    // from it would hand the turn a box that cannot answer.
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v2";
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", {
      ...runningPod("ca-v2"),
      certExpiresAt: new Date(Date.now() - 1000),
    });

    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls).toHaveLength(1);
  });

  /**
   * 🔴 The SINGLE-BOX path reads its box through spawner.get(), not through a listing, and
   * that projection used to omit certExpiresAt — so this check silently passed on "unknown
   * is usable" and the certificate fix did nothing for every one-box agent. The spawner side
   * is pinned in k8s-spawner.test.ts; this is the manager side of the same contract.
   */
  it("recreates a single box whose certificate expired, as reported through get()", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v2";
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", {
      ...runningPod("ca-v2"),
      certExpiresAt: new Date(Date.now() - 1000),
    });

    await mgr.getOrCreate("agent-a");

    expect(spawner.spawnCalls).toHaveLength(1);
  });

  it("reuses a running pod that carries no expiry at all (pre-label pod)", async () => {
    // Unknown is not expired. The CA-fingerprint version of this check once read a missing
    // label as stale and drained every box on sight.
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v2";
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", runningPod("ca-v2")); // no certExpiresAt

    const handle = await mgr.getOrCreate("agent-a");
    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
  });
});

describe("AgentBoxManager — injected spawnEnvResolver", () => {
  it("does NOT call the resolver when a running pod is reused (warm path → no RPC)", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    spawner.getReturns.set("agentbox-agent-a-0", {
      boxId: "agentbox-agent-a-0", agentId: "agent-a", status: "running",
      endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    });
    let calls = 0;
    mgr.setSpawnEnvResolver(async () => { calls++; return { SICLAW_AGENTBOX_IDLE_TIMEOUT: "150" }; });

    await mgr.getOrCreate("agent-a");
    expect(calls).toBe(0);
    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it("calls the resolver with the agentId and injects its env on a cold spawn", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    const seen: string[] = [];
    mgr.setSpawnEnvResolver(async (agentId) => { seen.push(agentId); return { SICLAW_AGENTBOX_IDLE_TIMEOUT: "150" }; });

    await mgr.getOrCreate("agent-a");
    expect(seen).toEqual(["agent-a"]);
    expect(spawner.spawnCalls[0].env).toEqual({ SICLAW_AGENTBOX_IDLE_TIMEOUT: "150" });
  });

  it("applies to every entry point, not just one call site (cold spawn always resolves)", async () => {
    // The resolver is owned by the manager, so a channel/cron path that calls
    // getOrCreate(agentId) with no extra args still gets the env.
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    mgr.setSpawnEnvResolver(async () => ({ SICLAW_AGENTBOX_IDLE_TIMEOUT: "0" }));
    await mgr.getOrCreate("agent-from-channel");
    expect(spawner.spawnCalls[0].env).toEqual({ SICLAW_AGENTBOX_IDLE_TIMEOUT: "0" });
  });

  it("spawns with no env when no resolver is set", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls[0].env).toBeUndefined();
  });

  it("spawns with no env when the resolver yields undefined", async () => {
    const spawner = new FakeSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    mgr.setSpawnEnvResolver(async () => undefined);
    await mgr.getOrCreate("agent-a");
    expect(spawner.spawnCalls[0].env).toBeUndefined();
  });
});

// ── Pooled agents (replicas > 1) ──────────────────────────────────────

/**
 * A spawner that can report a pool, so the manager's multi-box path can be driven without
 * a cluster. `listForAgent` and `expectedImage` are duck-typed on the real K8s spawner.
 */
class PoolSpawner extends FakeSpawner {
  pool: AgentBoxInfo[] = [];
  image = "agentbox:v2";
  async listForAgent(_agentId: string): Promise<AgentBoxInfo[]> { return this.pool; }
  expectedImage(_profile?: string): string { return this.image; }
  async spawn(config: AgentBoxConfig): Promise<AgentBoxHandle> {
    this.spawnCalls.push(config);
    const boxId = `agentbox-${config.agentId}-${config.instance ?? 0}`;
    return { boxId, endpoint: `http://10.0.0.${(config.instance ?? 0) + 1}:3000`, agentId: config.agentId };
  }
}

function poolBox(boxId: string, instance: number, over: Partial<AgentBoxInfo> = {}): AgentBoxInfo {
  return {
    boxId, agentId: "agent-a", status: "running", endpoint: `http://10.0.0.${instance + 1}:3000`,
    createdAt: new Date(), lastActiveAt: new Date(), profile: "agent", instance, image: "agentbox:v2",
    ...over,
  };
}

function pooledManager(spawner: PoolSpawner, replicas: number, statuses: Record<string, any> = {}) {
  const mgr = new AgentBoxManager(spawner);
  mgr.setReplicasResolver(async () => replicas);
  mgr.setBoxStatusProbe(async (endpoint) => {
    const found = Object.entries(statuses).find(([, s]) => (s as any).endpoint === endpoint);
    return (found?.[1] as any) ?? { sessionIds: [], turnsInFlight: 0, drained: true };
  });
  return mgr;
}

describe("AgentBoxManager — pooled agents", () => {
  it("keeps a session on the same box across turns", async () => {
    // The property everything else serves: a session being served never changes box, because
    // its background jobs' abort handles are in-memory closures that cannot follow it.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2);

    const first = await mgr.getOrCreate("agent-a", undefined, "s1");
    for (let i = 0; i < 4; i++) {
      expect((await mgr.getOrCreate("agent-a", undefined, "s1")).boxId).toBe(first.boxId);
    }
    expect(spawner.spawnCalls).toHaveLength(0); // pool already at size
  });

  it("spreads different sessions across the pool", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2);
    const a = await mgr.getOrCreate("agent-a", undefined, "s1");
    const b = await mgr.getOrCreate("agent-a", undefined, "s2");
    expect(a.boxId).not.toBe(b.boxId);
  });

  it("adopts what boxes report instead of re-placing a live session after a restart", async () => {
    // A fresh manager has an empty binding table while sessions are still live in boxes.
    // Placing one fresh would send a running conversation to a box holding none of its state.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2, {
      one: { endpoint: "http://10.0.0.1:3000", sessionIds: [], turnsInFlight: 0, drained: true },
      two: { endpoint: "http://10.0.0.2:3000", sessionIds: ["s-live"], turnsInFlight: 1, drained: false },
    });
    expect((await mgr.getOrCreate("agent-a", undefined, "s-live")).boxId).toBe("agentbox-agent-a-1");
  });

  it("drains a box running a stale image instead of killing it", async () => {
    // Pod reuse never compared the image, which is why a new AgentBox image only took effect
    // when someone deleted pods by hand — and that delete was a hard kill.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0, { image: "agentbox:v1" }), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2);

    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(spawner.stopCalls).toHaveLength(0);          // still serving what it holds
    expect(handle.boxId).toBe("agentbox-agent-a-1");    // but takes no new sessions
  });

  it("spawns pooled boxes as resident, or the pool would shrink itself between turns", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [];
    const mgr = pooledManager(spawner, 3);
    await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(spawner.spawnCalls[0].env?.SICLAW_AGENTBOX_IDLE_TIMEOUT).toBe("0");
  });

  it("falls back to ONE box when the replicas lookup fails", async () => {
    // Fail closed on scale: a config blip must never multiply an agent's pods.
    const spawner = new PoolSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => { throw new Error("portal down"); });
    await mgr.getOrCreate("agent-a", undefined, "s1");
    // Single-box path: spawned without an instance index.
    expect(spawner.spawnCalls[0].instance).toBeUndefined();
  });

  it("leaves an agent at replicas=1 on the original single-box path", async () => {
    const spawner = new PoolSpawner("k8s");
    const mgr = pooledManager(spawner, 1);
    await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(spawner.spawnCalls[0].instance).toBeUndefined();
    expect(spawner.spawnCalls[0].env?.SICLAW_AGENTBOX_IDLE_TIMEOUT).toBeUndefined();
  });
});

describe("AgentBoxManager — drain reaper", () => {
  function drainingManager(statusByEndpoint: Record<string, any>, probeThrows = false) {
    const spawner = new PoolSpawner("k8s");
    spawner.getReturns.set("old-box", poolBox("old-box", 0, { endpoint: "http://10.0.0.9:3000" }));
    const mgr = new AgentBoxManager(spawner);
    mgr.setBoxStatusProbe(async (endpoint) => {
      if (probeThrows) throw new Error("unreachable");
      return statusByEndpoint[endpoint] ?? { sessionIds: [], turnsInFlight: 0, drained: false };
    });
    (mgr as any).draining.set("old-box", Date.now());
    return { mgr, spawner };
  }

  it("removes a box once the box itself says it is drained", async () => {
    const { mgr, spawner } = drainingManager({ "http://10.0.0.9:3000": { sessionIds: [], turnsInFlight: 0, drained: true } });
    await (mgr as any).reapDrainedBoxes();
    expect(spawner.stopCalls).toEqual(["old-box"]);
  });

  it("waits while the box still reports work", async () => {
    // `drained` has to come from the box: a session with no in-flight turn can still have a
    // background sub-agent running under it, which is invisible from the Runtime.
    const { mgr, spawner } = drainingManager({
      "http://10.0.0.9:3000": { sessionIds: ["s1"], turnsInFlight: 0, drained: false },
    });
    await (mgr as any).reapDrainedBoxes();
    expect(spawner.stopCalls).toHaveLength(0);
  });

  it("names the turns it cuts when the drain deadline forces a live box out", async () => {
    // The streams break either way — the point is that the Runtime can say WHY, instead of
    // the user seeing a bare connection error for a rolling upgrade.
    const { mgr, spawner } = drainingManager({
      "http://10.0.0.9:3000": { sessionIds: ["s-live", "s-other"], turnsInFlight: 1, drained: false },
    });
    const reported: Array<{ ids: string[]; reason: string }> = [];
    mgr.setTurnTerminator((ids, reason) => reported.push({ ids, reason }));
    // A box lists every session RESIDENT on it and never forgets one that moved away, so
    // only the ones still bound HERE may be reported: s-other has since been placed on a
    // healthy box, and cutting its turn would blame this removal for someone else's work.
    (mgr as any).bindings.remember("agent-a", "s-live", "old-box");
    (mgr as any).bindings.remember("agent-a", "s-other", "other-box");
    // Past the grace period: the box is going regardless of what it still holds.
    (mgr as any).draining.set("old-box", Date.now() - 10 * 60_000);

    await (mgr as any).reapDrainedBoxes();

    expect(spawner.stopCalls).toEqual(["old-box"]);
    expect(reported).toEqual([{ ids: ["s-live"], reason: "box_rolled" }]);
  });

  it("does not report the same box's turns twice when the removal has to be retried", async () => {
    const { mgr, spawner } = drainingManager({
      "http://10.0.0.9:3000": { sessionIds: ["s-live"], turnsInFlight: 1, drained: false },
    });
    const reported: string[][] = [];
    mgr.setTurnTerminator((ids) => reported.push(ids));
    (mgr as any).bindings.remember("agent-a", "s-live", "old-box");
    (mgr as any).draining.set("old-box", Date.now() - 10 * 60_000);
    spawner.stopThrows = true;

    await (mgr as any).reapDrainedBoxes();
    spawner.stopThrows = false;
    // The mark survives a failed stop, so the next tick sees the same box listing the same
    // session — by then a retry may own that id, and cutting it would be someone else's turn.
    await (mgr as any).reapDrainedBoxes();

    expect(reported).toEqual([["s-live"]]);
  });

  it("does not report turns when the box left on its own terms", async () => {
    const { mgr, spawner } = drainingManager({ "http://10.0.0.9:3000": { sessionIds: [], turnsInFlight: 0, drained: true } });
    const reported: string[][] = [];
    mgr.setTurnTerminator((ids) => reported.push(ids));
    await (mgr as any).reapDrainedBoxes();
    expect(spawner.stopCalls).toEqual(["old-box"]);
    expect(reported).toEqual([]);
  });

  it("still removes an overdue box when it cannot be asked what it holds", async () => {
    // A probe failure must not buy the box another lap: it is already past the deadline.
    const { mgr, spawner } = drainingManager({}, true);
    const reported: string[][] = [];
    mgr.setTurnTerminator((ids) => reported.push(ids));
    (mgr as any).draining.set("old-box", Date.now() - 10 * 60_000);

    await (mgr as any).reapDrainedBoxes();

    expect(spawner.stopCalls).toEqual(["old-box"]);
    expect(reported).toEqual([]); // nothing to name, so nothing claimed
  });

  it("waits when the box cannot be asked at all", async () => {
    // Unreachable is not evidence of empty. Guessing here deletes live work.
    const { mgr, spawner } = drainingManager({}, true);
    await (mgr as any).reapDrainedBoxes();
    expect(spawner.stopCalls).toHaveLength(0);
  });

  it("removes a box that never drains, once its deadline passes", async () => {
    // A sub-agent may run ten minutes; a deploy cannot wait indefinitely.
    const { mgr, spawner } = drainingManager({
      "http://10.0.0.9:3000": { sessionIds: ["s1"], turnsInFlight: 1, drained: false },
    });
    (mgr as any).draining.set("old-box", Date.now() - 6 * 60_000);
    await (mgr as any).reapDrainedBoxes();
    expect(spawner.stopCalls).toEqual(["old-box"]);
  });

  it("forgets a box that is already gone without trying to stop it", async () => {
    const spawner = new PoolSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    mgr.setBoxStatusProbe(async () => ({ sessionIds: [], turnsInFlight: 0, drained: true }));
    (mgr as any).draining.set("vanished", Date.now());
    await (mgr as any).reapDrainedBoxes();
    expect(spawner.stopCalls).toHaveLength(0);
    expect((mgr as any).draining.size).toBe(0);
  });
});

describe("AgentBoxManager — regressions found in review", () => {
  it("never builds a replacement under a draining box's own pod name", async () => {
    // A draining box keeps its name until it is deleted. Treating its index as free
    // produced a spawn for the identical name, which the spawner then either reused (the
    // drain never rolls) or — on a CA-triggered drain — DELETED outright, mid-conversation.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0, { image: "agentbox:v1" }), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2);

    await mgr.getOrCreate("agent-a", undefined, "s1");
    await new Promise((r) => setTimeout(r, 5)); // the pool fill is deliberately backgrounded

    expect(spawner.spawnCalls.map((c) => c.instance)).not.toContain(0);
    expect(spawner.spawnCalls.map((c) => c.instance)).toEqual([2]); // next free index
    expect(spawner.stopCalls).toHaveLength(0);
  });

  it("does not treat an unreachable box as the least loaded one", async () => {
    // Failing to answer is what a wedged box does. Scoring it 0 in-flight made
    // least-loaded placement steer every new session straight onto it.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    mgr.setBoxStatusProbe(async (endpoint) => {
      if (endpoint === "http://10.0.0.1:3000") throw new Error("wedged");
      return { sessionIds: [], turnsInFlight: 3, drained: false };
    });
    // The healthy box reports 3 in-flight turns and still wins over the silent one.
    for (const sid of ["s1", "s2", "s3"]) {
      expect((await mgr.getOrCreate("agent-a", undefined, sid)).boxId).toBe("agentbox-agent-a-1");
    }
  });

  it("drains the extra boxes when replicas is lowered", async () => {
    // Acquisition cannot see this: at replicas=1 it takes the single-box path, which only
    // ever looks up instance 0 by name. The extras are resident, so nothing else stops them.
    const spawner = new PoolSpawner("k8s");
    spawner.listReturns = [
      poolBox("agentbox-agent-a-0", 0),
      poolBox("agentbox-agent-a-1", 1),
      poolBox("agentbox-agent-a-2", 2),
    ];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 1);
    mgr.setBoxStatusProbe(async () => ({ sessionIds: [], turnsInFlight: 0, drained: true }));

    await (mgr as any).reconcilePoolSizes();
    // Highest indices first — index 0 is the oldest and likeliest to be busy.
    expect([...(mgr as any).draining.keys()].sort()).toEqual(["agentbox-agent-a-1", "agentbox-agent-a-2"]);
  });

  it("leaves a correctly-sized pool alone", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.listReturns = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    await (mgr as any).reconcilePoolSizes();
    expect((mgr as any).draining.size).toBe(0);
  });
});

describe("AgentBoxManager — the pool it reconciles may not be its own", () => {
  // `list()` is scoped to the namespace and the `app=agentbox` label, not to this runtime.
  // Production runs several runtimes against one AgentBox namespace, so the reconciler sees
  // siblings' pods and — before the ownership check — judged them by this runtime's own
  // configuration. Three healthy boxes read as two too many and were destroyed.
  const sibling = () => {
    const spawner = new PoolSpawner("k8s");
    spawner.listReturns = [
      poolBox("agentbox-agent-a-0", 0),
      poolBox("agentbox-agent-a-1", 1),
      // The reasons this runtime would have found to act: a corpse to collect and replace,
      // and an image this runtime does not consider current.
      poolBox("agentbox-agent-a-2", 2, { status: "stopped", exitedUnexpectedly: true }),
      poolBox("agentbox-agent-a-3", 3, { image: "agentbox:v1" }),
    ];
    spawner.pool = spawner.listReturns;
    return spawner;
  };

  it("touches nothing when it cannot establish that the agent is its own", async () => {
    const spawner = sibling();
    const mgr = new AgentBoxManager(spawner);
    // What the control plane actually answers for another runtime's agent.
    mgr.setReplicasResolver(async () => { throw new Error("agent does not belong to this runtime"); });
    mgr.setBoxStatusProbe(async () => ({ sessionIds: [], turnsInFlight: 0, drained: true }));

    await (mgr as any).reconcilePoolSizes();
    await new Promise((r) => setTimeout(r, 10)); // a replacement would spawn in the background

    expect((mgr as any).draining.size).toBe(0); // no shrink, no staleness marking
    expect(spawner.stopCalls).toHaveLength(0);  // no corpse collection, no roll
    expect(spawner.spawnCalls).toHaveLength(0); // and nothing put back in someone else's pool
  });

  it("stops re-asking the control plane about an agent that is not its own", async () => {
    // A sibling's agent is a permanent answer, and the reaper ticks every ten seconds. The
    // memo is the reconciler's alone — the lookup stays uncached so a turn is never held at
    // one box on the strength of a remembered blip.
    const spawner = sibling();
    const mgr = new AgentBoxManager(spawner);
    let lookups = 0;
    mgr.setReplicasResolver(async () => { lookups++; throw new Error("agent does not belong to this runtime"); });

    for (let i = 0; i < 4; i++) await (mgr as any).reconcilePoolSizes();
    expect(lookups).toBe(1);

    (mgr as any).unownedAgents.clear(); // as if the memo window had elapsed
    await (mgr as any).reconcilePoolSizes();
    expect(lookups).toBe(2); // and it does ask again — a reassigned agent must be picked up
  });

  it("acts on the very same pool once the agent is known to be its own", async () => {
    // The control against the test above: without it, a reconciler broken in some unrelated
    // way would pass by doing nothing at all.
    const spawner = sibling();
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 1);
    mgr.setBoxStatusProbe(async () => ({ sessionIds: [], turnsInFlight: 0, drained: true }));

    await (mgr as any).reconcilePoolSizes();
    await new Promise((r) => setTimeout(r, 10));

    expect(spawner.stopCalls).toContain("agentbox-agent-a-2"); // the corpse is collected
    expect((mgr as any).draining.size).toBeGreaterThan(0);     // and the pool is shrunk
  });

  it("still serves a turn for an agent whose replica count is unavailable", async () => {
    // Ownership gates DESTRUCTION only. A request naming the agent is itself the evidence
    // that this runtime serves it, so an unresolvable count falls back to a single box
    // rather than refusing the turn.
    const spawner = new PoolSpawner("k8s");
    const box = poolBox("agentbox-agent-a-0", 0);
    spawner.pool = [box];
    spawner.getReturns.set("agentbox-agent-a-0", box);
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => { throw new Error("control plane down"); });

    const acquired = await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(acquired.boxId).toBe("agentbox-agent-a-0");
  });

  it("reports an unresolvable agent once a window, not once a tick", async () => {
    // The reaper runs every few seconds against every sibling agent in the namespace. Said
    // each time, this was the bulk of the runtime log — which is how the drain that mattered
    // went unnoticed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new AgentBoxManager(new PoolSpawner("k8s"));
    let lookups = 0;
    mgr.setReplicasResolver(async () => { lookups++; throw new Error("agent does not belong to this runtime"); });

    for (let i = 0; i < 4; i++) {
      expect(await (mgr as any).lookupReplicas("agent-a")).toBeUndefined();
      (mgr as any).replicasCache.clear(); // as if the TTL had elapsed between ticks
    }

    expect(lookups).toBe(4); // the lookup itself is NOT throttled — a blip must recover
    expect(warn.mock.calls.filter((c) => /replicas unknown/.test(String(c[0])))).toHaveLength(1);
  });
});

describe("AgentBoxManager — a single-box agent still rolls onto a new image", () => {
  it("drains a stale box and serves from a replacement, rather than keeping the old image forever", async () => {
    // The single-box path compares phase, profile and CA but never the image, and a box
    // under continuous traffic never idles out — so before this, a Runtime rollout left
    // every default agent (replicas=1) on the old AgentBox image indefinitely.
    const spawner = new PoolSpawner("k8s");
    const stale = poolBox("agentbox-agent-a-0", 0, { image: "agentbox:v1" });
    spawner.pool = [stale];
    spawner.getReturns.set("agentbox-agent-a-0", stale);
    const mgr = pooledManager(spawner, 1);

    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");

    // The stale box keeps serving what it holds; it is not killed.
    expect(spawner.stopCalls).toHaveLength(0);
    // A replacement comes up under the next FREE index — instance 0's name is still taken.
    expect(spawner.spawnCalls.map((c) => c.instance)).toEqual([1]);
    // …and the new session goes to the replacement, not to the box about to be removed.
    expect(handle.boxId).toBe("agentbox-agent-a-1");
  });

  it("leaves a current-image box alone on the fast path", async () => {
    const spawner = new PoolSpawner("k8s");
    const fresh = poolBox("agentbox-agent-a-0", 0); // image === spawner.image
    spawner.pool = [fresh];
    spawner.getReturns.set("agentbox-agent-a-0", fresh);
    const mgr = pooledManager(spawner, 1);

    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(handle.boxId).toBe("agentbox-agent-a-0");
    expect(spawner.spawnCalls).toHaveLength(0);
    expect(spawner.stopCalls).toHaveLength(0);
  });

  it("treats an unknown image as fresh rather than recycling every box", async () => {
    // A legacy pod may not report an image at all. Guessing stale would respawn on
    // every single acquisition.
    const spawner = new PoolSpawner("k8s");
    const unlabelled = poolBox("agentbox-agent-a-0", 0, { image: undefined });
    spawner.pool = [unlabelled];
    spawner.getReturns.set("agentbox-agent-a-0", unlabelled);
    const mgr = pooledManager(spawner, 1);

    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(handle.boxId).toBe("agentbox-agent-a-0");
    expect(spawner.spawnCalls).toHaveLength(0);
  });
});

describe("AgentBoxManager — PR review regressions", () => {
  it("does NOT move a session that is still resident on the draining box", async () => {
    // Review #1. During a rollout the old box keeps running the in-flight turn. Binding
    // the session to the replacement would send its next Stop/Steer/send to a box holding
    // none of its state — the exact loss affinity exists to prevent.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0, { image: "agentbox:v1" })];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 1);
    mgr.setBoxStatusProbe(async () => ({ sessionIds: ["s-live"], turnsInFlight: 1, drained: false }));

    const handle = await mgr.getOrCreate("agent-a", undefined, "s-live");
    expect(handle.boxId).toBe("agentbox-agent-a-0"); // stays on the box actually running it
  });

  it("moves a released session off a draining box", async () => {
    const spawner = new PoolSpawner("k8s");
    const stale = poolBox("agentbox-agent-a-0", 0, { image: "agentbox:v1" });
    spawner.pool = [stale, poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    // No box reports holding it → free.
    mgr.setBoxStatusProbe(async () => ({ sessionIds: [], turnsInFlight: 0, drained: true }));
    (mgr as any).bindings.remember("agent-a", "s-released", "agentbox-agent-a-0");
    (mgr as any).draining.set("agentbox-agent-a", Date.now());

    const handle = await mgr.getOrCreate("agent-a", undefined, "s-released");
    expect(handle.boxId).toBe("agentbox-agent-a-1");
  });

  it("keeps a session on the box that still reports holding it", async () => {
    // Background sub-agents keep a session resident after its turn returned, so the box
    // is still appending to the transcript and the next turn has to go there.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    mgr.setBoxStatusProbe(async (endpoint) => endpoint === "http://10.0.0.1:3000"
      ? { sessionIds: ["s-busy"], turnsInFlight: 0, drained: false }
      : { sessionIds: [], turnsInFlight: 0, drained: true });

    const handle = await mgr.getOrCreate("agent-a", undefined, "s-busy");
    expect(handle.boxId).toBe("agentbox-agent-a-0");
  });

  it("finds a session's box without deriving instance 0", async () => {
    // Review #3. A session pinned to instance 1 must not read as not-running.
    const spawner = new PoolSpawner("k8s");
    const one = poolBox("agentbox-agent-a-1", 1);
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), one];
    spawner.getReturns.set("agentbox-agent-a-1", one);
    const mgr = new AgentBoxManager(spawner);
    (mgr as any).bindings.remember("agent-a", "s1", "agentbox-agent-a-1");

    const handle = await mgr.getForSession("agent-a", "s1");
    expect(handle?.boxId).toBe("agentbox-agent-a-1");
  });

  it("reports no box rather than guessing instance 0 for an unknown session", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [];
    const mgr = new AgentBoxManager(spawner);
    expect(await mgr.getForSession("agent-a", "nobody")).toBeUndefined();
  });

  it("stops the concrete box it was given", async () => {
    // Review #4. stop(agentId) always derives instance 0, so terminating an N-box agent
    // deleted instance 0 N times and reported the survivors as stopped.
    const spawner = new PoolSpawner("k8s");
    const mgr = new AgentBoxManager(spawner);
    await mgr.stopBox("agentbox-agent-a-2");
    expect(spawner.stopCalls).toEqual(["agentbox-agent-a-2"]);
  });
});

describe("AgentBoxManager — the replica count is cached", () => {
  it("does not ask the control plane on every acquisition", async () => {
    // This runs once per turn from every entry point. Against an upstream control plane
    // that is a network round trip on the hot path of every conversation.
    const spawner = new PoolSpawner("k8s");
    const box = poolBox("agentbox-agent-a-0", 0);
    spawner.pool = [box];
    spawner.getReturns.set("agentbox-agent-a-0", box);
    let lookups = 0;
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => { lookups++; return 1; });

    for (let i = 0; i < 5; i++) await mgr.getOrCreate("agent-a", undefined, `s${i}`);
    expect(lookups).toBe(1);
  });

  it("retries a failed lookup instead of remembering the fallback", async () => {
    // A blip must not pin the agent at one box for the whole TTL.
    const spawner = new PoolSpawner("k8s");
    const box = poolBox("agentbox-agent-a-0", 0);
    spawner.pool = [box];
    spawner.getReturns.set("agentbox-agent-a-0", box);
    let lookups = 0;
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => { lookups++; throw new Error("control plane down"); });

    await mgr.getOrCreate("agent-a", undefined, "s1");
    await mgr.getOrCreate("agent-a", undefined, "s2");
    expect(lookups).toBe(2);
  });
});

describe("AgentBoxManager — silence is not emptiness", () => {
  it("keeps a session on its last box when that box cannot be asked", async () => {
    // During a rollout the old boxes have no box-status endpoint at all, so every one of
    // them is silent. Reading silence as "holds nothing" hands the session to a second box
    // while the first may still be writing its transcript.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    mgr.setBoxStatusProbe(async (endpoint) => {
      if (endpoint === "http://10.0.0.1:3000") throw new Error("404 — old image, no such endpoint");
      return { sessionIds: [], turnsInFlight: 0, drained: true };
    });
    (mgr as any).bindings.remember("agent-a", "s1", "agentbox-agent-a-0");

    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(handle.boxId).toBe("agentbox-agent-a-0");
  });

  it("still places a session that never ran anywhere", async () => {
    // No last box means nothing to protect — silence must not block a first placement.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    mgr.setBoxStatusProbe(async () => { throw new Error("everything silent"); });

    const handle = await mgr.getOrCreate("agent-a", undefined, "brand-new");
    expect(handle.boxId).toMatch(/^agentbox-agent-a/);
  });
});

describe("AgentBoxManager — asking a box that predates box-status", () => {
  it("falls back to the older session list, so a rollout does not split a live session", async () => {
    // Every box is one of these during the rollout that introduces box-status. The older
    // endpoint still says WHICH sessions it holds, which is the part placement needs.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    mgr.setBoxStatusProbe(async () => { throw new Error("404 — old image"); });
    mgr.setLegacySessionLister(async (endpoint) =>
      endpoint === "http://10.0.0.2:3000" ? ["s1"] : []);

    // No hint remembered: the fallback alone has to find the holder.
    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(handle.boxId).toBe("agentbox-agent-a-1");
  });

  it("gives up on a box that answers neither, rather than pinning the session to it forever", async () => {
    // Silence protects a session from being split — but a box that is silent because it is
    // wedged would otherwise keep every session it ever ran, failing every turn.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 2);
    mgr.setBoxStatusProbe(async (endpoint) => {
      if (endpoint === "http://10.0.0.1:3000") throw new Error("wedged");
      return { sessionIds: [], turnsInFlight: 0, drained: true };
    });
    mgr.setLegacySessionLister(async () => { throw new Error("wedged too"); });
    (mgr as any).bindings.remember("agent-a", "s1", "agentbox-agent-a-0");

    // The first few turns hold it there — the box may just be slow.
    expect((await mgr.getOrCreate("agent-a", undefined, "s1")).boxId).toBe("agentbox-agent-a-0");
    expect((await mgr.getOrCreate("agent-a", undefined, "s1")).boxId).toBe("agentbox-agent-a-0");
    // After the limit it is treated as gone and the session moves on.
    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(handle.boxId).toBe("agentbox-agent-a-1");
  });
});

describe("AgentBoxManager — who is holding this session", () => {
  it("names the box that reports holding it", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setBoxStatusProbe(async (endpoint) => endpoint === "http://10.0.0.2:3000"
      ? { sessionIds: ["s1"], turnsInFlight: 1, drained: false }
      : { sessionIds: [], turnsInFlight: 0, drained: true });

    expect((await mgr.getHolder("agent-a", "s1"))?.boxId).toBe("agentbox-agent-a-1");
  });

  it("answers nothing rather than offering a box that never saw the session", async () => {
    // steer/abort/clearQueue act on a RUNNING turn. Handing them any box of the agent means
    // a 404 the user did not cause — and a frontend that resends the text as a new prompt,
    // so the message gets answered twice.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setBoxStatusProbe(async () => ({ sessionIds: [], turnsInFlight: 0, drained: true }));

    expect(await mgr.getHolder("agent-a", "s1")).toBeUndefined();
  });

  it("keeps trusting a box that cannot be asked", async () => {
    // Same rule placement uses: silence is not evidence the session moved.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = new AgentBoxManager(spawner);
    mgr.setBoxStatusProbe(async (endpoint) => {
      if (endpoint === "http://10.0.0.1:3000") throw new Error("silent");
      return { sessionIds: [], turnsInFlight: 0, drained: true };
    });
    (mgr as any).bindings.remember("agent-a", "s1", "agentbox-agent-a-0");

    expect((await mgr.getHolder("agent-a", "s1"))?.boxId).toBe("agentbox-agent-a-0");
  });

  it("answers nothing when the agent has no boxes at all", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [];
    const mgr = new AgentBoxManager(spawner);
    expect(await mgr.getHolder("agent-a", "s1")).toBeUndefined();
    expect(spawner.spawnCalls).toHaveLength(0); // must never spawn
  });
});

describe("AgentBoxManager — pooling without shared session storage", () => {
  it("says so once when a pool has nowhere shared to keep its sessions", async () => {
    // Silent history loss is the failure this prevents someone from debugging blind.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawner = new PoolSpawner("k8s") as PoolSpawner & { hasSharedSessionStorage(): boolean };
    spawner.hasSharedSessionStorage = () => false;
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2);

    await mgr.getOrCreate("agent-a", undefined, "s1");
    await mgr.getOrCreate("agent-a", undefined, "s2");

    const hits = warn.mock.calls.filter((c) => /NOT on shared/.test(String(c[0])));
    expect(hits).toHaveLength(1); // once per agent, not once per turn
  });

  it("stays quiet when the boxes do share a volume", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawner = new PoolSpawner("k8s") as PoolSpawner & { hasSharedSessionStorage(): boolean };
    spawner.hasSharedSessionStorage = () => true;
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2);

    await mgr.getOrCreate("agent-a", undefined, "s1");
    expect(warn.mock.calls.filter((c) => /NOT on shared/.test(String(c[0])))).toHaveLength(0);
  });
});

describe("AgentBoxManager — a box that died without being asked to", () => {
  const crashed = (boxId: string, instance: number) =>
    poolBox(boxId, instance, { status: "stopped", exitedUnexpectedly: true });
  const retired = (boxId: string, instance: number) =>
    poolBox(boxId, instance, { status: "stopped", exitedUnexpectedly: false });

  it("collects the corpse and puts the box back", async () => {
    // A pool exists so that losing one box costs capacity, not service. Waiting for the
    // next request to notice means the pool runs short for as long as the agent is quiet.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), crashed("agentbox-agent-a-1", 1)];
    spawner.listReturns = spawner.pool;
    const mgr = pooledManager(spawner, 2);

    await (mgr as any).reconcilePoolSizes();
    await new Promise((r) => setTimeout(r, 10)); // the replacement spawns in the background

    expect(spawner.stopCalls).toContain("agentbox-agent-a-1");
    expect(spawner.spawnCalls.map((c) => c.instance)).toEqual([1]);
  });

  it("does not replace a box that exited cleanly", async () => {
    // The idle self-destruct is a feature. Replacing its work spawns a pod that idles out
    // and is spawned again, forever, for an agent nobody is using.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0), retired("agentbox-agent-a-1", 1)];
    spawner.listReturns = spawner.pool;
    const mgr = pooledManager(spawner, 2);

    await (mgr as any).reconcilePoolSizes();
    await new Promise((r) => setTimeout(r, 10));

    expect(spawner.stopCalls).toContain("agentbox-agent-a-1"); // corpse still collected
    expect(spawner.spawnCalls).toHaveLength(0);                // but not replaced
  });

  it("stops replacing a box that keeps dying", async () => {
    // An OOM on a prompt that rebuilds the same context kills the replacement too. The
    // pool stays short rather than looping against the K8s API.
    const spawner = new PoolSpawner("k8s");
    const mgr = pooledManager(spawner, 2);
    let allowed = 0;
    for (let i = 0; i < 6; i++) if ((mgr as any).mayRespawn("agent-a#1")) allowed++;
    expect(allowed).toBe(1); // the cooldown holds the rest back
  });

  /**
   * The crash-replacement path consults two cooldowns, and only one of them is free to ask:
   * `mayRespawn` SPENDS one of three attempts when it says yes, while the spawn-retry check
   * merely reports. So the reporting one has to go first, or a slot filtered out afterwards
   * has paid for a replacement that never happened.
   *
   * With today's constants the wrong order cannot actually bite — mayRespawn's own 2-minute
   * cooldown returns false without spending, and it outlasts the 30-second spawn cooldown,
   * so the windows never overlap. This test pins the ORDER rather than that coincidence:
   * tightening one constant or lengthening the other would make it real, and neither
   * constant's definition hints at the coupling.
   */
  it("consults the reporting cooldown before the one that spends an attempt", async () => {
    const spawner = new PoolSpawner("k8s");
    const pool = [poolBox("agentbox-agent-a-0", 0), crashed("agentbox-agent-a-1", 1)];
    spawner.pool = pool;
    spawner.listReturns = pool;
    const mgr = pooledManager(spawner, 2);

    // Slot 1 is blocked by the spawn-retry cooldown and has no crash history at all, so
    // mayRespawn WOULD say yes (and spend) if it were asked first.
    (mgr as any).spawnFailures.set("agent-a#1", Date.now());

    // Called directly rather than through the reconcile tick: both effects asserted below
    // are SYNCHRONOUS (the cooldown write happens inside the filter, and a blocked slot
    // never reaches spawnInstances at all), so waiting on a timer would only add a window
    // in which the assertions could pass for the wrong reason.
    await (mgr as any).healCrashedBoxes("agent-a", pool);

    expect(spawner.spawnCalls).toHaveLength(0);                      // blocked, as intended
    expect((mgr as any).crashRespawns.has("agent-a#1")).toBe(false); // and nothing was spent
  });
});

describe("AgentBoxManager — a deploy rolls one box at a time", () => {
  it("drains one stale box, not the whole pool", async () => {
    // Marking every stale box at once leaves ZERO boxes able to take a new session, so a
    // deploy turns every conversation started during it into a cold start.
    const spawner = new PoolSpawner("k8s");
    spawner.image = "agentbox:v3";
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { image: "agentbox:v2" }),
      poolBox("agentbox-agent-a-1", 1, { image: "agentbox:v2" }),
      poolBox("agentbox-agent-a-2", 2, { image: "agentbox:v2" }),
    ];
    const mgr = pooledManager(spawner, 3);

    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    expect((mgr as any).draining.size).toBe(1);
  });

  it("moves on to the next box once the previous one is gone", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.image = "agentbox:v3";
    spawner.pool = [
      poolBox("agentbox-agent-a-1", 1, { image: "agentbox:v2" }),
      poolBox("agentbox-agent-a-2", 2, { image: "agentbox:v2" }),
    ];
    const mgr = pooledManager(spawner, 2);

    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    const first = [...(mgr as any).draining.keys()][0];
    (mgr as any).draining.delete(first);                       // it finished draining and was removed
    spawner.pool = spawner.pool.filter((b) => b.boxId !== first);
    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    expect([...(mgr as any).draining.keys()]).toHaveLength(1);
    expect([...(mgr as any).draining.keys()][0]).not.toBe(first);
  });

  it("does not make a box that cannot be talked to wait its turn", async () => {
    // A stale CA means the runtime cannot reach the box at all. Keeping it in the pool
    // for the sake of an orderly roll serves nobody.
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { caFingerprint: "old" }),
      poolBox("agentbox-agent-a-1", 1, { caFingerprint: "old" }),
    ];
    const mgr = pooledManager(spawner, 2);

    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    expect((mgr as any).draining.size).toBe(2); // both, immediately
  });

  /**
   * 🔴 A certificate NEARING expiry is not the same as one that is already dead, and the
   * difference decides whether the whole pool goes at once. Every box of an agent mounts the
   * SAME per-agent Secret, so they all come due at the same instant — treating "due" as
   * urgent empties the pool in one tick, which is the stampede the renewal window exists to
   * prevent. Due ⇒ roll one at a time; dead ⇒ drop immediately.
   */
  it("rolls boxes whose certificate is merely nearing expiry, one at a time", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { caFingerprint: "current", certExpiresAt: soon }),
      poolBox("agentbox-agent-a-1", 1, { caFingerprint: "current", certExpiresAt: soon }),
      poolBox("agentbox-agent-a-2", 2, { caFingerprint: "current", certExpiresAt: soon }),
    ];
    const mgr = pooledManager(spawner, 3);

    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    expect((mgr as any).draining.size).toBe(1);
  });

  it("drops boxes whose certificate has already expired, all at once", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    const dead = new Date(Date.now() - 1000);
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { caFingerprint: "current", certExpiresAt: dead }),
      poolBox("agentbox-agent-a-1", 1, { caFingerprint: "current", certExpiresAt: dead }),
    ];
    const mgr = pooledManager(spawner, 2);

    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    expect((mgr as any).draining.size).toBe(2); // worthless — mTLS cannot succeed either way
  });

  it("leaves boxes with no expiry information alone", async () => {
    // Pods created before the expiry label existed. Reading "no answer" as stale is exactly
    // how the CA-fingerprint version of this check once drained every box on sight.
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { caFingerprint: "current" }),
      poolBox("agentbox-agent-a-1", 1, { caFingerprint: "current" }),
    ];
    const mgr = pooledManager(spawner, 2);

    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    expect((mgr as any).draining.size).toBe(0);
  });

  it("rolls a pod still named the way instance 0 used to be", async () => {
    // It works, its image is current — but nothing looks that name up any more, so it
    // would serve whatever it holds and never be counted, replaced or drained.
    const spawner = new PoolSpawner("k8s") as PoolSpawner & { legacyPodName(a: string, p?: string): string };
    spawner.legacyPodName = (agentId: string) => `agentbox-${agentId}`;
    spawner.pool = [poolBox("agentbox-agent-a", 0), poolBox("agentbox-agent-a-1", 1)];
    const mgr = pooledManager(spawner, 2);

    (mgr as any).markStaleBoxesDraining("agent-a", spawner.pool, "agent");
    expect([...(mgr as any).draining.keys()]).toEqual(["agentbox-agent-a"]);
  });
});

describe("AgentBoxManager — concurrent pool fills must not multiply", () => {
  /**
   * 🔴 THE STORM. Pool filling is triggered from getOrCreate — once per SESSION REQUEST —
   * and runs in the background, so while a pool sat short EVERY arriving request started its
   * own spawn for the same instance indices. Observed in a live cluster: `pool short by 4 …
   * spawning instances 1,2,3,4` four times inside one second, four pods created under one
   * name, four readiness waits on the one pod, and a raw 404 whenever one of them recycled a
   * pod another was still waiting on — all of it contending for the very resources the boxes
   * needed in order to start.
   */
  it("starts ONE spawn per slot no matter how many callers ask at once", async () => {
    const spawner = new PoolSpawner("k8s");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      await gate;
      return {
        boxId: `agentbox-${config.agentId}-${config.instance ?? 0}`,
        endpoint: `http://10.0.0.${(config.instance ?? 0) + 1}:3000`,
        agentId: config.agentId,
      };
    };
    const mgr = pooledManager(spawner, 3);

    // Five concurrent callers, all seeing the same empty pool and the same missing slots.
    const calls = Array.from({ length: 5 }, () => (mgr as any).spawnInstances("agent-a", undefined, [1, 2]));
    release!();
    await Promise.all(calls);

    // Two slots ⇒ two spawns, not ten.
    expect(spawner.spawnCalls).toHaveLength(2);
    expect(spawner.spawnCalls.map((c) => c.instance).sort()).toEqual([1, 2]);
  });

  it("hands every joined caller the box the first caller created", async () => {
    const spawner = new PoolSpawner("k8s");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      await gate;
      return { boxId: "the-one-box", endpoint: "http://10.0.0.2:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 2);

    const calls = [
      (mgr as any).spawnInstances("agent-a", undefined, [1]),
      (mgr as any).spawnInstances("agent-a", undefined, [1]),
    ];
    release!();
    const [a, b] = await Promise.all(calls);

    expect(a[0].boxId).toBe("the-one-box");
    expect(b[0].boxId).toBe("the-one-box");
    expect(spawner.spawnCalls).toHaveLength(1);
  });

  /**
   * 🔴 De-duplication is sound only between callers that want the same thing DONE TO THE POD.
   * An attempt started while a Pending pod was still young reuses it; a caller arriving after
   * the readiness deadline wants it deleted. Joining the older attempt left the pod in place
   * and failed everyone with it, costing another full readiness window before anything tried
   * again — a 95-second window in the measured case, not a race.
   */
  it("does not let a rebuild request join a reuse already in flight", async () => {
    const spawner = new PoolSpawner("k8s");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      await gate;
      return { boxId: "agentbox-agent-a-0", endpoint: "http://10.0.0.1:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 1);

    // A reuse is in flight for slot 0…
    const reuse = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => false);
    await Promise.resolve();
    // …and a rebuild for the same slot must NOT be absorbed by it.
    const rebuild = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => true);
    release!();
    await Promise.all([reuse, rebuild]);

    expect(spawner.spawnCalls).toHaveLength(2);
    expect(spawner.spawnCalls[0].recreate).toBeUndefined();
    expect(spawner.spawnCalls[1].recreate).toBe(true);
  });

  /**
   * 🔴 Superseding must not HARM the callers already waiting. The stronger attempt deletes
   * the pod, which is exactly what makes the older attempt's readiness wait fail — so every
   * caller holding the older promise got null and reported `Failed to spawn`, while the
   * replacement came up fine moments later. The failure was caused by the recovery.
   */
  it("hands the superseded attempt's waiters to the replacement", async () => {
    const spawner = new PoolSpawner("k8s");
    let failReuse: (() => void) | undefined;
    const reuseGate = new Promise<void>((r) => { failReuse = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      if (!config.recreate) {
        // Stands in for "the pod I was waiting on was deleted under me".
        await reuseGate;
        throw new Error("disappeared while waiting for it to become ready");
      }
      return { boxId: "agentbox-agent-a-0", endpoint: "http://10.0.0.7:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 1);

    const waiter = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => false);
    await Promise.resolve();
    const rebuild = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => true);
    failReuse!();

    const [fromWaiter, fromRebuild] = await Promise.all([waiter, rebuild]);

    // The original caller gets the replacement's box, not the casualty of its own recovery.
    expect(fromRebuild[0]?.boxId).toBe("agentbox-agent-a-0");
    expect(fromWaiter[0]?.boxId).toBe("agentbox-agent-a-0");
  });

  /**
   * 🔴 And it yields REGARDLESS of its own outcome. A Pending pod that turns Ready while the
   * replacement is still resolving its config makes the superseded attempt SUCCEED — but the
   * pod it succeeded about is under a demolition order. Handing that endpoint back is worse
   * than handing back the failure: it looks fine and dies under the first request.
   */
  it("yields to the replacement even when the superseded attempt succeeds", async () => {
    const spawner = new PoolSpawner("k8s");
    let readyNow: (() => void) | undefined;
    const turnsReady = new Promise<void>((r) => { readyNow = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      if (!config.recreate) {
        await turnsReady; // the pod becomes Ready after the rebuild has taken over
        return { boxId: "doomed-pod", endpoint: "http://10.0.0.1:3000", agentId: config.agentId };
      }
      return { boxId: "replacement-pod", endpoint: "http://10.0.0.2:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 1);

    const waiter = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => false);
    await Promise.resolve();
    const rebuild = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => true);
    readyNow!();

    const [fromWaiter] = await Promise.all([waiter, rebuild]);

    expect(fromWaiter[0]?.boxId).toBe("replacement-pod");
  });

  it("does not invent a successor when nothing superseded a failed attempt", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      throw new Error("no capacity");
    };
    const mgr = pooledManager(spawner, 1);

    const out = await (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => false);

    expect(out).toEqual([]); // a plain failure stays a failure
  });

  it("still de-duplicates in the weaker direction — a reuse joins a rebuild", async () => {
    // The asymmetry is deliberate: a rebuild already does everything a reuse would.
    const spawner = new PoolSpawner("k8s");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      await gate;
      return { boxId: "agentbox-agent-a-0", endpoint: "http://10.0.0.1:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 1);

    const rebuild = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => true);
    await Promise.resolve();
    const reuse = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => false);
    release!();
    await Promise.all([rebuild, reuse]);

    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].recreate).toBe(true);
  });

  it("two rebuild requests still collapse into one", async () => {
    const spawner = new PoolSpawner("k8s");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      await gate;
      return { boxId: "agentbox-agent-a-0", endpoint: "http://10.0.0.1:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 1);

    const a = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => true);
    await Promise.resolve();
    const b = (mgr as any).spawnInstances("agent-a", undefined, [0], true, undefined, () => true);
    release!();
    await Promise.all([a, b]);

    expect(spawner.spawnCalls).toHaveLength(1);
  });

  it("frees the slot once the spawn settles, so a later fill can retry it", async () => {
    const spawner = new PoolSpawner("k8s");
    const mgr = pooledManager(spawner, 2);

    await (mgr as any).spawnInstances("agent-a", undefined, [1]);
    await (mgr as any).spawnInstances("agent-a", undefined, [1]);

    expect(spawner.spawnCalls).toHaveLength(2);
    expect((mgr as any).inflightSpawns.size).toBe(0);
  });

  /**
   * De-duplication alone does not stop the storm: an attempt leaves the in-flight map the
   * moment it settles, so a slot that cannot be filled would be retried as fast as traffic
   * happens to arrive.
   */
  it("backs a failing slot off for background fills", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      throw new Error("no capacity");
    };
    const mgr = pooledManager(spawner, 2);

    expect((mgr as any).mayFillInstance("agent-a", 1)).toBe(true);
    await (mgr as any).spawnInstances("agent-a", undefined, [1]);
    expect((mgr as any).mayFillInstance("agent-a", 1)).toBe(false);
  });

  it("clears the backoff once the slot spawns successfully", async () => {
    const spawner = new PoolSpawner("k8s");
    let fail = true;
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      if (fail) throw new Error("no capacity");
      return { boxId: "b", endpoint: "http://10.0.0.2:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 2);

    await (mgr as any).spawnInstances("agent-a", undefined, [1]);
    expect((mgr as any).mayFillInstance("agent-a", 1)).toBe(false);

    fail = false;
    // The wait path is allowed through regardless of the cooldown — see getOrCreatePooled.
    await (mgr as any).spawnInstances("agent-a", undefined, [1]);
    expect((mgr as any).mayFillInstance("agent-a", 1)).toBe(true);
  });

  it("counts the backoff per slot, not per agent", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      if (config.instance === 1) throw new Error("no capacity");
      return { boxId: "b", endpoint: "http://10.0.0.3:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 3);

    await (mgr as any).spawnInstances("agent-a", undefined, [1, 2]);

    expect((mgr as any).mayFillInstance("agent-a", 1)).toBe(false);
    expect((mgr as any).mayFillInstance("agent-a", 2)).toBe(true);
  });

  /**
   * The one path that must NOT respect the cooldown: nothing is available to serve the turn
   * from, so a slot that failed a moment ago is still worth one more attempt.
   */
  it("still tries the awaited spawn when there is nothing to serve from", async () => {
    const spawner = new PoolSpawner("k8s");
    // Failure keyed on the SLOT, not on call order: the background fill for the remaining
    // indices is now launched before the awaited one, so "the first call" is no longer the
    // one this test is about.
    let slotZeroFailed = false;
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      if ((config.instance ?? 0) === 0 && !slotZeroFailed) {
        slotZeroFailed = true;
        throw new Error("no capacity");
      }
      return { boxId: "agentbox-agent-a-0", endpoint: "http://10.0.0.1:3000", agentId: config.agentId };
    };
    const mgr = pooledManager(spawner, 2);

    await expect(mgr.getOrCreate("agent-a", undefined, "s1")).rejects.toThrow(/Failed to spawn/);
    // Cooldown is now set for slot 0, yet the next turn must still get a box.
    const handle = await mgr.getOrCreate("agent-a", undefined, "s2");
    expect(handle.boxId).toBe("agentbox-agent-a-0");
  });
});

describe("AgentBoxManager — a pool that is at size but not up yet", () => {
  /**
   * 🔴 "Nothing reachable" and "pool short" are DIFFERENT conditions, and the gap between
   * them was a second, independent unbounded-growth path that de-duplication could not
   * close. A starting box counts as live for missingInstances (so `missing` is empty) but
   * is not reachable (so `accepting` is 0) — and the fall-through allocated a NEW index
   * every time. Each request picking a different index is precisely what de-dup cannot
   * merge, so the pool climbed 1, 2, 3, … while never actually being short.
   */
  /** A pool AT SIZE with nothing reachable: every box is still coming up. */
  function allStarting(count: number): AgentBoxInfo[] {
    return Array.from({ length: count }, (_, i) =>
      poolBox(`agentbox-agent-a-${i}`, i, { status: "starting", endpoint: "" }));
  }

  it("waits for a starting slot instead of allocating another index", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = allStarting(2);
    const mgr = pooledManager(spawner, 2);

    await mgr.getOrCreate("agent-a", undefined, "s1").catch(() => {});

    // A slot already coming up, never a fresh index above the pool size.
    expect(spawner.spawnCalls.every((c) => (c.instance ?? -1) < 2)).toBe(true);
    expect(spawner.spawnCalls.map((c) => c.instance)).toContain(0);
  });

  it("does not climb when request after request finds the pool starting", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = allStarting(2);
    const mgr = pooledManager(spawner, 2);

    for (let i = 0; i < 5; i++) {
      await mgr.getOrCreate("agent-a", undefined, `s${i}`).catch(() => {});
    }

    // The pool was never short, so no index beyond it may be invented — this is the
    // assertion the old code failed, climbing 2, 3, 4, … one per request.
    const indices = [...new Set(spawner.spawnCalls.map((c) => c.instance ?? -1))].sort();
    expect(Math.max(...indices)).toBeLessThan(2);
  });

  /**
   * 🔴 PRIORITY IS NOT ABANDONMENT. A starting slot is the right thing to WAIT on — cheaper
   * than deleting and recreating a pod — but the rebuildable slots still have to be dealt
   * with, because nothing else deals with them: healCrashedBoxes collects `stopped` boxes
   * only, so an `error` slot (a Failed/Unknown phase, or a pod with no phase yet) is
   * invisible to the reaper. Review measured a pool of starting(0) + error(1) where every
   * request went to instance 0 and instance 1 was never touched again — permanently broken
   * capacity if the starting pod stayed Pending.
   */
  it("does not strand an error slot while waiting on a starting one", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" }),
      poolBox("agentbox-agent-a-1", 1, { status: "error", endpoint: "" }),
    ];
    const mgr = pooledManager(spawner, 2);

    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 2).catch(() => {});
    await new Promise((r) => setTimeout(r, 20)); // the stranded rebuild goes to the background

    const touched = new Set(spawner.spawnCalls.map((c) => c.instance));
    expect(touched.has(0)).toBe(true); // waited on
    expect(touched.has(1)).toBe(true); // and not forgotten
  });

  /**
   * 🔴 `void` makes the call concurrent with the CALLER, not with the line above it. Placed
   * after the await, the "background" rebuild does not begin until the awaited slot resolves
   * — up to POD_READY_TIMEOUT_MS on the real path. So a stuck starting slot left the
   * stranded error slots idle for three minutes and then failed the turn anyway. Review
   * measured spawnCalls holding only [0] until instance 0 was released.
   */
  it("starts the stranded rebuild WHILE waiting, not after", async () => {
    const spawner = new PoolSpawner("k8s");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      if ((config.instance ?? 0) === 0) await gate; // the awaited slot stays stuck
      return { boxId: `agentbox-agent-a-${config.instance}`, endpoint: "http://10.0.0.9:3000", agentId: config.agentId };
    };
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" }),
      poolBox("agentbox-agent-a-1", 1, { status: "error", endpoint: "" }),
    ];
    const mgr = pooledManager(spawner, 2);

    const inflight = (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 2).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    // BEFORE the awaited slot resolves, the rebuild must already be under way.
    expect(spawner.spawnCalls.map((c) => c.instance)).toContain(1);

    release!();
    await inflight;
  });

  /**
   * 🔴 A `starting` slot is worth waiting on only while it is plausibly still coming up. Past
   * the deadline the spawner itself gives up on, a pod still `starting` is stuck — typically
   * unschedulable, which is the storm's own signature. Waiting on it forever means every
   * request burns POD_READY_TIMEOUT_MS and fails, in a loop, while the slot is never rebuilt:
   * healCrashedBoxes collects `stopped` boxes only, so nothing else would ever touch it.
   */
  it("rebuilds a starting slot that is past the readiness deadline instead of waiting again", async () => {
    const spawner = new PoolSpawner("k8s");
    const longStuck = poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" });
    longStuck.createdAt = new Date(Date.now() - POD_READY_TIMEOUT_MS - 60_000);
    spawner.pool = [longStuck];
    const mgr = pooledManager(spawner, 1);

    const before = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;
    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 1).catch(() => {});
    const after = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;

    expect(spawner.spawnCalls.map((c) => c.instance)).toEqual([0]); // same slot, rebuilt
    expect(after - before).toBe(1); // and charged, because a rebuild destroys a pod
  });

  /**
   * 🔴 THE GAP BETWEEN CLASSIFYING AND ACTING. Putting an over-age slot in the rebuild set
   * only decided what the manager INTENDED; the spawner still judges reuse from the pod
   * alone, and a Pending pod with a valid certificate passes every check it makes. So the
   * budget was spent and the same stuck pod was handed back — once per request, forever. The
   * intent has to travel with the spawn request, which is what `recreate` carries.
   */
  it("tells the spawner to REPLACE an over-age slot, not just classify it", async () => {
    const spawner = new PoolSpawner("k8s");
    const longStuck = poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" });
    longStuck.createdAt = new Date(Date.now() - POD_READY_TIMEOUT_MS - 60_000);
    spawner.pool = [longStuck];
    const mgr = pooledManager(spawner, 1);

    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 1).catch(() => {});

    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].recreate).toBe(true);
  });

  it("does NOT ask for a replacement when the slot is merely still coming up", async () => {
    const spawner = new PoolSpawner("k8s");
    const fresh = poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" });
    fresh.createdAt = new Date(Date.now() - 5_000);
    spawner.pool = [fresh];
    const mgr = pooledManager(spawner, 1);

    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 1).catch(() => {});

    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].recreate).toBeUndefined(); // waiting, not replacing
  });

  it("does not ask for a replacement when simply filling a short pool", async () => {
    // A missing index has no pod to replace; sending `recreate` there would be meaningless
    // at best and, on a slot that raced into existence, destructive.
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [];
    const mgr = pooledManager(spawner, 2);

    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 2).catch(() => {});

    expect(spawner.spawnCalls.every((c) => c.recreate === undefined)).toBe(true);
  });

  it("keeps waiting on a starting slot that is still within the deadline", async () => {
    const spawner = new PoolSpawner("k8s");
    const fresh = poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" });
    fresh.createdAt = new Date(Date.now() - 5_000);
    spawner.pool = [fresh];
    const mgr = pooledManager(spawner, 1);

    const before = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;
    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 1).catch(() => {});
    const after = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;

    expect(spawner.spawnCalls.map((c) => c.instance)).toEqual([0]);
    expect(after - before).toBe(0); // waiting destroys nothing, so nothing is charged
  });

  it("still fuses the stranded rebuild — the background path is not a way around the budget", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" }),
      poolBox("agentbox-agent-a-1", 1, { status: "error", endpoint: "" }),
    ];
    const mgr = pooledManager(spawner, 2);
    while ((mgr as any).spendDrainBudget("agent-a")) { /* exhaust, whatever its size */ }

    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 2).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    const touched = new Set(spawner.spawnCalls.map((c) => c.instance));
    expect(touched.has(0)).toBe(true);  // waiting is never fused
    expect(touched.has(1)).toBe(false); // the rebuild is
  });

  it("still allocates a free index when the pool is genuinely empty", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [];
    const mgr = pooledManager(spawner, 2);

    await mgr.getOrCreate("agent-a", undefined, "s1").catch(() => {});

    expect(spawner.spawnCalls.map((c) => c.instance)).toContain(0);
  });

  /**
   * 🔴 `starting` was too narrow. missingInstances counts capacity as every pod that is not
   * `stopped`, which also covers `error` — what a Failed/Unknown phase, or a pod with no
   * phase yet, maps to — plus `stopping` and a running box with a dead certificate. Matching
   * only `starting` left all of those falling through to freeInstances; measured by review,
   * five requests pushed the highest index to 6.
   */
  for (const status of ["error", "stopping"] as const) {
    it(`rebuilds a ${status} slot in place instead of allocating past the pool`, async () => {
      const spawner = new PoolSpawner("k8s");
      spawner.pool = [
        poolBox("agentbox-agent-a-0", 0, { status, endpoint: "" }),
        poolBox("agentbox-agent-a-1", 1, { status, endpoint: "" }),
      ];
      const mgr = pooledManager(spawner, 2);

      for (let i = 0; i < 5; i++) {
        await mgr.getOrCreate("agent-a", undefined, `s${i}`).catch(() => {});
      }

      const indices = spawner.spawnCalls.map((c) => c.instance ?? -1);
      expect(Math.max(...indices)).toBeLessThan(2);
    });
  }

  /**
   * A running box with a dead certificate takes a DIFFERENT route, and the distinction is
   * worth pinning: markStaleBoxesDraining judges it urgent and drains it, so it stops
   * counting as capacity and `missing` is non-empty — the replacement legitimately takes an
   * index above `replicas`, because the draining box still owns its name until it is reaped
   * ("indices need not be contiguous; the pool converges").
   *
   * What must NOT happen is a fresh index PER REQUEST. The bound is the number of distinct
   * slots, not their numeric value.
   */
  it("replaces expired boxes on a bounded set of slots, not one per request", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "ca-v1";
    const expired = { caFingerprint: "ca-v1", certExpiresAt: new Date(Date.now() - 1000) };
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, expired),
      poolBox("agentbox-agent-a-1", 1, expired),
    ];
    const mgr = pooledManager(spawner, 2);

    for (let i = 0; i < 5; i++) {
      await mgr.getOrCreate("agent-a", undefined, `s${i}`).catch(() => {});
    }

    const distinct = new Set(spawner.spawnCalls.map((c) => c.instance ?? -1));
    expect(distinct.size).toBeLessThanOrEqual(2); // the pool's width, however they are numbered
  });
});

describe("AgentBoxManager — the drain fuse has no path around it", () => {
  /**
   * Enough calls to exhaust DRAIN_BUDGET whatever it is set to. Deliberately not importing
   * the constant: the point is "the budget is gone", and a test that tracks its exact value
   * would need editing every time the fuse is retuned.
   */
  const DRAIN_BUDGET_FOR_TEST = 32;

  /**
   * 🔴 A fuse with a bypass is not a fuse. Once the drain budget trips,
   * markStaleBoxesDraining stops marking stale boxes — so they stay non-draining in the
   * pool. The at-size path then picked them up as "occupied but not placeable" and handed
   * their indices to spawnInstances, which DELETES AND RECREATES such a pod. Reproduced in
   * review: three requests after the trip rebuilt instances 0 and 1 regardless.
   *
   * Rebuilding is the same act the budget bounds, so it spends the budget too — and when
   * the budget is gone the answer is to create NOTHING, not to fall through to a fresh
   * index, which is the churn being prevented.
   */
  it("stops rebuilding unusable slots once the drain budget is spent", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    // Wrong CA ⇒ not placeable, and `running` ⇒ a rebuild rather than a wait.
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { caFingerprint: "old" }),
      poolBox("agentbox-agent-a-1", 1, { caFingerprint: "old" }),
    ];
    const mgr = pooledManager(spawner, 2);

    // Burn the budget the way a churn loop would.
    for (let i = 0; i < DRAIN_BUDGET_FOR_TEST; i++) (mgr as any).spendDrainBudget("agent-a");

    for (let i = 0; i < 3; i++) {
      await mgr.getOrCreate("agent-a", undefined, `s${i}`).catch(() => {});
    }

    expect(spawner.spawnCalls).toHaveLength(0);
  });

  it("still waits on a starting slot after the budget is spent — waiting destroys nothing", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [poolBox("agentbox-agent-a-0", 0, { status: "starting", endpoint: "" })];
    const mgr = pooledManager(spawner, 1);

    for (let i = 0; i < DRAIN_BUDGET_FOR_TEST; i++) (mgr as any).spendDrainBudget("agent-a");
    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 1).catch(() => {});

    // The slot is joined/awaited, not rebuilt, so the fuse has no reason to block it.
    expect(spawner.spawnCalls.map((c) => c.instance)).toEqual([0]);
  });

  /**
   * 🔴 ONE POD, ONE UNIT. The fuse counts boxes replaced — that is how
   * markStaleBoxesDraining spends it, once per box inside its loop. Spending once for a
   * whole batch made the unit a REQUEST: at 7 of 8 used, one request still rebuilt instances
   * 0, 1 and 2 while the counter moved only to 8, so the real ceiling was 8 × replicas pods.
   *
   * `error` boxes are used deliberately: they are not placeable, and markStaleBoxesDraining
   * skips them (it only marks `running` boxes), so they reach the rebuild branch without the
   * drain pass having spent anything first — which keeps the arithmetic below unambiguous.
   */
  it("spends one unit of budget per rebuilt pod, not one per request", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { status: "error", endpoint: "" }),
      poolBox("agentbox-agent-a-1", 1, { status: "error", endpoint: "" }),
      poolBox("agentbox-agent-a-2", 2, { status: "error", endpoint: "" }),
    ];
    const mgr = pooledManager(spawner, 3);

    const before = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;
    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 3).catch(() => {});
    const after = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;

    // Three slots rebuilt ⇒ three units gone. Batch-spending scored this as 1.
    expect(after - before).toBe(3);
  });

  /**
   * 🔴 CHARGED FOR PODS CREATED, NOT FOR REQUESTS MADE — the third variant of the same
   * unit mismatch. Charging per slot fixed the batch case, but the charge still happened
   * BEFORE spawnInstances de-duplicates: eight concurrent requests naming one dead slot each
   * spent a unit and then all waited on the single spawn that resulted. One pod creation
   * exhausted the fuse, and had that spawn failed, recovery was blocked for the rest of the
   * window.
   *
   * The gate therefore lives past the de-dup, so a caller that merely JOINS pays nothing.
   */
  it("charges one unit for one pod even when many requests race for it", async () => {
    const spawner = new PoolSpawner("k8s");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    spawner.spawn = async (config: AgentBoxConfig) => {
      spawner.spawnCalls.push(config);
      await gate; // hold the spawn open so every caller is concurrent with it
      return { boxId: "agentbox-agent-a-0", endpoint: "http://10.0.0.1:3000", agentId: config.agentId };
    };
    // One unusable, non-starting slot ⇒ the rebuild branch, for every caller.
    spawner.pool = [poolBox("agentbox-agent-a-0", 0, { status: "error", endpoint: "" })];
    const mgr = pooledManager(spawner, 1);

    const before = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;
    const calls = Array.from({ length: 8 }, (_, i) =>
      (mgr as any).getOrCreatePooled("agent-a", undefined, `s${i}`, 1).catch(() => {}));
    release!();
    await Promise.all(calls);
    const after = (mgr as any).drainBudget.get("agent-a")?.count ?? 0;

    expect(spawner.spawnCalls).toHaveLength(1);   // de-dup already guaranteed this
    expect(after - before).toBe(1);               // and the charge must match it
  });

  it("rebuilds only as many slots as the remaining budget allows", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.pool = [
      poolBox("agentbox-agent-a-0", 0, { status: "error", endpoint: "" }),
      poolBox("agentbox-agent-a-1", 1, { status: "error", endpoint: "" }),
      poolBox("agentbox-agent-a-2", 2, { status: "error", endpoint: "" }),
    ];
    const mgr = pooledManager(spawner, 3);

    // Drain the budget to exactly one remaining unit, without assuming its size.
    let remaining = 0;
    while ((mgr as any).spendDrainBudget("agent-a")) remaining++;
    (mgr as any).drainBudget.set("agent-a", { count: remaining - 1, since: Date.now() });

    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 3).catch(() => {});

    // One unit left ⇒ one slot, not all three.
    expect(spawner.spawnCalls).toHaveLength(1);
  });

  it("rebuilds while the budget still has room", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    spawner.pool = [poolBox("agentbox-agent-a-0", 0, { caFingerprint: "old" })];
    const mgr = pooledManager(spawner, 1);

    await (mgr as any).getOrCreatePooled("agent-a", undefined, "s1", 1).catch(() => {});

    expect(spawner.spawnCalls.length).toBeGreaterThan(0);
  });
});

describe("AgentBoxManager — a single box being rolled must hand over", () => {
  const runningBox = (over: Partial<AgentBoxInfo> = {}): AgentBoxInfo => ({
    boxId: "agentbox-agent-a-0", agentId: "agent-a", status: "running",
    endpoint: "https://10.0.0.1:3000", createdAt: new Date(), lastActiveAt: new Date(),
    caFingerprint: "ca-v1", image: "agentbox:v2", profile: "agent", instance: 0,
    ...over,
  });

  /**
   * 🔴 The reaper drains a single box whose certificate is due and creates the replacement,
   * but the single-box path kept returning the drained box: "due for renewal" still
   * authenticates, and only a stale IMAGE used to divert to the pool path. The replacement
   * took no traffic and the old box was killed at the drain deadline mid-request.
   */
  it("rolls through the pool path once the box is draining for its certificate", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v1";
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 1);
    const box = runningBox({ certExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    spawner.getReturns.set("agentbox-agent-a-0", box);
    (spawner as any).listForAgent = async () => [box];
    (mgr as any).draining.set(box.boxId, Date.now());

    await mgr.getOrCreate("agent-a", undefined, "s1").catch(() => {});

    // The pool path creates the successor rather than returning the box being replaced.
    expect(spawner.spawnCalls.length).toBeGreaterThan(0);
  });

  /**
   * The gate matters in the other direction too. A certificate is "due" for a THIRD of its
   * lifetime, so rolling on that alone would pay a synchronous cold start on a box that
   * works and that nothing has decided to replace.
   */
  it("keeps serving a due-but-not-draining box without a cold start", async () => {
    const spawner = new FakeSpawner("k8s");
    spawner.fingerprint = "ca-v1";
    const mgr = new AgentBoxManager(spawner);
    mgr.setReplicasResolver(async () => 1);
    spawner.getReturns.set("agentbox-agent-a-0", runningBox({
      certExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }));

    const handle = await mgr.getOrCreate("agent-a", undefined, "s1");

    expect(handle.endpoint).toBe("https://10.0.0.1:3000");
    expect(spawner.spawnCalls).toHaveLength(0);
  });
});

describe("AgentBoxManager — a box mTLS cannot reach is not a candidate", () => {
  /**
   * 🔴 Marking a box draining does NOT stop it being served from — that is deliberate ("a
   * draining box beats failing the turn"). So a box whose certificate died kept being
   * handed back to every session already bound to it, and every one of those turns failed.
   * The certificate check therefore belongs in isReachable, which is what placement, the
   * holder lookup and the binding fallback all derive from.
   */
  const withCert = (instance: number, over: Partial<AgentBoxInfo>) =>
    poolBox(`agentbox-agent-a-${instance}`, instance, { caFingerprint: "ca-v1", ...over });

  it("does not hand a session back to a box whose certificate expired", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "ca-v1";
    const dead = withCert(0, { certExpiresAt: new Date(Date.now() - 1000) });
    const alive = withCert(1, { certExpiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000) });
    spawner.pool = [dead, alive];
    const mgr = pooledManager(spawner, 2, {
      [dead.boxId]: { endpoint: dead.endpoint, sessionIds: ["s1"], turnsInFlight: 0, drained: false },
      [alive.boxId]: { endpoint: alive.endpoint, sessionIds: [], turnsInFlight: 0, drained: true },
    });

    // s1 is bound to the dead box, and the dead box even reports holding it — which is
    // exactly the state that used to pin the session there and fail every turn.
    (mgr as any).bindings.remember("agent-a", "s1", dead.boxId);
    const acquired = await mgr.getOrCreate("agent-a", undefined, "s1");

    expect(acquired.boxId).not.toBe(dead.boxId);
  });

  it("keeps serving a box whose certificate is merely near expiry", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "ca-v1";
    const soon = withCert(0, { certExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    spawner.pool = [soon, withCert(1, { certExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })];
    const mgr = pooledManager(spawner, 2, {
      [soon.boxId]: { endpoint: soon.endpoint, sessionIds: ["s1"], turnsInFlight: 0, drained: false },
    });

    const acquired = await mgr.getOrCreate("agent-a", undefined, "s1");

    expect(acquired.boxId).toBe(soon.boxId); // still authenticates; the roll replaces it
  });

  /**
   * 🔴 THE OPPOSITE ANSWER, and the reason the certificate test is not inside isReachable.
   *
   * getHolder answers "where IS this turn", for steer / abort / clearQueue. Hiding the box
   * that holds it does not stop the turn: the caller (boxForRunningTurn) falls through to
   * placement, which SPAWNS a pod to answer an abort, and that fresh box replies "session
   * not found" — which reads as already-stopped. An abort the box never confirmed must FAIL
   * rather than report success, because success tells the management plane to stop retrying
   * and tear down supervision. So the unreachable holder is the honest answer here.
   */
  it("still reports an expired box as the holder, so an abort fails honestly", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "ca-v1";
    const dead = withCert(0, { certExpiresAt: new Date(Date.now() - 1000) });
    spawner.pool = [dead];
    spawner.listReturns = spawner.pool;
    const mgr = pooledManager(spawner, 2, {
      [dead.boxId]: { endpoint: dead.endpoint, sessionIds: ["s1"], turnsInFlight: 1, drained: false },
    });

    const holder = await mgr.getHolder("agent-a", "s1");

    expect(holder?.boxId).toBe(dead.boxId);
  });
});

describe("AgentBoxManager — a wrong staleness judgement must not spin", () => {
  it("stops draining after a budget of replacements in one window", async () => {
    // Observed in a cluster: the reaper judged staleness from a projection that carried no
    // CA fingerprint, so every freshly created box read as signed by a CA we no longer
    // trust — drained on sight, replaced, judged the same way. Pods churned until someone
    // read the logs. The data bug is fixed; this is the fuse under it.
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    const mgr = pooledManager(spawner, 1);

    let drained = 0;
    for (let i = 0; i < 20; i++) {
      const box = poolBox(`agentbox-agent-a-${i}`, i, { caFingerprint: "wrong" });
      (mgr as any).markStaleBoxesDraining("agent-a", [box], "agent");
      if ((mgr as any).draining.has(box.boxId)) drained++;
    }
    expect(drained).toBe(8);       // the budget, not 20
  });

  it("keeps the budget per agent", async () => {
    const spawner = new PoolSpawner("k8s");
    spawner.fingerprint = "current";
    const mgr = pooledManager(spawner, 1);
    for (let i = 0; i < 20; i++) {
      (mgr as any).markStaleBoxesDraining("agent-a", [poolBox(`a-${i}`, i, { caFingerprint: "wrong" })], "agent");
    }
    (mgr as any).markStaleBoxesDraining("agent-b", [poolBox("b-0", 0, { caFingerprint: "wrong" })], "agent");
    expect((mgr as any).draining.has("b-0")).toBe(true);  // a different agent is unaffected
  });
});

