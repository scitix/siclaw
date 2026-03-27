/**
 * Skill File Writer
 *
 * Directory layout:
 *   skills/core/{skillName}/SKILL.md           — builtin (baked in Docker image)
 *   .siclaw/skills/global/{skillName}/SKILL.md  — global (from DB)
 *   .siclaw/skills/user/{userId}/{skillName}/   — personal (from DB)
 */

import fs from "node:fs";
import path from "node:path";
import { resolveUnderDir } from "../../shared/path-utils.js";

export interface SkillFiles {
  specs?: string;
  scripts?: Array<{
    name: string;
    content: string;
  }>;
}

export type SkillFileScope = "builtin" | "global" | "personal" | "skillset";

export interface ScannedSkill {
  dirName: string;
  name: string;
  description: string;
  scope: SkillFileScope;
  scripts: string[];
}

export class SkillFileWriter {
  private skillsDir: string;
  constructor(skillsDir: string) {
    // resolveUnderDir requires an absolute base — resolve defensively so callers
    // can pass relative paths (e.g. ".siclaw/skills" from config).
    this.skillsDir = path.resolve(skillsDir);
  }

  /** Initialize Skills PV (ensure dirs exist) */
  async init(): Promise<void> {
    for (const sub of ["core", "extension", "global", "user", "skillset", "platform"]) {
      const dir = path.join(this.skillsDir, sub);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    console.log("[skill-writer] Initialized skills directory:", this.skillsDir);
  }

  /** Resolve skill directory path (traversal-safe) */
  resolveDir(
    scope: SkillFileScope,
    dirName: string,
    userId?: string,
    skillSpaceId?: string,
  ): string {
    switch (scope) {
      case "builtin":
        return resolveUnderDir(this.skillsDir, "core", dirName);
      case "global":
        return resolveUnderDir(this.skillsDir, "global", dirName);
      case "personal":
        if (!userId) throw new Error("userId is required for personal scope");
        return resolveUnderDir(this.skillsDir, "user", userId, dirName);
      case "skillset":
        if (!skillSpaceId) throw new Error("skillSpaceId is required for skillset scope");
        return resolveUnderDir(this.skillsDir, "skillset", skillSpaceId, dirName);
    }
  }

  /** Write skill files to disk */
  async writeSkill(
    scope: SkillFileScope,
    dirName: string,
    files: SkillFiles,
    opts: { userId?: string; skillSpaceId?: string },
  ): Promise<{ skillDir: string }> {
    const skillDir = this.resolveDir(scope, dirName, opts.userId, opts.skillSpaceId);

    // Ensure directory exists
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    // Write SKILL.md (specs)
    if (files.specs !== undefined) {
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), files.specs, "utf-8");
    }

    // Write scripts and clean up orphans
    if (files.scripts) {
      const scriptsDir = path.join(skillDir, "scripts");
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
      }

      // Write new/updated scripts
      for (const script of files.scripts) {
        if (script.content != null) {
          fs.writeFileSync(
            path.join(scriptsDir, script.name),
            script.content,
            "utf-8",
          );
        }
      }

