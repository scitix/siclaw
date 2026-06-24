import { describe, it, expect, beforeEach } from "vitest";
import { emitDiagnostic } from "../diagnostic-events.js";
import { metricsRegistry, getMetricsAsJSON, processIncarnation } from "../metrics.js";

/**
 * Step 1 acceptance: the federation snapshot contract.
 * - getMetricsAsJSON() returns the prom-client family shape the aggregator expects
 * - histogram families expand into _bucket{le}/_sum/_count sub-samples with metricName
 * - plain counter/gauge samples carry no metricName
 * - processIncarnation is a stable, non-empty per-process nonce
 * - prom snapshot is CUMULATIVE (never cleared on read)
 */
describe("federation snapshot (getMetricsAsJSON + incarnation)", () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
  });

  it("returns counter/gauge/histogram families in PromSampleGroup shape", async () => {
    emitDiagnostic({
      type: "prompt_complete",
      prev: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
      curr: { tokens: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, total: 140 }, cost: 0.02 },
      model: { id: "claude-sonnet-4-20250514", name: "Sonnet", provider: "anthropic", contextWindow: 200000, maxTokens: 16384, reasoning: false },
      durationMs: 1500,
      outcome: "completed",
      userId: "u-fed-1",
    });

    const groups = await getMetricsAsJSON();

    // tokens_total is a counter
    const tokens = groups.find((g) => g.name === "siclaw_tokens_total");
    expect(tokens?.type).toBe("counter");
    expect(tokens!.values.length).toBeGreaterThan(0);
    // plain counter samples have no metricName
    expect(tokens!.values.every((v) => v.metricName === undefined)).toBe(true);

    // prompt_duration_ms is a histogram → expands into _bucket/_sum/_count
    const hist = groups.find((g) => g.name === "siclaw_prompt_duration_ms");
    expect(hist?.type).toBe("histogram");
    const subNames = new Set(hist!.values.map((v) => v.metricName));
    expect(subNames.has("siclaw_prompt_duration_ms_bucket")).toBe(true);
    expect(subNames.has("siclaw_prompt_duration_ms_sum")).toBe(true);
    expect(subNames.has("siclaw_prompt_duration_ms_count")).toBe(true);
    // a +Inf bucket exists and its label is the string "+Inf"
    const infBucket = hist!.values.find(
      (v) => v.metricName === "siclaw_prompt_duration_ms_bucket" && v.labels.le === "+Inf",
    );
    expect(infBucket).toBeDefined();
  });

  it("exposes a stable, non-empty processIncarnation", async () => {
    expect(typeof processIncarnation).toBe("string");
    expect(processIncarnation.length).toBeGreaterThan(0);
    // The same constant is returned on every read within the process.
    const { processIncarnation: again } = await import("../metrics.js");
    expect(again).toBe(processIncarnation);
  });

  it("prom snapshot is cumulative — NOT cleared on read", async () => {
    emitDiagnostic({
      type: "prompt_complete",
      prev: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
      curr: { tokens: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, total: 60 }, cost: 0.01 },
      model: { id: "m1", name: "M", provider: "anthropic", contextWindow: 1000, maxTokens: 100, reasoning: false },
      durationMs: 800,
      outcome: "completed",
      userId: "u-fed-2",
    });

    const first = await getMetricsAsJSON();
    const firstTokens = first.find((g) => g.name === "siclaw_tokens_total");
    const firstInput = firstTokens!.values.find((v) => v.labels.type === "input")!.value;
    expect(firstInput).toBe(50);

    // A second read with NO new events must return the same cumulative value.
    const second = await getMetricsAsJSON();
    const secondTokens = second.find((g) => g.name === "siclaw_tokens_total");
    const secondInput = secondTokens!.values.find((v) => v.labels.type === "input")!.value;
    expect(secondInput).toBe(50);
  });
});
