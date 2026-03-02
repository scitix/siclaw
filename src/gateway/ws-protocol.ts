import type { WebSocket } from "ws";

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

// --- Wire types ---

export interface WsRequest {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface WsResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
}

export interface WsEvent {
  type: "event";
  event: string;
  seq: number;
  payload: Record<string, unknown>;
}

// --- RPC handler signature ---

export type SendEventFn = (event: string, payload: Record<string, unknown>) => void;

export interface RpcContext {
  auth?: { userId: string; username: string };
  /** Send an event to the requesting WebSocket client only */
  sendEvent: SendEventFn;
}

export type RpcHandler = (
  params: Record<string, unknown>,
  context: RpcContext,
) => Promise<unknown>;

// --- Dispatch ---

let eventSeq = 0;

export function resetSeq(): void {
  eventSeq = 0;
}

export function parseFrame(data: string): WsRequest | null {
  try {
    const obj = JSON.parse(data);
    if (obj && obj.type === "req" && typeof obj.id === "string" && typeof obj.method === "string") {
      return obj as WsRequest;
    }
  } catch {
    // ignore malformed frames
  }
  return null;
}

export function sendResponse(ws: WebSocket, id: string, ok: boolean, payload?: unknown, error?: ErrorShape): void {
  const msg: WsResponse = { type: "res", id, ok };
  if (payload !== undefined) msg.payload = payload;
  if (error !== undefined) msg.error = error;
  ws.send(JSON.stringify(msg));
}

export function buildEvent(event: string, payload: Record<string, unknown>): string {
  const msg: WsEvent = { type: "event", event, seq: ++eventSeq, payload };
  return JSON.stringify(msg);
}

export type BroadcastFn = (event: string, payload: Record<string, unknown>) => void;

export const MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MiB

export function createBroadcaster(clients: Set<WebSocket>): BroadcastFn {
  return (event: string, payload: Record<string, unknown>) => {
    const frame = buildEvent(event, payload);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          console.warn(`[ws] Backpressure: skipping broadcast to client (buffered=${ws.bufferedAmount})`);
          continue;
        }
        ws.send(frame);
      }
    }
  };
}

function classifyErrorCode(message: string): string {
  if (/Unauthorized|login required/i.test(message)) return ErrorCode.UNAUTHORIZED;
  if (/Forbidden|admin access/i.test(message)) return ErrorCode.FORBIDDEN;
  if (/not found/i.test(message)) return ErrorCode.NOT_FOUND;
  if (/Unknown method/i.test(message)) return ErrorCode.INVALID_REQUEST;
  if (/timed? ?out/i.test(message)) return ErrorCode.AGENT_TIMEOUT;
  return ErrorCode.INTERNAL;
}

export async function dispatchRpc(
  methods: Map<string, RpcHandler>,
  request: WsRequest,
  ws: WebSocket,
  context: RpcContext,
): Promise<void> {
  const handler = methods.get(request.method);
  if (!handler) {
    sendResponse(ws, request.id, false, undefined, errorShape(ErrorCode.INVALID_REQUEST, `Unknown method: ${request.method}`));
    return;
  }
  const startTime = Date.now();
  try {
    const result = await handler(request.params ?? {}, context);
    console.log(`[rpc] ${request.method} completed in ${Date.now() - startTime}ms`);
    sendResponse(ws, request.id, true, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rpc] ${request.method} error (${Date.now() - startTime}ms):`, message);
    if (err instanceof RpcError) {
      sendResponse(ws, request.id, false, undefined, errorShape(err.code, message, { retryable: err.retryable, retryAfterMs: err.retryAfterMs }));
    } else {
      sendResponse(ws, request.id, false, undefined, errorShape(classifyErrorCode(message), message));
    }
  }
}