      // Delete scripts no longer in the list
      const keepSet = new Set(files.scripts.map((s) => s.name));
      for (const existing of fs.readdirSync(scriptsDir)) {
        if (!keepSet.has(existing)) {
          fs.unlinkSync(path.join(scriptsDir, existing));
        }
      }
    }

    return { skillDir };
  }

  /** Read skill files from disk */
  readSkill(
    scope: SkillFileScope,
    dirName: string,
    userId?: string,
    skillSpaceId?: string,
  ): SkillFiles | null {
    let skillDir = this.resolveDir(scope, dirName, userId, skillSpaceId);

    // Fallback to Docker-baked cwd/skills/{core,extension} for builtin skills
    if (!fs.existsSync(skillDir) && scope === "builtin") {
      for (const tier of ["core", "extension"]) {
        const bakedDir = path.join(process.cwd(), "skills", tier, dirName);
        if (fs.existsSync(bakedDir)) { skillDir = bakedDir; break; }
      }
    }

    if (!fs.existsSync(skillDir)) return null;

    const result: SkillFiles = {};

    // Read SKILL.md
    const specPath = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(specPath)) {
      result.specs = fs.readFileSync(specPath, "utf-8");
    }

    // Read scripts
    const scriptsDir = path.join(skillDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      result.scripts = [];
      for (const name of fs.readdirSync(scriptsDir)) {
        const content = fs.readFileSync(
          path.join(scriptsDir, name),
          "utf-8",
        );
        result.scripts.push({ name, content });
      }
    }

    return result;
  }

  /** Split specs into { before, yaml, after } around the frontmatter block */
  private splitFrontmatter(specs: string): { before: string; yaml: string; after: string } | null {
    const match = specs.match(/^(---\n)([\s\S]*?)(\n---)([\s\S]*)$/);
    if (!match) return null;
    return { before: match[1], yaml: match[2], after: match[3] + match[4] };
  }

  /** Strip YAML quotes from a raw value string */
  private unquoteYaml(raw: string): string {
    const v = raw.trim();
    if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
    return v;
  }

  /** Parse YAML frontmatter from SKILL.md content */
  parseFrontmatter(specs: string): { name: string; description: string } {
    const fm = this.splitFrontmatter(specs);
    if (!fm) return { name: "", description: "" };
    const { yaml } = fm;

    // Extract name (may be quoted with single or double quotes)
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? this.unquoteYaml(nameMatch[1]) : "";

    // Extract description — handles both inline and block scalar (>- / >)
    let description = "";
    // Block scalar first: "description: >-" or "description: >" followed by indented lines
    const blockMatch = yaml.match(
      /^description:\s*>-?\s*\n((?:[ \t]+.+\n?)+)/m,
    );
    if (blockMatch) {
      description = blockMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ");
    } else {
      // Inline: "description: some text"
      const descInlineMatch = yaml.match(/^description:\s*(.+)$/m);
      if (descInlineMatch) {
        description = descInlineMatch[1].trim();
      }
    }

    return { name, description };
  }

  /** Replace the `name:` field inside YAML frontmatter, preserving everything else */
  setFrontmatterName(specs: string, newName: string): string {
    // Sanitize: strip newlines to prevent YAML injection
    const safeName = newName.replace(/[\r\n]/g, "").trim();
    if (!safeName) return specs;
    // Single-quote to prevent YAML special char issues (: # { } ' etc.)
    const quoted = `'${safeName.replace(/'/g, "''")}'`;
    const fm = this.splitFrontmatter(specs);
    if (!fm) {
      // No frontmatter — prepend one
      return `---\nname: ${quoted}\n---\n${specs}`;
    }
    const { before, yaml, after } = fm;
    const nameMatch = yaml.match(/^name:\s*.+$/m);
    if (nameMatch) {
      // Replace existing name field
      const updatedYaml = yaml.replace(/^name:\s*.+$/m, `name: ${quoted}`);
      return `${before}${updatedYaml}${after}`;
    }
    // No name field — add it as the first field
    return `${before}name: ${quoted}\n${yaml}${after}`;
  }

  /** Scan a single directory for skills */
  private scanDir(
    dir: string,
    scope: SkillFileScope,
  ): ScannedSkill[] {
    if (!fs.existsSync(dir)) return [];

    const results: ScannedSkill[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip non-directories and _ prefixed (e.g. _lib)
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const specs = fs.readFileSync(skillMdPath, "utf-8");
      const { name, description } = this.parseFrontmatter(specs);

      // List scripts
      const scriptsDir = path.join(dir, entry.name, "scripts");
      let scripts: string[] = [];
      if (fs.existsSync(scriptsDir)) {
        scripts = fs.readdirSync(scriptsDir).filter((f) => !f.startsWith("."));
      }

      results.push({
        dirName: entry.name,
        name: name || entry.name,
        description,
        scope,
        scripts,
      });
    }

    return results;
  }

  /** Scan all skills under a scope directory */
  scanScope(scope: "builtin" | "global"): ScannedSkill[] {
    // "global" merges builtin + global-dir-scoped skills
    if (scope === "global") {
      const builtins = this.scanScope("builtin");
      const globalDir = path.join(this.skillsDir, "global");
      const globalSkills = this.scanDir(globalDir, "global");
      return [...builtins, ...globalSkills];
    }
    if (scope === "builtin") {
      const results: ScannedSkill[] = [];
      const seen = new Set<string>();

      // Scan Docker-baked cwd/skills/core and cwd/skills/extension
      for (const tier of ["core", "extension"]) {
        const bakedDir = path.join(process.cwd(), "skills", tier);
        for (const s of this.scanDir(bakedDir, "builtin")) {
          if (!seen.has(s.dirName)) { seen.add(s.dirName); results.push(s); }
        }
      }

      return results;
    }

    // Exhaustive — both "global" and "builtin" handled above
    return [];
  }

  /** Delete skill files from disk (including .published/ if present) */
  async deleteSkill(
    scope: SkillFileScope,
    dirName: string,
    opts: { userId?: string; skillSpaceId?: string },
  ): Promise<void> {
    const skillDir = this.resolveDir(scope, dirName, opts.userId, opts.skillSpaceId);

    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    // Also clean up .published/ and .staging/ directories (personal scope)
    if (scope === "personal" && opts.userId) {
      const publishedDir = this.resolvePublishedDir(opts.userId, dirName);
      if (fs.existsSync(publishedDir)) {
        fs.rmSync(publishedDir, { recursive: true, force: true });
      }
      const stagingDir = this.resolveStagingDir(opts.userId, dirName);
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    }
  }

  /** Resolve published snapshot directory path (traversal-safe) */
  resolvePublishedDir(userId: string, dirName: string): string {
    return resolveUnderDir(this.skillsDir, "user", userId, ".published", dirName);
  }

  /** Snapshot working copy to .published/ directory */
  async snapshotPublish(
    userId: string,
    dirName: string,
  ): Promise<void> {
    const skillDir = this.resolveDir("personal", dirName, userId);
    const publishedDir = this.resolvePublishedDir(userId, dirName);

    if (!fs.existsSync(skillDir)) {
      throw new Error(`Skill directory not found: ${skillDir}`);
    }

    // Clear existing published snapshot
    if (fs.existsSync(publishedDir)) {
      fs.rmSync(publishedDir, { recursive: true, force: true });
    }

    // Copy working → published
    fs.cpSync(skillDir, publishedDir, { recursive: true });
  }

  /** Read skill files from the .published/ directory */
  readPublished(userId: string, dirName: string): SkillFiles | null {
    const publishedDir = this.resolvePublishedDir(userId, dirName);
    if (!fs.existsSync(publishedDir)) return null;

    const result: SkillFiles = {};
    const specPath = path.join(publishedDir, "SKILL.md");
    if (fs.existsSync(specPath)) {
      result.specs = fs.readFileSync(specPath, "utf-8");
    }
    const scriptsDir = path.join(publishedDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      result.scripts = [];
      for (const name of fs.readdirSync(scriptsDir)) {
        const content = fs.readFileSync(path.join(scriptsDir, name), "utf-8");
        result.scripts.push({ name, content });
      }
    }
    return result;
  }

  /** Delete the .published/ directory for a skill */
  async deletePublished(
    userId: string,
    dirName: string,
  ): Promise<void> {
    const publishedDir = this.resolvePublishedDir(userId, dirName);
    if (fs.existsSync(publishedDir)) {
      fs.rmSync(publishedDir, { recursive: true, force: true });
    }
  }

  /** Resolve staging snapshot directory path (traversal-safe) */
  resolveStagingDir(userId: string, dirName: string): string {
    return resolveUnderDir(this.skillsDir, "user", userId, ".staging", dirName);
  }

  /** Snapshot working copy to .staging/ directory */
  async snapshotStaging(userId: string, dirName: string): Promise<void> {
    const skillDir = this.resolveDir("personal", dirName, userId);
    const stagingDir = this.resolveStagingDir(userId, dirName);

    if (!fs.existsSync(skillDir)) {
      throw new Error(`Skill directory not found: ${skillDir}`);
    }

    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    fs.cpSync(skillDir, stagingDir, { recursive: true });
  }

  /** Read skill files from the .staging/ directory */
  readStaging(userId: string, dirName: string): SkillFiles | null {
    const stagingDir = this.resolveStagingDir(userId, dirName);
    if (!fs.existsSync(stagingDir)) return null;

    const result: SkillFiles = {};
    const specPath = path.join(stagingDir, "SKILL.md");
    if (fs.existsSync(specPath)) {
      result.specs = fs.readFileSync(specPath, "utf-8");
    }
    const scriptsDir = path.join(stagingDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      result.scripts = [];
      for (const name of fs.readdirSync(scriptsDir)) {
        const content = fs.readFileSync(path.join(scriptsDir, name), "utf-8");
        result.scripts.push({ name, content });
      }
    }
    return result;
  }

  /** Delete the .staging/ directory for a skill */
  async deleteStaging(userId: string, dirName: string): Promise<void> {
    const stagingDir = this.resolveStagingDir(userId, dirName);
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /** Rename a skill directory on disk (and its .published/ dir if present) */
  async renameDir(
    scope: SkillFileScope,
    oldDirName: string,
    newDirName: string,
    opts: { userId?: string; skillSpaceId?: string },
  ): Promise<void> {
    const oldDir = this.resolveDir(scope, oldDirName, opts.userId, opts.skillSpaceId);
    const newDir = this.resolveDir(scope, newDirName, opts.userId, opts.skillSpaceId);

    if (!fs.existsSync(oldDir)) {
      throw new Error(`Skill directory not found: ${oldDir}`);
    }
    if (fs.existsSync(newDir)) {
      throw new Error(`Target directory already exists: ${newDir}`);
    }

    fs.renameSync(oldDir, newDir);

    // Also rename .published/ and .staging/ dirs if present (personal scope only)
    if (scope === "personal" && opts.userId) {
      const oldPublished = this.resolvePublishedDir(opts.userId, oldDirName);
      if (fs.existsSync(oldPublished)) {
        const newPublished = this.resolvePublishedDir(opts.userId, newDirName);
        fs.renameSync(oldPublished, newPublished);
      }
      const oldStaging = this.resolveStagingDir(opts.userId, oldDirName);
      if (fs.existsSync(oldStaging)) {
        const newStaging = this.resolveStagingDir(opts.userId, newDirName);
        fs.renameSync(oldStaging, newStaging);
      }
    }
  }

  /** Copy skill from user dir to global dir (for approve flow) */
  async copyToGlobal(
    userId: string,
    dirName: string,
  ): Promise<{ globalDir: string }> {
    const srcDir = this.resolveDir("personal", dirName, userId);
    const destDir = this.resolveDir("global", dirName);

    if (!fs.existsSync(srcDir)) {
      throw new Error(`Source skill not found: ${srcDir}`);
    }

    // Copy recursively
    fs.cpSync(srcDir, destDir, { recursive: true });

    return { globalDir: destDir };
  }

}
