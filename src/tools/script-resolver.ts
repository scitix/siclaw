import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig } from "../core/config.js";

function skillsBase(): string {
  const config = loadConfig();
  return path.resolve(process.cwd(), config.paths.skillsDir);
}

/** Skill scope directories to search (in priority order, CLI fallback) */
const SKILL_SCOPES = ["core", "team", "extension", "user"];

/**
 * Build the list of directories to search for a specific skill's scripts.
 * Single directory model: each pod has one /skills/ dir populated by bundle API.
 * CLI fallback: search all scope directories.
 */
function getSkillScriptDirs(skill: string): string[] {
  const base = skillsBase();

  // Search directly in skillsBase for bundle-materialized skills
  const directPath = path.join(base, skill, "scripts");
  if (fs.existsSync(directPath)) return [directPath];

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
 * Single directory model: skillsBase is the root.
 * CLI fallback: search all scope directories.
 */
function getSkillBaseDirs(): string[] {
  const base = skillsBase();

  // Check if bundle-materialized skills exist directly in skillsBase
  // (no scope subdirs like core/team/extension)
  const hasDirectSkills = fs.existsSync(base) && fs.readdirSync(base).some(
    (entry) => !entry.startsWith(".") && !SKILL_SCOPES.includes(entry) &&
      fs.statSync(path.join(base, entry)).isDirectory(),
  );
  if (hasDirectSkills) return [base];

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

  for (const base of getSkillBaseDirs()) {
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
