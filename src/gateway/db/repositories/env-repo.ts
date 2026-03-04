/**
 * Environment Repository — CRUD for admin-managed environments
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
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

  async save(
    env: { id?: string; name: string; isTest?: boolean; allowedServers?: string | null; defaultKubeconfig?: string | null },
    createdBy?: string,
  ): Promise<string> {
    if (env.id) {
      // Update existing
      const updates: Record<string, unknown> = { name: env.name };
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
