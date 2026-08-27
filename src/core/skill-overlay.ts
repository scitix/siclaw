import fs from "node:fs";
import path from "node:path";

export interface DiscoveredSkill {
  name: string;
  filePath?: string;
}

export interface SkillOverlayFilterOptions {
  resolvedDir: string;
  builtinDirs: string[];
  inheritFile: string;
  disabledFile: string;
  portalDir?: string;
}

function disabledNames(filePath: string): Set<string> {
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function inheritsBuiltins(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return true;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) !== false;
  } catch {
    return true;
  }
}

function isWithin(filePath: string, root: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
}

/** Apply the personal-preview precedence rule to model-visible Skills. */
export function filterHarnessSkills<T extends DiscoveredSkill>(
  skills: T[],
  options: SkillOverlayFilterOptions,
): T[] {
  const scoped = skills.filter((skill) => {
    if (!options.portalDir) return true;
    if (!skill.filePath) return false;
    return isWithin(skill.filePath, options.portalDir)
      || options.builtinDirs.some((root) => isWithin(skill.filePath!, root));
  });
  const personalNames = new Set(scoped
    .filter((skill) => skill.filePath && (
      isWithin(skill.filePath, options.resolvedDir)
      || Boolean(options.portalDir && isWithin(skill.filePath, options.portalDir))
    ))
    .map((skill) => skill.name));
  const disabled = disabledNames(path.resolve(options.disabledFile));
  const inherit = inheritsBuiltins(path.resolve(options.inheritFile));
  return scoped.filter((skill) => {
    const isBuiltin = Boolean(skill.filePath
      && options.builtinDirs.some((root) => isWithin(skill.filePath!, root)));
    if (!isBuiltin) return true;
    return inherit && !disabled.has(skill.name) && !personalNames.has(skill.name);
  });
}
