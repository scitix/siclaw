/**
 * Chat Repository — session & message CRUD
 */

import crypto from "node:crypto";
import { eq, desc, and, lt, lte, gte, isNull, isNotNull, or, like, inArray, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { sessions, messages, users, sessionStats } from "../schema.js";

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
    userId?: string;
    outcome?: "success" | "error" | "blocked";
    durationMs?: number;
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
      userId: msg.userId ?? null,
      outcome: msg.outcome ?? null,
      durationMs: msg.durationMs ?? null,
    });
    return id;
  }

  async getMessageById(messageId: string) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    return rows[0] ?? null;
  }

  async queryAuditLogs(opts: {
    userId?: string;
    userName?: string;
    toolName?: string;
    outcome?: string;
    startDate?: number;
    endDate?: number;
    cursorTs?: number;
    cursorId?: string;
    limit: number;
  }) {
    const conditions = [eq(messages.role, "tool")];

    if (opts.userId) conditions.push(eq(messages.userId, opts.userId));
    if (opts.userName) {
      const escaped = opts.userName.replace(/[%_]/g, "\\$&");
      conditions.push(like(users.username, `%${escaped}%`));
    }
    if (opts.toolName) conditions.push(eq(messages.toolName, opts.toolName));
    if (opts.outcome) conditions.push(eq(messages.outcome, opts.outcome));
    if (opts.startDate) conditions.push(gte(messages.timestamp, new Date(opts.startDate * 1000)));
    if (opts.endDate) conditions.push(lte(messages.timestamp, new Date(opts.endDate * 1000)));

    if (opts.cursorTs != null) {
      const cursorDate = new Date(opts.cursorTs * 1000);
      if (opts.cursorId) {
        conditions.push(
          or(
            lt(messages.timestamp, cursorDate),
            and(eq(messages.timestamp, cursorDate), lt(messages.id, opts.cursorId)),
          )!,
        );
      } else {
        conditions.push(lt(messages.timestamp, cursorDate));
      }
    }

    return this.db
      .select({
        id: messages.id,
        userId: messages.userId,
        userName: users.username,
        toolName: messages.toolName,
        toolInput: messages.toolInput,
        outcome: messages.outcome,
        durationMs: messages.durationMs,
        timestamp: messages.timestamp,
      })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(messages.timestamp), desc(messages.id))
      .limit(opts.limit + 1);
  }

  // ── DB Cleanup Methods ──────────────────────────────

  private static readonly BATCH_SIZE = 500;

  /**
   * Soft-delete inactive sessions (no activity for `inactiveDays`).
   * Only targets sessions that haven't been deleted yet.
   */
  async softDeleteInactiveSessions(inactiveDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - inactiveDays * 86400_000);
    const now = new Date();
    let total = 0;
    while (true) {
      const ids = await this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(isNull(sessions.deletedAt), lt(sessions.lastActiveAt, cutoff)))
        .limit(ChatRepository.BATCH_SIZE);
      if (ids.length === 0) break;
      await this.db
        .update(sessions)
        .set({ deletedAt: now })
        .where(inArray(sessions.id, ids.map((r) => r.id)));
      total += ids.length;
      if (ids.length < ChatRepository.BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * Hard-delete sessions that were soft-deleted more than `deletedDays` ago.
   * Messages are cleaned up automatically via FK CASCADE.
   */
  async purgeDeletedSessions(deletedDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - deletedDays * 86400_000);
    let total = 0;
    while (true) {
      const ids = await this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(isNotNull(sessions.deletedAt), lt(sessions.deletedAt, cutoff)))
        .limit(ChatRepository.BATCH_SIZE);
      if (ids.length === 0) break;
      await this.db
        .delete(sessions)
        .where(inArray(sessions.id, ids.map((r) => r.id)));
      total += ids.length;
      if (ids.length < ChatRepository.BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * Hard-delete session_stats older than `retentionDays`.
   * Note: sessionStats.createdAt is a raw epoch number in milliseconds
   * (no mode:"timestamp"), so we compare with numeric ms, not Date.
   */
  async purgeOldSessionStats(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86400_000;
    let total = 0;
    while (true) {
      const ids = await this.db
        .select({ id: sessionStats.id })
        .from(sessionStats)
        .where(lt(sessionStats.createdAt, cutoff))
        .limit(ChatRepository.BATCH_SIZE);
      if (ids.length === 0) break;
      await this.db
        .delete(sessionStats)
        .where(inArray(sessionStats.id, ids.map((r) => r.id)));
      total += ids.length;
      if (ids.length < ChatRepository.BATCH_SIZE) break;
    }
    return total;
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
