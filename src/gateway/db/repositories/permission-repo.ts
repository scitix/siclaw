/**
 * Permission Repository — user permission CRUD
 *
 * Manages per-user permissions (e.g. "skill_reviewer").
 * Idempotent grants via insert-first, catch-constraint pattern (works for MySQL + SQLite).
 */

import crypto from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { userPermissions } from "../schema.js";
import { isUniqueViolation } from "../dialect-helpers.js";

export class PermissionRepository {
  constructor(private db: Database) {}

  /** Grant a permission to a user. Returns the permission row id. Idempotent. */
  async grant(userId: string, permission: string, grantedBy: string): Promise<string> {
    const id = crypto.randomUUID();
    try {
      await this.db.insert(userPermissions).values({
        id, userId, permission, grantedBy, grantedAt: new Date(),
      });
      return id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Concurrent insert won — return the existing row
      const existing = await this.db
        .select({ id: userPermissions.id })
        .from(userPermissions)
        .where(and(eq(userPermissions.userId, userId), eq(userPermissions.permission, permission)))
        .limit(1);
      return existing[0].id;
    }
  }

  /** Revoke a permission from a user */
  async revoke(userId: string, permission: string): Promise<void> {
    await this.db
      .delete(userPermissions)
      .where(
        and(
          eq(userPermissions.userId, userId),
          eq(userPermissions.permission, permission),
        ),
      );
  }

  /** Check if a user has a specific permission */
  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: userPermissions.id })
      .from(userPermissions)
      .where(
        and(
          eq(userPermissions.userId, userId),
          eq(userPermissions.permission, permission),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** List all users with a specific permission */
  async listByPermission(permission: string): Promise<Array<{
    userId: string;
    grantedBy: string | null;
    grantedAt: Date | null;
  }>> {
    return this.db
      .select({
        userId: userPermissions.userId,
        grantedBy: userPermissions.grantedBy,
        grantedAt: userPermissions.grantedAt,
      })
      .from(userPermissions)
      .where(eq(userPermissions.permission, permission));
  }

  /** List all permissions for a user */
  async listForUser(userId: string): Promise<Array<{
    permission: string;
    grantedAt: Date | null;
  }>> {
    return this.db
      .select({
        permission: userPermissions.permission,
        grantedAt: userPermissions.grantedAt,
      })
      .from(userPermissions)
      .where(eq(userPermissions.userId, userId));
  }
}
