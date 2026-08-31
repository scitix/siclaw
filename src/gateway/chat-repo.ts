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
import type { ToolsetEnvelope } from "../shared/toolset-capture.js";

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
  /** Invocation id from the model's toolCall block. */
  toolCallId?: string | null;
  llmRound?: number | null;
  /** Every tool call emitted by one LLM round; serialized only at the RPC boundary. */
  toolset?: ToolsetEnvelope | null;
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
  /**
   * Leave this row unordered for now; it will be ordered when it enters processing.
   *
   * Only for user input the runtime injects into a turn: it is written on arrival so it
   * cannot be lost, but the box consumes it at a turn boundary that may be seconds later.
   */
  deferSequence?: boolean;
}

export interface UpdateMessageInput {
  messageId: string;
  sessionId: string;
  content: string;
  toolName?: string | null;
  toolInput?: string | null;
  toolCallId?: string | null;
  llmRound?: number | null;
  toolset?: ToolsetEnvelope | null;
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
  toolCallId: string | null;
  llmRound: number | null;
  toolset: ToolsetEnvelope | null;
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

function parseToolsetEnvelope(raw: unknown): ToolsetEnvelope | null {
  try {
    const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<ToolsetEnvelope> | null;
    return value?.version === 1 && Number.isInteger(value.llm_round) && Array.isArray(value.tool_calls)
      ? value as ToolsetEnvelope
      : null;
  } catch {
    // Rolling deploys can still return the retired semantic string values.
    return null;
  }
}

function metadataWithToolCallId(
  metadata: Record<string, unknown> | null | undefined,
  toolCallId: string | null | undefined,
): Record<string, unknown> | null {
  if (!toolCallId) return metadata ?? null;
  const current = metadata?.tool_dispatch;
  const toolDispatch = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  return {
    ...(metadata ?? {}),
    tool_dispatch: { ...toolDispatch, tool_call_id: toolCallId },
  };
}

function toolCallIdFromMetadata(metadata: Record<string, unknown> | null): string | null {
  const toolDispatch = metadata?.tool_dispatch;
  if (!toolDispatch || typeof toolDispatch !== "object" || Array.isArray(toolDispatch)) return null;
  const value = (toolDispatch as Record<string, unknown>).tool_call_id;
  return typeof value === "string" ? value : null;
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
  const metadata = metadataWithToolCallId(msg.metadata, msg.toolCallId);
  const result = await getClient().request("chat.appendMessage", {
    session_id: msg.sessionId,
    role: msg.role,
    content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    tool_call_id: msg.toolCallId ?? null,
    toolset: msg.toolset != null ? JSON.stringify(msg.toolset) : null,
    metadata: metadata != null ? JSON.stringify(metadata) : null,
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    from_agent_id: msg.fromAgentId ?? null,
    parent_session_id: msg.parentSessionId ?? null,
    delegation_id: msg.delegationId ?? null,
    target_agent_id: msg.targetAgentId ?? null,
    trace_id: msg.traceId ?? null,
    defer_sequence: msg.deferSequence === true ? true : undefined,
  });
  return result.id;
}

/**
 * Attach the AgentBox prompt trace to the exact user message that initiated it.
 * The Portal RPC enforces the exact message/session pair, user role, and
 * NULL-to-value idempotency. ControlPlane additionally verifies Runtime ownership;
 * standalone Portal uses its portal-secret-authenticated Runtime trust domain.
 * Missing trace ids are tolerated for rolling upgrades where an older AgentBox
 * does not yet include traceId in its prompt/steer ACK.
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
 * OTel trace ids are 32 lowercase hex characters — the contract the bind RPC above
 * enforces server-side. Exported so every place that INGESTS a trace id from another
 * process (the box's prompt ack, a delegation terminal event) applies the same gate:
 * accepting a malformed id at one boundary and rejecting it at another is how rows
 * get persisted under an id no link references.
 */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
export function validTraceId(value: unknown): string | undefined {
  return typeof value === "string" && TRACE_ID_RE.test(value) ? value : undefined;
}

/**
 * Report a failed trace bind — but only once per process when the upstream simply does
 * not implement the method.
 *
 * Binding a message to its trace is best-effort and optional: an upstream that has no
 * trace consumer yet answers "unknown method" to every prompt and every steer, and a
 * conversation steered a dozen times buries a real failure under a dozen identical lines.
 * Any OTHER failure is a genuine one-off and keeps its own line.
 *
 * Lives here, next to bindMessageTraceId, because its dedup only works if every bind
 * caller shares one reporter — server.ts (prompt/steer rows), delegate-api.ts
 * (delegated opening rows) and the lark/dingtalk channels all report through it.
 */
const unsupportedUpstreamMethodsReported = new Set<string>();
export function warnTraceBindFailure(kind: string, sessionId: string, messageId: string, err: unknown): void {
  const message = String((err as Error)?.message ?? err);
  if (/unknown method|not implemented|method not found/i.test(message)) {
    // Keyed by the method the upstream is missing, not by a single global flag: one
    // absent method must not silence the next one. The match runs on a bounded HEAD
    // of the message with a non-backtracking shape (\w+(\.\w+)+ is linear; the old
    // unanchored [\w.]+\.[\w]+ was measured quadratic — ~87s on a 400k-char error
    // echoed by an upstream) so a huge error payload cannot stall the event loop
    // from a fire-and-forget warn path.
    const head = message.slice(0, 256);
    const method = head.match(/\w+(?:\.\w+)+/)?.[0] ?? head;
    if (unsupportedUpstreamMethodsReported.has(method)) return;
    unsupportedUpstreamMethodsReported.add(method);
    console.warn(`[runtime] upstream does not implement ${method}; that capability is off for this process (${message.slice(0, 2000)})`);
    return;
  }
  console.warn(`[runtime] failed to bind ${kind} trace session=${sessionId} message=${messageId}:`, err);
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
  /** Exact assistant chat_messages id. Missing only for legacy cards. */
  messageId?: string;
  rating: "up" | "down";
  senderExternalId: string;
  channelId?: string | null;
  source?: string;
}): Promise<{ success: boolean; error?: string }> {
  return getClient().request("chat.recordFeedback", {
    session_id: params.sessionId,
    message_ref: params.messageRef,
    ...(params.messageId ? { message_id: params.messageId } : {}),
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
  const metadata = metadataWithToolCallId(msg.metadata, msg.toolCallId);
  await getClient().request("chat.updateMessage", {
    id: msg.messageId,
    session_id: msg.sessionId,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    tool_call_id: msg.toolCallId ?? null,
    toolset: msg.toolset != null ? JSON.stringify(msg.toolset) : null,
    metadata: metadata != null ? JSON.stringify(metadata) : null,
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    delegation_id: msg.delegationId ?? null,
  });
}

/**
 * Ask the store to give this row its place in the conversation.
 *
 * A user row is written the moment it arrives so it cannot be lost, but the box may not
 * consume it until a turn boundary seconds later — so arrival order is not processing
 * order, and a user typing faster than the model answers reloads to find every question
 * ahead of every answer. The store allocates the ordering key when we say the row entered
 * processing, keyed by row id so a replayed echo is a no-op rather than a silent shift.
 *
 * Sends nothing but the identity and the request: a partial update must leave the row's
 * content alone.
 */
export async function sequenceMessage(messageId: string, sessionId: string): Promise<void> {
  // A METHOD OF ITS OWN, deliberately. chat.updateMessage replaces the row's columns from
  // the payload, so a store implementing that contract literally — as this repo's own
  // Portal did — would read the absent `content` as an empty one and blank the user's
  // message. An upstream that has not implemented this answers "unknown method", which
  // costs the row its ordering key and nothing else.
  await getClient().request("chat.sequenceMessage", {
    id: messageId,
    session_id: sessionId,
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
    const toolset = parseToolsetEnvelope(r.toolset);
    return {
      id: r.id as string, sessionId: r.session_id as string, role: r.role as string,
      content: (r.content as string | null) ?? "", toolName: (r.tool_name as string | null) ?? null,
      toolInput: (r.tool_input as string | null) ?? null, metadata,
      toolCallId: toolCallIdFromMetadata(metadata),
      llmRound: toolset?.llm_round ?? null,
      toolset,
      outcome: (r.outcome as string | null) ?? null, durationMs: (r.duration_ms as number | null) ?? null,
      fromAgentId: (r.from_agent_id as string | null) ?? null,
      parentSessionId: (r.parent_session_id as string | null) ?? null,
      delegationId: (r.delegation_id as string | null) ?? null,
      targetAgentId: (r.target_agent_id as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
    };
  }).reverse();
}
