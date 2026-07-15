/**
 * Chat repository — FrontendWsClient RPC client for chat persistence.
 *
 * Runtime no longer accesses the database directly. All chat persistence
 * goes through Portal via WS RPC.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";
import { normalizeChatSessionTitle } from "./chat-session-fields.js";
import { stripLanguageDirective } from "../shared/strip-language-directive.js";
import type { GroupItemStatus } from "../core/tool-registry.js";

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
  /** per-prompt root trace id (OTel 32-hex) for message-level trace filtering. */
  traceId?: string | null;
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
  delegationId?: string | null;
}

export interface UpdateDelegationToolMessageInput {
  sessionId: string;
  toolName: string;
  delegationId: string;
  content: string;
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
  /** Group terminal event per-item status snapshot (mirrors DelegationEventPayload.itemStatuses). */
  itemStatuses?: Array<{ index: number; status: GroupItemStatus }>;
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
  opts?: { senderExternalId?: string | null; channelId?: string | null },
): Promise<void> {
  const payload: Record<string, unknown> = {
    session_id: sessionId, agent_id: agentId, user_id: userId,
    title: normalizeChatSessionTitle(title), preview, origin,
  };
  if (lineage) {
    payload.parent_session_id = lineage.parentSessionId ?? null;
    payload.parent_agent_id = lineage.parentAgentId ?? null;
    payload.delegation_id = lineage.delegationId ?? null;
    payload.target_agent_id = lineage.targetAgentId ?? null;
  }
  // Channel (Lark/DingTalk) audit dimensions: the raw sender id (open_id /
  // staffId — the "same person" key, never the binding owner) and which channel.
  // Each gated on != null so web/api/a2a callers leave the payload unchanged.
  if (opts?.senderExternalId != null) payload.sender_external_id = opts.senderExternalId;
  if (opts?.channelId != null) payload.channel_id = opts.channelId;
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
  // Defence in depth: never persist the agentbox's injected `[System: respond in X]`
  // language directive as a user message (it's a model-only control token). The
  // gateway path already stores the original text, so this is a no-op there, but it
  // guards any caller that hands us a brain-recorded user turn.
  const content = msg.role === "user" ? stripLanguageDirective(msg.content) : msg.content;
  const result = await getClient().request("chat.appendMessage", {
    session_id: msg.sessionId,
    role: msg.role,
    content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: msg.metadata != null ? JSON.stringify(msg.metadata) : null,
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    from_agent_id: msg.fromAgentId ?? null,
    parent_session_id: msg.parentSessionId ?? null,
    delegation_id: msg.delegationId ?? null,
    target_agent_id: msg.targetAgentId ?? null,
    trace_id: msg.traceId ?? null,
  });
  return result.id;
}

/**
 * Attach the AgentBox prompt trace to the exact user message that initiated it.
 * The Portal RPC enforces user-role, runtime ownership, and NULL-to-value
 * idempotency. Missing trace ids are tolerated for rolling upgrades where an
 * older AgentBox does not yet include traceId in its prompt/steer ACK.
 */
export async function bindMessageTraceId(
  messageId: string,
  sessionId: string,
  traceId?: string | null,
): Promise<void> {
  if (!traceId) return;
  await getClient().request("chat.bindMessageTraceId", {
    id: messageId,
    session_id: sessionId,
    trace_id: traceId,
  });
}

/**
 * Record (or re-vote) end-user feedback on a channel reply. `messageRef` is a
 * channel-level reply reference (Feishu CardKit card_id), not a chat_messages
 * id — see the message_feedback DDL comment. One vote per (reply, person);
 * the server upserts on repeat clicks.
 */
export async function recordChannelFeedback(params: {
  sessionId: string;
  messageRef: string;
  rating: "up" | "down";
  senderExternalId: string;
  channelId?: string | null;
  source?: string;
}): Promise<{ success: boolean; error?: string }> {
  return getClient().request("chat.recordFeedback", {
    session_id: params.sessionId,
    message_ref: params.messageRef,
    rating: params.rating,
    sender_external_id: params.senderExternalId,
    channel_id: params.channelId ?? null,
    source: params.source ?? "lark",
  });
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
    ...(evt.partialSource ? { partial_source: evt.partialSource } : {}),
    ...(evt.interruptedTool ? { interrupted_tool: evt.interruptedTool } : {}),
    ...(evt.itemStatuses ? { item_statuses: evt.itemStatuses } : {}),
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
    delegation_id: msg.delegationId ?? null,
  });
}

/** Update the parent async delegation tool row after its background batch finishes. */
export async function updateDelegationToolMessage(msg: UpdateDelegationToolMessageInput): Promise<void> {
  await getClient().request("chat.updateDelegationToolMessage", {
    session_id: msg.sessionId,
    tool_name: msg.toolName,
    delegation_id: msg.delegationId,
    content: msg.content,
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
