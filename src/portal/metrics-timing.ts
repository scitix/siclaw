/**
 * Latency summarisation for the metrics Timing endpoint.
 *
 * siclaw persists one row per model call in `chat_messages` with the timing
 * envelope at `metadata.llm_call` (written by src/gateway/sse-consumer.ts from
 * the recorder in src/core/llm-call-recorder.ts):
 *   - `metadata.llm_call.ms.{net_ttft, thinking, output, total}` — non-overlapping
 *     partition of one provider request
 *   - tool rows: `duration_ms` column
 * This module turns a collected list of millisecond values into the
 * `{count, avg, min, max, p90}` shape the audit UI renders.
 */

export interface LatencyStats {
  count: number;
  avg: number;
  min: number;
  max: number;
  p90: number;
}

const EMPTY: LatencyStats = { count: 0, avg: 0, min: 0, max: 0, p90: 0 };

/** Summarise a list of latency samples (ms). Empty → all zeros. */
export function summariseLatency(values: number[]): LatencyStats {
  if (values.length === 0) return { ...EMPTY };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  // Nearest-rank p90: index ceil(0.9*n)-1, clamped.
  const p90Idx = Math.min(n - 1, Math.max(0, Math.ceil(0.9 * n) - 1));
  return {
    count: n,
    avg: Math.round(sum / n),
    min: sorted[0],
    max: sorted[n - 1],
    p90: sorted[p90Idx],
  };
}

export type LlmCallMsKey = "net_ttft" | "thinking" | "output" | "total";

/**
 * Extract a finite, non-negative integer ms value from
 * `metadata.llm_call.ms[key]` of a stored chat_messages.metadata string.
 * Returns undefined when absent / unparseable / negative (absence =
 * "unmeasured", the correct downstream semantics). `metadata` may be a
 * pre-decoded object too (defensive).
 */
export function extractLlmCallMs(metadata: unknown, key: LlmCallMsKey): number | undefined {
  let obj: unknown = metadata;
  if (typeof metadata === "string") {
    try { obj = JSON.parse(metadata); } catch { return undefined; }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const call = (obj as Record<string, unknown>).llm_call;
  if (!call || typeof call !== "object") return undefined;
  const ms = (call as Record<string, unknown>).ms;
  if (!ms || typeof ms !== "object") return undefined;
  const v = (ms as Record<string, unknown>)[key];
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}
