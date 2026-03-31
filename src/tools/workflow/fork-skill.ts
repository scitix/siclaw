import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { skillExistsInBundle, skillExistsAsBuiltin } from "../infra/script-resolver.js";

interface ForkSkillParams {
  source: string;
  specs?: string;
  scripts?: Array<{ name: string; content?: string }>;
  labels?: string[];
}

export function createForkSkillTool(): ToolDefinition {
  return {
    name: "fork_skill",
    label: "Fork Skill",
    description: `Fork an existing builtin or global skill into a personal copy that you can customize.

Use this tool when the user wants to:
- Fork / copy / clone a builtin or global skill to make personal modifications
- Override a global skill with a personal version
- Customize an existing skill's behavior, parameters, or scripts

This tool outputs a structured fork definition that the user can preview and save. It does NOT persist anything — the user must confirm via the UI.

**When to use this tool vs others:**
- \`fork_skill\`: Fork an existing builtin/global skill to personal (with or without modifications)
- \`create_skill\`: Create a brand-new skill from scratch (only when no existing skill covers the same functionality)
- \`update_skill\`: Update an existing personal skill

**IMPORTANT**: Before calling this tool, check \`<available_skills>\` in your system prompt and read the source skill's SKILL.md to understand its current content. You need the exact skill name.

**Prefer forking over creating**: If a user wants to create a skill that overlaps with an existing builtin or global skill, recommend forking instead. This avoids duplicate skills that confuse the model. Fork lets them customize while keeping a clear lineage.

## Environments and Approval Workflow

| Environment | Behavior |
|-------------|----------|
| **Dev / Test** | Forked skill (draft) is immediately visible and testable. |
| **Production** | Forked skill must be **approved** before it appears. |

- Forked skills with scripts require admin approval before production use.
- In dev/test, the forked copy is available immediately for testing.

Parameters:
- source: The exact name of the builtin or global skill to fork (e.g. "find-node", "roce-perftest-pod")
- specs: Optional modified SKILL.md content. If omitted, the source skill's SKILL.md is copied as-is.
- scripts: Optional modified scripts. If omitted, the source skill's scripts are copied as-is.
  - Changed script: { name: "run.sh", content: "#!/bin/bash\\n..." }
  - Unchanged script: { name: "run.sh" } (name only, server copies from source)

Examples:
- Fork without changes: fork_skill(source="find-node")
- Fork with modified specs: fork_skill(source="find-node", specs="---\\nname: find-node\\n...")
- Fork with modified script: fork_skill(source="find-node", scripts=[{name: "find-node.sh", content: "..."}])`,
    parameters: Type.Object({
      source: Type.String({
        description: "Name of the builtin or global skill to fork (e.g. 'find-node')",
      }),
      specs: Type.Optional(
        Type.String({
          description: "Modified SKILL.md content. If omitted, source skill's content is copied.",
        })
      ),
      scripts: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "Script filename (e.g. 'run.sh')" }),
            content: Type.Optional(Type.String({ description: "Modified script content. If omitted, source script is copied." })),
          }),
          { description: "Modified scripts. If omitted, all source scripts are copied." }
        )
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), { description: "Labels/tags for the forked skill (e.g. ['gpu', 'network'])" })
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ForkSkillParams;

      if (!params.source?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Source skill name is required." }) }],
          details: { error: true },
        };
      }

      const sourceName = params.source.trim();

      // Verify source skill exists and is a builtin or global skill
      const existsInBundle = skillExistsInBundle(sourceName);
      const existsAsBuiltin = skillExistsAsBuiltin(sourceName);

      if (!existsInBundle && !existsAsBuiltin) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Source skill '${sourceName}' not found. Check the skill name and try again.` }) }],
          details: { error: true },
        };
      }

      const hasScripts = params.scripts && params.scripts.length > 0;
      const hasModifications = !!params.specs || hasScripts;
      const labels = params.labels?.map(l => l.trim()).filter(Boolean);

      const result = {
        fork: true,
        sourceSkillName: sourceName,
        skill: {
          name: sourceName,
          description: "",
          type: "Custom",
          specs: params.specs,
          scripts: params.scripts?.map((s) => ({
            name: s.name,
            content: s.content,
          })),
          labels: labels && labels.length > 0 ? labels : undefined,
        },
        summary: hasModifications
          ? `Forked skill '${sourceName}' with modifications. Please review and click Save to Personal.`
          : `Forked skill '${sourceName}'. Please review and click Save to Personal.`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (_refs) => createForkSkillTool(),
  modes: ["web"],
};
