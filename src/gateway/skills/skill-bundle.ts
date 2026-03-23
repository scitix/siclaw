/**
 * Skill Bundle Builder
 *
 * Builds a SkillBundle for AgentBox consumption.
 * Only includes team + personal + skill-space skills — builtin skills are baked into the AgentBox Docker image.
 */

import crypto from "node:crypto";
import type { SkillFileWriter } from "./file-writer.js";
import type { SkillRepository } from "../db/repositories/skill-repo.js";
import type { SkillContentRepository } from "../db/repositories/skill-content-repo.js";
import type { SkillSpaceRepository } from "../db/repositories/skill-space-repo.js";

export interface SkillBundleEntry {
  dirName: string;
  scope: "team" | "personal" | "skillset";
  specs: string;
  scripts: Array<{ name: string; content: string }>;
  skillSpaceId?: string;
}

export interface SkillBundle {
  /** Content hash for cache validation */
  version: string;
  skills: SkillBundleEntry[];
  /** Builtin skill names the user has disabled (AgentBox removes these from baked-in skills) */
  disabledBuiltins: string[];
}

/**
 * Build a skill bundle for a given user and environment.
 *
 * - Team: from DB (skill_contents table, published tag)
 * - Personal:
 *   - env="dev"  → all personal skills (working copy)
 *   - env="prod" → only approved skills (published copy)
 */
export async function buildSkillBundle(
  userId: string,
  env: "prod" | "dev",
  skillWriter: SkillFileWriter,
  skillRepo: SkillRepository,
  skillContentRepo: SkillContentRepository,
  disabledSkills?: Set<string>,
  skillSpaceRepo?: SkillSpaceRepository,
): Promise<SkillBundle> {
  const skills: SkillBundleEntry[] = [];
  const disabled = disabledSkills ?? new Set<string>();

  // 1. Team skills (from DB)
  const teamSkills = await skillRepo.list({ scope: "team" });
  for (const meta of teamSkills) {
    if (disabled.has(meta.name)) continue;
    const files = await skillContentRepo.read(meta.id, "published");
    if (!files) continue;
    skills.push({
      dirName: meta.dirName,
      scope: "team",
      specs: files.specs ?? "",
      scripts: files.scripts ?? [],
    });
  }

  // 2. Personal skills (from DB)
  const userSkills = await skillRepo.listForUser(userId, { scope: "personal" });
  for (const meta of userSkills.skills) {
    if (disabled.has(meta.name)) continue;

    if (env === "dev") {
      const files = await skillContentRepo.read(meta.id, "working");
      if (!files) continue;
      skills.push({
        dirName: meta.dirName,
        scope: "personal",
        specs: files.specs ?? "",
        scripts: files.scripts ?? [],
      });
    } else {
      const reviewStatus = (meta as any).reviewStatus as string;
      if (reviewStatus !== "approved") continue;
      const files = await skillContentRepo.read(meta.id, "published");
      if (!files) continue;
      skills.push({
        dirName: meta.dirName,
        scope: "personal",
        specs: files.specs ?? "",
        scripts: files.scripts ?? [],
      });
    }
  }

  // 3. Skill space skills are only exposed in dev/test bundles.
  if (env === "dev" && skillSpaceRepo) {
    const userSpaces = await skillSpaceRepo.listForUser(userId);
    for (const space of userSpaces) {
      const spaceSkills = await skillRepo.listBySkillSpaceId(space.id);
      for (const meta of spaceSkills) {
        if (disabled.has(meta.name)) continue;
        const files = await skillContentRepo.read(meta.id, "working");
        if (!files) continue;
        skills.push({
          dirName: meta.dirName,
          scope: "skillset",
          specs: files.specs ?? "",
          scripts: files.scripts ?? [],
          skillSpaceId: space.id,
        });
      }
    }
  }

  // Disabled builtin names for AgentBox to remove from baked-in skills
  const builtinNames = new Set(skillWriter.scanScope("builtin").map(s => s.name));
  const disabledBuiltins = [...disabled].filter(name => builtinNames.has(name));

  // Compute content hash
  const hash = crypto.createHash("sha256");
  for (const s of skills) {
    hash.update(s.dirName);
    hash.update(s.specs);
    for (const script of s.scripts) {
      hash.update(script.name);
      hash.update(script.content);
    }
  }
  for (const name of disabledBuiltins) hash.update(`disabled:${name}`);
  const version = hash.digest("hex").slice(0, 16);

  return { version, skills, disabledBuiltins };
}
