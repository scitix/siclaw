/**
 * User Environment Config Repository — per-user kubeconfig for each environment
 */

import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Database } from "../index.js";
import { userEnvConfigs } from "../schema.js";

export class UserEnvConfigRepository {
  constructor(private db: Database) {}

  async listForUser(userId: string) {
    return this.db
      .select({
        id: userEnvConfigs.id,
        userId: userEnvConfigs.userId,
        envId: userEnvConfigs.envId,
        createdAt: userEnvConfigs.createdAt,
        updatedAt: userEnvConfigs.updatedAt,
      })
      .from(userEnvConfigs)
      .where(eq(userEnvConfigs.userId, userId));
  }

  async get(userId: string, envId: string) {
    const rows = await this.db
      .select()
      .from(userEnvConfigs)
      .where(and(eq(userEnvConfigs.userId, userId), eq(userEnvConfigs.envId, envId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async set(userId: string, envId: string, kubeconfig: string): Promise<string> {
    const existing = await this.get(userId, envId);
    if (existing) {
      await this.db
        .update(userEnvConfigs)
        .set({ kubeconfig, updatedAt: new Date() })
        .where(eq(userEnvConfigs.id, existing.id));
      return existing.id;
    }
    const id = crypto.randomBytes(12).toString("hex");
    await this.db.insert(userEnvConfigs).values({
      id,
      userId,
      envId,
      kubeconfig,
    });
    return id;
  }

  async remove(userId: string, envId: string): Promise<void> {
    await this.db
      .delete(userEnvConfigs)
      .where(and(eq(userEnvConfigs.userId, userId), eq(userEnvConfigs.envId, envId)));
  }

  async has(userId: string, envId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: userEnvConfigs.id })
      .from(userEnvConfigs)
      .where(and(eq(userEnvConfigs.userId, userId), eq(userEnvConfigs.envId, envId)))
      .limit(1);
    return rows.length > 0;
  }

  async removeAllForEnv(envId: string): Promise<void> {
    await this.db
      .delete(userEnvConfigs)
      .where(eq(userEnvConfigs.envId, envId));
  }

  /** Get all user configs for an env (for cleanup when deleting env) */
  async listForEnv(envId: string) {
    return this.db
      .select({
        userId: userEnvConfigs.userId,
        envId: userEnvConfigs.envId,
      })
      .from(userEnvConfigs)
      .where(eq(userEnvConfigs.envId, envId));
  }

  /**
   * Get full records (including kubeconfig content) for all users with configs for the given envId.
   * Separate from listForEnv() which omits the large kubeconfig blob for lightweight queries.
   * Used by environment.update to validate kubeconfigs against a changed apiServer.
   */
  async listFullForEnv(envId: string) {
    return this.db
      .select()
      .from(userEnvConfigs)
      .where(eq(userEnvConfigs.envId, envId));
  }
}
