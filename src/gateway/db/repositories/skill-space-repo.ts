/**
 * Skill Space Repository — collaboration space CRUD + member management
 */

import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Database } from "../index.js";
import { skillSpaces, skillSpaceMembers, skills, userDisabledSkillSpaces } from "../schema.js";
import { isUniqueViolation } from "../dialect-helpers.js";

export interface CreateSkillSpaceInput {
  name: string;
  description?: string;
  ownerId: string;
}

export interface UpdateSkillSpaceInput {
  name?: string;
  description?: string;
}

export type SkillSpaceRole = "owner" | "maintainer";

export function normalizeSkillSpaceRole(role?: string | null): SkillSpaceRole {
  return role === "owner" ? "owner" : "maintainer";
}

export class SkillSpaceRepository {
  constructor(private db: Database) {}

  async create(input: CreateSkillSpaceInput): Promise<string> {
    const id = crypto.randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(skillSpaces).values({
          id,
          name: input.name,
          description: input.description ?? null,
          ownerId: input.ownerId,
        });
        // Auto-add owner as member with "owner" role
        await tx.insert(skillSpaceMembers).values({
          id: crypto.randomUUID(),
          skillSpaceId: id,
          userId: input.ownerId,
          role: "owner",
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`A skill space named "${input.name}" already exists`);
      }
      throw err;
    }
    return id;
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(skillSpaces)
      .where(eq(skillSpaces.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async update(id: string, updates: UpdateSkillSpaceInput) {
    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setFields.name = updates.name;
    if (updates.description !== undefined) setFields.description = updates.description;
    await this.db.update(skillSpaces).set(setFields).where(eq(skillSpaces.id, id));
  }

  async deleteById(id: string) {
    await this.db.delete(skillSpaces).where(eq(skillSpaces.id, id));
  }

  /** List all skill spaces a user is a member of */
  async listForUser(userId: string) {
    const rows = await this.db
      .select({
        id: skillSpaces.id,
        name: skillSpaces.name,
        description: skillSpaces.description,
        ownerId: skillSpaces.ownerId,
        createdAt: skillSpaces.createdAt,
        updatedAt: skillSpaces.updatedAt,
        memberRole: skillSpaceMembers.role,
      })
      .from(skillSpaceMembers)
      .innerJoin(skillSpaces, eq(skillSpaceMembers.skillSpaceId, skillSpaces.id))
      .where(eq(skillSpaceMembers.userId, userId));
    return rows.map((row) => ({
      ...row,
      memberRole: normalizeSkillSpaceRole(row.memberRole),
    }));
  }

  // ─── Member management ────────────────────────────

  async addMember(skillSpaceId: string, userId: string, role: string = "maintainer"): Promise<string> {
    const id = crypto.randomUUID();
    try {
      await this.db.insert(skillSpaceMembers).values({
        id,
        skillSpaceId,
        userId,
        role: normalizeSkillSpaceRole(role),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error("User is already a member of this skill space");
      }
      throw err;
    }
    return id;
  }

  async removeMember(skillSpaceId: string, userId: string): Promise<void> {
    await this.db
      .delete(skillSpaceMembers)
      .where(
        and(
          eq(skillSpaceMembers.skillSpaceId, skillSpaceId),
          eq(skillSpaceMembers.userId, userId),
        ),
      );
  }

  async listMembers(skillSpaceId: string) {
    const rows = await this.db
      .select()
      .from(skillSpaceMembers)
      .where(eq(skillSpaceMembers.skillSpaceId, skillSpaceId));
    return rows.map((row) => ({
      ...row,
      role: normalizeSkillSpaceRole(row.role),
    }));
  }

  async getMembership(skillSpaceId: string, userId: string) {
    const rows = await this.db
      .select()
      .from(skillSpaceMembers)
      .where(
        and(
          eq(skillSpaceMembers.skillSpaceId, skillSpaceId),
          eq(skillSpaceMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    return {
      ...rows[0],
      role: normalizeSkillSpaceRole(rows[0].role),
    };
  }

  async isOwner(skillSpaceId: string, userId: string): Promise<boolean> {
    const m = await this.getMembership(skillSpaceId, userId);
    return m?.role === "owner";
  }

  async isMember(skillSpaceId: string, userId: string): Promise<boolean> {
    const m = await this.getMembership(skillSpaceId, userId);
    return m !== null;
  }

  async isMaintainer(skillSpaceId: string, userId: string): Promise<boolean> {
    const m = await this.getMembership(skillSpaceId, userId);
    return m?.role === "owner" || m?.role === "maintainer";
  }

  /** Check if a skill space has any skills (used before deletion) */
  async hasSkills(skillSpaceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.skillSpaceId, skillSpaceId))
      .limit(1);
    return rows.length > 0;
  }

  /** List skills belonging to a skill space */
  async listSkills(skillSpaceId: string) {
    return this.db
      .select()
      .from(skills)
      .where(eq(skills.skillSpaceId, skillSpaceId));
  }

  // ─── Per-user disabled skill spaces ────────────

  async listDisabledSpaces(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ skillSpaceId: userDisabledSkillSpaces.skillSpaceId })
      .from(userDisabledSkillSpaces)
      .where(eq(userDisabledSkillSpaces.userId, userId));
    return rows.map(r => r.skillSpaceId);
  }

  async disableSpace(userId: string, skillSpaceId: string): Promise<void> {
    try {
      await this.db
        .insert(userDisabledSkillSpaces)
        .values({ userId, skillSpaceId });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  async enableSpace(userId: string, skillSpaceId: string): Promise<void> {
    await this.db
      .delete(userDisabledSkillSpaces)
      .where(
        and(
          eq(userDisabledSkillSpaces.userId, userId),
          eq(userDisabledSkillSpaces.skillSpaceId, skillSpaceId),
        ),
      );
  }
}
