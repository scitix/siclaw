import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { skillExistsInBundle, skillExistsAsBuiltin } from "./script-resolver.js";

interface CreateSkillParams {
  name: string;
  description: string;
  type?: string;
  specs: string;
  scripts?: Array<{ name: string; content?: string }>;
  labels?: string[];
}

export function createCreateSkillTool(): ToolDefinition {
  return {
    name: "create_skill",
    label: "Create Skill",
    description: `Create a new Siclaw skill definition from a troubleshooting conversation.
This tool outputs a structured skill definition that the user can preview and save. It does NOT persist anything — the user must confirm via the UI.

Use this tool when the user asks you to turn a troubleshooting workflow, diagnosis process, or operational procedure into a reusable skill.

A skill consists of:
- name: kebab-case identifier (e.g. "check-pod-oom")
- description: one-line summary of what the skill does
- type: category (e.g. "Monitoring", "Network", "Security", "Database", "Core", "Utility", "Automation")
- specs: the SKILL.md content in markdown (with YAML frontmatter)
- scripts: optional helper scripts (shell or python) the skill uses. **Only include scripts the skill actually needs** — do not include unrelated or leftover scripts. For user-uploaded scripts, just provide the filename (no content needed) — the server copies the file from uploads automatically.

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
<e.g.: run_skill: skill="<name>", script="<script>", args="<args>">

## Parameters
<table of required and optional parameters with descriptions>

## Procedure
<step-by-step actions the bot should take, with concrete commands>

## Examples
<multiple concrete tool invocations with realistic parameters>
\`\`\`

For skills WITHOUT scripts (pure kubectl guidance), omit the \`## Tool\` section and put commands directly in \`## Procedure\`.

Important:
- This tool is for creating NEW skills only.
- To update, modify, rename, or replace an existing skill, use the \`update_skill\` tool instead.
- If the user asks to "change", "modify", "update", or "replace" a skill (whether created earlier in this conversation or not), always use \`update_skill\`.
- Only use \`create_skill\` when the user explicitly wants a brand-new, separate skill.

**Approval required**: Skills with scripts require admin approval before they become active. After creating a skill, do NOT attempt to test or run it — it will not be available until an admin approves it. Inform the user that the skill is pending review.

## Script Execution Modes

When a skill includes scripts, you MUST choose the correct execution tool based on WHERE the script needs to run:

| Tool | Runs where | When to use |
|------|-----------|-------------|
| \`run_skill\` | Local (AgentBox) | Scripts that call kubectl from outside the cluster (most common) |
| \`node_script\` | On a K8s node (host namespaces) | Scripts needing host tools, filesystem, /proc, /sys, devices |
| \`pod_script\` | Inside a pod (kubectl exec) | Scripts running diagnostics inside a running pod |
| \`pod_netns_script\` | Node + pod's network namespace | Network diagnostics needing host tools + pod's network view |

In the SKILL.md, document the tool in a "## Tool" section. Examples:

### run_skill (local execution, calls kubectl)
\`\`\`
## Tool
run_skill: skill="find-node", script="find-node.sh", args="<keyword>"
\`\`\`

### node_script (execute on node)
\`\`\`
## Tool
Use the \`node_script\` tool:
node_script: node="<node>", skill="node-logs", script="get-node-logs.sh", args="--unit containerd"
\`\`\`

### pod_script (execute inside pod)
\`\`\`
## Tool
Use the \`pod_script\` tool:
pod_script: pod="<pod>", namespace="<ns>", skill="pod-diagnose", script="check.sh"
\`\`\`

### pod_netns_script (pod network namespace + host tools)
\`\`\`
## Tool
Use the \`pod_netns_script\` tool:
pod_netns_script: pod="<pod>", namespace="<ns>", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1"
\`\`\``,
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
            content: Type.Optional(Type.String({ description: "Script file content. If omitted, the script is copied from the user's uploads directory by name." })),
          }),
          { description: "Optional helper scripts for the skill. For user-uploaded scripts, just provide the name — the server will copy it from uploads automatically." }
        )
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), { description: "Labels/tags for the skill (e.g. ['gpu', 'network', 'monitoring'])" })
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as CreateSkillParams;

      // Validate required fields
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

      const skillName = params.name.trim();

      // Reject if a skill with the same name already exists
      if (skillExistsInBundle(skillName)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `A skill named '${skillName}' already exists (personal or team). Use 'update_skill' to modify it, or 'fork_skill' to fork a builtin/team skill.` }) }],
          details: { error: true },
        };
      }
      if (skillExistsAsBuiltin(skillName)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `A builtin skill named '${skillName}' already exists. Use 'fork_skill' to fork it into a personal copy with modifications.` }) }],
          details: { error: true },
        };
      }

      const hasScripts = params.scripts && params.scripts.length > 0;
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
        summary: `Created skill definition '${params.name.trim()}'. Please review and click Save.`
          + (hasScripts ? ' This skill has scripts and will require admin approval after saving. Do NOT attempt to test or run it until approved.' : ''),
        reviewNote: hasScripts
          ? "This skill contains scripts and will enter PENDING review status after saving. It CANNOT be used or tested until an admin approves it. Please inform the user that the skill is awaiting admin approval."
          : undefined,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
}
