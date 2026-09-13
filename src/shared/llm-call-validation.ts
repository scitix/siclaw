/**
 * Wire contract for the metering endpoint, shared by sender and receiver.
 *
 * The receiver cannot trust the shape it is handed — a box runs a different
 * image version than the Runtime for the whole duration of a rollout — so every
 * field is checked here rather than cast.
 *
 * The validation rule that matters: a token field is accepted ONLY as a finite
 * non-negative number or `null`. Anything else (a string, NaN, undefined) is
 * rejected rather than coerced, because coercion is how an unknown quietly
 * becomes a zero — the exact confusion the whole record type exists to prevent.
 */

import { LLM_WORKLOADS, MAX_CORRELATION_ID_LENGTH, isLlmWorkload, resolveUsageStatus } from "./llm-call-record.js";
import type { LlmCallMeasurement, UsageField, UsageSource, UsageStatus } from "./llm-call-record.js";

export const LLM_CALL_MEASUREMENTS_PATH = "/api/internal/llm-call-measurements";

/** Cap per delivery; a larger batch is rejected rather than silently truncated. */
export const MAX_MEASUREMENTS_PER_BATCH = 64;

const USAGE_STATUSES: readonly UsageStatus[] = ["reported", "partial", "missing", "unknown"];
const USAGE_SOURCES: readonly UsageSource[] = ["provider", "sdk_default", "rehydrated", "unknown"];
const USAGE_FIELDS: readonly UsageField[] = ["input", "output", "reasoning", "cache_read", "cache_write"];

