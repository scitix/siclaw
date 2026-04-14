import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../../core/types.js";
import { loadConfig } from "../../core/config.js";
import { GatewayClient } from "../../agentbox/gateway-client.js";
import { parseCronExpression, getAverageIntervalMs } from "../../cron/cron-matcher.js";
import { CRON_LIMITS } from "../../cron/cron-limits.js";

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

NOTE: The "list" action returns schedules scoped to the current agent.
For mutation actions (create, update, delete, pause, resume, rename), the frontend handles agent binding automatically.

CRITICAL — LANGUAGE: The "name" and "description" fields MUST be written in the SAME language the user is speaking.
If the user speaks Korean, write in Korean. If Japanese, write in Japanese. Match the user's language exactly. This directly controls the language of the scheduled task's output.

CRITICAL — TARGET CONTEXT: When creating or updating a schedule, you MUST include the specific target in the description field.
The description must be a self-contained instruction that clearly specifies WHAT to operate on:
- For Kubernetes tasks: include the cluster/environment name and namespace (e.g. "Check abnormal pods in the default namespace of the roce-production cluster")
- For host tasks: include the hostname or IP (e.g. "Check disk usage on host web-server-01")
- For service tasks: include the service name (e.g. "Verify API health of payment-service")
The scheduled task runs autonomously with no user interaction — if the target is ambiguous, the task WILL fail or produce wrong results.

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

IMPORTANT: Minimum schedule interval is ${Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000)} minutes. Schedules more frequent than this will be rejected. Do NOT attempt shorter intervals.

Common cron patterns:
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
        Type.String({ description: "Schedule ID (UUID). Only use if you obtained the exact ID from a previous list result. Otherwise omit and use name." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Schedule name (for create/update, or to find schedule when id is unknown)" }),
      ),
      newName: Type.Optional(
        Type.String({ description: "New name for rename action" }),
      ),
      description: Type.Optional(
        Type.String({ description: "Self-contained instruction including the specific target (cluster name, hostname, service, etc.) and the action to perform. Must be unambiguous enough to run without user interaction." }),
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

      const cfg = loadConfig();
      const gatewayUrl = cfg.server.gatewayUrl || `http://localhost:${cfg.server.port}`;
      const client = new GatewayClient({ gatewayUrl });

      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
        details: { error: true },
      });
      const ok = (summary: string) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ summary }) }],
        details: {},
      });

      // Resolve an id either from params.id or by looking up by name via list.
      const resolveId = async (): Promise<{ id: string; name: string } | null> => {
        if (params.id) {
          // We still need the name for the summary message — list once to find it.
          try {
            const list = await client.listAgentTasks();
            const hit = list.find((t) => t.id === params.id);
            if (hit) return { id: hit.id, name: hit.name };
            return { id: params.id, name: params.id };
          } catch { return { id: params.id, name: params.id }; }
        }
        if (!params.name) return null;
        const list = await client.listAgentTasks();
        const match = list.find((t) => t.name === params.name);
        return match ? { id: match.id, name: match.name } : null;
      };

      const validateSchedule = (schedule: string) => {
        parseCronExpression(schedule);
        const { avg, min } = getAverageIntervalMs(schedule, CRON_LIMITS.INTERVAL_SAMPLE_COUNT);
        const limitMin = Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000);
        if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
          throw new Error(`Schedule interval too short: minimum ${limitMin} minutes between executions`);
        }
        if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
          const floorMin = Math.round(CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60_000);
          throw new Error(`Schedule has burst firing: minimum gap between executions must be at least ${floorMin} minutes (average interval must be at least ${limitMin} minutes)`);
        }
      };

      try {
        if (params.action === "list") {
          const tasks = await client.listAgentTasks();
          if (tasks.length === 0) {
            return { content: [{ type: "text", text: "No scheduled tasks currently." }], details: {} };
          }
          const lines = tasks.map((t, i) => {
            const status = t.status === "active" ? "🟢 Running" : "⏸️ Paused";
            return `${i + 1}. **${t.name}** — ${status}\n   Cron: \`${t.schedule}\`${t.description ? `\n   Description: ${t.description}` : ""}${t.lastResult ? `\n   Last result: ${t.lastResult}` : ""}`;
          });
          return {
            content: [{ type: "text", text: `Total ${tasks.length} scheduled task(s):\n\n${lines.join("\n\n")}` }],
            details: {},
          };
        }

        if (params.action === "create") {
          if (!params.name?.trim()) return fail("Schedule name is required.");
          if (!params.schedule?.trim()) return fail("Cron schedule expression is required.");
          validateSchedule(params.schedule.trim());
          await client.createAgentTask({
            name: params.name.trim(),
            schedule: params.schedule.trim(),
            prompt: params.description?.trim() || params.name.trim(),
            description: params.description?.trim(),
            status: params.status ?? "active",
          });
          return ok(`Created scheduled task "${params.name.trim()}" (${params.schedule.trim()}).`);
        }

        if (params.action === "update") {
          const target = await resolveId();
          if (!target) return fail("Schedule ID or name is required for update.");
          if (params.schedule?.trim()) validateSchedule(params.schedule.trim());
          await client.updateAgentTask(target.id, {
            name: params.name?.trim(),
            schedule: params.schedule?.trim(),
            prompt: params.description?.trim(),
            description: params.description?.trim(),
            status: params.status,
          });
          return ok(`Updated scheduled task "${target.name}".`);
        }

        if (params.action === "delete") {
          const target = await resolveId();
          if (!target) return fail("Schedule ID or name is required for delete.");
          await client.deleteAgentTask(target.id);
          return ok(`Deleted scheduled task "${target.name}".`);
        }

        if (params.action === "pause" || params.action === "resume") {
          const target = await resolveId();
          if (!target) return fail(`Schedule ID or name is required for ${params.action}.`);
          await client.updateAgentTask(target.id, {
            status: params.action === "pause" ? "paused" : "active",
          });
          return ok(`${params.action === "pause" ? "Paused" : "Resumed"} scheduled task "${target.name}".`);
        }

        if (params.action === "rename") {
          const target = await resolveId();
          if (!target) return fail("Schedule ID or current name is required for rename.");
          if (!params.newName?.trim()) return fail("New name is required for rename.");
          await client.updateAgentTask(target.id, { name: params.newName.trim() });
          return ok(`Renamed scheduled task "${target.name}" → "${params.newName.trim()}".`);
        }

        return fail(`Unknown action: ${params.action}`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createManageScheduleTool(refs.kubeconfigRef),
  modes: ["web", "channel"],
  platform: true,
};
