import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { loadConfig } from "../core/config.js";

interface ManageScheduleParams {
  action: "create" | "update" | "delete" | "pause" | "resume" | "rename" | "list";
  id?: string;
  name?: string;
  newName?: string;
  description?: string;
  schedule?: string;
  status?: "active" | "paused";
}

export function createManageScheduleTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "manage_schedule",
    label: "Manage Schedule",
    description: `Create, update, delete, pause, resume, rename, or list cron schedules for automated task execution.
This tool outputs a structured schedule definition. ALL actions are AUTO-EXECUTED immediately — no user confirmation needed.

IMPORTANT: An environment MUST be selected before using this tool. If no environment is selected, all actions will fail.
If the user has not selected an environment, ask them to select one first before proceeding.
All operations are scoped to the current environment — "list" only returns schedules in that environment, and mutations only affect schedules in that environment.

CRITICAL RESPONSE RULES:
- After calling this tool, tell the user the operation is DONE. Use past tense: "Created/Updated/Paused/Resumed/Deleted/Renamed".
- NEVER say "Click", "Confirm", "Update", "Save", or any similar call-to-action.
- NEVER ask the user to do anything to complete the operation — it is already completed automatically.
- Exception: "list" action returns current schedules as text.

Use this tool when the user asks you to:
- View current scheduled tasks (e.g. "view tasks", "what scheduled tasks are there", "list schedules") → action: "list"
- Set up a recurring/scheduled task (e.g. "run a health check every morning") → action: "create"
- Modify an existing schedule's timing or description → action: "update"
- Rename a schedule → action: "rename"
- Stop/pause a scheduled task (e.g. "stop this task", "pause") → action: "pause" (NOT delete!)
- Resume/restart a paused task (e.g. "start task", "resume") → action: "resume"
- Permanently delete a scheduled task (e.g. "delete task") → action: "delete"

IMPORTANT: When the user says "stop", "pause", use "pause" — NOT "delete".
Only use "delete" when the user explicitly says "delete".

Parameters:
- action: "create", "update", "delete", "pause", "resume", or "rename"
- id: the schedule ID. If unknown, pass the name instead — the UI will resolve it.
- name: schedule name (used for create, update, or to find a schedule when id is unknown)
- newName: new name for rename action
- description: what the scheduled task should do (natural language — the bot will execute this as a prompt)
- schedule: standard 5-field cron expression (min hour dom month dow)
- status: "active" or "paused"

Common cron patterns:
- Every minute: * * * * *
- Every hour: 0 * * * *
- Daily at 9am: 0 9 * * *
- Weekdays at 9am: 0 9 * * 1-5
- Weekly Sunday 2am: 0 2 * * 0
- Monthly 1st at midnight: 0 0 1 * *`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("rename"),
        Type.Literal("list"),
      ], { description: "The action to perform" }),
      id: Type.Optional(
        Type.String({ description: "Schedule ID. If unknown, pass name instead." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Schedule name (for create/update, or to find schedule when id is unknown)" }),
      ),
      newName: Type.Optional(
        Type.String({ description: "New name for rename action" }),
      ),
      description: Type.Optional(
        Type.String({ description: "What the scheduled task should do" }),
      ),
      schedule: Type.Optional(
        Type.String({ description: "Cron expression (min hour dom month dow)" }),
      ),
      status: Type.Optional(
        Type.Union([Type.Literal("active"), Type.Literal("paused")], {
          description: "Schedule status",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ManageScheduleParams;

      // List action: query Gateway for current schedules
      if (params.action === "list") {
        const cfg = loadConfig();
        const gatewayUrl = cfg.server.gatewayUrl || "http://siclaw-gateway";
        const userId = cfg.userId;
        try {
          const listUrl = `${gatewayUrl}/api/internal/cron-list?userId=${encodeURIComponent(userId)}`;
          const resp = await fetch(
            listUrl,
            { signal: AbortSignal.timeout(5_000) },
          );
          const data = (await resp.json()) as { jobs?: Array<{ id: string; name: string; schedule: string; status: string; description?: string | null; lastRunAt?: string | null; lastResult?: string | null }> };
          const jobs = data.jobs ?? [];
          if (jobs.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No scheduled tasks currently." }],
              details: {},
            };
          }
          const lines = jobs.map((j, i) => {
            const status = j.status === "active" ? "🟢 Running" : "⏸️ Paused";
            return `${i + 1}. **${j.name}** — ${status}\n   Cron: \`${j.schedule}\`${j.description ? `\n   Description: ${j.description}` : ""}${j.lastResult ? `\n   Last result: ${j.lastResult}` : ""}`;
          });
          return {
            content: [{ type: "text" as const, text: `Total ${jobs.length} scheduled task(s):\n\n${lines.join("\n\n")}` }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed to query scheduled tasks: ${err instanceof Error ? err.message : String(err)}` }],
            details: { error: true },
          };
        }
      }

      // Simple actions: delete, pause, resume, rename — just need id or name to locate
      if (params.action === "delete" || params.action === "pause" || params.action === "resume") {
        if (!params.id && !params.name) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Schedule ID or name is required for ${params.action}.` }) }],
            details: { error: true },
          };
        }
        const labels: Record<string, string> = { delete: "Deleted", pause: "Paused", resume: "Resumed" };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: params.action,
              id: params.id,
              name: params.name,
              summary: `${labels[params.action]} scheduled task "${params.name || params.id}".`,
            }),
          }],
          details: {},
        };
      }

      if (params.action === "rename") {
        if (!params.id && !params.name) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Schedule ID or current name is required for rename." }) }],
            details: { error: true },
          };
        }
        if (!params.newName?.trim()) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "New name is required for rename." }) }],
            details: { error: true },
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "rename",
              id: params.id,
              name: params.name,
              newName: params.newName.trim(),
              summary: `Renamed scheduled task "${params.name || params.id}" → "${params.newName.trim()}".`,
            }),
          }],
          details: {},
        };
      }

      // create / update — need full schedule info
      if (params.action === "update" && !params.id && !params.name) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Schedule ID or name is required for update." }) }],
          details: { error: true },
        };
      }

      if (!params.name?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Schedule name is required." }) }],
          details: { error: true },
        };
      }

      if (!params.schedule?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Cron schedule expression is required." }) }],
          details: { error: true },
        };
      }

      const result = {
        action: params.action,
        id: params.id,
        schedule: {
          name: params.name.trim(),
          description: params.description?.trim() || "",
          schedule: params.schedule.trim(),
          status: params.status || "active",
        },
        summary: params.action === "create"
          ? `Created scheduled task "${params.name.trim()}" (${params.schedule.trim()}).`
          : `Updated scheduled task "${params.name.trim()}" (${params.schedule.trim()}).`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
}
