/**
 * Chat repository — FrontendWsClient RPC client for chat persistence.
 *
 * Runtime no longer accesses the database directly. All chat persistence
 * goes through Portal via WS RPC.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";

export interface ChatSessionLineageInput {
  /** Parent chat session for delegated child sessions. Null/undefined for normal top-level chat. */
  parentSessionId?: string | null;
  /** Agent that initiated the delegation. Null/undefined for normal top-level chat. */
  parentAgentId?: string | null;
  /** Stable id tying the parent tool call, child session, and streamed child rows together. */
  delegationId?: string | null;
  /** Agent selected to execute the delegated work. For self-delegation this equals the current agent. */
  targetAgentId?: string | null;
}

export interface AppendMessageInput {
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
  toolInput?: string | null;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
  /** Agent that authored this row when it belongs to a delegated child stream. */
  fromAgentId?: string | null;
  parentSessionId?: string | null;
  delegationId?: string | null;
  targetAgentId?: string | null;
}

export interface UpdateMessageInput {
  messageId: string;
  sessionId: string;
  content: string;
  toolName?: string | null;
  toolInput?: string | null;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolInput: string | null;
  metadata: Record<string, unknown> | null;
  outcome: string | null;
  durationMs: number | null;
  fromAgentId: string | null;
  parentSessionId: string | null;
  delegationId: string | null;
  targetAgentId: string | null;
  createdAt: Date;
}

export interface AppendDelegationEventInput {
  parentSessionId: string;
  parentAgentId: string | null;
  userId: string;
  delegationId: string;
  childSessionId: string;
  targetAgentId: string | null;
  status: "done" | "failed" | "timed_out" | "cancelled";
  capsule: string;
  fullSummary?: string;
  summaryTruncated?: boolean;
  scope?: string;
  taskIndex?: number;
  totalTasks?: number;
  toolCalls?: number;
  durationMs?: number;
}

/** Module-level FrontendWsClient reference, set via initChatRepo(). */
let _client: FrontendWsClient | null = null;

/** Initialize the chat repo module with a FrontendWsClient instance. */
export function initChatRepo(client: FrontendWsClient): void {
  _client = client;
}

function getClient(): FrontendWsClient {
  if (!_client) throw new Error("[chat-repo] FrontendWsClient not initialized — call initChatRepo() first");
  return _client;
}

/**
 * Ensure a chat_sessions row exists (upsert via RPC).
 */
export async function ensureChatSession(
  sessionId: string, agentId: string, userId: string,
  title?: string, preview?: string, origin?: string,
  lineage?: ChatSessionLineageInput,
): Promise<void> {
  const payload: Record<string, unknown> = {
    session_id: sessionId, agent_id: agentId, user_id: userId,
    title, preview, origin,
  };
  if (lineage) {
    payload.parent_session_id = lineage.parentSessionId ?? null;
    payload.parent_agent_id = lineage.parentAgentId ?? null;
    payload.delegation_id = lineage.delegationId ?? null;
    payload.target_agent_id = lineage.targetAgentId ?? null;
  }
  await getClient().request("chat.ensureSession", payload);
}

/**
 * Insert a single message row via RPC. Returns the generated id.
 *
 * `metadata` is JSON-stringified before sending because Upstream's Go RPC
 * handler extracts it with `ptrStr(...)` which only accepts string values;
 * passing a bare object would silently drop to nil on the wire. The read
 * path in `getMessages` below reverses the transformation.
 */
export async function appendMessage(msg: AppendMessageInput): Promise<string> {
  const result = await getClient().request("chat.appendMessage", {
    session_id: msg.sessionId,
    role: msg.role,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: msg.metadata != null ? JSON.stringify(msg.metadata) : null,
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    from_agent_id: msg.fromAgentId ?? null,
    parent_session_id: msg.parentSessionId ?? null,
    delegation_id: msg.delegationId ?? null,
    target_agent_id: msg.targetAgentId ?? null,
  });
  return result.id;
}

/**
 * Persist a parent-session notification that records a delegated child run
 * result. Today this is audit/event metadata only; the frontend hides it so
 * the synchronous delegation tool card remains the only visible user surface.
 * A later async Notify scheduler can feed the same event shape back to the
 * parent model as a synthetic user turn.
 */
export async function appendDelegationEvent(evt: AppendDelegationEventInput): Promise<string> {
  const metadata: Record<string, unknown> = {
    kind: "delegation_event",
    source: "system_notification",
    event_type: `delegation.${evt.status}`,
    delegation_id: evt.delegationId,
    child_session_id: evt.childSessionId,
    target_agent_id: evt.targetAgentId,
    parent_agent_id: evt.parentAgentId,
    status: evt.status,
    capsule: evt.capsule,
    ...(evt.fullSummary ? { full_summary: evt.fullSummary } : {}),
    ...(evt.summaryTruncated != null ? { summary_truncated: evt.summaryTruncated } : {}),
    ...(evt.scope ? { scope: evt.scope } : {}),
    ...(evt.taskIndex != null ? { task_index: evt.taskIndex } : {}),
    ...(evt.totalTasks != null ? { total_tasks: evt.totalTasks } : {}),
    ...(evt.toolCalls != null ? { tool_calls: evt.toolCalls } : {}),
    ...(evt.durationMs != null ? { duration_ms: evt.durationMs } : {}),
  };

  return appendMessage({
    sessionId: evt.parentSessionId,
    role: "user",
    content: evt.capsule,
    metadata,
    fromAgentId: evt.targetAgentId,
    delegationId: evt.delegationId,
    targetAgentId: evt.targetAgentId,
  });
}

/** Update an existing persisted message row. Used to turn running tool rows into completed rows. */
export async function updateMessage(msg: UpdateMessageInput): Promise<void> {
  await getClient().request("chat.updateMessage", {
    id: msg.messageId,
    session_id: msg.sessionId,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: msg.metadata != null ? JSON.stringify(msg.metadata) : null,
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
  });
}

/**
 * Bump message count — now handled by append-message endpoint.
 * Kept for backward compatibility but is a no-op.
 */
export async function incrementMessageCount(_sessionId: string): Promise<void> {
  // append-message endpoint already increments count
}

/**
 * Read messages for a session via RPC.
 */
export async function getMessages(
  sessionId: string,
  opts?: { before?: Date; limit?: number },
): Promise<StoredMessage[]> {
  const data = await getClient().request("chat.getMessages", {
    session_id: sessionId,
    before: opts?.before?.toISOString() ?? undefined,
    limit: opts?.limit ?? 50,
  }) as { messages: Array<Record<string, unknown>> };

  return (data.messages as Array<Record<string, unknown>>).map((r) => {
    const rawMeta = r.metadata as unknown;
    const metadata = rawMeta == null ? null
      : typeof rawMeta === "string" ? JSON.parse(rawMeta) as Record<string, unknown>
      : rawMeta as Record<string, unknown>;
    return {
      id: r.id as string, sessionId: r.session_id as string, role: r.role as string,
      content: (r.content as string | null) ?? "", toolName: (r.tool_name as string | null) ?? null,
      toolInput: (r.tool_input as string | null) ?? null, metadata,
      outcome: (r.outcome as string | null) ?? null, durationMs: (r.duration_ms as number | null) ?? null,
      fromAgentId: (r.from_agent_id as string | null) ?? null,
      parentSessionId: (r.parent_session_id as string | null) ?? null,
      delegationId: (r.delegation_id as string | null) ?? null,
      targetAgentId: (r.target_agent_id as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
    };
  }).reverse();
}
