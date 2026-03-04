/**
 * Skill Repository — skill metadata CRUD
 */

import crypto from "node:crypto";
import { eq, and, or, sql } from "drizzle-orm";
import type { Database } from "../index.js";
import { skills, userDisabledSkills } from "../schema.js";
import { isUniqueViolation } from "../dialect-helpers.js";

export interface CreateSkillInput {
  name: string;
  description?: string;
  type?: string;
  scope: "builtin" | "team" | "personal";
  authorId?: string;
  dirName: string;
  forkedFromId?: string;
  version?: number;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  type?: string;
  status?: string;
  contributionStatus?: "none" | "pending" | "approved";
  reviewStatus?: "draft" | "pending" | "approved";
  scope?: "builtin" | "team" | "personal";
  dirName?: string;
  publishedVersion?: number | null;
  stagingVersion?: number;
  teamSourceSkillId?: string | null;
  teamPinnedVersion?: number | null;
  forkedFromId?: string | null;
}

export class SkillRepository {
  constructor(private db: Database) {}

  async list(opts?: { scope?: string; authorId?: string }) {
    let query = this.db.select().from(skills);

    if (opts?.scope) {
      query = query.where(eq(skills.scope, opts.scope as any)) as any;
    }
    if (opts?.authorId) {
      query = query.where(eq(skills.authorId, opts.authorId)) as any;
    }

    return query;
  }

  async listForUser(userId: string, opts?: {
    limit?: number;
    offset?: number;
    scope?: "builtin" | "team" | "personal";
    search?: string;
  }) {
    const limit = opts?.limit ?? 30;
    const offset = opts?.offset ?? 0;

    let conditions = or(
      eq(skills.scope, "team"),
      and(eq(skills.scope, "personal"), eq(skills.authorId, userId)),
    );

    // scope filter
    if (opts?.scope) {
      if (opts.scope === "personal") {
        conditions = and(eq(skills.scope, "personal"), eq(skills.authorId, userId));
      } else {
        conditions = eq(skills.scope, opts.scope);
      }
    }

    // search filter — name LIKE '%query%' OR description LIKE '%query%'
    if (opts?.search) {
      const pattern = `%${opts.search}%`;
      conditions = and(
        conditions,
        or(
          sql`${skills.name} LIKE ${pattern}`,
          sql`${skills.description} LIKE ${pattern}`,
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(skills)
      .where(conditions)
      .orderBy(skills.name)
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    return {
      skills: hasMore ? rows.slice(0, limit) : rows,
      hasMore,
    };
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(input: CreateSkillInput) {
    const id = crypto.randomUUID();
    await this.db.insert(skills).values({
      id,
      name: input.name,
      description: input.description ?? null,
      type: input.type ?? "Custom",
      version: input.version ?? 1,
      scope: input.scope,
      authorId: input.authorId ?? null,
      dirName: input.dirName,
      status: "installed",
      contributionStatus: "none",
      forkedFromId: input.forkedFromId ?? null,
    });
    return id;
  }

  async update(id: string, updates: UpdateSkillInput) {
    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setFields.name = updates.name;
    if (updates.description !== undefined)
      setFields.description = updates.description;
    if (updates.type !== undefined) setFields.type = updates.type;
    if (updates.status !== undefined) setFields.status = updates.status;
    if (updates.contributionStatus !== undefined)
      setFields.contributionStatus = updates.contributionStatus;
    if (updates.reviewStatus !== undefined)
      setFields.reviewStatus = updates.reviewStatus;
    if (updates.scope !== undefined) setFields.scope = updates.scope;
    if (updates.dirName !== undefined) setFields.dirName = updates.dirName;
    if (updates.publishedVersion !== undefined) setFields.publishedVersion = updates.publishedVersion;
    if (updates.stagingVersion !== undefined) setFields.stagingVersion = updates.stagingVersion;
    if (updates.teamSourceSkillId !== undefined) setFields.teamSourceSkillId = updates.teamSourceSkillId;
    if (updates.teamPinnedVersion !== undefined) setFields.teamPinnedVersion = updates.teamPinnedVersion;
    if (updates.forkedFromId !== undefined) setFields.forkedFromId = updates.forkedFromId;

    await this.db.update(skills).set(setFields).where(eq(skills.id, id));
  }

  async bumpVersion(id: string) {
    await this.db
      .update(skills)
      .set({
        version: sql`${skills.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, id));
  }

  async bumpStagingVersion(id: string): Promise<number> {
    await this.db
      .update(skills)
      .set({
        stagingVersion: sql`${skills.stagingVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, id));
    const row = await this.getById(id);
    return (row as any)?.stagingVersion ?? 1;
  }

  async listPending(opts?: { limit?: number; offset?: number }) {
    const limit = opts?.limit ?? 30;
    const offset = opts?.offset ?? 0;

    const rows = await this.db
      .select()
      .from(skills)
      .where(
        or(
          eq(skills.reviewStatus, "pending"),
          eq(skills.contributionStatus, "pending"),
        ),
      )
      .orderBy(skills.updatedAt)
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    return {
      skills: hasMore ? rows.slice(0, limit) : rows,
      hasMore,
    };
  }

  async deleteById(id: string) {
    await this.db.delete(skills).where(eq(skills.id, id));
  }

  async getByDirNameAndScope(dirName: string, scope: string) {
    const rows = await this.db
      .select()
      .from(skills)
      .where(and(eq(skills.dirName, dirName), eq(skills.scope, scope as any)))
      .limit(1);
    return rows[0] ?? null;
  }

  // ─── Per-user disabled skills ───────────────────

  async listDisabledSkills(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ skillName: userDisabledSkills.skillName })
      .from(userDisabledSkills)
      .where(eq(userDisabledSkills.userId, userId));
    return rows.map((r) => r.skillName);
  }

  async disableSkill(userId: string, skillName: string): Promise<void> {
    try {
      await this.db
        .insert(userDisabledSkills)
        .values({ userId, skillName });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Already disabled — idempotent no-op
    }
  }

  async enableSkill(userId: string, skillName: string): Promise<void> {
    await this.db
      .delete(userDisabledSkills)
      .where(
        and(
          eq(userDisabledSkills.userId, userId),
          eq(userDisabledSkills.skillName, skillName),
        ),
      );
  }
}
