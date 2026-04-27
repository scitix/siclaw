// Error envelope — see docs/design/error-envelope.md.
// Wire-compatible with sicore's pkg/model/response.go ErrorDetail.

export type ErrorDetail = {
  code: string;
  message: string;
  retriable: boolean;
  retryAfterMs?: number;
  requestId?: string;
  details?: unknown;
};

// REST body wrapper. SSE error frames carry ErrorDetail directly (event name discriminates).
export type ErrorEnvelope = { error: ErrorDetail };

// Codes mirror sicore ErrCode* where applicable, plus a few siclaw-specific ones.
// Add new codes here only when actually emitted from code; see design doc §2.
export const ErrorCodes = {
  INTERNAL: "INTERNAL_ERROR",
  BAD_REQUEST: "BAD_REQUEST",

  CONNECTION_FAILED: "CONNECTION_FAILED",
  CONNECTION_TIMEOUT: "CONNECTION_TIMEOUT",
  STREAM_INTERRUPTED: "STREAM_INTERRUPTED",

  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  AGENTBOX_FAILED: "AGENTBOX_FAILED",

  MODEL_RATE_LIMIT: "MODEL_RATE_LIMIT",
  MODEL_OVERLOADED: "MODEL_OVERLOADED",
  MODEL_ERROR: "MODEL_ERROR",
  TOOL_ERROR: "TOOL_ERROR",
} as const;

export function isErrorDetail(value: unknown): value is ErrorDetail {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    typeof v.retriable === "boolean"
  );
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isErrorDetail(v.error);
}

// wrapError — passthrough rule R1 for already-wrapped objects, wrap rule R2 for raw errors.
// Defaults: retriable=true (optimistic), code=INTERNAL_ERROR.
export function wrapError(
  err: unknown,
  defaults: Partial<ErrorDetail> = {},
): ErrorDetail {
  if (isErrorDetail(err)) return err;
  if (isErrorEnvelope(err)) return err.error;

  const message =
    defaults.message ??
    (err instanceof Error ? err.message : err == null ? "Unknown error" : String(err));

  const detail: ErrorDetail = {
    code: defaults.code ?? ErrorCodes.INTERNAL,
    message,
    retriable: defaults.retriable ?? true,
  };
  if (defaults.retryAfterMs != null) detail.retryAfterMs = defaults.retryAfterMs;
  if (defaults.requestId) detail.requestId = defaults.requestId;
  if (defaults.details !== undefined) detail.details = defaults.details;
  return detail;
}

// Encode ErrorDetail as an SSE `event: error` frame. Caller writes returned string to the response.
export function sseErrorFrame(detail: ErrorDetail): string {
  return `event: error\ndata: ${JSON.stringify(detail)}\n\n`;
}

// Convenience for REST handlers that need the {error: ...} body shape.
export function errorBody(detail: ErrorDetail): ErrorEnvelope {
  return { error: detail };
}
