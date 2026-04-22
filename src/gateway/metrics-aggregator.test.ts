import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitDiagnostic } from "../shared/diagnostic-events.js";
import {
  MetricsAggregator,
  type LocalCollectorRef,
  type PodLister,
  type SnapshotFetcher,
} from "./metrics-aggregator.js";
import type { MetricsSnapshot, ToolCallStats, SkillCallStats } from "../shared/metrics-types.js";

function snap(
  tools: Partial<ToolCallStats>[] = [],
  skills: Partial<SkillCallStats>[] = [],
  activeSessions = 0,
): MetricsSnapshot {
  return {
    activeSessions,
    toolCallDeltas: tools.map((t) => ({
      toolName: t.toolName ?? "tool",
      userId: t.userId ?? "u",
      agentId: t.agentId ?? null,
      success: t.success ?? 0,
      error: t.error ?? 0,
      total: (t.success ?? 0) + (t.error ?? 0),
    })),
    skillCallDeltas: skills.map((s) => ({
      skillName: s.skillName ?? "skill",
      scope: s.scope ?? "global",
      userId: s.userId ?? "u",
      agentId: s.agentId ?? null,
      success: s.success ?? 0,
      error: s.error ?? 0,
      total: (s.success ?? 0) + (s.error ?? 0),
      avgDurationMs: s.avgDurationMs ?? 0,
    })),
  };
}

// ── Local mode ─────────────────────────────────────────────

describe("MetricsAggregator (local mode)", () => {
  let aggr: MetricsAggregator;
  let local: LocalCollectorRef;

  beforeEach(() => {
    local = {
      snapshot: () => ({ activeSessions: 3, wsConnections: 99 }),
      topTools: vi.fn(() => [{ toolName: "t", userId: "u", agentId: null, success: 1, error: 0, total: 1 }]),
      topSkills: vi.fn(() => [{ skillName: "s", scope: "global" as const, userId: "u", agentId: null, success: 1, error: 0, total: 1, avgDurationMs: 10 }]),
    };
    aggr = new MetricsAggregator("local", local);
  });

  afterEach(() => aggr.destroy());

  it("snapshot returns localRef.activeSessions plus tracked wsConnections", () => {
    expect(aggr.snapshot()).toEqual({ activeSessions: 3, wsConnections: 0 });
  });

  it("topTools/topSkills delegate to the local collector", () => {
    expect(aggr.topTools(5, "u")).toHaveLength(1);
    expect(local.topTools).toHaveBeenCalledWith(5, "u");
    expect(aggr.topSkills(5)).toHaveLength(1);
    expect(local.topSkills).toHaveBeenCalledWith(5, undefined);
  });

  it("increments wsConnections on ws_connected diagnostic event", () => {
    emitDiagnostic({ type: "ws_connected" });
    emitDiagnostic({ type: "ws_connected" });
    expect(aggr.snapshot().wsConnections).toBe(2);
    emitDiagnostic({ type: "ws_disconnected" });
    expect(aggr.snapshot().wsConnections).toBe(1);
  });

  it("ws_disconnected never drives the counter below 0", () => {
    emitDiagnostic({ type: "ws_disconnected" });
    emitDiagnostic({ type: "ws_disconnected" });
    expect(aggr.snapshot().wsConnections).toBe(0);
  });
});

// ── K8s mode: merge + pull loop ────────────────────────────

