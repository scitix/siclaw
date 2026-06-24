import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetricsAggregator, type PodLister, type SnapshotFetcher, type FederationSelfMetrics } from "./metrics-aggregator.js";
import { PromFederationAggregator } from "./prom-federation-aggregator.js";
import type { MetricsFlushPayload } from "../shared/metrics-types.js";

/**
 * Step 4 acceptance: the federator's self-monitoring. After 9090 is removed the
 * federator is the only Prometheus entry point, so its failures must be observable.
 */

function fedSnap(incarnation: string, value: number): MetricsFlushPayload {
  return {
    incarnation,
    prom: [{ name: "siclaw_tokens_total", type: "counter", values: [{ labels: { type: "input" }, value }] }],
  };
}

/** In-memory stand-in for the prom-client self-metrics, so we can assert on values. */
function makeSelfMetrics() {
  const state = {
    pullFailures: new Map<string, number>(),
    pullDurations: [] as number[],
    lastSuccess: 0,
    tracked: -1,
    series: -1,
  };
  const self: FederationSelfMetrics = {
    pullFailuresTotal: { inc: ({ box_id }) => state.pullFailures.set(box_id, (state.pullFailures.get(box_id) ?? 0) + 1) },
    pullDurationMs: { observe: (ms) => state.pullDurations.push(ms) },
    lastSuccessTimestampSeconds: { set: (s) => (state.lastSuccess = s) },
    trackedInstances: { set: (n) => (state.tracked = n) },
    seriesCount: { set: (n) => (state.series = n) },
  };
  return { self, state };
}

describe("federation self-monitoring", () => {
  let lister: PodLister;
  let fetcher: SnapshotFetcher;
  let pods: Array<{ boxId: string; endpoint: string; status: string }>;
  let fetchMap: Map<string, MetricsFlushPayload | null>;
  let aggr: MetricsAggregator;

  beforeEach(() => {
    vi.useFakeTimers();
    pods = [];
    fetchMap = new Map();
    lister = { list: async () => pods };
    fetcher = { fetch: async (e: string) => (fetchMap.has(e) ? fetchMap.get(e)! : null) };
  });

  afterEach(() => {
    aggr?.destroy();
    vi.useRealTimers();
  });

  it("counts pull failures per box and does not advance last_success when all fail", async () => {
    const { self, state } = makeSelfMetrics();
    const fed = new PromFederationAggregator();
    aggr = new MetricsAggregator(lister, fetcher, fed, self);

    pods.push({ boxId: "box-x", endpoint: "https://x", status: "running" });
    fetchMap.set("https://x", null); // fetch returns null → failure

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve(); await Promise.resolve();

    expect(state.pullFailures.get("box-x")).toBe(1);
    expect(state.lastSuccess).toBe(0); // never advanced — nothing fetched
    // a pull-duration sample is still recorded
    expect(state.pullDurations.length).toBeGreaterThanOrEqual(1);
  });

  it("advances last_success and reports tracked/series counts on a successful pull", async () => {
    const { self, state } = makeSelfMetrics();
    const fed = new PromFederationAggregator();
    aggr = new MetricsAggregator(lister, fetcher, fed, self);

    pods.push({ boxId: "box-a", endpoint: "https://a", status: "running" });
    pods.push({ boxId: "box-b", endpoint: "https://b", status: "running" });
    fetchMap.set("https://a", fedSnap("inc-1", 10));
    fetchMap.set("https://b", fedSnap("inc-1", 20));

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve(); await Promise.resolve();

    expect(state.lastSuccess).toBeGreaterThan(0);
    expect(state.tracked).toBe(2); // two instances
    expect(state.series).toBe(1);  // same business labels → one series
    expect(state.pullFailures.size).toBe(0);
  });

  it("self-metrics registry names have zero overlap with federated business metrics", async () => {
    const { federationSelfRegistry } = await import("./federation-self-metrics.js");
    const text = await federationSelfRegistry.metrics();
    // every metric in this registry is a federation self-metric, never a business metric
    const typeNames = (text.match(/^# TYPE (\S+) /gm) || []).map((l) => l.split(" ")[2]);
    expect(typeNames.length).toBeGreaterThan(0);
    expect(typeNames.every((n) => n.startsWith("siclaw_federation_"))).toBe(true);
    expect(typeNames).not.toContain("siclaw_tokens_total");
    expect(typeNames).not.toContain("siclaw_sessions_active");
  });
});
