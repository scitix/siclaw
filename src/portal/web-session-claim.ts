import { getDb } from "../gateway/db.js";
import { buildUpsert } from "../gateway/dialect-helpers.js";
import { normalizeChatSessionTitle } from "./chat-session-fields.js";

/** Atomically reserve new IDs; an existing session's identity is never overwritten. */
export async function claimWebChatSession(sessionId: string, agentId: string, userId: string, title: string): Promise<boolean> {
  const db = getDb();
  const insert = buildUpsert(db, "chat_sessions", ["id", "agent_id", "user_id", "title", "origin"],
    [sessionId, agentId, userId, normalizeChatSessionTitle(title), "web"], ["id"], [{ col: "id", expr: "id" }]);
  await db.query(insert.sql, insert.params);
  const [rows] = await db.query<Array<{ id: string }>>(
    "SELECT id FROM chat_sessions WHERE id = ? AND agent_id = ? AND user_id = ? AND deleted_at IS NULL AND parent_session_id IS NULL AND (origin IS NULL OR origin = 'web')",
    [sessionId, agentId, userId]);
  return rows.length === 1;
}
