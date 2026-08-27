import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig } from "../../core/config.js";

export interface SkillScriptResolverOptions {
  /** Session-owned Skill root containing policy files and legacy scope dirs. */
  skillsBaseDir?: string;
  /** Exact materialized Skill directory. LocalSpawner passes <agent>/resolved. */
  resolvedSkillsDir?: string;
  /** Image Built-in roots. Primarily injectable for tests. */
  builtinDirs?: string[];
}

export interface SkillScriptResolver {
  resolveScript(params: { skill?: string; script: string }): ResolvedScript | { error: string };
  resolveSkillScript(skill: string, script: string): ResolvedScript | null;
  listSkillScripts(skill: string): string[];
  listAllSkillsWithScripts(): Array<{ skill: string; scripts: string[] }>;
  skillExistsInBundle(skillName: string): boolean;
  skillExistsAsBuiltin(skillName: string): boolean;
  readSkillMd(skill: string, maxChars?: number): string | null;
  skillMdHint(skill: string): string;
}

function skillsBase(options: SkillScriptResolverOptions = {}): string {
  if (options.skillsBaseDir) return path.resolve(options.skillsBaseDir);
  const config = loadConfig();
  return path.resolve(process.cwd(), config.paths.skillsDir);
}

function resolvedSkillsDir(options: SkillScriptResolverOptions = {}): string {
  return path.resolve(options.resolvedSkillsDir ?? path.join(skillsBase(options), "resolved"));
}

/** Builtin skills directories (baked into Docker image at skills/core/ and skills/extension/) */
const BUILTIN_TIERS = ["core", "extension"] as const;

function builtinDirs(options: SkillScriptResolverOptions = {}): string[] {
  if (options.builtinDirs) return options.builtinDirs.map((dir) => path.resolve(dir));
  return BUILTIN_TIERS.map(t => path.resolve(process.cwd(), "skills", t));
}

/** Load disabled builtins list (written by agentbox startup from bundle API) */
function loadDisabledBuiltins(options: SkillScriptResolverOptions = {}): Set<string> {
  try {
    const filePath = path.join(skillsBase(options), ".disabled-builtins.json");
    if (fs.existsSync(filePath)) {
      return new Set(JSON.parse(fs.readFileSync(filePath, "utf-8")) as string[]);
    }
  } catch { /* ignore malformed file */ }
  return new Set();
}

/** Default-on preview policy written beside the materialized Skill bundle. */
function loadInheritBuiltins(options: SkillScriptResolverOptions = {}): boolean {
  try {
    const filePath = path.join(skillsBase(options), ".inherit-builtins.json");
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) !== false;
    }
  } catch { /* keep the backward-compatible default */ }
  return true;
}

/**
 * Skill scope directories to search (in priority order, CLI fallback).
 * Higher-specificity scopes first: global > builtin.
 */
const SKILL_SCOPES = ["extension", "global", "core"];

/** Directory entry with associated scope */
interface ScopeDir {
  dir: string;
  scope: SkillScope;
}

/** Map scope directory names to SkillScope values */
const SCOPE_MAP: Record<string, SkillScope> = {
  extension: "builtin",
  global: "global",
  core: "builtin",
};

/**
 * Build the list of directories to search for a specific skill's scripts.
 *
 * Priority: global (bundle) > builtin (Docker image).
 * 1. Bundle-materialized resolved/ directory (built by materialize with priority merging)
 * 2. Legacy flat layout (bundle-materialized without scope subdirs)
 * 3. Scope subdirectories (extension > global > core)
 * 4. Builtin fallback (skills/core/) — unless disabled
 */
function getSkillScriptDirs(skill: string, options: SkillScriptResolverOptions = {}): ScopeDir[] {
  const base = skillsBase(options);
  const inheritBuiltins = loadInheritBuiltins(options);
  const disabled = loadDisabledBuiltins(options);

  // 1. Unified resolved/ directory (built by materialize with priority merging)
  // K8s mode: {base}/resolved/{skill}/scripts
  const resolvedPath = path.join(resolvedSkillsDir(options), skill, "scripts");
  if (fs.existsSync(resolvedPath)) return [{ dir: resolvedPath, scope: "global" }];

  // 2. Legacy flat layout (bundle-materialized without scope subdirs)
  const directPath = path.join(base, skill, "scripts");
  if (fs.existsSync(directPath)) return [{ dir: directPath, scope: "global" }];

  // 3. Scope subdirectories (extension > global > core)
  const dirs: ScopeDir[] = [];
  for (const scopeName of SKILL_SCOPES) {
    if (SCOPE_MAP[scopeName] === "builtin" && (!inheritBuiltins || disabled.has(skill))) continue;
    const dir = path.join(base, scopeName, skill, "scripts");
    if (fs.existsSync(dir)) dirs.push({ dir, scope: SCOPE_MAP[scopeName] });
  }
  if (dirs.length > 0) return dirs;

  // 4. Builtin fallback (skills/{core,extension}/) — for skills not in the bundle
  if (inheritBuiltins && !disabled.has(skill)) {
    for (const bDir of builtinDirs(options)) {
      const builtinPath = path.join(bDir, skill, "scripts");
      if (fs.existsSync(builtinPath)) return [{ dir: builtinPath, scope: "builtin" }];
    }
  }

  return [];
}

