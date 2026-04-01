import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

interface SkillPreviewParams {
  name: string;
  description: string;
  type?: string;
  specs: string;
  scripts?: Array<{ name: string; content?: string }>;
  labels?: string[];
}

export function createSkillPreviewTool(): ToolDefinition {
  return {
    name: "skill_preview",
    label: "Skill Preview",
    description: `Generate a structured skill preview that the user can review and copy.
This tool renders a side panel with the skill's files and copy buttons. It does NOT persist anything.

Use this tool when the user asks you to:
- Turn a troubleshooting workflow into a reusable skill
- Modify or improve an existing skill (read the current SKILL.md first, then output the full modified version)
- Create a new diagnostic procedure as a skill

**Output order**: First explain what you built or changed and why in a concise summary, then call this tool. The skill card appears after your text.

A skill consists of:
- name: kebab-case identifier (e.g. "check-pod-oom")
- description: one-line summary of what the skill does
- type: category (e.g. "Monitoring", "Network", "Security", "Database", "Core", "Utility", "Automation")
- specs: the SKILL.md content in markdown (with YAML frontmatter)
- scripts: optional helper scripts (shell or python)

The specs field should follow SKILL.md format:
\`\`\`
---
name: <skill-name>
description: >-
  One-line summary. Mention the execution tool if the skill uses scripts.
---
# <Skill Title>

## Purpose
What problem this skill solves and when to use it.

## Tool
<execution tool invocation syntax — required for script-based skills>
<e.g.: local_script: skill="<name>", script="<script>", args="<args>">

## Parameters
<table of required and optional parameters with descriptions>

## Procedure
<step-by-step actions the bot should take, with concrete commands>

## Examples
<multiple concrete tool invocations with realistic parameters>
\`\`\`

For skills WITHOUT scripts (pure kubectl guidance), omit the \`## Tool\` section and put commands directly in \`## Procedure\`.

## Script Execution Modes

| Tool | Runs where | When to use |
|------|-----------|-------------|
| \`local_script\` | Local (AgentBox) | Scripts that call kubectl from outside the cluster (most common) |
| \`node_script\` | On a K8s node | Scripts needing host tools, filesystem, /proc, /sys, devices |
| \`pod_script\` | Inside a pod | Scripts running diagnostics inside a running pod |
| \`node_script\` + \`netns\` | Node + pod's network namespace | Network diagnostics needing host tools + pod's network view |`,
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name in kebab-case (e.g. 'check-pod-oom')",
      }),
      description: Type.String({
        description: "One-line description of what the skill does",
      }),
      type: Type.Optional(
        Type.String({
          description: "Category: Monitoring, Network, Security, Database, Core, Utility, Automation, Custom",
        })
      ),
      specs: Type.String({
        description: "Full SKILL.md content (markdown with YAML frontmatter)",
      }),
      scripts: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "Script filename (e.g. 'run.sh', 'diagnose.py')" }),
            content: Type.Optional(Type.String({ description: "Script file content" })),
          }),
          { description: "Helper scripts for the skill" }
        )
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), { description: "Labels/tags for the skill" })
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as SkillPreviewParams;

      if (!params.name?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Skill name is required." }) }],
          details: { error: true },
        };
      }
      if (!params.specs?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Skill specs (SKILL.md content) is required." }) }],
          details: { error: true },
        };
      }

      const labels = params.labels?.map(l => l.trim()).filter(Boolean);
      const result = {
        skill: {
          name: params.name.trim(),
          description: params.description?.trim() || "",
          type: params.type?.trim() || "Custom",
          specs: params.specs,
          scripts: params.scripts?.map((s) => ({
            name: s.name,
            content: s.content,
          })) || [],
          labels: labels && labels.length > 0 ? labels : undefined,
        },
        summary: `Generated skill preview for '${params.name.trim()}'. Click View to inspect and copy.`,
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
  create: (_refs) => createSkillPreviewTool(),
  modes: ["web", "channel"],
  platform: true,
};
