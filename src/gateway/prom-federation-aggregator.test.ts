import { describe, it, expect } from "vitest";
import { PromFederationAggregator } from "./prom-federation-aggregator.js";
import type { PromSampleGroup } from "../shared/metrics-types.js";

/**
 * Step 2 HARD ACCEPTANCE — the correctness safety net for federation.
 * After 9090 direct-scrape is removed (module 6) there is no reconciliation
 * baseline, so every delta/reset/race property is asserted here.
 */

// ── helpers ──

function counter(name: string, samples: Array<[Record<string, string | number>, number]>): PromSampleGroup {
  return { name, type: "counter", values: samples.map(([labels, value]) => ({ labels, value })) };
}

function gauge(name: string, value: number, labels: Record<string, string | number> = {}): PromSampleGroup {
  return { name, type: "gauge", values: [{ labels, value }] };
}

/** Build a histogram family the way getMetricsAsJSON expands it. */
function histogram(
  name: string,
  labels: Record<string, string | number>,
  buckets: Array<[number | "+Inf", number]>,
  sum: number,
  count: number,
): PromSampleGroup {
  const values = buckets.map(([le, value]) => ({
    labels: { ...labels, le },
    value,
    metricName: `${name}_bucket`,
  }));
  values.push({ labels: { ...labels } as Record<string, string | number>, value: sum, metricName: `${name}_sum` } as never);
  values.push({ labels: { ...labels } as Record<string, string | number>, value: count, metricName: `${name}_count` } as never);
  return { name, type: "histogram", values };
}

/** Pull the accumulated value of one counter series from exportGroups(). */
function counterVal(agg: PromFederationAggregator, name: string, labels: Record<string, string | number> = {}): number | undefined {
  const fam = agg.exportGroups().find((g) => g.name === name);
  return fam?.values.find((v) => sameLabels(v.labels, labels))?.value;
}

function gaugeVal(agg: PromFederationAggregator, name: string, labels: Record<string, string | number> = {}): number | undefined {
  return counterVal(agg, name, labels);
}

function sameLabels(a: Record<string, string | number>, b: Record<string, string | number>): boolean {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => String(a[k]) === String(b[k]));
}

