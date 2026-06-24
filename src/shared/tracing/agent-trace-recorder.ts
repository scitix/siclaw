/**
 * AgentTraceRecorder — the single hook layer that turns brain/route events into
 * an OpenTelemetry span tree, one tree per user prompt.
 *
 * Event-consumption contract (mirrors the SSE consumer in http-server.ts):
 *   - Non-routing brain events arrive via a GATED `brain.subscribe` registered
 *     in session.ts (the gate `_routeBrainEventsThroughExtra` is the same one
 *     SSE uses) → handleEvent.
 *   - Routing replays the winning attempt's brain events + the `model_route_*`
 *     events through `emitSessionExtraEvent` (http-server.ts) → handleEvent.
 *   Both paths converge on the single `handleEvent` entry, dispatched by type.
 *   The recorder NEVER subscribes to the brain directly.
 *
 * ROOT boundary: ROOT spans are opened/closed by EXPLICIT prompt boundaries
 * (`startPrompt`/`endPrompt`), never by `agent_start` — auto-retry and model
 * routing emit multiple agent_start/agent_end pairs inside one user prompt, so
 * an agent_start-rooted trace would be shredded into fragments.
 *
 * Authoritative token/cost: ROOT carries `getSessionStats()` deltas computed at
 * endPrompt (cumulative post − pre) — this is the trusted accounting. Per-call
 * message.usage is ALSO read defensively onto each LLM span as supplementary
 * per-call granularity (typeof-guarded, skipped when absent); it never replaces
 * the ROOT deltas.
 *
 * Fault isolation: every public method is wrapped in try/catch and only ever
 * console.warn — a recorder fault must never disturb the brain-event main flow
 * (same contract as emitDiagnostic). When tracing is disabled every method is a
 * clean no-op.
 */

import {
  trace as otelTrace,
  ROOT_CONTEXT,
  SpanStatusCode,
  type Span,
  type Context,
  type Attributes,
} from "@opentelemetry/api";
import type { BrainSession, BrainSessionStats } from "../../core/brain-session.js";
import { loadConfig } from "../../core/config.js";
import { getTracer, isTracingEnabled } from "./otel-provider.js";
import {
  Attr,
  SpanKind,
  contentAttribute,
  tokenCountAttributes,
  type TokenDelta,
} from "./openinference-attrs.js";

const ROOT_SPAN_NAME = "agent.prompt";
const TURN_SPAN_NAME = "turn";
const LLM_SPAN_NAME = "llm.call";

export interface TraceAttachContext {
  userId?: string;
  agentId?: string | null;
}

/** Brain + identity captured at attach, used to read model/stats at prompt time. */
interface SessionAttachment {
  brain: BrainSession;
  ctx: TraceAttachContext;
}

/** Live span handles for one in-flight prompt. */
interface SessionTrace {
  root: Span;
  /** Explicit parent context for children — NOT the implicit active-context stack. */
  rootCtx: Context;
  statsAtStart: BrainSessionStats;
  turn?: { span: Span; ctx: Context };
  llm?: Span;
  /** toolCallId → TOOL span (keyed so concurrent same-name tools never collide). */
  tools: Map<string, Span>;
}

const attachments = new Map<string, SessionAttachment>();
const traces = new Map<string, SessionTrace>();

// ── field extraction helpers (brain events are untyped `any` upstream) ──────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Concatenate the text parts of an assistant message's content array. */
function extractAssistantText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  let text = "";
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text.length > 0 ? text : undefined;
}

