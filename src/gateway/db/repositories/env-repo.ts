/**
 * Environment Repository — CRUD for admin-managed environments
 */

import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../index.js";
import { environments } from "../schema.js";

export class EnvironmentRepository {
  constructor(private db: Database) {}

  async list() {
    return this.db
      .select({
        id: environments.id,
        name: environments.name,
        isTest: environments.isTest,
        apiServer: environments.apiServer,
        allowedServers: environments.allowedServers,
        defaultKubeconfig: environments.defaultKubeconfig,
        createdBy: environments.createdBy,
        createdAt: environments.createdAt,
        updatedAt: environments.updatedAt,
      })
      .from(environments);
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(environments)
      .where(eq(environments.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async listByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(environments)
      .where(inArray(environments.id, ids));
  }

  async save(
    env: { id?: string; name: string; isTest?: boolean; apiServer: string; allowedServers?: string | null; defaultKubeconfig?: string | null },
    createdBy?: string,
  ): Promise<string> {
    if (!env.apiServer || typeof env.apiServer !== "string" || !env.apiServer.trim()) {
      throw new Error("apiServer is required and must be a non-empty string");
    }

    if (env.id) {
      // Update existing
      const updates: Record<string, unknown> = { name: env.name, apiServer: env.apiServer };
      if (env.isTest !== undefined) updates.isTest = env.isTest;
      if (env.allowedServers !== undefined) updates.allowedServers = env.allowedServers;
      if (env.defaultKubeconfig !== undefined) updates.defaultKubeconfig = env.defaultKubeconfig;
      await this.db
        .update(environments)
        .set(updates)
        .where(eq(environments.id, env.id));
      return env.id;
    }

    // Create new
    const id = crypto.randomBytes(12).toString("hex");
    await this.db.insert(environments).values({
      id,
      name: env.name,
      isTest: env.isTest ?? false,
      apiServer: env.apiServer,
      allowedServers: env.allowedServers ?? null,
      defaultKubeconfig: env.defaultKubeconfig ?? null,
      createdBy: createdBy ?? null,
    });
    return id;
  }

  async clearDefaultKubeconfig(envId: string): Promise<void> {
    await this.db
      .update(environments)
      .set({ defaultKubeconfig: null })
      .where(eq(environments.id, envId));
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(environments)
      .where(eq(environments.id, id));
  }
}