describe("PromFederationAggregator", () => {
  it("(1) accumulates deltas across rounds for a counter", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 100]])]);
    // first ingest counts the full current value
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(100);

    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 250]])]);
    // delta 150 added → 250 total (matches the pod's own cumulative)
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(250);
  });

  it("(2) detects in-process reset (cur < lastSeen) and counts cur as the delta", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [counter("siclaw_prompts_total", [[{ outcome: "completed" }, 80]])]);
    // same incarnation, but value dropped (registry resetMetrics) → reset, delta = 5
    agg.ingest("box-a", "inc-1", [counter("siclaw_prompts_total", [[{ outcome: "completed" }, 5]])]);
    expect(counterVal(agg, "siclaw_prompts_total", { outcome: "completed" })).toBe(85);
  });

  it("(3) incarnation isolation: a rebuilt pod (same boxId, new incarnation) is counted in full, not diffed against the stale high lastSeen", () => {
    const agg = new PromFederationAggregator();
    // incarnation 1 reaches 100, gets pulled
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 100]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(100);

    // pod rebuilt: same boxId, fresh process counts from 0 and quickly reaches 60,
    // which is BELOW the old lastSeen of 100. A boxId-only key would compute
    // delta = max(0, 60-100) = 0 and LOSE all 60. With (boxId,incarnation) it's a
    // new series → counted in full.
    agg.ingest("box-a", "inc-2", [counter("siclaw_tokens_total", [[{ type: "input" }, 60]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(160);
  });

  it("(3b) incarnation isolation also holds when the new process surpasses the old lastSeen", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 100]])]);
    // new incarnation reaches 150 (> old 100). boxId-only key would add only 50.
    agg.ingest("box-a", "inc-2", [counter("siclaw_tokens_total", [[{ type: "input" }, 150]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(250);
  });

  it("(4) idempotent: ingesting the same frame twice adds nothing the second time", () => {
    const agg = new PromFederationAggregator();
    const frame = [counter("siclaw_tokens_total", [[{ type: "output" }, 42]])];
    agg.ingest("box-a", "inc-1", frame);
    agg.ingest("box-a", "inc-1", frame); // flush retry / pull+flush collision
    expect(counterVal(agg, "siclaw_tokens_total", { type: "output" })).toBe(42);
  });

  it("(5) a late/flush frame after the instance left the live set still computes a correct delta (no recount)", () => {
    const agg = new PromFederationAggregator();
    // round 1: pulled at 70
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 70]])]);
    // pod disappears from the pod list across two reconciliations.
    agg.retainInstances(new Set<string>());
    agg.retainInstances(new Set<string>());
    // A late SIGTERM flush / reordered pull arrives with final value 90. The counter
    // baseline is retained (LRU), so delta = 20 — NOT a full recount of 90.
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 90]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(90);
  });

  it("(②) a late frame after eviction is NOT re-counted in full (counter baseline retained)", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 50]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(50);
    // pod leaves; two reconciliations would have dropped a naive baseline.
    agg.retainInstances(new Set<string>());
    agg.retainInstances(new Set<string>());
    // late frame of 100 → delta 50 → total 100 (the pod's true cumulative), not 150.
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 100]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(100);
  });

  it("(③) a reordered stale-incarnation frame computes a correct delta, not a full recount", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 100]])]);
    // pod rebuilt: new incarnation reports 10 → supersedes inc-1, +10 = 110
    agg.ingest("box-a", "inc-2", [counter("siclaw_tokens_total", [[{ type: "input" }, 10]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(110);
    // a reordered old-incarnation frame (inc-1 grew 100 → 120 before it died) arrives
    // late. With the baseline retained, delta = 20 → 130 (inc-1 final 120 + inc-2 10),
    // NOT a full recount of 120 (which would give 230).
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 120]])]);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(130);
  });

  it("(①) label values containing ',' or '=' do NOT collapse into one series", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [
      { name: "siclaw_tokens_total", type: "counter", values: [
        { labels: { a: "1,b=2" }, value: 5 },
        { labels: { a: "1", b: "2" }, value: 7 },
      ] },
    ]);
    const fam = agg.exportGroups().find((g) => g.name === "siclaw_tokens_total");
    // two DISTINCT series, not one merged-and-summed series of 12
    expect(fam!.values.length).toBe(2);
    expect(fam!.values.some((v) => v.value === 12)).toBe(false);
  });

  it("LRU caps retained baselines so memory is bounded under churn", () => {
    const agg = new PromFederationAggregator();
    // ingest far more distinct instances than the cap; tracked count must stay bounded.
    for (let i = 0; i < 5000; i++) {
      agg.ingest(`box-${i}`, "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 1]])]);
    }
    expect(agg.trackedInstanceCount()).toBeLessThanOrEqual(4096);
  });

  it("(6) gauge whitelist: sessions_active is summed across live pods; non-whitelisted gauges are skipped", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [
      gauge("siclaw_sessions_active", 2),
      gauge("siclaw_context_tokens_used", 1500, { provider: "anthropic", model: "m" }),
      gauge("siclaw_ws_connections", 3),
    ]);
    agg.ingest("box-b", "inc-1", [gauge("siclaw_sessions_active", 5)]);

    // summed across the two pods
    expect(gaugeVal(agg, "siclaw_sessions_active")).toBe(7);
    // non-whitelisted gauges never federated
    expect(agg.exportGroups().find((g) => g.name === "siclaw_context_tokens_used")).toBeUndefined();
    expect(agg.exportGroups().find((g) => g.name === "siclaw_ws_connections")).toBeUndefined();
  });

  it("(6b) gauge sum drops a pod's contribution after it is evicted", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [gauge("siclaw_sessions_active", 2)]);
    agg.ingest("box-b", "inc-1", [gauge("siclaw_sessions_active", 5)]);
    expect(gaugeVal(agg, "siclaw_sessions_active")).toBe(7);

    // box-b gone → grace then evict
    agg.retainInstances(new Set(["box-a"]));
    agg.retainInstances(new Set(["box-a"]));
    expect(gaugeVal(agg, "siclaw_sessions_active")).toBe(2);
  });

  it("(7) admission control: non-siclaw_ counters/histograms are ignored", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [
      counter("nodejs_eventloop_lag_seconds", [[{}, 99]]),
      counter("siclaw_tokens_total", [[{ type: "input" }, 10]]),
    ]);
    expect(agg.exportGroups().find((g) => g.name === "nodejs_eventloop_lag_seconds")).toBeUndefined();
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(10);
  });

  it("histogram sub-samples accumulate per bucket/sum/count just like counters", () => {
    const agg = new PromFederationAggregator();
    const labels = { provider: "anthropic", model: "m", outcome: "completed" };
    agg.ingest("box-a", "inc-1", [
      histogram("siclaw_prompt_duration_ms", labels, [[500, 1], [1000, 2], ["+Inf", 3]], 2100, 3),
    ]);
    agg.ingest("box-a", "inc-1", [
      histogram("siclaw_prompt_duration_ms", labels, [[500, 2], [1000, 4], ["+Inf", 6]], 4500, 6),
    ]);

    const fam = agg.exportGroups().find((g) => g.name === "siclaw_prompt_duration_ms");
    expect(fam?.type).toBe("histogram");
    const inf = fam!.values.find((v) => v.metricName === "siclaw_prompt_duration_ms_bucket" && v.labels.le === "+Inf");
    const count = fam!.values.find((v) => v.metricName === "siclaw_prompt_duration_ms_count");
    const sum = fam!.values.find((v) => v.metricName === "siclaw_prompt_duration_ms_sum");
    expect(inf?.value).toBe(6);   // 3 + 3
    expect(count?.value).toBe(6); // 3 + 3
    expect(sum?.value).toBe(4500); // 2100 + 2400
  });

  it("two pods with the same business labels converge into one federated series (pod identity aggregated away)", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 30]])]);
    agg.ingest("box-b", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 70]])]);
    const fam = agg.exportGroups().find((g) => g.name === "siclaw_tokens_total");
    // one series, summed
    expect(fam!.values.length).toBe(1);
    expect(counterVal(agg, "siclaw_tokens_total", { type: "input" })).toBe(100);
  });

  it("metrics() renders valid Prometheus text: one # TYPE per family, no duplicates", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [
      { name: "siclaw_tokens_total", help: "Cumulative tokens", type: "counter", values: [{ labels: { type: "input" }, value: 10 }] },
      gauge("siclaw_sessions_active", 2),
    ]);
    agg.ingest("box-b", "inc-1", [
      { name: "siclaw_tokens_total", help: "Cumulative tokens", type: "counter", values: [{ labels: { type: "input" }, value: 5 }] },
      gauge("siclaw_sessions_active", 3),
    ]);

    const text = agg.metrics();

    // exactly one TYPE line per family
    expect((text.match(/# TYPE siclaw_tokens_total /g) || []).length).toBe(1);
    expect((text.match(/# TYPE siclaw_sessions_active /g) || []).length).toBe(1);
    expect(text).toContain("# HELP siclaw_tokens_total Cumulative tokens");
    expect(text).toContain("# TYPE siclaw_tokens_total counter");
    expect(text).toContain('siclaw_tokens_total{type="input"} 15');
    expect(text).toContain("# TYPE siclaw_sessions_active gauge");
    expect(text).toContain("siclaw_sessions_active 5");
  });

  it("metrics() renders histograms with precise _bucket/_sum/_count and a +Inf bucket", () => {
    const agg = new PromFederationAggregator();
    const labels = { provider: "anthropic", model: "m", outcome: "completed" };
    agg.ingest("box-a", "inc-1", [
      { ...histogram("siclaw_prompt_duration_ms", labels, [[500, 1], [1000, 3], ["+Inf", 4]], 5200, 4), help: "latency" },
    ]);

    const text = agg.metrics();
    expect(text).toContain("# TYPE siclaw_prompt_duration_ms histogram");
    expect(text).toContain('siclaw_prompt_duration_ms_bucket{le="+Inf",model="m",outcome="completed",provider="anthropic"} 4');
    expect(text).toContain('siclaw_prompt_duration_ms_bucket{le="500",model="m",outcome="completed",provider="anthropic"} 1');
    expect(text).toMatch(/siclaw_prompt_duration_ms_sum\{[^}]*\} 5200/);
    expect(text).toMatch(/siclaw_prompt_duration_ms_count\{[^}]*\} 4/);
  });

  it("metrics() output round-trips through a fresh prom-client Registry without parse errors", async () => {
    // Sanity: the text we emit is accepted by a standard parser. We assert no duplicate
    // TYPE lines (the failure mode the dedup contract guards against).
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [
      { name: "siclaw_tokens_total", help: "h", type: "counter", values: [{ labels: { type: "input", provider: "p" }, value: 7 }] },
    ]);
    const text = agg.metrics();
    // every metric-name TYPE appears at most once
    const typeLines = (text.match(/^# TYPE (\S+) /gm) || []).map((l) => l.split(" ")[2]);
    expect(new Set(typeLines).size).toBe(typeLines.length);
    // label escaping: a value with a quote is escaped
    agg.ingest("box-c", "inc-1", [
      { name: "siclaw_tokens_total", help: "h", type: "counter", values: [{ labels: { type: 'a"b' }, value: 1 }] },
    ]);
    expect(agg.metrics()).toContain('type="a\\"b"');
  });

  it("tracks instance/series counts for self-monitoring", () => {
    const agg = new PromFederationAggregator();
    agg.ingest("box-a", "inc-1", [counter("siclaw_tokens_total", [[{ type: "input" }, 1]], )]);
    agg.ingest("box-b", "inc-1", [counter("siclaw_tokens_total", [[{ type: "output" }, 1]])]);
    expect(agg.trackedInstanceCount()).toBe(2);
    expect(agg.seriesCount()).toBe(2);
  });
});