/** Drop undefined values so an Attributes object never carries empty slots. */
function flatAttrs(obj: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/** Read the PII gate lazily so a sendContent toggle is honoured per-prompt. */
function sendContentEnabled(): boolean {
  try {
    return loadConfig().tracing?.sendContent === true;
  } catch {
    return false;
  }
}

// ── span helpers ────────────────────────────────────────────────────────────

/** End a span best-effort; OTel tolerates a double end() but we still guard. */
function endSpanSafe(span: Span | undefined, status?: { code: SpanStatusCode; message?: string }): void {
  if (!span) return;
  try {
    if (status) span.setStatus(status);
    span.end();
  } catch (err) {
    console.warn("[tracing] endSpan error:", err);
  }
}

/** Force-end every open child + ROOT of a trace, marking children ERROR/aborted. */
function abortTrace(trace: SessionTrace): void {
  for (const toolSpan of trace.tools.values()) {
    endSpanSafe(toolSpan, { code: SpanStatusCode.ERROR, message: "aborted" });
  }
  trace.tools.clear();
  if (trace.llm) {
    endSpanSafe(trace.llm, { code: SpanStatusCode.ERROR, message: "aborted" });
    trace.llm = undefined;
  }
  if (trace.turn) {
    endSpanSafe(trace.turn.span, { code: SpanStatusCode.ERROR, message: "aborted" });
    trace.turn = undefined;
  }
  trace.root.addEvent("aborted");
  endSpanSafe(trace.root, { code: SpanStatusCode.ERROR, message: "aborted" });
}

// ── event dispatch ────────────────────────────────────────────────────────────

function parentContext(trace: SessionTrace): Context {
  return trace.turn?.ctx ?? trace.rootCtx;
}

/**
 * Per-type field extraction for model_route_* events. Field names differ by
 * subtype: start uses primaryProvider/primaryModelId; switch uses
 * fromProvider/toProvider/fromModelId/toModelId; attempt/success use
 * provider/modelId. A flat read of event.provider/modelId would be undefined
 * for start/switch. Source of truth: ModelRouteEvent union in core/model-routing.ts.
 */
function routeEventAttributes(type: string, event: Record<string, unknown>): Record<string, unknown> {
  // Common across all subtypes (absent fields drop out via flatAttrs).
  const base: Record<string, unknown> = {
    attempt: event.attempt,
    failureKind: event.failureKind,
    errorMessage: event.errorMessage,
  };
  switch (type) {
    case "model_route_start":
      return {
        ...base,
        strategy: event.strategy,
        candidateCount: event.candidateCount,
        activeCandidateKey: event.activeCandidateKey,
        primaryCandidateKey: event.primaryCandidateKey,
        primaryProvider: event.primaryProvider,
        primaryModelId: event.primaryModelId,
      };
    case "model_route_attempt":
      return {
        ...base,
        candidateKey: event.candidateKey,
        provider: event.provider,
        modelId: event.modelId,
        status: event.status,
        fallbackBlockedReason: event.fallbackBlockedReason,
      };
    case "model_route_switch":
      return {
        ...base,
        fromCandidateKey: event.fromCandidateKey,
        toCandidateKey: event.toCandidateKey,
        fromProvider: event.fromProvider,
        fromModelId: event.fromModelId,
        toProvider: event.toProvider,
        toModelId: event.toModelId,
        cooldownUntil: event.cooldownUntil,
      };
    case "model_route_success":
      return {
        ...base,
        candidateKey: event.candidateKey,
        provider: event.provider,
        modelId: event.modelId,
        isFallback: event.isFallback,
        primaryCandidateKey: event.primaryCandidateKey,
        recoveredFromCandidateKey: event.recoveredFromCandidateKey,
        recoveredFromProvider: event.recoveredFromProvider,
        recoveredFromModelId: event.recoveredFromModelId,
      };
    case "model_route_exhausted":
      return {
        ...base,
        candidateKey: event.candidateKey,
        fallbackBlockedReason: event.fallbackBlockedReason,
      };
    case "model_route_aborted":
    case "model_route_rollback":
      return { ...base, candidateKey: event.candidateKey };
    default:
      // Unknown future subtype — keep the common fields only.
      return base;
  }
}

function dispatch(sessionId: string, trace: SessionTrace, event: Record<string, unknown>): void {
  const type = str(event.type);
  if (!type) return;
  const tracer = getTracer();
  const attachment = attachments.get(sessionId);
  const sendContent = sendContentEnabled();

  // model routing + auto retry/compaction → ROOT annotations (ROOT always exists here)
  if (type.startsWith("model_route_")) {
    trace.root.addEvent(type, flatAttrs(routeEventAttributes(type, event)));
    // model_route_success fires on EVERY turn under the unified runner entry and
    // carries the winning model — write it onto the ROOT so the AGENT span shows
    // the model that actually answered, not the one pinned at startPrompt (stale
    // after a fallback switch). Authoritative + uniform; no ROOT-label patch off
    // getModel() needed.
    if (type === "model_route_success") {
      trace.root.setAttributes(flatAttrs({
        [Attr.llmModelName]: str(event.modelId),
        [Attr.llmProvider]: str(event.provider),
      }));
    }
    return;
  }
  if (type.startsWith("auto_retry_") || type.startsWith("auto_compaction_")) {
    trace.root.addEvent(type, flatAttrs({
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      reason: event.reason,
      errorMessage: event.errorMessage,
      success: event.success,
    }));
    return;
  }

  switch (type) {
    case "agent_start":
    case "agent_end":
      // Internal turn markers only — NOT a ROOT boundary (see file header).
      trace.root.addEvent(type);
      return;

    case "turn_start": {
      // best-effort CHAIN span; replace any stale turn defensively.
      if (trace.turn) endSpanSafe(trace.turn.span);
      const span = tracer.startSpan(
        TURN_SPAN_NAME,
        { attributes: { [Attr.spanKind]: SpanKind.CHAIN } },
        trace.rootCtx,
      );
      trace.turn = { span, ctx: otelTrace.setSpan(trace.rootCtx, span) };
      return;
    }
    case "turn_end": {
      if (trace.turn) {
        endSpanSafe(trace.turn.span);
        trace.turn = undefined;
      }
      return;
    }

    case "message_start": {
      const message = event.message;
      if (!isRecord(message) || message.role !== "assistant") return;
      const model = attachment?.brain.getModel?.();
      const span = tracer.startSpan(
        LLM_SPAN_NAME,
        {
          attributes: flatAttrs({
            [Attr.spanKind]: SpanKind.LLM,
            [Attr.llmModelName]: model?.id,
            [Attr.llmProvider]: model?.provider,
          }),
        },
        parentContext(trace),
      );
      // If a previous LLM span was left open (no message_end), close it first.
      if (trace.llm) endSpanSafe(trace.llm);
      trace.llm = span;
      return;
    }
    case "message_end": {
      const message = event.message;
      if (!isRecord(message) || message.role !== "assistant") return;
      const span = trace.llm;
      if (!span) return;
      const stopReason = str(message.stopReason);
      span.setAttributes(flatAttrs({ [Attr.llmFinishReason]: stopReason }));
      const text = extractAssistantText(message);
      span.setAttributes(contentAttribute(Attr.outputValue, text, "llm_output", sendContent));
      // Per-call token/cost: supplementary granularity read defensively off
      // message.usage. This is metadata (NOT content) so it bypasses the
      // sendContent gate. The ROOT getSessionStats() delta remains the
      // authoritative accounting — this only adds per-LLM-span detail, and is
      // skipped silently whenever a field is missing or non-numeric.
      span.setAttributes(perCallTokenAttributes(message.usage));
      const isError = stopReason === "error";
      endSpanSafe(span, isError
        ? { code: SpanStatusCode.ERROR, message: str(message.errorMessage) ?? "error" }
        : { code: SpanStatusCode.OK });
      trace.llm = undefined;
      return;
    }

    case "tool_execution_start": {
      const callId = str(event.toolCallId) ?? `tool-${trace.tools.size}`;
      const span = tracer.startSpan(
        str(event.toolName) ?? "tool",
        {
          attributes: flatAttrs({
            [Attr.spanKind]: SpanKind.TOOL,
            [Attr.toolName]: str(event.toolName),
          }),
        },
        parentContext(trace),
      );
      // tool.parameters is OpenInference's canonical key for tool args; do NOT
      // also mirror them onto input.value (redundant, doubles content bloat).
      span.setAttributes(contentAttribute(Attr.toolParameters, event.args, "tool_args", sendContent));
      // Defensive: a duplicate start for the same callId closes the prior span.
      const existing = trace.tools.get(callId);
      if (existing) endSpanSafe(existing);
      trace.tools.set(callId, span);
      return;
    }
    case "tool_execution_end": {
      const callId = str(event.toolCallId);
      // Fall back to the only open tool span when no id is present.
      const span = callId !== undefined
        ? trace.tools.get(callId)
        : (trace.tools.size === 1 ? [...trace.tools.values()][0] : undefined);
      if (!span) return;
      span.setAttributes(contentAttribute(Attr.outputValue, event.result, "tool_result", sendContent));
      const isError = event.isError === true;
      endSpanSafe(span, isError ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.OK });
      if (callId !== undefined) trace.tools.delete(callId);
      else trace.tools.clear();
      return;
    }

    default:
      // Unknown event types (message_update deltas, etc.) carry no span action.
      return;
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Read per-call token/cost off a `message.usage` object onto an LLM span.
 * Every field is typeof-guarded — a missing or non-numeric field is skipped,
 * never written as wrong data. Mirrors bench's phoenix-tracer usage read.
 */
function perCallTokenAttributes(usage: unknown): Attributes {
  if (!isRecord(usage)) return {};
  const attrs: Attributes = {};
  if (typeof usage.input === "number") attrs[Attr.tokenPrompt] = usage.input;
  if (typeof usage.output === "number") attrs[Attr.tokenCompletion] = usage.output;
  if (typeof usage.totalTokens === "number") attrs[Attr.tokenTotal] = usage.totalTokens;
  if (isRecord(usage.cost) && typeof usage.cost.total === "number") {
    attrs[Attr.cost] = usage.cost.total;
  }
  return attrs;
}

function computeTokenDelta(prev: BrainSessionStats, curr: BrainSessionStats): TokenDelta {
  return {
    input: (curr.tokens.input ?? 0) - (prev.tokens.input ?? 0),
    output: (curr.tokens.output ?? 0) - (prev.tokens.output ?? 0),
    cacheRead: (curr.tokens.cacheRead ?? 0) - (prev.tokens.cacheRead ?? 0),
    cacheWrite: (curr.tokens.cacheWrite ?? 0) - (prev.tokens.cacheWrite ?? 0),
    total: (curr.tokens.total ?? 0) - (prev.tokens.total ?? 0),
  };
}

export const tracingRecorder = {
  /** Record the brain + identity for a session. Does not open any span. */
  attach(sessionId: string, brain: BrainSession, ctx: TraceAttachContext): void {
    if (!isTracingEnabled()) return;
    try {
      attachments.set(sessionId, { brain, ctx });
    } catch (err) {
      console.warn("[tracing] attach error:", err);
    }
  },

  /** Idempotent. Force-ends any in-flight span tree (ABORTED) and drops session state. */
  detach(sessionId: string): void {
    try {
      const trace = traces.get(sessionId);
      if (trace) {
        traces.delete(sessionId);
        abortTrace(trace);
      }
      attachments.delete(sessionId);
    } catch (err) {
      console.warn("[tracing] detach error:", err);
    }
  },

  /** Open the ROOT span for one user prompt and snapshot cumulative stats. */
  startPrompt(sessionId: string, promptText?: string): void {
    if (!isTracingEnabled()) return;
    try {
      const attachment = attachments.get(sessionId);
      if (!attachment) {
        console.debug(`[tracing] startPrompt with no attachment for ${sessionId}; skipping`);
        return;
      }
      // A pre-existing trace means a prior endPrompt was missed — abort it cleanly.
      const stale = traces.get(sessionId);
      if (stale) {
        traces.delete(sessionId);
        abortTrace(stale);
      }
      const model = attachment.brain.getModel?.();
      const root = getTracer().startSpan(
        ROOT_SPAN_NAME,
        {
          attributes: flatAttrs({
            [Attr.spanKind]: SpanKind.AGENT,
            [Attr.sessionId]: sessionId,
            [Attr.userId]: attachment.ctx.userId,
            [Attr.metadata]: attachment.ctx.agentId
              ? JSON.stringify({ "agent.id": attachment.ctx.agentId })
              : undefined,
            [Attr.llmModelName]: model?.id,
            [Attr.llmProvider]: model?.provider,
            // User prompt as ROOT input — content, so gated by sendContent +
            // redacted. Empty/absent promptText yields no key (contentAttribute).
            ...contentAttribute(Attr.inputValue, promptText, "llm_input", sendContentEnabled()),
          }),
        },
        ROOT_CONTEXT,
      );
      traces.set(sessionId, {
        root,
        rootCtx: otelTrace.setSpan(ROOT_CONTEXT, root),
        statsAtStart: attachment.brain.getSessionStats(),
        tools: new Map(),
      });
    } catch (err) {
      console.warn("[tracing] startPrompt error:", err);
    }
  },

  /** Single event entry. Drops events that arrive with no open ROOT (e.g. background turns). */
  handleEvent(sessionId: string, event: Record<string, unknown>): void {
    if (!isTracingEnabled()) return;
    try {
      const trace = traces.get(sessionId);
      if (!trace) {
        console.debug(`[tracing] handleEvent with no ROOT for ${sessionId}; dropping ${String(event?.type)}`);
        return;
      }
      dispatch(sessionId, trace, event);
    } catch (err) {
      console.warn("[tracing] handleEvent error:", err);
    }
  },

  /** Close any open children + ROOT, attaching authoritative token/cost deltas. */
  endPrompt(sessionId: string, outcome: "completed" | "error"): void {
    if (!isTracingEnabled()) return;
    try {
      const trace = traces.get(sessionId);
      if (!trace) return;
      traces.delete(sessionId);

      // Close children left open by missing end events (graceful — not aborted).
      for (const toolSpan of trace.tools.values()) endSpanSafe(toolSpan);
      trace.tools.clear();
      if (trace.llm) { endSpanSafe(trace.llm); trace.llm = undefined; }
      if (trace.turn) { endSpanSafe(trace.turn.span); trace.turn = undefined; }

      const attachment = attachments.get(sessionId);
      const curr = attachment?.brain.getSessionStats();
      if (curr) {
        const delta = computeTokenDelta(trace.statsAtStart, curr);
        trace.root.setAttributes(tokenCountAttributes(delta));
        const costDelta = (curr.cost ?? 0) - (trace.statsAtStart.cost ?? 0);
        if (costDelta > 0) trace.root.setAttributes({ [Attr.cost]: costDelta });
      }
      endSpanSafe(trace.root, outcome === "error"
        ? { code: SpanStatusCode.ERROR }
        : { code: SpanStatusCode.OK });
    } catch (err) {
      console.warn("[tracing] endPrompt error:", err);
    }
  },
};

/** Test-only: clear module state between cases. NOT used in production. */
export function __resetRecorderForTest(): void {
  attachments.clear();
  traces.clear();
}
