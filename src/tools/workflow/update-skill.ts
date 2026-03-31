import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { skillExistsInBundle } from "../infra/script-resolver.js";

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

**Skill directories are read-only. All skill modifications must go through skill management tools (create_skill, update_skill, fork_skill).**

This tool outputs a structured skill update that the user can preview and confirm. It does NOT persist anything — the user must confirm via the UI.

Use this tool (NOT create_skill) when the user asks to modify, update, change, or fix an existing skill. This includes:
- When the user message contains \`[Skill: <name>]\` context from the UI (the user selected a skill to edit)
- When the user asks to change a skill that was created earlier in the conversation
- When the user asks to modify or replace an existing skill

**Identify the target skill FIRST**:
Before calling this tool, you MUST know the exact name of the skill to update. Check \`<available_skills>\` in your system prompt, or \`read\` the skill's SKILL.md for details. If the user's request is ambiguous, ASK them to clarify which skill they mean.

## Environments and Approval Workflow

| Environment | Behavior |
|-------------|----------|
| **Dev / Test** | Updated content (working copy) is immediately visible and testable. |
| **Production** | Only the **approved** version is active. Updates enter a staged review state and the OLD version remains in use until the new version is approved. |

- When scripts are changed, the update enters a **staged review** state and requires admin approval before the new version becomes active in production.
- The **old version** of the skill remains usable in production during review.
- In dev/test, the working copy is immediately available for testing.
- After updating in production context, inform the user that the update is pending review.

Parameters:
- id: The skill ID from the UI context, OR the skill's kebab-case name (for name-based lookup).
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
| \`local_script\` | Local (AgentBox) | Scripts that call kubectl from outside the cluster (most common) |
| \`node_script\` | On a K8s node (host namespaces) | Scripts needing host tools, filesystem, /proc, /sys, devices |
| \`pod_script\` | Inside a pod (kubectl exec) | Scripts running diagnostics inside a running pod |
| \`node_script\` + \`netns\` | Node + pod's network namespace | Network diagnostics needing host tools + pod's network view (use \`resolve_pod_netns\` first) |

In the SKILL.md, document the tool in a "## Tool" section. Examples:

### local_script (local execution, calls kubectl)
\`\`\`
## Tool
local_script: skill="find-node", script="find-node.sh", args="<keyword>"
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

### node_script + netns (pod network namespace + host tools)
\`\`\`
## Tool
First resolve the pod's network namespace, then run with netns param:
resolve_pod_netns: pod="<pod>", namespace="<ns>"
node_script: node="<node>", netns="<netns>", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1"
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

      // Reject if the target skill doesn't exist in the bundle (personal/global)
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
          ? "This update contains scripts and will enter STAGED review status. The OLD version of the skill remains active and usable, but the new version will NOT take effect in production until an admin approves it. Tip: the user can switch to a test workspace to debug the updated skill immediately without waiting for approval. Please inform the user about both the approval requirement and the test workspace option."
          : undefined,
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
  create: (_refs) => createUpdateSkillTool(),
  modes: ["web"],
};
