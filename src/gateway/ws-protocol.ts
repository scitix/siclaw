// --- Error types ---

export const ErrorCode = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAVAILABLE: "UNAVAILABLE",
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorShape {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

export function errorShape(
  code: string, message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return { code, message, ...opts };
}

export class RpcError extends Error {
  constructor(
    public readonly code: string, message: string,
    public readonly retryable?: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

// --- RPC handler signature ---

export type SendEventFn = (event: string, payload: Record<string, unknown>) => void;

export interface RpcContext {
  /** Send an event back to Portal (over the phone-home WS) for streaming RPCs. */
  sendEvent: SendEventFn;
}

export type RpcHandler = (
  params: Record<string, unknown>,
  context: RpcContext,
) => Promise<unknown>;
