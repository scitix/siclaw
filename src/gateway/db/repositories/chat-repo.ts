/**
 * Chat Repository — session & message CRUD
 */

import crypto from "node:crypto";
import { eq, desc, asc, and, lt, isNull, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { sessions, messages } from "../schema.js";

export class ChatRepository {
  constructor(private db: Database) {}

  async listSessions(userId: string, limit = 20, workspaceId?: string) {
    const conditions = [eq(sessions.userId, userId), isNull(sessions.deletedAt)];
    if (workspaceId) {
      conditions.push(eq(sessions.workspaceId, workspaceId));
    }
    return this.db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(desc(sessions.lastActiveAt))
      .limit(limit);
  }

  async getSession(sessionId: string) {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  async createSession(userId: string, title?: string, workspaceId?: string) {
    const id = crypto.randomUUID();
    await this.db.insert(sessions).values({
      id,
      userId,
      workspaceId: workspaceId ?? null,
      title: title ?? "New Chat",
      preview: "",
      messageCount: 0,
    });
    return { id, title: title ?? "New Chat" };
  }

  async deleteSession(userId: string, sessionId: string) {
    // Soft delete — mark as deleted, keep data for post-training
    // Filter by userId to prevent cross-user session deletion
    await this.db
      .update(sessions)
      .set({ deletedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  }

  async updateSessionMeta(
    sessionId: string,
    updates: { title?: string; preview?: string },
  ) {
    await this.db
      .update(sessions)
      .set({
        ...updates,
        lastActiveAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
  }

  async incrementMessageCount(sessionId: string) {
    await this.db
      .update(sessions)
      .set({
        messageCount: sql`message_count + 1`,
        lastActiveAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
  }

  async getMessages(
    sessionId: string,
    opts?: { before?: Date; limit?: number },
  ) {
    const limit = opts?.limit ?? 50;
    const where = opts?.before
      ? and(
          eq(messages.sessionId, sessionId),
          lt(messages.timestamp, opts.before),
        )
      : eq(messages.sessionId, sessionId);

    // Fetch newest N rows, then reverse to chronological order
    const rows = await this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.timestamp))
      .limit(limit);
    return rows.reverse();
  }

  async appendMessage(msg: {
    sessionId: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolName?: string;
    toolInput?: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = crypto.randomUUID();
    await this.db.insert(messages).values({
      id,
      sessionId: msg.sessionId,
      role: msg.role,
      content: msg.content,
      toolName: msg.toolName ?? null,
      toolInput: msg.toolInput ?? null,
      metadata: msg.metadata ?? null,
    });
    return id;
  }

  async updateMetadata(
    userId: string,
    messageId: string,
    metadata: Record<string, unknown>,
  ) {
    // Merge with existing metadata — verify ownership via session join
    const rows = await this.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(and(eq(messages.id, messageId), eq(sessions.userId, userId)))
      .limit(1);
    if (!rows[0]) return;
    const existing = (rows[0]?.metadata as Record<string, unknown>) ?? {};
    const merged = { ...existing, ...metadata };
    await this.db
      .update(messages)
      .set({ metadata: merged })
      .where(eq(messages.id, messageId));
  }
}
