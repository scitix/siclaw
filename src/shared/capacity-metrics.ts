/**
 * Capacity gauges — how much work one AgentBox process is carrying right now.
 *
 * These answer a different question from the business metrics in metrics.ts: not
 * "how much has this agent done" but "how close is this box to its limits". They
 * exist so per-box thresholds — sub-agent concurrency, memory requests, where a new
 * session should be placed — can be set from measurement instead of guesswork.
 *
 * Two properties separate them from everything in metrics.ts:
 *
 *  - **Sampled, not event-driven.** There is no diagnostic event for "the event loop
 *    is 80ms behind". Values are read at scrape time through prom-client's `collect`
 *    hook, so they cannot go stale the way an event-updated gauge can when the events
 *    stop arriving.
 *
 *  - **Per box, never summed.** Adding RSS or event-loop lag across pods produces a
 *    number that means nothing. The federation carries these with a `box_id` label
 *    (`PER_BOX_GAUGES` in prom-federation-aggregator.ts), so a cross-box total is an
 *    explicit PromQL `sum()` where that is meaningful and is never taken implicitly
 *    where it is not.
 *
 * Registration is opt-in via `startCapacityMetrics()` and is called only by the
 * AgentBox entry point — the Gateway shares this prom-client registry and must not
 * start reporting box capacity it does not have.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { Gauge } from "prom-client";
import { metricsRegistry } from "./metrics.js";

/** Live counters the host process supplies whenever the registry is read. */
export interface CapacityProbe {
  /** Sessions with a prompt actually running — not merely resident in memory. */
  turnsInFlight(): number;
  /** Sub-agent slots occupied. */
  subagentActive(): number;
  /** Sub-agent spawns queued behind a full limiter. */
  subagentPending(): number;
  /** Configured sub-agent slot count (the denominator for the two above). */
  subagentLimit(): number;
}

const NS_PER_MS = 1e6;

/**
 * How often the event-loop delay histogram is summarised and reset.
 *
 * The histogram is summarised on its own timer rather than inside `collect` because
 * the registry has more than one reader (the /metrics route, the 30s federation pull,
 * the SIGTERM flush). Resetting inside `collect` would let whichever reader arrived
 * first consume the window and leave the others reporting near-zero lag.
 */
const LAG_SAMPLE_INTERVAL_MS = 10_000;

let probe: CapacityProbe | null = null;
let lagHistogram: IntervalHistogram | null = null;
let lagTimer: ReturnType<typeof setInterval> | null = null;
let lagMeanMs = 0;
let lagMaxMs = 0;
let gaugesRegistered = false;

/** Read a probe field, or 0 when no probe is installed (gauge must still be a number). */
function read(field: keyof CapacityProbe): number {
  if (!probe) return 0;
  const v = probe[field]();
  return Number.isFinite(v) ? v : 0;
}

function registerGauges(): void {
  if (gaugesRegistered) return;
  gaugesRegistered = true;

  new Gauge({
    name: "siclaw_box_turns_in_flight",
    help: "Sessions in this box with a prompt currently running",
    registers: [metricsRegistry],
    collect() { this.set(read("turnsInFlight")); },
  });

  new Gauge({
    name: "siclaw_box_subagent_active",
    help: "Sub-agent slots currently occupied in this box",
    registers: [metricsRegistry],
    collect() { this.set(read("subagentActive")); },
  });

  new Gauge({
    name: "siclaw_box_subagent_pending",
    help: "Sub-agent spawns queued waiting for a slot in this box",
    registers: [metricsRegistry],
    collect() { this.set(read("subagentPending")); },
  });

  new Gauge({
    name: "siclaw_box_subagent_limit",
    help: "Configured sub-agent slot count for this box",
    registers: [metricsRegistry],
    collect() { this.set(read("subagentLimit")); },
  });

  new Gauge({
    name: "siclaw_box_rss_bytes",
    help: "Resident set size of this box process",
    registers: [metricsRegistry],
    collect() { this.set(process.memoryUsage.rss()); },
  });

  new Gauge({
    name: "siclaw_box_heap_used_bytes",
    help: "V8 heap in use in this box process",
    registers: [metricsRegistry],
    collect() { this.set(process.memoryUsage().heapUsed); },
  });

  new Gauge({
    name: "siclaw_box_event_loop_lag_mean_ms",
    help: "Mean event-loop delay over the last sampling window",
    registers: [metricsRegistry],
    collect() { this.set(lagMeanMs); },
  });

  new Gauge({
    name: "siclaw_box_event_loop_lag_max_ms",
    help: "Worst event-loop delay observed in the last sampling window",
    registers: [metricsRegistry],
    collect() { this.set(lagMaxMs); },
  });
}

/** Summarise the current window and start a fresh one. */
function sampleLag(): void {
  if (!lagHistogram) return;
  lagMeanMs = lagHistogram.mean / NS_PER_MS;
  lagMaxMs = lagHistogram.max / NS_PER_MS;
  lagHistogram.reset();
}

/**
 * Begin reporting capacity gauges for this process.
 *
 * Safe to call more than once — the gauges register on the first call and later
 * calls only swap the probe. Returns a stop function for tests and shutdown.
 */
export function startCapacityMetrics(p: CapacityProbe): () => void {
  probe = p;
  registerGauges();

  if (!lagHistogram) {
    lagHistogram = monitorEventLoopDelay({ resolution: 20 });
    lagHistogram.enable();
  }
  if (!lagTimer) {
    lagTimer = setInterval(sampleLag, LAG_SAMPLE_INTERVAL_MS);
    // Never hold the process open just to sample lag.
    lagTimer.unref?.();
  }

  return stopCapacityMetrics;
}

/**
 * Stop sampling and detach the probe. The gauges stay registered (prom-client has no
 * safe re-registration story) but report 0, which is the truth once nothing is being
 * measured.
 */
export function stopCapacityMetrics(): void {
  probe = null;
  if (lagTimer) {
    clearInterval(lagTimer);
    lagTimer = null;
  }
  if (lagHistogram) {
    lagHistogram.disable();
    lagHistogram = null;
  }
  lagMeanMs = 0;
  lagMaxMs = 0;
}
