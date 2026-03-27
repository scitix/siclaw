/**
 * Skill Content Repository — stores skill file contents (SKILL.md + scripts) in DB
 *
 * Replaces filesystem-based storage for global and personal skills.
 * BuiltIn skills are still read from Docker image.
 */

import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Database } from "../index.js";
import { skillContents } from "../schema.js";

export type SkillContentTag = "working" | "staging" | "published";

export interface SkillFiles {
  specs?: string;
  scripts?: Array<{ name: string; content: string }>;
}

export class SkillContentRepository {
  constructor(private db: Database) {}

  /** Save/update skill content (upsert by skill_id + tag) */
  async save(skillId: string, tag: SkillContentTag, files: SkillFiles): Promise<void> {
    const id = crypto.randomUUID();
    const specs = files.specs ?? null;
    const scriptsJson = files.scripts ?? null;

    // Try insert, on conflict update
    try {
      await this.db.insert(skillContents).values({
        id,
        skillId,
        tag,
        specs,
        scriptsJson,
      });
    } catch (err: any) {
      // Duplicate key — update instead
      const code = err?.cause?.code || err?.code || "";
      if (code === "ER_DUP_ENTRY" || code === "SQLITE_CONSTRAINT_UNIQUE" || String(err).includes("UNIQUE constraint")) {
        await this.db
          .update(skillContents)
          .set({ specs, scriptsJson, updatedAt: new Date() })
          .where(and(eq(skillContents.skillId, skillId), eq(skillContents.tag, tag)));
      } else {
        throw err;
      }
    }
  }

  /** Read skill content by skill_id + tag */
  async read(skillId: string, tag: SkillContentTag): Promise<SkillFiles | null> {
    const rows = await this.db
      .select()
      .from(skillContents)
      .where(and(eq(skillContents.skillId, skillId), eq(skillContents.tag, tag)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      specs: row.specs ?? undefined,
      scripts: row.scriptsJson ?? undefined,
    };
  }

  /** Delete skill content (specific tag or all tags) */
  async delete(skillId: string, tag?: SkillContentTag): Promise<void> {
    if (tag) {
      await this.db
        .delete(skillContents)
        .where(and(eq(skillContents.skillId, skillId), eq(skillContents.tag, tag)));
    } else {
      // Delete all tags for this skill
      await this.db
        .delete(skillContents)
        .where(eq(skillContents.skillId, skillId));
    }
  }

  /** Copy content from one tag to another (snapshot) */
  async copy(skillId: string, fromTag: SkillContentTag, toTag: SkillContentTag): Promise<void> {
    const source = await this.read(skillId, fromTag);
    if (!source) {
      throw new Error(`No ${fromTag} content found for skill ${skillId}`);
    }
    await this.save(skillId, toTag, source);
  }

  /** Copy content to another skill (global contribution) */
  async copyToSkill(
    srcSkillId: string,
    destSkillId: string,
    fromTag: SkillContentTag,
    toTag: SkillContentTag,
  ): Promise<void> {
    const source = await this.read(srcSkillId, fromTag);
    if (!source) {
      throw new Error(`No ${fromTag} content found for skill ${srcSkillId}`);
    }
    await this.save(destSkillId, toTag, source);
  }
}
