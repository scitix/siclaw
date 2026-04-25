export interface DelegationLineagePayload {
  parentSessionId?: string | null;
  parentAgentId?: string | null;
  delegationId?: string | null;
  targetAgentId?: string | null;
}

export interface DelegationAppendMessagePayload {
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
  toolInput?: string | null;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
  fromAgentId?: string | null;
  parentSessionId?: string | null;
  delegationId?: string | null;
  targetAgentId?: string | null;
}

export interface DelegationUpdateMessagePayload {
  messageId: string;
  sessionId: string;
  content: string;
  toolName?: string | null;
  toolInput?: string | null;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
  delegationId?: string | null;
}

export interface DelegationToolUpdatePayload {
  sessionId: string;
  toolName: string;
  delegationId: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
}

export interface DelegationEventPayload {
  parentSessionId: string;
  parentAgentId: string | null;
  userId: string;
  delegationId: string;
  childSessionId: string;
  targetAgentId: string | null;
  status: "done" | "partial" | "failed" | "timed_out" | "cancelled";
  capsule: string;
  fullSummary?: string;
  summaryTruncated?: boolean;
  scope?: string;
  taskIndex?: number;
  totalTasks?: number;
  toolCalls?: number;
  durationMs?: number;
  partialSource?: "steered" | "runtime_fallback";
  interruptedTool?: string;
}

export type DelegationPersistenceEvent =
  | {
      type: "delegation.ensure_session";
      sessionId: string;
      agentId: string;
      userId: string;
      title?: string;
      preview?: string;
      origin?: string;
      lineage?: DelegationLineagePayload;
    }
  | { type: "delegation.append_message"; message: DelegationAppendMessagePayload }
  | { type: "delegation.update_message"; message: DelegationUpdateMessagePayload }
  | { type: "delegation.update_tool_message"; message: DelegationToolUpdatePayload }
  | { type: "delegation.append_event"; event: DelegationEventPayload }
  | { type: "delegation.emit_chat_event"; sessionId: string; event: Record<string, unknown> };

export interface DelegationPersistenceResponse {
  ok: boolean;
  id?: string;
}
