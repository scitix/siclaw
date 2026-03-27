/**
 * Skill Bundle Builder
 *
 * Builds a SkillBundle for AgentBox consumption.
 * Only includes global + personal + skill-space skills — builtin skills are baked into the AgentBox Docker image.
 */

import crypto from "node:crypto";
import type { SkillFileWriter } from "./file-writer.js";
import type { SkillRepository } from "../db/repositories/skill-repo.js";
import type { SkillContentRepository } from "../db/repositories/skill-content-repo.js";
import type { SkillSpaceRepository } from "../db/repositories/skill-space-repo.js";
import type { WorkspaceSkillComposer } from "../db/repositories/workspace-repo.js";

export interface SkillBundleEntry {
  dirName: string;
  scope: "global" | "personal" | "skillset";
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
 * - Global: from DB (skill_contents table, published tag)
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
  workspaceSkillComposer?: WorkspaceSkillComposer | null,
): Promise<SkillBundle> {
  const skills: SkillBundleEntry[] = [];
  const disabled = disabledSkills ?? new Set<string>();
  const globalSelection = workspaceSkillComposer ? new Set(workspaceSkillComposer.globalSkillRefs) : null;
  const personalSelection = workspaceSkillComposer ? new Set(workspaceSkillComposer.personalSkillIds) : null;
  const skillSpaceSelections = workspaceSkillComposer
    ? new Map(
        workspaceSkillComposer.skillSpaces.map((entry) => [
          entry.skillSpaceId,
          new Set(entry.disabledSkillIds ?? []),
        ]),
      )
    : null;

  // 1. Global skills (from DB)
  const globalSkills = await skillRepo.list({ scope: "global" });
  for (const meta of globalSkills) {
    if (disabled.has(meta.name)) continue;
    if (globalSelection && !globalSelection.has(`global:${meta.id}`)) continue;
    const files = await skillContentRepo.read(meta.id, "published");
    if (!files) continue;
    skills.push({
      dirName: meta.dirName,
      scope: "global",
      specs: files.specs ?? "",
      scripts: files.scripts ?? [],
    });
  }

  // 2. Personal skills (from DB)
  const userSkills = await skillRepo.listForUser(userId, { scope: "personal" });
  for (const meta of userSkills.skills) {
    if (disabled.has(meta.name)) continue;
    if (personalSelection && !personalSelection.has(meta.id)) continue;

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

  // 3. Skill space skills — intentionally dev-only for now.
  //    Skillset skills are working copies that may contain unreviewed changes.
  //    Production bundles only include published global/personal skills.
  //    TODO: Document this constraint in an ADR when skillset→prod promotion is designed.
  if (env === "dev" && skillSpaceRepo) {
    const userSpaces = await skillSpaceRepo.listForUser(userId);
    for (const space of userSpaces) {
      if (skillSpaceSelections && !skillSpaceSelections.has(space.id)) continue;
      const disabledSkillIds = skillSpaceSelections?.get(space.id) ?? new Set<string>();
      const spaceSkills = await skillRepo.listBySkillSpaceId(space.id);
      for (const meta of spaceSkills) {
        if (disabled.has(meta.name)) continue;
        if (disabledSkillIds.has(meta.id)) continue;
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
  const workspaceExcludedBuiltins = globalSelection
    ? skillWriter
        .scanScope("builtin")
        .filter((skill) => !globalSelection.has(`builtin:${skill.dirName}`))
        .map((skill) => skill.name)
    : [];
  const disabledBuiltins = [...new Set([...disabled, ...workspaceExcludedBuiltins])].filter(name => builtinNames.has(name));

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
