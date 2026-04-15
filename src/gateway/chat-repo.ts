/**
 * Minimal chat repository for agent trace persistence.
 *
 * Used by sse-consumer to record agent events (user message, assistant message,
 * tool calls, outcomes) into chat_messages during scheduled-task / web chat
 * execution, and by the task-run messages endpoint to read them back.
 *
 * Scope is intentionally narrow — session management (create / delete / list)
 * lives elsewhere (see portal/chat-gateway.ts for web chat session creation,
 * task-coordinator.ts ensureChatSession for scheduled-task session creation).
 */

import crypto from "node:crypto";
import { getDb } from "./db.js";

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

/**
 * Insert a single message row. Returns the generated id.
 *
 * Caller must ensure chat_sessions row for sessionId exists (FK constraint).
 */
export async function appendMessage(msg: AppendMessageInput): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.query(
    `INSERT INTO chat_messages (id, session_id, role, content, tool_name, tool_input, metadata, outcome, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      msg.sessionId,
      msg.role,
      msg.content,
      msg.toolName ?? null,
      msg.toolInput ?? null,
      msg.metadata != null ? JSON.stringify(msg.metadata) : null,
      msg.outcome ?? null,
      msg.durationMs ?? null,
    ],
  );
  return id;
}

/**
 * Read messages for a session, newest-N then chronological.
 *
 * Returns messages ordered oldest → newest (matching siclaw_main behaviour:
 * fetch desc, reverse to chronological for display).
 */
export async function getMessages(
  sessionId: string,
  opts?: { before?: Date; limit?: number },
): Promise<StoredMessage[]> {
  const limit = opts?.limit ?? 50;
  const db = getDb();
  const params: unknown[] = [sessionId];
  let where = "session_id = ?";
  if (opts?.before) {
    where += " AND created_at < ?";
    params.push(opts.before);
  }
  params.push(limit);
  const [rows] = (await db.query(
    `SELECT id, session_id, role, content, tool_name, tool_input, metadata, outcome, duration_ms, created_at
     FROM chat_messages
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
    params,
  )) as any;

  const mapped: StoredMessage[] = (rows as Array<Record<string, unknown>>).map((r) => {
    // mysql2 auto-decodes JSON columns; fall back to parse if a driver returns string.
    const rawMeta = r.metadata as unknown;
    const metadata =
      rawMeta == null
        ? null
        : typeof rawMeta === "string"
          ? (JSON.parse(rawMeta) as Record<string, unknown>)
          : (rawMeta as Record<string, unknown>);
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      role: r.role as string,
      content: (r.content as string | null) ?? "",
      toolName: (r.tool_name as string | null) ?? null,
      toolInput: (r.tool_input as string | null) ?? null,
      metadata,
      outcome: (r.outcome as string | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      createdAt: r.created_at as Date,
    };
  });
  return mapped.reverse();
}

/**
 * Bump the session's message_count and last_active_at.
 *
 * No-op if the session row doesn't exist (UPDATE affects 0 rows) — caller
 * is responsible for creating chat_sessions before appending messages.
 */
export async function incrementMessageCount(sessionId: string): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE chat_sessions
     SET message_count = message_count + 1, last_active_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [sessionId],
  );
}
