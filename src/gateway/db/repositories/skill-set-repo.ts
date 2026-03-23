/**
 * Skill Set Repository — collaboration space CRUD + member management
 */

import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Database } from "../index.js";
import { skillSets, skillSetMembers, skills } from "../schema.js";
import { isUniqueViolation } from "../dialect-helpers.js";

export interface CreateSkillSetInput {
  name: string;
  description?: string;
  ownerId: string;
}

export interface UpdateSkillSetInput {
  name?: string;
  description?: string;
  inviteToken?: string | null;
}

export class SkillSetRepository {
  constructor(private db: Database) {}

  async create(input: CreateSkillSetInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(skillSets).values({
      id,
      name: input.name,
      description: input.description ?? null,
      ownerId: input.ownerId,
    });
    // Auto-add owner as member with "owner" role
    await this.db.insert(skillSetMembers).values({
      id: crypto.randomUUID(),
      skillSetId: id,
      userId: input.ownerId,
      role: "owner",
    });
    return id;
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(skillSets)
      .where(eq(skillSets.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async update(id: string, updates: UpdateSkillSetInput) {
    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setFields.name = updates.name;
    if (updates.description !== undefined) setFields.description = updates.description;
    if (updates.inviteToken !== undefined) setFields.inviteToken = updates.inviteToken;
    await this.db.update(skillSets).set(setFields).where(eq(skillSets.id, id));
  }

  async getByInviteToken(token: string) {
    const rows = await this.db
      .select()
      .from(skillSets)
      .where(eq(skillSets.inviteToken, token))
      .limit(1);
    return rows[0] ?? null;
  }

  async deleteById(id: string) {
    await this.db.delete(skillSets).where(eq(skillSets.id, id));
  }

  /** List all skill sets a user is a member of */
  async listForUser(userId: string) {
    const rows = await this.db
      .select({
        id: skillSets.id,
        name: skillSets.name,
        description: skillSets.description,
        ownerId: skillSets.ownerId,
        createdAt: skillSets.createdAt,
        updatedAt: skillSets.updatedAt,
        memberRole: skillSetMembers.role,
      })
      .from(skillSetMembers)
      .innerJoin(skillSets, eq(skillSetMembers.skillSetId, skillSets.id))
      .where(eq(skillSetMembers.userId, userId));
    return rows;
  }

  // ─── Member management ────────────────────────────

  async addMember(skillSetId: string, userId: string, role: string = "member"): Promise<string> {
    const id = crypto.randomUUID();
    try {
      await this.db.insert(skillSetMembers).values({
        id,
        skillSetId,
        userId,
        role,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error("User is already a member of this skill set");
      }
      throw err;
    }
    return id;
  }

  async removeMember(skillSetId: string, userId: string): Promise<void> {
    await this.db
      .delete(skillSetMembers)
      .where(
        and(
          eq(skillSetMembers.skillSetId, skillSetId),
          eq(skillSetMembers.userId, userId),
        ),
      );
  }

  async listMembers(skillSetId: string) {
    return this.db
      .select()
      .from(skillSetMembers)
      .where(eq(skillSetMembers.skillSetId, skillSetId));
  }

  async getMembership(skillSetId: string, userId: string) {
    const rows = await this.db
      .select()
      .from(skillSetMembers)
      .where(
        and(
          eq(skillSetMembers.skillSetId, skillSetId),
          eq(skillSetMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async isOwner(skillSetId: string, userId: string): Promise<boolean> {
    const m = await this.getMembership(skillSetId, userId);
    return m?.role === "owner";
  }

  async isMember(skillSetId: string, userId: string): Promise<boolean> {
    const m = await this.getMembership(skillSetId, userId);
    return m !== null;
  }

  /** Check if a skill set has any skills (used before deletion) */
  async hasSkills(skillSetId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.skillSetId, skillSetId))
      .limit(1);
    return rows.length > 0;
  }

  /** List skills belonging to a skill set */
  async listSkills(skillSetId: string) {
    return this.db
      .select()
      .from(skills)
      .where(eq(skills.skillSetId, skillSetId));
  }
}
