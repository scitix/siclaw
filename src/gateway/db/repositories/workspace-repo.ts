/**
 * Workspace Repository — CRUD for workspaces and their allow-lists
 */

import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Database } from "../index.js";
import {
  workspaces,
  workspaceSkills,
  workspaceTools,
  workspaceEnvironments,
  workspaceCredentials,
} from "../schema.js";

export type Workspace = typeof workspaces.$inferSelect;

export class WorkspaceRepository {
  constructor(private db: Database) {}

  async list(userId: string): Promise<Workspace[]> {
    return this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, userId));
  }

  async getById(id: string): Promise<Workspace | null> {
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getOrCreateDefault(userId: string): Promise<Workspace> {
    // Check if default workspace exists
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.isDefault, true)))
      .limit(1);
    if (rows[0]) return rows[0];

    // Create default workspace
    const id = crypto.randomUUID();
    await this.db.insert(workspaces).values({
      id,
      userId,
      name: "Default",
      isDefault: true,
    });

    const created = await this.getById(id);
    return created!;
  }

  async create(
    userId: string,
    name: string,
    configJson?: Workspace["configJson"],
  ): Promise<Workspace> {
    const id = crypto.randomUUID();
    await this.db.insert(workspaces).values({
      id,
      userId,
      name,
      isDefault: false,
      configJson: configJson ?? null,
    });
    return (await this.getById(id))!;
  }

  async update(
    id: string,
    data: { name?: string; configJson?: Workspace["configJson"] },
  ): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.configJson !== undefined) updates.configJson = data.configJson;
    if (Object.keys(updates).length === 0) return;
    updates.updatedAt = new Date();

    await this.db
      .update(workspaces)
      .set(updates)
      .where(eq(workspaces.id, id));
  }

  async delete(id: string): Promise<void> {
    // Prevent deleting default workspace
    const ws = await this.getById(id);
    if (!ws) throw new Error("Workspace not found");
    if (ws.isDefault) throw new Error("Cannot delete default workspace");

    await this.db.delete(workspaces).where(eq(workspaces.id, id));
  }

  // ─── Allow-list: Skills ───────────────────────────

  async getSkills(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ skillName: workspaceSkills.skillName })
      .from(workspaceSkills)
      .where(eq(workspaceSkills.workspaceId, workspaceId));
    return rows.map((r) => r.skillName);
  }

  async setSkills(workspaceId: string, skillNames: string[]): Promise<void> {
    await this.db
      .delete(workspaceSkills)
      .where(eq(workspaceSkills.workspaceId, workspaceId));
    if (skillNames.length > 0) {
      await this.db.insert(workspaceSkills).values(
        skillNames.map((name) => ({ workspaceId, skillName: name })),
      );
    }
  }

  // ─── Allow-list: Tools ────────────────────────────

  async getTools(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ toolName: workspaceTools.toolName })
      .from(workspaceTools)
      .where(eq(workspaceTools.workspaceId, workspaceId));
    return rows.map((r) => r.toolName);
  }

  async setTools(workspaceId: string, toolNames: string[]): Promise<void> {
    await this.db
      .delete(workspaceTools)
      .where(eq(workspaceTools.workspaceId, workspaceId));
    if (toolNames.length > 0) {
      await this.db.insert(workspaceTools).values(
        toolNames.map((name) => ({ workspaceId, toolName: name })),
      );
    }
  }

  // ─── Allow-list: Environments ─────────────────────

  async getEnvironments(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ envId: workspaceEnvironments.envId })
      .from(workspaceEnvironments)
      .where(eq(workspaceEnvironments.workspaceId, workspaceId));
    return rows.map((r) => r.envId);
  }

  async setEnvironments(
    workspaceId: string,
    envIds: string[],
  ): Promise<void> {
    await this.db
      .delete(workspaceEnvironments)
      .where(eq(workspaceEnvironments.workspaceId, workspaceId));
    if (envIds.length > 0) {
      await this.db.insert(workspaceEnvironments).values(
        envIds.map((envId) => ({ workspaceId, envId })),
      );
    }
  }

  // ─── Allow-list: Credentials ──────────────────────

  async getCredentials(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ credentialId: workspaceCredentials.credentialId })
      .from(workspaceCredentials)
      .where(eq(workspaceCredentials.workspaceId, workspaceId));
    return rows.map((r) => r.credentialId);
  }

  async setCredentials(
    workspaceId: string,
    credentialIds: string[],
  ): Promise<void> {
    await this.db
      .delete(workspaceCredentials)
      .where(eq(workspaceCredentials.workspaceId, workspaceId));
    if (credentialIds.length > 0) {
      await this.db.insert(workspaceCredentials).values(
        credentialIds.map((credentialId) => ({ workspaceId, credentialId })),
      );
    }
  }
}
