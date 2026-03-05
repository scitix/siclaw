import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { skillExistsInBundle } from "./script-resolver.js";

interface UpdateSkillParams {
  id?: string;
  name: string;
  description: string;
  type?: string;
  specs: string;
  scripts?: Array<{ name: string; content?: string }>;
  labels?: string[];
}

export function createUpdateSkillTool(): ToolDefinition {
  return {
    name: "update_skill",
    label: "Update Skill",
    description: `Update an existing Siclaw skill definition.
This tool outputs a structured skill update that the user can preview and confirm. It does NOT persist anything — the user must confirm via the UI.

Use this tool (NOT create_skill) when the user asks to modify, update, change, or fix an existing skill. This includes:
- When the user message contains [Editing Skill: <name> (id:<id>)] context from the UI
- When the user asks to change a skill that was created earlier in the conversation
- When the user asks to modify or replace an existing skill

**IMPORTANT — Identify the target skill FIRST**:
Before calling this tool, you MUST know the exact name of the skill to update. Check the Skill Scripts Reference in your context for existing skills. If the user's request is ambiguous (e.g. "update that skill", "update it"), ASK the user to clarify which skill they mean. Never guess — a wrong target will corrupt the wrong skill.

Do NOT use read, edit, write, or bash on files under .siclaw/skills/ — the filesystem is read-only. Always use this tool instead.

**Approval required**: When scripts are changed, the update enters a "staged" review state and requires admin approval before the new version becomes active. The old version of the skill remains usable during review. After updating, do NOT attempt to test the new version — it will not take effect until an admin approves it. Inform the user that the update is pending review.

Parameters:
- id: The skill ID from [Editing Skill: ... (id:<id>)] context, OR the skill's kebab-case name (for name-based lookup).
- name: the skill name in kebab-case (cannot be changed after creation).
- description: one-line summary
- type: category (Monitoring, Network, Security, Database, Core, Utility, Automation, Custom)
- specs: full updated SKILL.md content (complete, not a diff)
- scripts: the COMPLETE list of scripts the skill should have after the update. **Only include scripts the skill actually needs.** Scripts NOT in this list will be DELETED from disk.
  - Changed script: { name: "run.sh", content: "#!/bin/bash\\n..." }
  - Unchanged script: { name: "run.sh" } (name only, server preserves original)
  - To remove a script: simply omit it from the array — it will be deleted

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
      id: Type.Optional(Type.String({
        description: "Skill ID or kebab-case name for lookup.",
      })),
      name: Type.String({
        description: "Skill name in kebab-case (e.g. 'check-pod-oom')",
      }),
      description: Type.String({
        description: "One-line description of what the skill does",
      }),
      type: Type.Optional(
        Type.String({
          description:
            "Category: Monitoring, Network, Security, Database, Core, Utility, Automation, Custom",
        }),
      ),
      specs: Type.String({
        description: "Full updated SKILL.md content (markdown with YAML frontmatter)",
      }),
      scripts: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({
              description: "Script filename (e.g. 'run.sh', 'diagnose.py')",
            }),
            content: Type.Optional(
              Type.String({
                description:
                  "Updated script content. If omitted, the server preserves the existing file.",
              }),
            ),
          }),
          {
            description:
              "Scripts for the skill. Provide content for changed scripts, name-only for unchanged. Omit to delete.",
          },
        ),
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), { description: "Labels/tags for the skill (e.g. ['gpu', 'network', 'monitoring'])" })
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as UpdateSkillParams;

      if (!params.name?.trim()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Skill name is required." }),
            },
          ],
          details: { error: true },
        };
      }
      if (!params.specs?.trim()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Skill specs (SKILL.md content) is required.",
              }),
            },
          ],
          details: { error: true },
        };
      }

      const skillName = params.name.trim();

      // Reject if the target skill doesn't exist in the bundle (personal/team)
      if (!skillExistsInBundle(skillName)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Skill '${skillName}' not found. Cannot update a skill that doesn't exist. Use 'create_skill' to create a new skill, or check the skill name.`,
              }),
            },
          ],
          details: { error: true },
        };
      }

      const hasScripts = params.scripts && params.scripts.length > 0;
      const labels = params.labels?.map(l => l.trim()).filter(Boolean);
      const result = {
        skillId: params.id?.trim() || "",
        skill: {
          name: params.name.trim(),
          description: params.description?.trim() || "",
          type: params.type?.trim() || "Custom",
          specs: params.specs,
          scripts:
            params.scripts?.map((s) => ({
              name: s.name,
              content: s.content,
            })) || [],
          labels: labels && labels.length > 0 ? labels : undefined,
        },
        summary: `Updated skill definition '${params.name.trim()}'. Please review and click Update.`
          + (hasScripts ? ' Script changes will be staged for admin review. The old version remains active until approved. Do NOT attempt to test the new version until approved.' : ''),
        reviewNote: hasScripts
          ? "This update contains scripts and will enter STAGED review status. The OLD version of the skill remains active and usable, but the new version will NOT take effect until an admin approves it. Please inform the user that the update is awaiting admin approval."
          : undefined,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
}
