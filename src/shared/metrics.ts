/**
 * Prometheus metrics subscriber — the ONLY file that depends on prom-client.
 *
 * Subscribes to the diagnostic event bus and maps events to Prometheus metrics.
 * Business code never imports this module directly — it only calls emitDiagnostic().
 *
 * Importing this module (side-effect import) registers the subscriber automatically.
 */

import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { onDiagnostic, type DiagnosticEvent } from "./diagnostic-events.js";

export const metricsRegistry = new Registry();

/** Whether to include user_id label on token/cost metrics */
const INCLUDE_USER_ID = process.env.SICLAW_METRICS_USER_ID !== "false";

// ── Phase 1: Core metrics (7) ──

const tokensTotal = new Counter({
  name: "siclaw_tokens_total",
  help: "Cumulative token consumption",
  labelNames: ["type", "provider", "model", "user_id"] as const,
  registers: [metricsRegistry],
});

const costUsdTotal = new Counter({
  name: "siclaw_cost_usd_total",
  help: "Cumulative LLM cost in USD",
  labelNames: ["provider", "model", "user_id"] as const,
  registers: [metricsRegistry],
});

const promptDurationMs = new Histogram({
  name: "siclaw_prompt_duration_ms",
  help: "Prompt end-to-end processing latency in milliseconds",
  labelNames: ["provider", "model", "outcome"] as const,
  buckets: [500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
  registers: [metricsRegistry],
});

const promptsTotal = new Counter({
  name: "siclaw_prompts_total",
  help: "Total prompts processed",
  labelNames: ["provider", "model", "outcome"] as const,
  registers: [metricsRegistry],
});

const sessionsActive = new Gauge({
  name: "siclaw_sessions_active",
  help: "Current number of active sessions",
  registers: [metricsRegistry],
});

const toolCallsTotal = new Counter({
  name: "siclaw_tool_calls_total",
  help: "Total tool invocations",
  labelNames: ["tool_name", "outcome"] as const,
  registers: [metricsRegistry],
});

const wsConnections = new Gauge({
  name: "siclaw_ws_connections",
  help: "Current number of WebSocket connections",
  registers: [metricsRegistry],
});

// ── Phase 2: Session health metrics (4) ──

const contextTokensUsed = new Gauge({
  name: "siclaw_context_tokens_used",
  help: "Current context window tokens used (sampled per turn)",
  labelNames: ["provider", "model"] as const,
  registers: [metricsRegistry],
});

const contextTokensLimit = new Gauge({
  name: "siclaw_context_tokens_limit",
  help: "Context window token limit (sampled per turn)",
  labelNames: ["provider", "model"] as const,
  registers: [metricsRegistry],
});

const sessionStuckTotal = new Counter({
  name: "siclaw_session_stuck_total",
  help: "Number of stuck sessions detected",
  registers: [metricsRegistry],
});

const sessionStuckAgeMs = new Histogram({
  name: "siclaw_session_stuck_age_ms",
  help: "Duration of stuck sessions in milliseconds",
  buckets: [30_000, 60_000, 120_000, 300_000],
  registers: [metricsRegistry],
});

// ── Event → metric mapping ──

function handleDiagnostic(event: DiagnosticEvent): void {
  switch (event.type) {
    case "prompt_complete": {
      const { prev, curr, model, durationMs, outcome, userId } = event;
      const provider = model?.provider ?? "unknown";
      const modelId = model?.id ?? "unknown";

      // Token deltas (session stats are cumulative — subtract pre-prompt snapshot)
      const dInput = curr.tokens.input - prev.tokens.input;
      const dOutput = curr.tokens.output - prev.tokens.output;
      const dCacheRead = curr.tokens.cacheRead - prev.tokens.cacheRead;
      const dCacheWrite = curr.tokens.cacheWrite - prev.tokens.cacheWrite;

      const baseLabels = INCLUDE_USER_ID && userId
        ? { provider, model: modelId, user_id: userId }
        : { provider, model: modelId };

      if (dInput > 0) tokensTotal.inc({ ...baseLabels, type: "input" }, dInput);
      if (dOutput > 0) tokensTotal.inc({ ...baseLabels, type: "output" }, dOutput);
      if (dCacheRead > 0) tokensTotal.inc({ ...baseLabels, type: "cache_read" }, dCacheRead);
      if (dCacheWrite > 0) tokensTotal.inc({ ...baseLabels, type: "cache_write" }, dCacheWrite);

      // Cost delta
      const dCost = curr.cost - prev.cost;
      if (dCost > 0) costUsdTotal.inc(baseLabels, dCost);

      // Prompt duration + count
      const outcomeLabels = { provider, model: modelId, outcome };
      promptDurationMs.observe(outcomeLabels, durationMs);
      promptsTotal.inc(outcomeLabels);
      break;
    }

    case "session_created":
      sessionsActive.inc();
      break;

    case "session_released":
      sessionsActive.dec();
      break;

    case "tool_call":
      toolCallsTotal.inc({ tool_name: event.toolName, outcome: event.outcome });
      break;

    case "ws_connected":
      wsConnections.inc();
      break;

    case "ws_disconnected":
      wsConnections.dec();
      break;

    case "context_usage":
      contextTokensUsed.set({ provider: event.provider, model: event.model }, event.tokensUsed);
      contextTokensLimit.set({ provider: event.provider, model: event.model }, event.tokensLimit);
      break;

    case "session_stuck":
      sessionStuckTotal.inc();
      sessionStuckAgeMs.observe(event.idleMs);
      break;
  }
}

// Auto-register subscriber when this module is imported
onDiagnostic(handleDiagnostic);