/**
 * Build the list of base directories for enumerating all skills.
 *
 * Priority: global (bundle) > builtin (Docker image).
 * Uses seenSkills dedup in callers so first-wins = highest priority.
 */
function getSkillBaseDirs(options: SkillScriptResolverOptions = {}): string[] {
  const base = skillsBase(options);
  const inheritBuiltins = loadInheritBuiltins(options);
  const resolvedDir = resolvedSkillsDir(options);

  const dirs: string[] = [];
  if (fs.existsSync(resolvedDir)) dirs.push(resolvedDir);

  // 1. Legacy flat layout (bundle-materialized without scope subdirs)
  const hasDirectSkills = fs.existsSync(base) && fs.readdirSync(base).some(
    (entry) => entry !== path.basename(resolvedDir) && !entry.startsWith(".") && !SKILL_SCOPES.includes(entry) &&
      fs.statSync(path.join(base, entry)).isDirectory(),
  );
  if (hasDirectSkills) {
    dirs.push(base);
  }

  // 2. Scope subdirectories (extension > global > core)
  for (const scope of SKILL_SCOPES) {
    if (!inheritBuiltins && SCOPE_MAP[scope] === "builtin") continue;
    const dir = path.join(base, scope);
    if (fs.existsSync(dir)) dirs.push(dir);
  }

  // 3. Builtin fallback (skills/{core,extension}/ from Docker image)
  if (inheritBuiltins) {
    for (const bDir of builtinDirs(options)) {
      if (fs.existsSync(bDir) && !dirs.includes(bDir)) dirs.push(bDir);
    }
  }

  return dirs;
}

/** Check if a skill exists in the materialized bundle (global/builtin) */
export function skillExistsInBundle(skillName: string, options: SkillScriptResolverOptions = {}): boolean {
  const base = skillsBase(options);
  const resolvedDir = path.join(resolvedSkillsDir(options), skillName);
  if (fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory()) return true;
  // Legacy flat layout
  const directDir = path.join(base, skillName);
  if (fs.existsSync(directDir) && fs.statSync(directDir).isDirectory()) return true;
  // Personal/global scope remains available when inherited resources are off.
  const globalDir = path.join(base, "global", skillName);
  if (fs.existsSync(globalDir) && fs.statSync(globalDir).isDirectory()) return true;
  if (!loadInheritBuiltins(options) || loadDisabledBuiltins(options).has(skillName)) return false;
  const extensionDir = path.join(base, "extension", skillName);
  if (fs.existsSync(extensionDir) && fs.statSync(extensionDir).isDirectory()) return true;
  return false;
}

/** Check if a skill exists as a non-disabled builtin (skills/{core,extension}/) */
export function skillExistsAsBuiltin(skillName: string, options: SkillScriptResolverOptions = {}): boolean {
  if (!loadInheritBuiltins(options)) return false;
  const disabled = loadDisabledBuiltins(options);
  if (disabled.has(skillName)) return false;
  for (const bDir of builtinDirs(options)) {
    const dir = path.join(bDir, skillName);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return true;
  }
  return false;
}

export type SkillScope = "builtin" | "global";

export interface ResolvedScript {
  path: string;
  content: string;
  interpreter: "bash" | "python3";
  scope: SkillScope;
}

/**
 * Resolve a skill script.
 * Searches the single skills directory (bundle model) or scope dirs (CLI fallback).
 */
export function resolveSkillScript(
  skill: string,
  script: string,
  options: SkillScriptResolverOptions = {},
): ResolvedScript | null {
  for (const { dir, scope } of getSkillScriptDirs(skill, options)) {
    const scriptPath = path.join(dir, script);
    if (fs.existsSync(scriptPath)) {
      return {
        path: scriptPath,
        content: fs.readFileSync(scriptPath, "utf-8"),
        interpreter: script.endsWith(".py") ? "python3" : "bash",
        scope,
      };
    }
  }
  return null;
}

/**
 * List available scripts for a given skill.
 */
export function listSkillScripts(skill: string, options: SkillScriptResolverOptions = {}): string[] {
  const scripts = new Set<string>();
  for (const { dir } of getSkillScriptDirs(skill, options)) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".sh") || f.endsWith(".py")) scripts.add(f);
      }
    } catch {
      /* dir may not exist */
    }
  }
  return [...scripts];
}

/**
 * List all skills that have scripts.
 */
