import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig } from "../core/config.js";

function skillsBase(): string {
  const config = loadConfig();
  return path.resolve(process.cwd(), config.paths.skillsDir);
}

/** Skill scope directories to search (in priority order) */
const SKILL_SCOPES = ["core", "team", "extension", "user"];

/** Resolve the active skills directory name based on isTestEnv */
function activeDir(isTestEnv?: boolean): string {
  return isTestEnv ? ".skills-dev" : ".skills-prod";
}

/**
 * Build the list of directories to search for a specific skill's scripts.
 * Prefers .skills-prod/ or .skills-dev/ (gateway mode); falls back to scope dirs (CLI mode).
 */
function getSkillScriptDirs(skill: string, isTestEnv?: boolean): string[] {
  const base = skillsBase();
  const activeParent = path.join(base, "user", activeDir(isTestEnv));

  // Gateway mode: .skills-prod/ or .skills-dev/ exists → only search there.
  // If the skill isn't symlinked into the active directory (e.g. unpublished
  // in production), return empty — do NOT fall back to raw scope dirs.
  if (fs.existsSync(activeParent)) {
    const activePath = path.join(activeParent, skill, "scripts");
    return fs.existsSync(activePath) ? [activePath] : [];
  }

  // CLI fallback: search all scope directories
  const dirs: string[] = [];
  for (const scope of SKILL_SCOPES) {
    const dir = path.join(base, scope, skill, "scripts");
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Build the list of base directories for enumerating all skills.
 * Prefers .skills-prod/ or .skills-dev/ (gateway mode); falls back to scope dirs (CLI mode).
 */
function getSkillBaseDirs(isTestEnv?: boolean): string[] {
  const base = skillsBase();
  const activePath = path.join(base, "user", activeDir(isTestEnv));
  if (fs.existsSync(activePath)) return [activePath];

  // CLI fallback: search all scope directories
  return SKILL_SCOPES
    .map((scope) => path.join(base, scope))
    .filter((dir) => fs.existsSync(dir));
}

export interface ResolvedScript {
  path: string;
  content: string;
  interpreter: "bash" | "python3";
}

/**
 * Resolve a skill script.
 * In gateway mode searches .skills-prod/ or .skills-dev/; in CLI mode searches all scope dirs.
 */
export function resolveSkillScript(
  skill: string,
  script: string,
  isTestEnv?: boolean,
): ResolvedScript | null {
  for (const dir of getSkillScriptDirs(skill, isTestEnv)) {
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
export function listSkillScripts(skill: string, isTestEnv?: boolean): string[] {
  const scripts = new Set<string>();
  for (const dir of getSkillScriptDirs(skill, isTestEnv)) {
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
export function listAllSkillsWithScripts(isTestEnv?: boolean): Array<{
  skill: string;
  scripts: string[];
}> {
  const result: Array<{ skill: string; scripts: string[] }> = [];
  const seen = new Set<string>();

  for (const base of getSkillBaseDirs(isTestEnv)) {
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.name.startsWith("_")) continue; // skip _lib etc.
        if ((!d.isDirectory() && !d.isSymbolicLink()) || seen.has(d.name))
          continue;
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
  isTestEnv?: boolean;
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

  const resolved = resolveSkillScript(skill, script, params.isTestEnv);
  if (!resolved) {
    const available = listSkillScripts(skill, params.isTestEnv);
    if (available.length > 0) {
      return {
        error: `Script "${script}" not found in skill "${skill}". Available: ${available.join(", ")}`,
      };
    }
    const allSkills = listAllSkillsWithScripts(params.isTestEnv);
    let hint = `Skill "${skill}" has no scripts directory.`;
    if (allSkills.length > 0) {
      hint += `\nSkills with scripts: ${allSkills.map((s) => `${s.skill} (${s.scripts.join(", ")})`).join("; ")}`;
    }
    return { error: hint };
  }
  return resolved;
}
