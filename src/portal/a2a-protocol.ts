/**
 * A2A Protocol — shared wire types & constants.
 *
 * The A2A boundary has two sides in Siclaw:
 *   - server (a2a-gateway.ts): exposes a Siclaw agent as an A2A server.
 *   - client (Phase 2): calls an EXTERNAL A2A agent as a tool.
 *
 * Both sides speak the same A2A v1.0 HTTP+JSON wire format, so the protocol
 * vocabulary (task states, message/stream shapes, content-type, terminal-state
 * predicate) lives here, decoupled from any node:http / DB dependency. Keep this
 * module transport-free so the client side can import it without dragging in
 * server-only machinery.
 */

export const A2A_VERSION = "1.0";
export const A2A_JSON = "application/a2a+json; charset=utf-8";
export const ASSISTANT_ARTIFACT_ID = "assistant-text";

export type A2aTaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

export const A2A_TASK_STATES = new Set<A2aTaskState>([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export interface A2aMessage {
  messageId?: string;
  contextId?: string;
  taskId?: string;
  role?: string;
  parts?: Array<{ text?: string; raw?: string; url?: string; data?: unknown; mediaType?: string }>;
  metadata?: Record<string, unknown>;
}

export interface NormalizedA2aMessage extends A2aMessage {
  messageId: string;
  contextId?: string;
}

export interface SendMessageRequest {
  message?: A2aMessage;
  configuration?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type A2aStreamResponse =
  | { task: Record<string, unknown> }
  | { message: Record<string, unknown> }
  | { statusUpdate: Record<string, unknown> }
  | { artifactUpdate: Record<string, unknown> };

export function isTerminalState(state: A2aTaskState): boolean {
  return state === "TASK_STATE_COMPLETED"
    || state === "TASK_STATE_FAILED"
    || state === "TASK_STATE_CANCELED"
    || state === "TASK_STATE_REJECTED";
}