export interface ValidationResult {
  ok: boolean;
  error?: string;
  batch?: { session_id: string; measurements: LlmCallMeasurement[] };
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A token count: finite, non-negative, or explicitly unknown. Never coerced. */
function isTokenValue(v: unknown): v is number | null {
  if (v === null) return true;
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Validate one delivery. Returns the typed batch, or the first reason it was refused. */
export function validateMeasurementBatch(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (!isNonEmptyString(b.session_id)) return { ok: false, error: "session_id is required" };
  if (!Array.isArray(b.measurements)) return { ok: false, error: "measurements must be an array" };
  if (b.measurements.length === 0) return { ok: false, error: "measurements must not be empty" };
  if (b.measurements.length > MAX_MEASUREMENTS_PER_BATCH) {
    return { ok: false, error: `at most ${MAX_MEASUREMENTS_PER_BATCH} measurements per batch` };
  }

  for (const [index, raw] of b.measurements.entries()) {
    const error = validateMeasurement(raw);
    if (error) return { ok: false, error: `measurements[${index}]: ${error}` };
  }
  return { ok: true, batch: b as unknown as { session_id: string; measurements: LlmCallMeasurement[] } };
}

/** Returns a reason string when invalid, or null when acceptable. */
export function validateMeasurement(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "must be an object";
  const m = raw as Record<string, unknown>;

  if (!isNonEmptyString(m.call_id)) return "call_id is required";
  if (!isNonEmptyString(m.prompt_id)) return "prompt_id is required";
  // Optional: an older box sends nothing, and that must keep working. Present it
  // must be a string that FITS the column (VARCHAR(64)) — a longer value would be
  // silently truncated by MySQL and quietly correlate to the wrong request, or in
  // strict mode reject the row. `null` is the explicit "no request", and is
  // accepted; an empty string is not, since it is neither an id nor an absence.
  for (const field of ["root_request_id", "parent_call_id"] as const) {
    const value = m[field];
    if (value === undefined || value === null) continue;
    if (!isNonEmptyString(value)) return `${field} must be a non-empty string or null`;
    if (value.length > MAX_CORRELATION_ID_LENGTH) {
      return `${field} exceeds ${MAX_CORRELATION_ID_LENGTH} characters`;
    }
  }
  if (m.kind !== "agent" && m.kind !== "aux") return "kind must be agent or aux";
  // Absent is tolerated for an older box and becomes `unattributed` at the
  // write, which is visible. A PRESENT but unknown value is refused rather
  // than stored: an unrecognised spelling would sit in the table splitting the
  // aggregate it belongs to, and nothing downstream would report it.
  if (m.workload !== undefined && !isLlmWorkload(m.workload)) {
    return `workload is not a known value (expected one of: ${LLM_WORKLOADS.join(", ")})`;
  }
  if (!isCount(m.round)) return "round must be a non-negative integer";
  if (!isCount(m.attempt)) return "attempt must be a non-negative integer";
  if (!isCount(m.network_attempts)) return "network_attempts must be a non-negative integer";
  if (typeof m.provider !== "string") return "provider must be a string";
  if (typeof m.model_id !== "string") return "model_id must be a string";
  if (typeof m.api_type !== "string") return "api_type must be a string";

  if (!USAGE_STATUSES.includes(m.usage_status as UsageStatus)) return "usage_status is not a known value";
  if (!USAGE_SOURCES.includes(m.usage_source as UsageSource)) return "usage_source is not a known value";
  if (!Array.isArray(m.reported_fields) || m.reported_fields.some((f) => !USAGE_FIELDS.includes(f as UsageField))) {
    return "reported_fields contains an unknown field";
  }

  for (const field of [
    "input_tokens_total", "output_tokens_total", "reasoning_tokens",
    "cache_read_tokens", "cache_write_tokens", "payload_bytes", "payload_tokens_estimated",
  ]) {
    if (!isTokenValue(m[field])) return `${field} must be a non-negative number or null`;
  }

  if (!isNonEmptyString(m.request_at)) return "request_at is required";
  if (!isNonEmptyString(m.response_end_at)) return "response_end_at is required";
  if (m.since_prev_ms !== null && !isTokenValue(m.since_prev_ms)) return "since_prev_ms must be a number or null";
  if (m.cost_micros !== null && m.cost_micros !== undefined) return "cost_micros must be null (unpriced)";
  if (!m.request_snapshot || typeof m.request_snapshot !== "object") return "request_snapshot is required";
  return validateUsageCoherence(m);
}

/**
 * Reject combinations that are individually well-typed but cannot all be true.
 *
 * Type checks alone let a skewed sender file the one record this design exists
 * to prevent: `source: provider` + `status: reported` + no reported fields + all
 * zeros. `hasTrustworthyUsage` would accept it, and a dashboard would show a
 * free call. Version skew during a rollout is exactly when that gets written, so
 * the receiver has to refuse it rather than trust the producer's discipline.
 */
function validateUsageCoherence(m: Record<string, unknown>): string | null {
  const fields = m.reported_fields as UsageField[];
  const source = m.usage_source as UsageSource;
  const status = m.usage_status as UsageStatus;

  // Claiming the provider reported, while naming nothing it reported.
  if (source === "provider" && fields.length === 0) {
    return "usage_source=provider requires at least one reported field";
  }
  // `reported`/`partial` assert a provider answer; the other sources are by
  // definition the absence of one.
  if ((status === "reported" || status === "partial") && source !== "provider") {
    return `usage_status=${status} requires usage_source=provider`;
  }
  // NOTE: values WITHOUT reported_fields are legitimate and must be accepted.
  // That is exactly what the observer produces when a stream broke part-way: it
  // keeps the figures it managed to read as EVIDENCE while marking the read
  // untrustworthy (`unknown`). Rejecting it made the receiver refuse the whole
  // batch — taking the healthy records alongside it — over a row the producer
  // was right to send. Only `provider` may not name nothing (checked above).
  //
  // A field named as reported must still carry a value: there the claim and the
  // data contradict each other outright.
  for (const [field, column] of FIELD_COLUMNS) {
    if (fields.includes(field) && (m[column] === null || m[column] === undefined)) {
      return `${field} is in reported_fields but ${column} is null`;
    }
  }
  // The evidence exception is for UNTRUSTWORTHY reads only. On a record that
  // aggregation will bank (`provider`), or one asserting the provider stayed
  // silent (`sdk_default`), every value must be one the provider actually named
  // — otherwise `partial` + `reported_fields: [input]` could smuggle in a
  // `cache_read: 0` nobody reported, and `hasTrustworthyUsage` would accept it.
  if (source === "provider" || source === "sdk_default") {
    for (const [field, column] of FIELD_COLUMNS) {
      if (!fields.includes(field) && m[column] !== null && m[column] !== undefined) {
        return `${column} is present but ${field} is not in reported_fields`;
      }
    }
  }
  // Validate the status against the SAME derivation the producer used, for all
  // four values rather than just `reported`. Checking only the complete case
  // still let `provider + [input]` be filed as `missing`, and an unknown-source
  // evidence row be filed as `missing` — both of which assert "the provider
  // reported nothing" about a call where it demonstrably did.
  //
  // The one exception is the evidence row itself: an unreadable stream is
  // `unknown` by construction, and the derivation agrees, so it needs no
  // special case — but a row claiming `unknown` while naming fields from a
  // provider read would be caught here.
  const derived = resolveUsageStatus(m.api_type as string, fields, source);
  if (derived !== status) {
    return `usage_status=${status} contradicts the ${String(m.api_type)} contract for source=${source} ` +
      `and fields=[${fields.join(",")}] (expected ${derived})`;
  }
  return null;
}

/** Reported-field name → the column carrying its value. */
const FIELD_COLUMNS: ReadonlyArray<readonly [UsageField, string]> = [
  ["input", "input_tokens_total"],
  ["output", "output_tokens_total"],
  ["reasoning", "reasoning_tokens"],
  ["cache_read", "cache_read_tokens"],
  ["cache_write", "cache_write_tokens"],
];