describe("MetricsAggregator (k8s mode)", () => {
  let aggr: MetricsAggregator;
  let lister: PodLister;
  let fetcher: SnapshotFetcher;
  let pods: Array<{ boxId: string; endpoint: string; status: string }>;
  let fetchMap: Map<string, MetricsSnapshot | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    pods = [];
    fetchMap = new Map();
    lister = { list: async () => pods };
    fetcher = {
      fetch: async (endpoint: string) => fetchMap.has(endpoint) ? fetchMap.get(endpoint)! : null,
    };
    aggr = new MetricsAggregator("k8s", undefined, lister, fetcher);
  });

  afterEach(() => {
    aggr.destroy();
    vi.useRealTimers();
  });

  it("snapshot returns clusterActiveSessions (initially 0)", () => {
    expect(aggr.snapshot().activeSessions).toBe(0);
  });

  it("pull loop fires every 30s, sums activeSessions across pods, merges deltas", async () => {
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "running" });
    pods.push({ boxId: "p2", endpoint: "https://p2", status: "running" });
    fetchMap.set("https://p1", snap(
      [{ toolName: "t1", userId: "u", success: 2 }],
      [{ skillName: "s1", scope: "global", userId: "u", success: 1, avgDurationMs: 100 }],
      5,
    ));
    fetchMap.set("https://p2", snap(
      [{ toolName: "t1", userId: "u", success: 1, error: 1 }],
      [],
      7,
    ));

    await vi.advanceTimersByTimeAsync(30_000);
    // Let the pull promise resolve
    await Promise.resolve();
    await Promise.resolve();

    expect(aggr.snapshot().activeSessions).toBe(12);
    const top = aggr.topTools(5);
    expect(top).toHaveLength(1);
    expect(top[0].success).toBe(3);
    expect(top[0].error).toBe(1);
  });

  it("skips pods that aren't running or have no endpoint", async () => {
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "pending" });
    pods.push({ boxId: "p2", endpoint: "", status: "running" });
    fetchMap.set("https://p1", snap([{ success: 10 }], [], 10));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(aggr.snapshot().activeSessions).toBe(0);
  });

  it("topTools filters by userId", async () => {
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "running" });
    fetchMap.set("https://p1", snap([
      { toolName: "t", userId: "alice", success: 2 },
      { toolName: "t", userId: "bob", success: 5 },
    ]));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    const aliceOnly = aggr.topTools(10, "alice");
    expect(aliceOnly).toHaveLength(1);
    expect(aliceOnly[0].userId).toBe("alice");
  });

  it("topSkills computes avg duration from success+error counts and sorts by total desc", async () => {
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "running" });
    fetchMap.set("https://p1", snap(
      [],
      [
        { skillName: "fast", scope: "global", userId: "u", success: 4, avgDurationMs: 10 },
        { skillName: "slow", scope: "builtin", userId: "u", success: 1, avgDurationMs: 500 },
      ],
    ));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    const top = aggr.topSkills(10);
    expect(top[0].skillName).toBe("fast");
    expect(top[0].total).toBe(4);
    expect(top[0].avgDurationMs).toBe(10);
    expect(top[1].skillName).toBe("slow");
  });

  it("merging updates existing skill entries additively", async () => {
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "running" });

    // First pull
    fetchMap.set("https://p1", snap([], [
      { skillName: "s", scope: "global", userId: "u", success: 2, avgDurationMs: 100 },
    ]));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve(); await Promise.resolve();

    // Second pull
    fetchMap.set("https://p1", snap([], [
      { skillName: "s", scope: "global", userId: "u", success: 1, error: 1, avgDurationMs: 200 },
    ]));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve(); await Promise.resolve();

    const s = aggr.topSkills(10)[0];
    expect(s.success).toBe(3);
    expect(s.error).toBe(1);
    // totalDurationMs = 2*100 + 2*200 = 600, total = 4 → avg 150
    expect(s.avgDurationMs).toBe(150);
  });

  it("destroy clears the pull timer", async () => {
    // Replace the fetcher.fetch with a spy to detect calls after destroy.
    const fetchSpy = vi.fn(async () => null);
    fetcher = { fetch: fetchSpy };
    // Rebuild aggregator with the spyable fetcher.
    aggr.destroy();
    aggr = new MetricsAggregator("k8s", undefined, lister, fetcher);
    pods.push({ boxId: "p1", endpoint: "https://p1", status: "running" });
    aggr.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
