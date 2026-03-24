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
  workspaceClusters,
  workspaceCredentials,
} from "../schema.js";

export type Workspace = typeof workspaces.$inferSelect;
export interface WorkspaceSkillComposer {
  globalSkillRefs: string[];
  personalSkillIds: string[];
  skillSpaces: Array<{
    skillSpaceId: string;
    disabledSkillIds: string[];
  }>;
}

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

  async getOrCreateDefault(userId: string, envType?: string): Promise<Workspace> {
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
      envType: envType ?? "prod",
    });

    const created = await this.getById(id);
    return created!;
  }

  async create(
    userId: string,
    name: string,
    configJson?: Workspace["configJson"],
    envType?: string,
  ): Promise<Workspace> {
    const id = crypto.randomUUID();
    await this.db.insert(workspaces).values({
      id,
      userId,
      name,
      isDefault: false,
      envType: envType ?? "prod",
      configJson: configJson ?? null,
    });
    return (await this.getById(id))!;
  }

  async update(
    id: string,
    data: { name?: string; configJson?: Workspace["configJson"]; envType?: string },
  ): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.configJson !== undefined) updates.configJson = data.configJson;
    if (data.envType !== undefined) updates.envType = data.envType;
    if (Object.keys(updates).length === 0) return;
    updates.updatedAt = new Date();

    await this.db
      .update(workspaces)
      .set(updates)
      .where(eq(workspaces.id, id));
  }

  async getSkillComposer(workspaceId: string): Promise<WorkspaceSkillComposer | null> {
    const ws = await this.getById(workspaceId);
    const composer = ws?.configJson?.skillComposer as WorkspaceSkillComposer | undefined;
    if (!composer) return null;
    return {
      globalSkillRefs: Array.isArray(composer.globalSkillRefs) ? [...new Set(composer.globalSkillRefs.filter(Boolean))] : [],
      personalSkillIds: Array.isArray(composer.personalSkillIds) ? [...new Set(composer.personalSkillIds.filter(Boolean))] : [],
      skillSpaces: Array.isArray(composer.skillSpaces)
        ? composer.skillSpaces
            .filter((entry) => entry && typeof entry.skillSpaceId === "string" && entry.skillSpaceId)
            .map((entry) => ({
              skillSpaceId: entry.skillSpaceId,
              disabledSkillIds: Array.isArray(entry.disabledSkillIds)
                ? [...new Set(entry.disabledSkillIds.filter(Boolean))]
                : [],
            }))
        : [],
    };
  }

  async setSkillComposer(workspaceId: string, composer: WorkspaceSkillComposer): Promise<void> {
    const ws = await this.getById(workspaceId);
    if (!ws) throw new Error("Workspace not found");
    const nextConfig = {
      ...(ws.configJson ?? {}),
      skillComposer: {
        globalSkillRefs: [...new Set(composer.globalSkillRefs.filter(Boolean))],
        personalSkillIds: [...new Set(composer.personalSkillIds.filter(Boolean))],
        skillSpaces: composer.skillSpaces
          .filter((entry) => entry.skillSpaceId)
          .map((entry) => ({
            skillSpaceId: entry.skillSpaceId,
            disabledSkillIds: [...new Set((entry.disabledSkillIds ?? []).filter(Boolean))],
          })),
      },
    };
    await this.update(workspaceId, { configJson: nextConfig });
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

  // ─── Allow-list: Clusters ────────────────────────

  async getClusters(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ clusterId: workspaceClusters.clusterId })
      .from(workspaceClusters)
      .where(eq(workspaceClusters.workspaceId, workspaceId));
    return rows.map((r) => r.clusterId);
  }

  async setClusters(
    workspaceId: string,
    clusterIds: string[],
  ): Promise<void> {
    await this.db
      .delete(workspaceClusters)
      .where(eq(workspaceClusters.workspaceId, workspaceId));
    if (clusterIds.length > 0) {
      await this.db.insert(workspaceClusters).values(
        clusterIds.map((clusterId) => ({ workspaceId, clusterId })),
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
