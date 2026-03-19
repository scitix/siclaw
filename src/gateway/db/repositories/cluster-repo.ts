/**
 * Cluster Repository — CRUD for admin-managed K8s clusters
 */

import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../index.js";
import { clusters } from "../schema.js";

export class ClusterRepository {
  constructor(private db: Database) {}

  async list() {
    return this.db
      .select({
        id: clusters.id,
        name: clusters.name,
        infraContext: clusters.infraContext,
        isTest: clusters.isTest,
        apiServer: clusters.apiServer,
        allowedServers: clusters.allowedServers,
        defaultKubeconfig: clusters.defaultKubeconfig,
        debugImage: clusters.debugImage,
        createdBy: clusters.createdBy,
        createdAt: clusters.createdAt,
        updatedAt: clusters.updatedAt,
      })
      .from(clusters);
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(clusters)
      .where(eq(clusters.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.db
      .select({
        id: clusters.id,
        name: clusters.name,
        infraContext: clusters.infraContext,
        isTest: clusters.isTest,
        apiServer: clusters.apiServer,
        allowedServers: clusters.allowedServers,
        defaultKubeconfig: clusters.defaultKubeconfig,
        debugImage: clusters.debugImage,
        createdBy: clusters.createdBy,
        createdAt: clusters.createdAt,
        updatedAt: clusters.updatedAt,
      })
      .from(clusters)
      .where(inArray(clusters.id, ids));
  }

  async save(
    cluster: { id?: string; name: string; infraContext?: string | null; isTest?: boolean; apiServer: string; allowedServers?: string | null; defaultKubeconfig?: string | null; debugImage?: string | null },
    createdBy?: string,
  ): Promise<string> {
    if (!cluster.apiServer || typeof cluster.apiServer !== "string" || !cluster.apiServer.trim()) {
      throw new Error("apiServer is required and must be a non-empty string");
    }

    if (cluster.id) {
      // Update existing
      const updates: Record<string, unknown> = { name: cluster.name, apiServer: cluster.apiServer };
      if (cluster.infraContext !== undefined) updates.infraContext = cluster.infraContext;
      if (cluster.isTest !== undefined) updates.isTest = cluster.isTest;
      if (cluster.allowedServers !== undefined) updates.allowedServers = cluster.allowedServers;
      if (cluster.defaultKubeconfig !== undefined) updates.defaultKubeconfig = cluster.defaultKubeconfig;
      if (cluster.debugImage !== undefined) updates.debugImage = cluster.debugImage;
      await this.db
        .update(clusters)
        .set(updates)
        .where(eq(clusters.id, cluster.id));
      return cluster.id;
    }

    // Create new
    const id = crypto.randomBytes(12).toString("hex");
    await this.db.insert(clusters).values({
      id,
      name: cluster.name,
      infraContext: cluster.infraContext ?? null,
      isTest: cluster.isTest ?? false,
      apiServer: cluster.apiServer,
      allowedServers: cluster.allowedServers ?? null,
      defaultKubeconfig: cluster.defaultKubeconfig ?? null,
      debugImage: cluster.debugImage ?? null,
      createdBy: createdBy ?? null,
    });
    return id;
  }

  async clearDefaultKubeconfig(clusterId: string): Promise<void> {
    await this.db
      .update(clusters)
      .set({ defaultKubeconfig: null })
      .where(eq(clusters.id, clusterId));
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(clusters)
      .where(eq(clusters.id, id));
  }
}
