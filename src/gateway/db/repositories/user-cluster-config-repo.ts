/**
 * User Cluster Config Repository — per-user kubeconfig for each K8s cluster
 */

import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Database } from "../index.js";
import { userClusterConfigs } from "../schema.js";

export class UserClusterConfigRepository {
  constructor(private db: Database) {}

  async listForUser(userId: string) {
    return this.db
      .select({
        id: userClusterConfigs.id,
        userId: userClusterConfigs.userId,
        clusterId: userClusterConfigs.clusterId,
        createdAt: userClusterConfigs.createdAt,
        updatedAt: userClusterConfigs.updatedAt,
      })
      .from(userClusterConfigs)
      .where(eq(userClusterConfigs.userId, userId));
  }

  async get(userId: string, clusterId: string) {
    const rows = await this.db
      .select()
      .from(userClusterConfigs)
      .where(and(eq(userClusterConfigs.userId, userId), eq(userClusterConfigs.clusterId, clusterId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async set(userId: string, clusterId: string, kubeconfig: string): Promise<string> {
    const existing = await this.get(userId, clusterId);
    if (existing) {
      await this.db
        .update(userClusterConfigs)
        .set({ kubeconfig, updatedAt: new Date() })
        .where(eq(userClusterConfigs.id, existing.id));
      return existing.id;
    }
    const id = crypto.randomBytes(12).toString("hex");
    await this.db.insert(userClusterConfigs).values({
      id,
      userId,
      clusterId,
      kubeconfig,
    });
    return id;
  }

  async remove(userId: string, clusterId: string): Promise<void> {
    await this.db
      .delete(userClusterConfigs)
      .where(and(eq(userClusterConfigs.userId, userId), eq(userClusterConfigs.clusterId, clusterId)));
  }

  async has(userId: string, clusterId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: userClusterConfigs.id })
      .from(userClusterConfigs)
      .where(and(eq(userClusterConfigs.userId, userId), eq(userClusterConfigs.clusterId, clusterId)))
      .limit(1);
    return rows.length > 0;
  }

  async removeAllForCluster(clusterId: string): Promise<void> {
    await this.db
      .delete(userClusterConfigs)
      .where(eq(userClusterConfigs.clusterId, clusterId));
  }

  /** Get all user configs for a cluster (for cleanup when deleting cluster) */
  async listForCluster(clusterId: string) {
    return this.db
      .select({
        userId: userClusterConfigs.userId,
        clusterId: userClusterConfigs.clusterId,
      })
      .from(userClusterConfigs)
      .where(eq(userClusterConfigs.clusterId, clusterId));
  }

  /**
   * Get full records (including kubeconfig content) for all users with configs for the given clusterId.
   * Separate from listForCluster() which omits the large kubeconfig blob for lightweight queries.
   * Used by cluster.update to validate kubeconfigs against a changed apiServer.
   */
  async listFullForCluster(clusterId: string) {
    return this.db
      .select()
      .from(userClusterConfigs)
      .where(eq(userClusterConfigs.clusterId, clusterId));
  }
}
