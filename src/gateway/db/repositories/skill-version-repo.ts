/**
 * Skill Version Repository — immutable version snapshots
 */

import crypto from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../index.js";
import { skillVersions } from "../schema.js";

export type SkillVersionTag = "published" | "approved";

export interface CreateSkillVersionInput {
  skillId: string;
  version: number;
  tag?: SkillVersionTag;
  files?: {
    specs?: string;
    scripts?: string[];
    metadata?: {
      name?: string | null;
      description?: string | null;
      type?: string | null;
      labels?: string[] | null;
    };
  } | null;
  specs?: string;
  scriptsJson?: Array<{ name: string; content: string }>;
  commitMessage?: string;
  authorId?: string;
}

export type SkillVersion = typeof skillVersions.$inferSelect;

export class SkillVersionRepository {
  constructor(private db: Database) {}

  async create(input: CreateSkillVersionInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(skillVersions).values({
      id,
      skillId: input.skillId,
      version: input.version,
      tag: input.tag ?? null,
      files: input.files ?? null,
      specs: input.specs ?? null,
      scriptsJson: input.scriptsJson ?? null,
      commitMessage: input.commitMessage ?? null,
      authorId: input.authorId ?? null,
    });
    return id;
  }

  async getByVersion(skillId: string, version: number): Promise<SkillVersion | null> {
    const rows = await this.db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getLatest(skillId: string): Promise<SkillVersion | null> {
    const rows = await this.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.version))
      .limit(1);
    return rows[0] ?? null;
  }

  async listForSkill(skillId: string, opts?: { tag?: SkillVersionTag; limit?: number }): Promise<SkillVersion[]> {
    const limit = opts?.limit ?? 50;
    const where = opts?.tag
      ? and(eq(skillVersions.skillId, skillId), eq(skillVersions.tag, opts.tag))
      : eq(skillVersions.skillId, skillId);
    return this.db
      .select()
      .from(skillVersions)
      .where(where)
      .orderBy(desc(skillVersions.version))
      .limit(limit);
  }

  async deleteForSkill(skillId: string): Promise<void> {
    await this.db.delete(skillVersions).where(eq(skillVersions.skillId, skillId));
  }
}
