/**
 * Shared failure normalization for capability runs.
 *
 * Checkpoint, auto-resume detail, and Runtime logs all cross a trust boundary.
 * Only machine tokens + producer-provided safe short reasons may appear here —
 * never owner-facing `error` text, source paths, or provider payloads.
 */

import type { CapabilityRunFailure } from "./contract.js";

/** Safe short-reason cap persisted in the opaque checkpoint / logs. */
export const FAILURE_MESSAGE_MAX = 256;

/** Machine token: ≤64 chars, [a-zA-Z0-9_.-] only. */
export function asFailureToken(field: unknown): string | undefined {
  if (typeof field !== "string") return undefined;
  const normalized = field.trim();
  return normalized && normalized.length <= 64 && /^[a-zA-Z0-9_.-]+$/.test(normalized)
    ? normalized
    : undefined;
}

/** Safe short reason: strip controls, collapse whitespace, hard-cap length. */
export function asSafeFailureMessage(field: unknown, max = FAILURE_MESSAGE_MAX): string | undefined {
  if (typeof field !== "string") return undefined;
  const cleaned = field
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return undefined;
  const codePoints = Array.from(cleaned);
  return codePoints.length > max ? codePoints.slice(0, max).join("") : cleaned;
}

/**
 * Normalize an arbitrary failure object into a checkpoint-safe record.
 * Invalid/missing code → `runtime_failure` (callers that mean "box" must pass
 * an explicit box_* / batch_* code; structuredBoxFailure does that).
 */
export function normalizeFailure(value: unknown): CapabilityRunFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const recognized = [
    "code", "stage", "attempts", "idle_s", "bound_s", "tool_pending",
    "last_sdk_message", "exception_class", "message",
  ];
  if (!recognized.some((field) => Object.prototype.hasOwnProperty.call(raw, field))) {
    return undefined;
  }
  const code = asFailureToken(raw.code) ?? "runtime_failure";
  const stage = asFailureToken(raw.stage) ?? "unknown";
  const finiteNonNegative = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
  const attempts = finiteNonNegative(raw.attempts);
  const idle = finiteNonNegative(raw.idle_s);
  const bound = finiteNonNegative(raw.bound_s);
  const lastMessage = asFailureToken(raw.last_sdk_message);
  const exceptionClass = asFailureToken(raw.exception_class);
  // Only the producer `message` field — never raw.error (owner-facing / unsafe).
  const message =
    asSafeFailureMessage(raw.message) ?? (exceptionClass ? `${code}:${exceptionClass}` : code);
  return {
    code,
    stage,
    ...(attempts !== undefined ? { attempts: Math.floor(attempts) } : {}),
    ...(idle !== undefined ? { idle_s: idle } : {}),
    ...(bound !== undefined ? { bound_s: bound } : {}),
    ...(typeof raw.tool_pending === "boolean" ? { tool_pending: raw.tool_pending } : {}),
    ...(lastMessage ? { last_sdk_message: lastMessage } : {}),
    ...(exceptionClass ? { exception_class: exceptionClass } : {}),
    message,
  };
}

export interface BoxErrorLike {
  error?: string;
  code?: string;
  stage?: string;
  attempts?: number;
  idle_s?: number;
  bound_s?: number;
  tool_pending?: boolean;
  last_sdk_message?: string;
  message?: string;
  exception_class?: string;
  reason?: string;
}

/**
 * Project a box error event into a checkpoint-safe failure.
 *
 * Tokens are normalized HERE so Runtime logs and checkpoint share one
 * sanitized view (forged newlines / spaces in code never reach the log line).
 * `error` is owner-facing and is never copied into `message` or logs.
 * Bare box frames default to box_error/unknown.
 */
export function structuredBoxFailure(evt: BoxErrorLike): CapabilityRunFailure {
  const code = asFailureToken(evt.code) ?? "box_error";
  const stage = asFailureToken(evt.stage) ?? "unknown";
  const exceptionClass = asFailureToken(evt.exception_class);
  const lastSdk = asFailureToken(evt.last_sdk_message);
  // Producer safe short reason only — never evt.error / evt.reason.
  let message = asSafeFailureMessage(evt.message);
  if (!message && exceptionClass) {
    message = `${code}:${exceptionClass}`;
  } else if (!message) {
    message = code;
  }
  return normalizeFailure({
    code,
    stage,
    attempts: evt.attempts,
    idle_s: evt.idle_s,
    bound_s: evt.bound_s,
    tool_pending: evt.tool_pending,
    last_sdk_message: lastSdk,
    exception_class: exceptionClass,
    message,
  })!;
}
