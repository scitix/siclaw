/**
 * OpenTelemetry provider lifecycle + fan-out (no Collector).
 *
 * Builds one BatchSpanProcessor per configured exporter and attaches them all
 * to a single NodeTracerProvider — this is the fan-out point that lets "one
 * recording path" feed multiple OTLP backends (Phoenix, Langfuse, …) chosen by
 * config. The recorder never imports an exporter; it only asks for a tracer.
 *
 * SDK 2.x note: span processors are passed via the constructor
 * (`new NodeTracerProvider({ spanProcessors })`); the 1.x `addSpanProcessor`
 * method has been removed.
 *
 * Disabled state (config.tracing.enabled !== true) is a clean no-op: no
 * provider is built, isTracingEnabled() stays false, and the recorder short-
 * circuits before touching any OTel API.
 */

import { trace, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { SpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SiclawConfig, TracingExporterConfig } from "../../core/config.js";

/** Instrumentation-scope name attached to every span this layer produces. */
export const TRACER_NAME = "siclaw-agent-trace-recorder";
const DEFAULT_SERVICE_NAME = "siclaw-agentbox";
/** Cap on forceFlush during shutdown so a dead in-network backend cannot stall SIGTERM. */
const FORCE_FLUSH_TIMEOUT_MS = 3000;

let provider: BasicTracerProvider | null = null;
let enabled = false;

/**
 * Authoritative source for the PII gate (config.tracing.sendContent), kept as
 * module state and refreshed on every initTracing/reinitTracing. The recorder
 * reads it via isSendContentEnabled() instead of loadConfig() so a hot-reload
 * toggle flips the gate atomically — loadConfig() would cache the on-disk value
 * and never observe a DB-driven reinit.
 */
let activeSendContent = false;

/** Process-level serial lock for reinitTracing — see reinitTracing() below. */
let reinitInFlight: Promise<void> | null = null;

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep only string-valued headers — OTLPTraceExporter expects Record<string,string>. */
function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build span processors from the exporter list. URL/header validation lives here
 * (config.ts intentionally carries no business validation). Invalid entries are
 * skipped with a warning rather than aborting the whole tracing setup.
 */
function buildSpanProcessors(exporters: TracingExporterConfig[] | undefined): SpanProcessor[] {
  const processors: SpanProcessor[] = [];
  for (const ex of exporters ?? []) {
    if (!ex || typeof ex.url !== "string" || ex.url.trim() === "") {
      console.warn("[tracing] Skipping exporter with missing/invalid url");
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(ex.url);
    } catch {
      // Do NOT log the raw url — it may carry user:pass@ credentials. Parsing
      // failed here, so there is no host/pathname to show: use the fallback.
      console.warn("[tracing] Skipping exporter with malformed url: <unparseable>");
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.warn(`[tracing] Skipping exporter with unsupported protocol: ${parsed.protocol}`);
      continue;
    }
    const headers = sanitizeHeaders(ex.headers);
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: ex.url, headers })));
  }
  return processors;
}

/**
 * Initialise tracing from config. No-op (and leaves isTracingEnabled() false)
 * when tracing is disabled or no valid exporter is configured. Idempotent — a
 * second call while a provider is live returns immediately.
 */
export function initTracing(config: SiclawConfig): void {
  const tracing = config.tracing;
  // Refresh the PII gate FIRST — before the idempotent early-return below — so
  // isSendContentEnabled() always reflects the latest config, even when a
  // provider is already live and on the disabled paths (e.g. a reinit that
  // turns tracing off).
  activeSendContent = tracing?.sendContent === true;
  if (provider) return; // idempotent
  if (!tracing || tracing.enabled !== true) return;

  const processors = buildSpanProcessors(tracing.exporters);
  if (processors.length === 0) {
    console.warn("[tracing] enabled but no valid exporters configured; tracing stays disabled");
    return;
  }

  const resource = resourceFromAttributes({
    "service.name": tracing.serviceName ?? DEFAULT_SERVICE_NAME,
  });
  const built = new NodeTracerProvider({ resource, spanProcessors: processors });
  built.register();
  provider = built;
  enabled = true;
  console.log(`[tracing] enabled with ${processors.length} exporter(s), service.name=${tracing.serviceName ?? DEFAULT_SERVICE_NAME}`);
}

/** Recorder short-circuit: true only after a provider is live. */
export function isTracingEnabled(): boolean {
  return enabled;
}

/** Tracer used by the recorder. Falls through to the global no-op tracer when disabled. */
export function getTracer(): Tracer {
  return (provider ?? trace.getTracerProvider()).getTracer(TRACER_NAME);
}

/**
 * Flush + shut down the provider. forceFlush is raced against a 3s timeout so a
 * dead in-network backend (BatchSpanProcessor OTLP retry default is 10s+) cannot
 * hold the process past the K8s 30s grace period.
 */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  const live = provider;
  try {
    await Promise.race([live.forceFlush(), timeout(FORCE_FLUSH_TIMEOUT_MS)]);
  } catch (err) {
    console.warn("[tracing] forceFlush error during shutdown:", err);
  }
  try {
    await live.shutdown();
  } catch (err) {
    console.warn("[tracing] shutdown error:", err);
  }
  provider = null;
  enabled = false;
}

/**
 * Hot-reload the provider at runtime: flush + tear down the current provider,
 * then build a fresh one from the new config (new exporters / serviceName /
 * sendContent all take effect). Distinct from initTracing(), which is idempotent
 * (`if (provider) return`) and would no-op against a live provider.
 *
 * Serialised on a process-level in-flight Promise: in local mode several
 * in-process AgentBoxes share this single provider singleton, so concurrent
 * reloads must not interleave shutdown+init. Each call chains after the previous
 * (errors swallowed so one failed reinit doesn't poison the chain), guaranteeing
 * shutdownTracing() fully completes before the next initTracing() runs.
 */
export function reinitTracing(config: SiclawConfig): Promise<void> {
  reinitInFlight = (reinitInFlight ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await shutdownTracing();
      initTracing(config);
    });
  return reinitInFlight;
}

/**
 * The PII gate honoured by the recorder. True only when config.tracing.sendContent
 * was true at the last initTracing/reinitTracing — kept as module state so a
 * hot-reload toggle is observed atomically (see activeSendContent).
 */
export function isSendContentEnabled(): boolean {
  return activeSendContent;
}

/**
 * Test-only seam: install a tracer provider (e.g. one wired to InMemorySpanExporter)
 * and flip the enabled flag, bypassing the OTLP exporter build. Pass null to reset.
 * Optionally set the sendContent gate. NOT a production code path — the prod entry
 * is initTracing().
 */
export function __installTracerProviderForTest(
  testProvider: BasicTracerProvider | null,
  sendContent = false,
): void {
  provider = testProvider;
  enabled = testProvider != null;
  activeSendContent = sendContent;
}
