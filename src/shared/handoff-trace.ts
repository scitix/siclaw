import type { SpanContext } from "@opentelemetry/api";

/** Trusted execution context carried on control events, never model arguments. */
export interface HandoffTraceContext {
  traceId: string;
  parentSpanId?: string;
  traceFlags?: number;
}

export function normalizeHandoffTrace(value: unknown): HandoffTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.traceId !== "string" || !/^[0-9a-f]{32}$/.test(v.traceId) || /^0+$/.test(v.traceId)) return undefined;
  const parentSpanId = typeof v.parentSpanId === "string" && /^[0-9a-f]{16}$/.test(v.parentSpanId) && !/^0+$/.test(v.parentSpanId)
    ? v.parentSpanId : undefined;
  return {
    traceId: v.traceId,
    ...(parentSpanId ? { parentSpanId, traceFlags: v.traceFlags === 0 ? 0 : 1 } : {}),
  };
}

export function handoffParentSpan(value: HandoffTraceContext | undefined): SpanContext | undefined {
  return value?.parentSpanId ? { traceId: value.traceId, spanId: value.parentSpanId, traceFlags: value.traceFlags ?? 1, isRemote: true } : undefined;
}
