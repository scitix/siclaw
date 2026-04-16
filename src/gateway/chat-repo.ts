/**
 * Chat repository — FrontendWsClient RPC client for chat persistence.
 *
 * Runtime no longer accesses the database directly. All chat persistence
 * goes through Portal via WS RPC.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";

export interface AppendMessageInput {
  sessionId: string;
  role: "user" | "assistant" | "tool";
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
  createdAt: Date;
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
): Promise<void> {
  await getClient().request("chat.ensureSession", {
    session_id: sessionId, agent_id: agentId, user_id: userId,
    title, preview, origin,
  });
}

/**
 * Insert a single message row via RPC. Returns the generated id.
 */
export async function appendMessage(msg: AppendMessageInput): Promise<string> {
  const result = await getClient().request("chat.appendMessage", {
    session_id: msg.sessionId,
    role: msg.role,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: msg.metadata ?? null,
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
  });
  return result.id;
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
      createdAt: new Date(r.created_at as string),
    };
  }).reverse();
}
