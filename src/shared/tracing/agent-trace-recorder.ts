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
  TraceFlags,
  isValidTraceId,
  type Span,
  type Context,
  type SpanContext,
  type Attributes,
} from "@opentelemetry/api";
import { randomBytes } from "node:crypto";
import type { BrainSession } from "../../core/brain-session.js";
import { getTracer, isTracingEnabled, isSendContentEnabled } from "./otel-provider.js";
import {
  Attr,
  SpanKind,
  contentAttribute,
  toolCallsOutputValue,
  toolDefinitionsInputValue,
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
  turn?: { span: Span; ctx: Context };
  llm?: Span;
  /** toolCallId → TOOL span (keyed so concurrent same-name tools never collide). */
  tools: Map<string, Span>;
  /**
   * Whether available tool definitions have been written for this prompt yet.
   * Definitions go on the FIRST llm.call only (they are static per session; one
   * observation per trace suffices to light up Langfuse's Available filters) —
   * see docs/design/2026-07-08-langfuse-tool-instrumentation.md.
   */
  toolsWritten: boolean;
}

const attachments = new Map<string, SessionAttachment>();
const traces = new Map<string, SessionTrace>();
/**
 * Per-prompt root trace id, DECOUPLED from the tracing export switch. Populated
 * unconditionally by startPrompt — the real ROOT span's trace id when tracing is
 * on, a freshly generated 32-hex id when off — so DB-side trace_id stamping works
 * even when spans are not exported. Read via getRootTraceId; cleared in
 * endPrompt/detach.
 */
const promptTraceIds = new Map<string, string>();

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

/**
 * Extract the model's tool-call parts from an assistant message's content array.
 * pi shape: `{ type:"toolCall", id, name, arguments }`. Source for the OpenAI
 * `output.tool_calls` — see the design doc "Instrumentation contract".
 *
 * Only `"toolCall"` is matched: pi's LIVE event stream always tags tool-call
 * parts that way. (message-utils.ts additionally accepts the `toolUse` /
 * `functionCall` aliases because it inspects persisted/other-provider messages;
 * the recorder consumes only the live stream, so the narrower match is correct.)
 */
