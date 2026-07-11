// Error envelope — see docs/design/error-envelope.md.
// Wire-compatible with the management server's ErrorDetail (pkg/model/response.go).

export type ErrorDetail = {
  code: string;
  message: string;
  retriable: boolean;
  /** Original HTTP status when the failure crossed an HTTP hop (e.g. AgentBox). */
  status?: number;
  retryAfterMs?: number;
  requestId?: string;
  details?: unknown;
};

// REST body wrapper. SSE error frames carry ErrorDetail directly (event name discriminates).
export type ErrorEnvelope = { error: ErrorDetail };

// Codes mirror the management server's ErrCode* where applicable, plus a few siclaw-specific ones.
// Add new codes here only when actually emitted from code; see design doc §2.
export const ErrorCodes = {
  INTERNAL: "INTERNAL_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",

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

/**
 * Error subclass for code paths that know the wire classification at the
 * throw-site. `wrapRpcError` converts it back to a plain serializable object;
 * callers never rely on Error's non-enumerable `message` property crossing WS.
 */
export class RpcResponseError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(detail: ErrorDetail) {
    super(detail.message);
    this.name = "RpcResponseError";
    this.code = detail.code;
    this.retriable = detail.retriable;
    this.status = detail.status;
    this.retryAfterMs = detail.retryAfterMs;
    this.requestId = detail.requestId;
    this.details = detail.details;
  }
}

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
  if (defaults.status != null) detail.status = defaults.status;
  if (defaults.retryAfterMs != null) detail.retryAfterMs = defaults.retryAfterMs;
  if (defaults.requestId) detail.requestId = defaults.requestId;
  if (defaults.details !== undefined) detail.details = defaults.details;
  return detail;
}

function httpErrorCode(status: number | undefined): string {
  switch (status) {
    case 400:
    case 422:
      return ErrorCodes.BAD_REQUEST;
    case 401:
      return ErrorCodes.UNAUTHORIZED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return ErrorCodes.CONFLICT;
    case 429:
      return ErrorCodes.TOO_MANY_REQUESTS;
    case 502:
    case 503:
    case 504:
      return ErrorCodes.SERVICE_UNAVAILABLE;
    default:
      return status == null ? ErrorCodes.INTERNAL : ErrorCodes.AGENTBOX_FAILED;
  }
}

function httpErrorRetriable(status: number | undefined): boolean | undefined {
  if (status == null) return undefined;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Convert an Error (including AgentBox HTTP errors) to the canonical WS error
 * object. Structural fields are intentionally accepted so rolling-upgrade
 * callers that still throw `Object.assign(new Error(), { status, ... })` retain
 * their metadata. `retryable` is accepted as a legacy alias but the wire always
 * emits the canonical `retriable` spelling.
 */
export function wrapRpcError(err: unknown): ErrorDetail {
  const source = isErrorEnvelope(err) ? err.error : err;
  const value = source && typeof source === "object" ? source as Record<string, unknown> : {};
  const status = typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
    ? value.status
    : undefined;
  const code = typeof value.code === "string" && value.code.trim() ? value.code : httpErrorCode(status);
  const explicitRetriable = typeof value.retriable === "boolean"
    ? value.retriable
    : typeof value.retryable === "boolean"
      ? value.retryable
      : undefined;
  const retryAfterMs = typeof value.retryAfterMs === "number" ? value.retryAfterMs : undefined;
  const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
  const detail = wrapError(source, {
    code,
    retriable: explicitRetriable ?? httpErrorRetriable(status) ?? true,
    ...(status != null ? { status } : {}),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
    ...(requestId ? { requestId } : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
  });

  // Always return a plain object: Error.message is non-enumerable, so sending an
  // Error subclass directly through JSON.stringify would silently drop it.
  return {
    code: detail.code,
    message: detail.message,
    retriable: detail.retriable,
    ...(status != null ? { status } : {}),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
    ...(requestId ? { requestId } : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
  };
}

// Encode ErrorDetail as an SSE `event: error` frame. Caller writes returned string to the response.
export function sseErrorFrame(detail: ErrorDetail): string {
  return `event: error\ndata: ${JSON.stringify(detail)}\n\n`;
}

// Convenience for REST handlers that need the {error: ...} body shape.
export function errorBody(detail: ErrorDetail): ErrorEnvelope {
  return { error: detail };
}
