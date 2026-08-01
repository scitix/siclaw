import { describe, it, expect, afterEach } from "vitest";
import { metricsRegistry } from "../metrics.js";
import { startCapacityMetrics, stopCapacityMetrics, type CapacityProbe } from "../capacity-metrics.js";

/**
 * The contract these gauges have to keep is that they are read at SCRAPE time, not at
 * event time — a capacity reading that lags the thing it measures is worse than none,
 * because it is trusted the same way.
 */

async function read(name: string): Promise<number | undefined> {
  const groups = await metricsRegistry.getMetricsAsJSON();
  return groups.find((g) => g.name === name)?.values[0]?.value;
}

function probeOf(v: Partial<Record<keyof CapacityProbe, number>>): CapacityProbe {
  return {
    turnsInFlight: () => v.turnsInFlight ?? 0,
    subagentActive: () => v.subagentActive ?? 0,
    subagentPending: () => v.subagentPending ?? 0,
    subagentLimit: () => v.subagentLimit ?? 0,
  };
}

afterEach(() => stopCapacityMetrics());

describe("capacity metrics", () => {
  it("reports the probe's values at scrape time, not at registration time", async () => {
    let inFlight = 1;
    startCapacityMetrics({ ...probeOf({}), turnsInFlight: () => inFlight });
    expect(await read("siclaw_box_turns_in_flight")).toBe(1);

    // The whole point: no re-registration, no event, and the gauge still moves.
    inFlight = 7;
    expect(await read("siclaw_box_turns_in_flight")).toBe(7);
  });

  it("exposes sub-agent occupancy alongside its limit", async () => {
    startCapacityMetrics(probeOf({ subagentActive: 4, subagentPending: 2, subagentLimit: 4 }));
    expect(await read("siclaw_box_subagent_active")).toBe(4);
    expect(await read("siclaw_box_subagent_pending")).toBe(2);
    // Without the limit, "4 active" cannot be read as saturated or idle.
    expect(await read("siclaw_box_subagent_limit")).toBe(4);
  });

  it("reports process memory", async () => {
    startCapacityMetrics(probeOf({}));
    expect(await read("siclaw_box_rss_bytes")).toBeGreaterThan(0);
    expect(await read("siclaw_box_heap_used_bytes")).toBeGreaterThan(0);
  });

  it("reports event-loop lag as a number even before the first sampling window closes", async () => {
    startCapacityMetrics(probeOf({}));
    expect(await read("siclaw_box_event_loop_lag_mean_ms")).toBe(0);
    expect(await read("siclaw_box_event_loop_lag_max_ms")).toBe(0);
  });

  it("reports zero once stopped rather than the last value seen", async () => {
    startCapacityMetrics(probeOf({ turnsInFlight: 5 }));
    expect(await read("siclaw_box_turns_in_flight")).toBe(5);

    stopCapacityMetrics();
    expect(await read("siclaw_box_turns_in_flight")).toBe(0);
  });

  it("tolerates being started twice — the second call swaps the probe", async () => {
    startCapacityMetrics(probeOf({ turnsInFlight: 1 }));
    expect(() => startCapacityMetrics(probeOf({ turnsInFlight: 9 }))).not.toThrow();
    expect(await read("siclaw_box_turns_in_flight")).toBe(9);
  });
});