export function listAllSkillsWithScripts(options: SkillScriptResolverOptions = {}): Array<{
  skill: string;
  scripts: string[];
}> {
  const result: Array<{ skill: string; scripts: string[] }> = [];
  const seen = new Set<string>();
  const disabled = loadDisabledBuiltins(options);
  const base = skillsBase(options);
  const builtinSet = new Set([
    ...builtinDirs(options),
    path.join(base, "extension"),
    path.join(base, "core"),
  ]);

  for (const base of getSkillBaseDirs(options)) {
    const isBuiltinDir = builtinSet.has(base);
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.name.startsWith("_")) continue; // skip _lib etc.
        if (seen.has(d.name)) continue;
        // Check if entry is a directory (for symlinks, stat the target)
        let isDir = d.isDirectory();
        if (!isDir && d.isSymbolicLink()) {
          try {
            isDir = fs.statSync(path.join(base, d.name)).isDirectory();
          } catch { /* broken symlink */ }
        }
        if (!isDir) continue;
        // Skip disabled builtins so they don't shadow bundle overrides
        if (isBuiltinDir && disabled.has(d.name)) continue;
        const scriptsDir = path.join(base, d.name, "scripts");
        try {
          const scripts = fs
            .readdirSync(scriptsDir)
            .filter((f) => f.endsWith(".sh") || f.endsWith(".py"));
          if (scripts.length > 0) {
            seen.add(d.name);
            result.push({ skill: d.name, scripts });
          }
        } catch {
          /* no scripts dir */
        }
      }
    } catch {
      /* dir doesn't exist */
    }
  }

  return result;
}

/**
 * Read a skill's SKILL.md (the file beside its scripts/ dir), truncated. Returned
 * verbatim so a "script not found" error can hand the model the skill's real
 * instructions — exact script names + usage — instead of letting it guess again.
 * Returns null when the skill has no readable SKILL.md.
 */
export function readSkillMd(
  skill: string,
  maxChars = 6000,
  options: SkillScriptResolverOptions = {},
): string | null {
  for (const { dir } of getSkillScriptDirs(skill, options)) {
    try {
      const md = fs.readFileSync(path.join(path.dirname(dir), "SKILL.md"), "utf-8");
      return md.length > maxChars ? `${md.slice(0, maxChars)}\n…[SKILL.md truncated]` : md;
    } catch {
      /* no SKILL.md in this dir — try the next */
    }
  }
  return null;
}

/** Suffix appended to a "script not found" error: the skill's SKILL.md, if any. */
export function skillMdHint(skill: string, options: SkillScriptResolverOptions = {}): string {
  const md = readSkillMd(skill, 6000, options);
  return md
    ? `\n\n--- SKILL.md for "${skill}" (use the exact script name and usage from here, do not guess) ---\n${md}`
    : "";
}

/**
 * Unified entry point: resolve a script from skill scripts.
 * Requires a skill name.
 */
export function resolveScript(params: {
  skill?: string;
  script: string;
}, options: SkillScriptResolverOptions = {}): ResolvedScript | { error: string } {
  const script = params.script?.trim();
  if (!script) {
    return { error: "Script name is required." };
  }

  if (
    script.includes("/") ||
    script.includes("\\")
  ) {
    return {
      error: "Script name must not contain path separators.",
    };
  }

  const skill = params.skill?.trim();
  if (!skill) {
    return { error: "Skill name is required." };
  }
  if (skill.includes("/") || skill.includes("\\")) {
    return {
      error: "Skill name must not contain path separators.",
    };
  }

  const resolved = resolveSkillScript(skill, script, options);
  if (!resolved) {
    const available = listSkillScripts(skill, options);
    if (available.length > 0) {
      return {
        error: `Script "${script}" not found in skill "${skill}". Available: ${available.join(", ")}${skillMdHint(skill, options)}`,
      };
    }
    const allSkills = listAllSkillsWithScripts(options);
    let hint = `Skill "${skill}" has no scripts directory.`;
    if (allSkills.length > 0) {
      hint += `\nSkills with scripts: ${allSkills.map((s) => `${s.skill} (${s.scripts.join(", ")})`).join("; ")}`;
    }
    return { error: hint };
  }
  return resolved;
}

/** Bind script lookup to one Session's materialized Skill and policy roots. */
export function createSkillScriptResolver(options: SkillScriptResolverOptions = {}): SkillScriptResolver {
  return {
    resolveScript: (params) => resolveScript(params, options),
    resolveSkillScript: (skill, script) => resolveSkillScript(skill, script, options),
    listSkillScripts: (skill) => listSkillScripts(skill, options),
    listAllSkillsWithScripts: () => listAllSkillsWithScripts(options),
    skillExistsInBundle: (skillName) => skillExistsInBundle(skillName, options),
    skillExistsAsBuiltin: (skillName) => skillExistsAsBuiltin(skillName, options),
    readSkillMd: (skill, maxChars) => readSkillMd(skill, maxChars, options),
    skillMdHint: (skill) => skillMdHint(skill, options),
  };
}
