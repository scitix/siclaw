/**
 * Skill File Writer
 *
 * Retained utilities:
 * 1. init() — create skills directory structure
 * 2. resolveDir() — traversal-safe directory resolution (used by cleanup logic)
 * 3. parseFrontmatter() / setFrontmatterName() — SKILL.md metadata utilities
 *
 * All builtin/global/personal/skillset skill content is in the database.
 * Disk scanning (readSkill, scanScope) moved to builtin-sync.ts.
 * Disk writing for agent execution handled by materialize pipeline.
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

export class SkillFileWriter {
  private skillsDir: string;
  constructor(skillsDir: string) {
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

    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? this.unquoteYaml(nameMatch[1]) : "";

    let description = "";
    const blockMatch = yaml.match(/^description:\s*>-?\s*\n((?:[ \t]+.+\n?)+)/m);
    if (blockMatch) {
      description = blockMatch[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
    } else {
      const descInlineMatch = yaml.match(/^description:\s*(.+)$/m);
      if (descInlineMatch) {
        description = descInlineMatch[1].trim();
      }
    }

    return { name, description };
  }

  /** Replace the `name:` field inside YAML frontmatter, preserving everything else */
  setFrontmatterName(specs: string, newName: string): string {
    const safeName = newName.replace(/[\r\n]/g, "").trim();
    if (!safeName) return specs;
    const quoted = `'${safeName.replace(/'/g, "''")}'`;
    const fm = this.splitFrontmatter(specs);
    if (!fm) {
      return `---\nname: ${quoted}\n---\n${specs}`;
    }
    const { before, yaml, after } = fm;
    const nameMatch = yaml.match(/^name:\s*.+$/m);
    if (nameMatch) {
      const updatedYaml = yaml.replace(/^name:\s*.+$/m, `name: ${quoted}`);
      return `${before}${updatedYaml}${after}`;
    }
    return `${before}name: ${quoted}\n${yaml}${after}`;
  }
}
