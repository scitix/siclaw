/**
 * Skill File Writer — writes skill files to Skills PV
 *
 * Directory layout:
 *   .siclaw/skills/user/{userId}/{skillName}/SKILL.md
 *   .siclaw/skills/team/{skillName}/SKILL.md
 *   .siclaw/skills/core/{skillName}/SKILL.md
 */

import fs from "node:fs";
import path from "node:path";
import type { S3Storage } from "../../lib/s3-storage.js";

export interface SkillFiles {
  specs?: string;
  scripts?: Array<{
    name: string;
    content: string;
  }>;
}

export interface ScannedSkill {
  dirName: string;
  name: string;
  description: string;
  scope: "core" | "team" | "personal" | "extension";
  scripts: string[];
}

export class SkillFileWriter {
  constructor(private skillsDir: string) {}

  /** Initialize Skills PV (ensure dirs exist) */
  async init(): Promise<void> {
    for (const sub of ["core", "team", "user", "extension", "platform"]) {
      const dir = path.join(this.skillsDir, sub);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    console.log("[skill-writer] Initialized skills directory:", this.skillsDir);
  }

  /** Resolve skill directory path */
  resolveDir(
    scope: "core" | "team" | "personal" | "extension",
    dirName: string,
    userId?: string,
  ): string {
    switch (scope) {
      case "core":
        return path.join(this.skillsDir, "core", dirName);
      case "team":
        return path.join(this.skillsDir, "team", dirName);
      case "personal":
        return path.join(this.skillsDir, "user", userId || "unknown", dirName);
      case "extension":
        return path.join(this.skillsDir, "extension", dirName);
    }
  }

  /** Write skill files to disk */
  async writeSkill(
    scope: "core" | "team" | "personal" | "extension",
    dirName: string,
    files: SkillFiles,
    opts: { userId?: string },
  ): Promise<{ skillDir: string }> {
    const skillDir = this.resolveDir(scope, dirName, opts.userId);

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
    scope: "core" | "team" | "personal" | "extension",
    dirName: string,
    userId?: string,
  ): SkillFiles | null {
    let skillDir = this.resolveDir(scope, dirName, userId);

    // Fallback to Docker-baked cwd/skills/{scope} for core/extension skills
    if (!fs.existsSync(skillDir) && (scope === "core" || scope === "extension")) {
      const bakedDir = path.join(process.cwd(), "skills", scope, dirName);
      if (fs.existsSync(bakedDir)) skillDir = bakedDir;
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

  /** Parse YAML frontmatter from SKILL.md content */
  parseFrontmatter(specs: string): { name: string; description: string } {
    const match = specs.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { name: "", description: "" };
    const yaml = match[1];

    // Extract name (always a simple string)
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : "";

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

  /** Scan a single directory for skills */
  private scanDir(
    dir: string,
    scope: "core" | "team" | "personal" | "extension",
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
  scanScope(scope: "core" | "team" | "extension", userId?: string): ScannedSkill[] {
    const scopeDir =
      scope === "core"
        ? path.join(this.skillsDir, "core")
        : scope === "team"
          ? path.join(this.skillsDir, "team")
          : scope === "extension"
            ? path.join(this.skillsDir, "extension")
            : path.join(this.skillsDir, "user", userId || "unknown");

    const results = this.scanDir(scopeDir, scope);

    // For core/extension skills: also scan Docker-baked cwd/skills/{scope} (dedup by dirName)
    if (scope === "core" || scope === "extension") {
      const bakedDir = path.join(process.cwd(), "skills", scope);
      if (bakedDir !== scopeDir) {
        const baked = this.scanDir(bakedDir, scope);
        const seen = new Set(results.map((s) => s.dirName));
        for (const s of baked) {
          if (!seen.has(s.dirName)) results.push(s);
        }
      }
    }

    return results;
  }

  /** Delete skill files from disk (including .published/ if present) */
  async deleteSkill(
    scope: "core" | "team" | "personal" | "extension",
    dirName: string,
    opts: { userId?: string },
  ): Promise<void> {
    const skillDir = this.resolveDir(scope, dirName, opts.userId);

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

  /** Resolve published snapshot directory path */
  resolvePublishedDir(userId: string, dirName: string): string {
    return path.join(this.skillsDir, "user", userId, ".published", dirName);
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

  /** Resolve staging snapshot directory path */
  resolveStagingDir(userId: string, dirName: string): string {
    return path.join(this.skillsDir, "user", userId, ".staging", dirName);
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
    scope: "core" | "team" | "personal" | "extension",
    oldDirName: string,
    newDirName: string,
    opts: { userId?: string },
  ): Promise<void> {
    const oldDir = this.resolveDir(scope, oldDirName, opts.userId);
    const newDir = this.resolveDir(scope, newDirName, opts.userId);

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

  /** Copy skill from user dir to team dir (for approve flow) */
  async copyToTeam(
    userId: string,
    dirName: string,
  ): Promise<{ teamDir: string }> {
    const srcDir = this.resolveDir("personal", dirName, userId);
    const destDir = this.resolveDir("team", dirName);

    if (!fs.existsSync(srcDir)) {
      throw new Error(`Source skill not found: ${srcDir}`);
    }

    // Copy recursively
    fs.cpSync(srcDir, destDir, { recursive: true });

    return { teamDir: destDir };
  }

  /** Materialize skill files from S3 to a local directory */
  async materializeFromS3(
    s3: S3Storage,
    s3Key: string,
    targetDir: string,
  ): Promise<void> {
    // Clear target if exists
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });
    await s3.downloadDir(s3Key, targetDir);
  }
}