function extractToolCalls(message: unknown): { id?: string; name: string; args?: unknown }[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const calls: { id?: string; name: string; args?: unknown }[] = [];
  for (const part of message.content) {
    if (isRecord(part) && part.type === "toolCall" && typeof part.name === "string") {
      calls.push({ id: str(part.id), name: part.name, args: part.arguments });
    }
  }
  return calls;
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

/**
 * Read the PII gate from otel-provider module state (set on init/reinit). This
 * is the authoritative source — reading loadConfig() here would cache the
 * on-disk value and never observe a DB-driven hot-reload (reinitTracing).
 */
function sendContentEnabled(): boolean {
  return isSendContentEnabled();
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
      // Available tool definitions → input.value, on the FIRST llm.call of the
      // prompt only (see the toolsWritten field + design doc "Instrumentation
      // contract"). Pulled live via brain.getTools?() — same event-time pull as
      // getModel above; unconditional metadata, NOT gated by sendContent. Latch
      // is set regardless of result so a toolless session doesn't re-poll.
      if (!trace.toolsWritten) {
        trace.toolsWritten = true;
        const inputValue = toolDefinitionsInputValue(attachment?.brain.getTools?.() ?? []);
        if (inputValue) span.setAttributes({ [Attr.inputValue]: inputValue });
      }
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
      // Called tools → output.value in OpenAI shape (tool names unconditional,
      // arguments + free text gated by sendContent). See design doc
      // "Instrumentation contract". A turn that called no tools falls back to the
      // plain-text output.value path (unchanged behavior).
      const toolCallsOut = toolCallsOutputValue(extractToolCalls(message), text, sendContent);
      if (toolCallsOut !== undefined) {
        span.setAttributes({ [Attr.outputValue]: toolCallsOut });
      } else {
        span.setAttributes(contentAttribute(Attr.outputValue, text, "llm_output", sendContent));
      }
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
      // Reuse a span already opened for this callId rather than closing+rebuilding.
      // The existing span is either a genuine duplicate start, or one pre-opened by
      // ensureToolSpan() at sub-agent dispatch so the child ROOT could nest under
      // the real spawn span (see ensureToolSpan). Only create when absent; either
      // ordering (event-channel-first or ensureToolSpan-first) converges here and
      // the args are (re)set below regardless of who opened the span.
      const span = trace.tools.get(callId) ?? tracer.startSpan(
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
      trace.tools.set(callId, span);
      return;
    }
    case "tool_execution_end": {
      // Pair by id when present. Without an id, fall back to the OLDEST still-open
      // tool span (Map preserves insertion order) — best-effort FIFO. This closes
      // exactly that one span with the event's real status, so an id-less end (and
      // critically its ERROR status) is never dropped and then silently closed OK
      // by endPrompt. Exact attribution under id-less CONCURRENCY still requires
      // toolCallId; FIFO is precise only when id-less tools finish in start order.
      const callId = str(event.toolCallId);
      const key = callId ?? (trace.tools.size > 0 ? trace.tools.keys().next().value : undefined);
      const span = key !== undefined ? trace.tools.get(key) : undefined;
      if (!span || key === undefined) return;
      span.setAttributes(contentAttribute(Attr.outputValue, event.result, "tool_result", sendContent));
      const isError = event.isError === true;
      endSpanSafe(span, isError ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.OK });
      trace.tools.delete(key);
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
 * never written as wrong data. Token/cost live ONLY on these per-call spans; the
 * backend (Langfuse/Phoenix) rolls the trace total up from them, so the ROOT span
 * carries no token/cost of its own (writing both double-counts the trace total).
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

/**
 * Parent context for a prompt's ROOT span. Given a valid 32-hex trace id, build a
 * remote SpanContext carrying it so the ROOT span (and, via rootCtx, its children)
 * inherit that trace id. Absent/invalid id → ROOT_CONTEXT (a genuine random root),
 * so the MAIN prompt path is byte-for-byte unchanged.
 *
 * CALLER: runSpawnedSubagent (agentbox/session.ts) — a sub-agent passes its parent
 * prompt's root trace id (mainTraceId) here so the child's span tree lands under the
 * SAME trace T1 (block B, sibling root under T1). This is runtime-internal main→child
 * propagation, NOT the old Plan-A portal downlink (removed in 0d9b374a) — do not wire
 * external/gateway trace ids in. Keep this caller comment so it is not mistaken for
 * dead code and dropped again.
 */
function rootContextForTrace(traceId?: string): Context {
  if (!traceId || !isValidTraceId(traceId)) {
    if (traceId) console.debug(`[tracing] ignoring invalid trace id: ${traceId}`);
    return ROOT_CONTEXT;
  }
  const spanContext: SpanContext = {
    traceId,
    // A remote parent needs a valid (non-zero) 16-hex span id or the SDK discards
    // the context and reverts to a random trace id. It references a caller span with
    // no observation in this process, so the ROOT becomes the trace's top span.
    spanId: randomBytes(8).toString("hex"),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  return otelTrace.setSpanContext(ROOT_CONTEXT, spanContext);
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
      promptTraceIds.delete(sessionId);
    } catch (err) {
      console.warn("[tracing] detach error:", err);
    }
  },

  /**
   * Open the ROOT span for one user prompt and snapshot cumulative stats.
   *
   * Also records a per-prompt root trace id in `promptTraceIds`, decoupled from
   * the tracing export switch: when tracing is on it is the real ROOT span's
   * trace id (so DB-side trace_id matches the exported trace); when off — or when
   * no attachment exists — a freshly generated 32-hex id, so DB trace_id stamping
   * works regardless. Read via getRootTraceId; cleared in endPrompt/detach.
   */
  startPrompt(sessionId: string, promptText?: string, userId?: string, traceId?: string, parentSpanContext?: SpanContext): void {
    if (!isTracingEnabled()) {
      try {
        promptTraceIds.set(sessionId, randomBytes(16).toString("hex"));
      } catch (err) {
        console.warn("[tracing] startPrompt (id-only) error:", err);
      }
      return;
    }
    try {
      const attachment = attachments.get(sessionId);
      if (!attachment) {
        console.debug(`[tracing] startPrompt with no attachment for ${sessionId}; id-only`);
        promptTraceIds.set(sessionId, randomBytes(16).toString("hex"));
        return;
      }
      // A pre-existing trace means a prior endPrompt was missed — abort it cleanly.
      const stale = traces.get(sessionId);
      if (stale) {
        traces.delete(sessionId);
        abortTrace(stale);
      }
      const model = attachment.brain.getModel?.();
      // ROOT parent selection:
      //   • parentSpanContext present (sub-agent, = parent's spawn_subagent tool
      //     span, captured via ensureToolSpan at dispatch) → the ROOT nests UNDER
      //     that real span: parentSpanId = the spawn span's spanId, trace id
      //     inherited from it. This is the nested layout (spawn_subagent → child).
      //   • else traceId present (sub-agent fallback: spawn span could not be
      //     captured, e.g. its parent trace already ended) → rootContextForTrace
      //     inherits the trace id only, landing the child as a sibling top-level
      //     tree under T1.
      //   • else (main prompt) → rootContextForTrace returns ROOT_CONTEXT, a
      //     genuine root whose SDK-assigned trace id is read back.
      const rootParent = parentSpanContext
        ? otelTrace.setSpanContext(ROOT_CONTEXT, parentSpanContext)
        : rootContextForTrace(traceId);
      const root = getTracer().startSpan(
        ROOT_SPAN_NAME,
        {
          attributes: flatAttrs({
            [Attr.spanKind]: SpanKind.AGENT,
            [Attr.sessionId]: sessionId,
            // Per-request userId (from the prompt body) wins; fall back to the
            // session's attach-time identity (process-level USER_ID, set only in
            // a K8s per-user pod). The per-request source keeps user.id correct
            // in modes where no per-process identity exists (in-process spawner,
            // shared multi-user runtime). `||` (not `??`) so an empty-string
            // userId — e.g. a cron task with no owner — falls back too rather
            // than emitting a blank user.id (flatAttrs only drops null/undefined).
            [Attr.userId]: userId || attachment.ctx.userId,
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
        rootParent,
      );
      promptTraceIds.set(sessionId, root.spanContext().traceId);
      traces.set(sessionId, {
        root,
        rootCtx: otelTrace.setSpan(ROOT_CONTEXT, root),
        tools: new Map(),
        toolsWritten: false,
      });
    } catch (err) {
      console.warn("[tracing] startPrompt error:", err);
    }
  },

  /**
   * Synchronously build-or-get the tool span for `callId` and return its
   * SpanContext. Purpose: a sub-agent dispatched from INSIDE a tool's execute()
   * (spawn_subagent) can capture its parent tool span's SpanContext at dispatch
   * time and pass it to the child's startPrompt (parentSpanContext) so the child
   * ROOT nests under the real span — WITHOUT racing the async event channel that
   * would otherwise be the only thing to open it. The later tool_execution_start
   * for the same callId reuses this span (does not rebuild). Attributes mirror
   * tool_execution_start's (SpanKind.TOOL + toolName); args are added later when
   * tool_execution_start fires. Returns undefined when tracing is off or no prompt
   * is in flight for sessionId (caller then falls back to sibling/id-only).
   */
  ensureToolSpan(sessionId: string, callId: string, toolName: string): SpanContext | undefined {
    if (!isTracingEnabled()) return undefined;
    try {
      const trace = traces.get(sessionId);
      if (!trace) return undefined;
      const existing = trace.tools.get(callId);
      if (existing) return existing.spanContext();
      const span = getTracer().startSpan(
        toolName,
        { attributes: flatAttrs({ [Attr.spanKind]: SpanKind.TOOL, [Attr.toolName]: toolName }) },
        parentContext(trace),
      );
      trace.tools.set(callId, span);
      return span.spanContext();
    } catch (err) {
      console.warn("[tracing] ensureToolSpan error:", err);
      return undefined;
    }
  },

  /**
   * The per-prompt root trace id for a session, or undefined if no prompt is in
   * flight. Independent of the tracing export switch (see promptTraceIds) so
   * callers can stamp chat_messages.trace_id whether or not spans are exported.
   */
  getRootTraceId(sessionId: string): string | undefined {
    try {
      return promptTraceIds.get(sessionId);
    } catch (err) {
      console.warn("[tracing] getRootTraceId error:", err);
      return undefined;
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
    // Clear the decoupled trace id unconditionally — startPrompt sets it even when
    // tracing is off, so it must be cleared even when off or it would leak.
    promptTraceIds.delete(sessionId);
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

      // No token/cost on the ROOT: the per-call llm spans carry it and the backend
      // aggregates the trace total from them. Writing it here too would double the
      // trace-level total (and a post−pre session delta would also fold in failed
      // model-route candidates, over-attributing to the delivered answer).
      endSpanSafe(trace.root, outcome === "error"
        ? { code: SpanStatusCode.ERROR }
        : { code: SpanStatusCode.OK });
    } catch (err) {
      console.warn("[tracing] endPrompt error:", err);
    }
  },

  /**
   * Close every in-flight trace before a provider swap. A tracing hot-reload
   * (POST /api/reload-tracing, fired by any exporter CRUD) tears down the live
   * provider via reinitTracing; the recorder's open spans live in this module and
   * would otherwise reference the now-dead provider, orphaning the trace and
   * splitting later events onto a dead ROOT. The reload orchestrator MUST call
   * this BEFORE reinitTracing so the spans end on the CURRENT provider (reinit's
   * forceFlush then exports them). Each cut trace gets a `tracing_reloaded` event
   * and closes with no error status (interrupted by config change, not failed);
   * state is cleared so the next prompt opens a fresh trace.
   */
  abortAll(): void {
    for (const trace of traces.values()) {
      try {
        trace.root.addEvent("tracing_reloaded");
        for (const toolSpan of trace.tools.values()) endSpanSafe(toolSpan);
        if (trace.llm) endSpanSafe(trace.llm);
        if (trace.turn) endSpanSafe(trace.turn.span);
        endSpanSafe(trace.root);
      } catch (err) {
        console.warn("[tracing] abortAll error:", err);
      }
    }
    traces.clear();
    promptTraceIds.clear();
  },
};

/** Test-only: clear module state between cases. NOT used in production. */
export function __resetRecorderForTest(): void {
  attachments.clear();
  traces.clear();
  promptTraceIds.clear();
}
