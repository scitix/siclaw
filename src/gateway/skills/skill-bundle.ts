/**
 * Skill Bundle Builder
 *
 * Builds a SkillBundle for AgentBox consumption.
 * All scopes (builtin, global, personal, skillset) are read from DB.
 */

import crypto from "node:crypto";
import type { SkillRepository } from "../db/repositories/skill-repo.js";
import type { SkillContentRepository } from "../db/repositories/skill-content-repo.js";
import type { SkillSpaceRepository } from "../db/repositories/skill-space-repo.js";
import type { WorkspaceSkillComposer } from "../db/repositories/workspace-repo.js";

/** Generate a filesystem-safe slug from a skill name (execution chain only) */
export function toSkillDirName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface SkillBundleEntry {
  dirName: string;
  scope: "builtin" | "global" | "personal" | "skillset";
  specs: string;
  scripts: Array<{ name: string; content: string }>;
  skillSpaceId?: string;
}

export interface SkillBundle {
  /** Content hash for cache validation */
  version: string;
  skills: SkillBundleEntry[];
}

/**
 * Build a skill bundle for a given user and environment.
 * All scopes read from DB. Builtin skills synced to DB at startup.
 *
 * Priority (materialize handles override): personal > skillset > global > builtin
 */
export async function buildSkillBundle(
  userId: string,
  env: "prod" | "dev",
  skillRepo: SkillRepository,
  skillContentRepo: SkillContentRepository,
  disabledSkills?: Set<string>,
  skillSpaceRepo?: SkillSpaceRepository,
  workspaceSkillComposer?: WorkspaceSkillComposer | null,
): Promise<SkillBundle> {
  const skills: SkillBundleEntry[] = [];
  const disabled = disabledSkills ?? new Set<string>();
  // Empty array = no filter (include all), only non-empty array = whitelist
  const globalRefs = workspaceSkillComposer?.globalSkillRefs;
  const globalSelection = globalRefs && globalRefs.length > 0 ? new Set(globalRefs) : null;
  const personalIds = workspaceSkillComposer?.personalSkillIds;
  const personalSelection = personalIds && personalIds.length > 0 ? new Set(personalIds) : null;
  const skillSpaceSelections = workspaceSkillComposer
    ? new Map(
        workspaceSkillComposer.skillSpaces.map((entry) => [
          entry.skillSpaceId,
          new Set(entry.disabledSkillIds ?? []),
        ]),
      )
    : null;

  // Priority order: personal > skillset > global > builtin
  // Higher-priority scopes added first so dedup keeps them.

  // 1. Personal skills (highest priority — user's own edits)
  const userSkills = await skillRepo.listForUser(userId, { scope: "personal", limit: 1000 });
  for (const meta of userSkills.skills) {
    if (disabled.has(meta.id)) continue;
    if (personalSelection && !personalSelection.has(meta.id)) continue;

    if (env === "dev") {
      const files = await skillContentRepo.read(meta.id, "working");
      if (!files) continue;
      skills.push({
        dirName: toSkillDirName(meta.name),
        scope: "personal",
        specs: files.specs ?? "",
        scripts: files.scripts ?? [],
      });
    } else {
      const approvedVersion = (meta as any).approvedVersion as number | null;
      if (approvedVersion == null) continue;
      const files = await skillContentRepo.read(meta.id, "approved");
      if (!files) continue;
      skills.push({
        dirName: toSkillDirName(meta.name),
        scope: "personal",
        specs: files.specs ?? "",
        scripts: files.scripts ?? [],
      });
    }
  }

  // 2. Skill space skills
  if (skillSpaceRepo) {
    const userSpaces = await skillSpaceRepo.listForUser(userId);
    const disabledSpaceIds = new Set(await skillSpaceRepo.listDisabledSpaces(userId));
    for (const space of userSpaces) {
      if (disabledSpaceIds.has(space.id)) continue;
      if (skillSpaceSelections && !skillSpaceSelections.has(space.id)) continue;
      const disabledSkillIds = skillSpaceSelections?.get(space.id) ?? new Set<string>();
      const spaceSkills = await skillRepo.listBySkillSpaceId(space.id);
      for (const meta of spaceSkills) {
        if (disabled.has(meta.id)) continue;
        if (disabledSkillIds.has(meta.id)) continue;

        if (env === "prod") {
          const approvedVersion = (meta as any).approvedVersion as number | null;
          if (approvedVersion == null) continue;
          const files = await skillContentRepo.read(meta.id, "approved");
          if (!files) continue;
          skills.push({
            dirName: toSkillDirName(meta.name),
            scope: "skillset",
            specs: files.specs ?? "",
            scripts: files.scripts ?? [],
            skillSpaceId: space.id,
          });
        } else {
          const publishedVersion = (meta as any).publishedVersion as number | null;
          if (publishedVersion == null) continue;
          const files = await skillContentRepo.read(meta.id, "published");
          if (!files) continue;
          skills.push({
            dirName: toSkillDirName(meta.name),
            scope: "skillset",
            specs: files.specs ?? "",
            scripts: files.scripts ?? [],
            skillSpaceId: space.id,
          });
        }
      }
    }
  }

  // 3. Global skills
  const globalSkills = await skillRepo.list({ scope: "global" });
  const globalOriginIds = new Set(globalSkills.map((m: any) => m.originId as string | null).filter(Boolean));
  const globalNames = new Set(globalSkills.map((m: any) => m.name as string));
  for (const meta of globalSkills) {
    if (disabled.has(meta.id)) continue;
    if (globalSelection && !globalSelection.has(`global:${meta.id}`)) continue;
    const files = await skillContentRepo.read(meta.id, "published");
    if (!files) continue;
    skills.push({
      dirName: toSkillDirName(meta.name),
      scope: "global",
      specs: files.specs ?? "",
      scripts: files.scripts ?? [],
    });
  }

  // 4. Builtin skills (lowest priority — skip if overridden by global via originId or name)
  const builtinSkills = await skillRepo.list({ scope: "builtin" });
  for (const meta of builtinSkills) {
    if (disabled.has(meta.id)) continue;
    if (globalOriginIds.has(meta.id) || globalNames.has(meta.name)) continue;
    if (globalSelection && !globalSelection.has(`builtin:${meta.dirName}`)) continue;
    const files = await skillContentRepo.read(meta.id, "published");
    if (!files) continue;
    skills.push({
      dirName: toSkillDirName(meta.name),
      scope: "builtin",
      specs: files.specs ?? "",
      scripts: files.scripts ?? [],
    });
  }

  // Dedup by dirName — higher-priority scopes (added first) win
  const seenDirNames = new Map<string, string>(); // dirName → "scope:name"
  const deduped: typeof skills = [];
  for (const s of skills) {
    const existing = seenDirNames.get(s.dirName);
    if (existing) {
      console.warn(`[skill-bundle] dirName collision: "${s.scope}:${s.dirName}" dropped (kept ${existing})`);
      continue;
    }
    seenDirNames.set(s.dirName, `${s.scope}:${s.dirName}`);
    deduped.push(s);
  }

  // Compute content hash
  const hash = crypto.createHash("sha256");
  for (const s of deduped) {
    hash.update(s.dirName);
    hash.update(s.specs);
    for (const script of [...s.scripts].sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(script.name);
      hash.update(script.content);
    }
  }
  const version = hash.digest("hex").slice(0, 16);

  return { version, skills: deduped };
}
