/**
 * Notification Repository — user notification CRUD
 *
 * "Delete" operations are soft-deletes (set dismissedAt).
 * Notifications older than the retention period can be purged via purgeOlderThan().
 */

import crypto from "node:crypto";
import { eq, and, desc, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { notifications } from "../schema.js";

export interface CreateNotificationInput {
  userId: string;
  type: string; // "vote_up", "vote_down", "skill_reverted", "cron_result"
  title: string;
  message?: string;
  relatedId?: string;
}

export interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string | null;
  relatedId: string | null;
  isRead: boolean;
  dismissedAt: Date | null;
  createdAt: Date | null;
}

export class NotificationRepository {
  constructor(private db: Database) {}

  /** Create a notification, returns its id */
  async create(input: CreateNotificationInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(notifications).values({
      id,
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message ?? null,
      relatedId: input.relatedId ?? null,
      isRead: false,
    });
    return id;
  }

  /** List non-dismissed notifications for a user */
  async listForUser(
    userId: string,
    opts?: { limit?: number; unreadOnly?: boolean },
  ): Promise<NotificationRow[]> {
    const limit = opts?.limit ?? 50;
    const conditions = [
      eq(notifications.userId, userId),
      isNull(notifications.dismissedAt),
    ];
    if (opts?.unreadOnly) {
      conditions.push(eq(notifications.isRead, false));
    }
    return this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  /** Get unread count (non-dismissed only) */
  async unreadCount(userId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
          isNull(notifications.dismissedAt),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  /** Mark a single notification as read (filtered by userId to prevent cross-user access) */
  async markRead(userId: string, id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  }

  /** Mark all notifications as read for a user */
  async markAllRead(userId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
        ),
      );
  }

  /** Soft-delete a single notification (filtered by userId to prevent cross-user access) */
  async dismiss(userId: string, id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ dismissedAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  }

  /** Soft-delete all notifications for a user (set dismissedAt) */
  async dismissAll(userId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ dismissedAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.dismissedAt),
        ),
      );
  }

  /** Dismiss all non-dismissed notifications matching type + relatedId (across all users) */
  async dismissByTypeAndRelatedId(type: string, relatedId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ dismissedAt: new Date() })
      .where(
        and(
          eq(notifications.type, type),
          eq(notifications.relatedId, relatedId),
          isNull(notifications.dismissedAt),
        ),
      );
  }

  /** Hard-delete notifications older than the given date (for periodic cleanup) */
  async purgeOlderThan(date: Date): Promise<number> {
    // Count before delete (avoids sql.js getRowsModified race)
    const countRows = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(lt(notifications.createdAt, date));
    const count = Number(countRows[0]?.count ?? 0);
    if (count > 0) {
      await this.db
        .delete(notifications)
        .where(lt(notifications.createdAt, date));
    }
    return count;
  }
}
