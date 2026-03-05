import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig } from "../core/config.js";

function skillsBase(): string {
  const config = loadConfig();
  return path.resolve(process.cwd(), config.paths.skillsDir);
}

/** Builtin skills directory (baked into Docker image at skills/core/) */
function builtinCoreDir(): string {
  return path.resolve(process.cwd(), "skills", "core");
}

/** Load disabled builtins list (written by agentbox startup from bundle API) */
function loadDisabledBuiltins(): Set<string> {
  try {
    const filePath = path.join(skillsBase(), ".disabled-builtins.json");
    if (fs.existsSync(filePath)) {
      return new Set(JSON.parse(fs.readFileSync(filePath, "utf-8")) as string[]);
    }
  } catch { /* ignore malformed file */ }
  return new Set();
}

/**
 * Skill scope directories to search (in priority order, CLI fallback).
 * Higher-specificity scopes first: personal > team > builtin.
 */
const SKILL_SCOPES = ["user", "extension", "team", "core"];

/**
 * Build the list of directories to search for a specific skill's scripts.
 *
 * Priority: personal/team (bundle) > builtin (Docker image).
 * 1. Bundle-materialized (skillsBase/<skill>/) — contains personal or team
 * 2. CLI fallback: scope subdirectories (user > team > core)
 * 3. Builtin fallback (skills/core/) — unless disabled
 */
function getSkillScriptDirs(skill: string): string[] {
  const base = skillsBase();

  // 1. Bundle-materialized skills (personal/team override builtins)
  const directPath = path.join(base, skill, "scripts");
  if (fs.existsSync(directPath)) return [directPath];

  // 2. CLI fallback: search all scope directories (user > team > core)
  const dirs: string[] = [];
  for (const scope of SKILL_SCOPES) {
    const dir = path.join(base, scope, skill, "scripts");
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  if (dirs.length > 0) return dirs;

  // 3. Builtin fallback (skills/core/) — for skills not in the bundle
  const disabled = loadDisabledBuiltins();
  if (!disabled.has(skill)) {
    const builtinPath = path.join(builtinCoreDir(), skill, "scripts");
    if (fs.existsSync(builtinPath)) return [builtinPath];
  }

  return [];
}

/**
 * Build the list of base directories for enumerating all skills.
 *
 * Priority: personal/team (bundle) > builtin (Docker image).
 * Uses seenSkills dedup in callers so first-wins = highest priority.
 */
function getSkillBaseDirs(): string[] {
  const base = skillsBase();

  // 1. Bundle-materialized skills (personal/team first)
  const hasDirectSkills = fs.existsSync(base) && fs.readdirSync(base).some(
    (entry) => !entry.startsWith(".") && !SKILL_SCOPES.includes(entry) &&
      fs.statSync(path.join(base, entry)).isDirectory(),
  );
  if (hasDirectSkills) {
    const dirs = [base];
    // Builtin as fallback for skills not in the bundle
    const coreDir = builtinCoreDir();
    if (fs.existsSync(coreDir)) dirs.push(coreDir);
    return dirs;
  }

  // 2. CLI fallback: search all scope directories (user > team > core)
  return SKILL_SCOPES
    .map((scope) => path.join(base, scope))
    .filter((dir) => fs.existsSync(dir));
}

/** Check if a skill exists in the materialized bundle (personal/team) */
export function skillExistsInBundle(skillName: string): boolean {
  const dir = path.join(skillsBase(), skillName);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

/** Check if a skill exists as a non-disabled builtin (skills/core/) */
export function skillExistsAsBuiltin(skillName: string): boolean {
  const disabled = loadDisabledBuiltins();
  if (disabled.has(skillName)) return false;
  const dir = path.join(builtinCoreDir(), skillName);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

export interface ResolvedScript {
  path: string;
  content: string;
  interpreter: "bash" | "python3";
}

/**
 * Resolve a skill script.
 * Searches the single skills directory (bundle model) or scope dirs (CLI fallback).
 */
export function resolveSkillScript(
  skill: string,
  script: string,
): ResolvedScript | null {
  for (const dir of getSkillScriptDirs(skill)) {
    const scriptPath = path.join(dir, script);
    if (fs.existsSync(scriptPath)) {
      return {
        path: scriptPath,
        content: fs.readFileSync(scriptPath, "utf-8"),
        interpreter: script.endsWith(".py") ? "python3" : "bash",
      };
    }
  }
  return null;
}

/**
 * List available scripts for a given skill.
 */
export function listSkillScripts(skill: string): string[] {
  const scripts = new Set<string>();
  for (const dir of getSkillScriptDirs(skill)) {
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
export function listAllSkillsWithScripts(): Array<{
  skill: string;
  scripts: string[];
}> {
  const result: Array<{ skill: string; scripts: string[] }> = [];
  const seen = new Set<string>();
  const disabled = loadDisabledBuiltins();
  const coreDir = builtinCoreDir();

  for (const base of getSkillBaseDirs()) {
    const isBuiltinDir = base === coreDir;
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.name.startsWith("_")) continue; // skip _lib etc.
        if ((!d.isDirectory() && !d.isSymbolicLink()) || seen.has(d.name))
          continue;
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
 * Unified entry point: resolve a script from skill scripts.
 * Requires a skill name.
 */
export function resolveScript(params: {
  skill?: string;
  script: string;
}): ResolvedScript | { error: string } {
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

  const resolved = resolveSkillScript(skill, script);
  if (!resolved) {
    const available = listSkillScripts(skill);
    if (available.length > 0) {
      return {
        error: `Script "${script}" not found in skill "${skill}". Available: ${available.join(", ")}`,
      };
    }
    const allSkills = listAllSkillsWithScripts();
    let hint = `Skill "${skill}" has no scripts directory.`;
    if (allSkills.length > 0) {
      hint += `\nSkills with scripts: ${allSkills.map((s) => `${s.skill} (${s.scripts.join(", ")})`).join("; ")}`;
    }
    return { error: hint };
  }
  return resolved;
}
