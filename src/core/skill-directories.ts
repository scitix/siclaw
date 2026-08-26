import fs from "node:fs";
import path from "node:path";

export interface ResolveSkillDirectoriesInput {
  cwd: string;
  skillsBase: string;
  /** Authoritative Agent-scoped or Portal-scoped resolved skill directory. */
  scopedSkillsDir?: string;
  includeBundledSkills: boolean;
  includePlatformSkills: boolean;
}

/**
 * Select the skill roots visible to one session.
 *
 * A supplied scopedSkillsDir is authoritative even before it exists. This is
 * important during LocalSpawner cold start: a failed or pending sync must not
 * make the Agent inherit another Agent's process-shared resolved/ tree.
 */
export function resolveSkillDirectories(input: ResolveSkillDirectoriesInput): string[] {
  const resolvedSkillsDir = path.join(input.skillsBase, "resolved");
  const builtinPath = path.resolve(input.cwd, "skills", "core");
  const extensionPath = path.resolve(input.cwd, "skills", "extension");
  const platformPath = path.resolve(input.cwd, "skills", "platform");
  const skillsDirs: string[] = [];

  if (input.scopedSkillsDir !== undefined) {
    if (fs.existsSync(input.scopedSkillsDir)) {
      skillsDirs.push(input.scopedSkillsDir);
    }
  } else if (fs.existsSync(resolvedSkillsDir)) {
    skillsDirs.push(resolvedSkillsDir);
  } else if (input.includeBundledSkills) {
    for (const bundledDir of [builtinPath, extensionPath]) {
      if (fs.existsSync(bundledDir)) skillsDirs.push(bundledDir);
    }
  }

  if (input.includePlatformSkills && fs.existsSync(platformPath)) {
    skillsDirs.push(platformPath);
  }

  return skillsDirs;
}
