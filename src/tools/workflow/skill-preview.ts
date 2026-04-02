import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { resolveUnderDir } from "../../shared/path-utils.js";

const DRAFTS_BASE = path.resolve(process.cwd(), ".siclaw/user-data/skill-drafts");

interface SkillPreviewParams {
  dir: string;
}

export function createSkillPreviewTool(): ToolDefinition {
  return {
    name: "skill_preview",
    label: "Skill Preview",
    description: `Render a skill draft as a structured preview panel with copy buttons.

**Workflow** — when the user asks to create, modify, or improve a skill:
1. First explain what you plan to build or change.
2. Write ALL files to \`.siclaw/user-data/skill-drafts/<name>/\` — SKILL.md AND all scripts. Write every file BEFORE calling skill_preview.
3. Call \`skill_preview\` ONCE with the directory path, after ALL files are written.

**IMPORTANT**:
- Write ALL files first, then call skill_preview ONCE. Do NOT call skill_preview after writing only SKILL.md — wait until scripts are also written.
- skill_preview **deletes the directory** after reading. Do NOT write more files or call skill_preview again — the directory is gone. If you need to redo, write all files from scratch to a new directory.

**SKILL.md format**:
\`\`\`
---
name: <kebab-case-name>
description: >-
  One-line summary. Mention the execution tool if the skill uses scripts.
---
# <Title>
## Purpose    — what problem this solves
## Tool       — execution tool invocation (required for script-based skills)
## Parameters — table of required/optional parameters
## Procedure  — step-by-step actions with concrete commands
## Examples   — concrete tool invocations with realistic parameters
\`\`\`

**Script execution modes**:
| Tool | Runs where | When to use |
|------|-----------|-------------|
| \`local_script\` | AgentBox | kubectl commands from outside the cluster — most common |
| \`node_script\` | K8s node | Needs host tools, /proc, /sys, devices |
| \`pod_script\` | Inside a pod | Diagnostics inside a running container |
| \`node_script\` + \`netns\` | Node + pod network ns | Host tools + pod network view |`,
    parameters: Type.Object({
      dir: Type.String({
        description: "Path to the skill draft directory (e.g. '.siclaw/user-data/skill-drafts/check-pod-oom')",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as SkillPreviewParams;
      const dir = params.dir?.trim();

      if (!dir) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "dir is required" }) }],
          details: { error: true },
        };
      }

      // Security: resolve relative paths against cwd first, then validate via resolveUnderDir.
      // Agent may pass relative (".siclaw/user-data/skill-drafts/foo") or absolute — both must work.
      const absoluteDir = path.resolve(dir);
      let safeDir: string;
      try {
        safeDir = resolveUnderDir(DRAFTS_BASE, absoluteDir);
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "dir must be under .siclaw/user-data/skill-drafts/<name>/" }) }],
          details: { error: true },
        };
      }
      if (safeDir === DRAFTS_BASE) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "dir must be a subdirectory, not the drafts root" }) }],
          details: { error: true },
        };
      }

      if (!fs.existsSync(safeDir)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Directory not found: ${safeDir}` }) }],
          details: { error: true },
        };
      }

      // Read SKILL.md — cleanup in finally to avoid leaving drafts on error
      try {
        const specPath = path.join(safeDir, "SKILL.md");
        if (!fs.existsSync(specPath)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `SKILL.md not found in ${safeDir}` }) }],
            details: { error: true },
          };
        }
        const specs = fs.readFileSync(specPath, "utf-8").replace(/\r\n/g, "\n");

        // Parse name and description from YAML frontmatter
        let name = path.basename(safeDir);
        let description = "";
        let type = "Custom";
        const fmMatch = specs.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          if (nameMatch) name = nameMatch[1].trim();
          // Multiline: "description: >-\n  line1\n  line2" or inline: "description: one line"
          const descMulti = fm.match(/^description:\s*>-?\s*\n((?:[ \t]+.+\n?)+)/m);
          if (descMulti) {
            description = descMulti[1].trim().replace(/\n\s*/g, " ");
          } else {
            const descInline = fm.match(/^description:\s*(?!>)(.+)$/m);
            if (descInline) description = descInline[1].trim().replace(/^["']|["']$/g, "");
          }
          const typeMatch = fm.match(/^type:\s*(.+)$/m);
          if (typeMatch) type = typeMatch[1].trim();
        }

        // Read scripts (skip symlinks to prevent exfiltration)
        const scripts: Array<{ name: string; content: string }> = [];
        const scriptsDir = path.join(safeDir, "scripts");
        if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
          for (const f of fs.readdirSync(scriptsDir).sort()) {
            const fp = path.join(scriptsDir, f);
            const stat = fs.lstatSync(fp);
            if (stat.isFile() && !stat.isSymbolicLink()) {
              scripts.push({ name: f, content: fs.readFileSync(fp, "utf-8") });
            }
          }
        }

        const result = {
          skill: { name, description, type, specs, scripts },
          summary: `Skill preview for '${name}'. Click View to inspect and copy.`,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      } finally {
        // Always clean up draft directory
        try { fs.rmSync(safeDir, { recursive: true, force: true }); } catch { /* NFS may delay */ }
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (_refs) => createSkillPreviewTool(),
  modes: ["web", "channel"],
  platform: true,
};
