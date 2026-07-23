import type { SiclawTask } from "./a2a-client.js";
import { ALIAS_PATTERN } from "./config.js";
import type { AgentRouter } from "./router.js";

const STATUS_TO_A2A: Record<string, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
  rejected: "TASK_STATE_REJECTED",
};

function agentHint(router: AgentRouter): string {
  if (router.isSingle) {
    return `Only one Siclaw agent is configured (${router.describeAgents()}); "agent" may be omitted.`;
  }
  return `Configured Siclaw agents (pass one as "agent"): ${router.describeAgents()}.`;
}

function agentProperty(router: AgentRouter) {
  return {
    type: "string",
    pattern: ALIAS_PATTERN,
    description:
      `Which configured Siclaw agent to use, selected by alias (never a key). ${agentHint(router)}`,
  } as const;
}

export function buildToolDefinitions(router: AgentRouter) {
  const agent = agentProperty(router);
  const multi = !router.isSingle;
  const hint = agentHint(router);
  const requireAgent = multi ? ` You must pass "agent" because more than one agent is configured.` : "";
  const routeNote = ` If "agent" is omitted, the adapter routes to the agent that created the task.`;
  const listNote = multi
    ? ` Without "agent" it aggregates tasks from every configured agent and tags each with its alias; with "agent" it lists only that agent's tasks.`
    : ` Tasks are tagged with the configured agent's alias.`;

  return [
    {
      name: "siclaw_investigate",
      description:
        "Ask the configured Siclaw SRE agent to investigate an operational question. This creates an asynchronous Sicore A2A task. Reuse context_id to continue the same investigation. If the returned task is not terminal, do not submit it again: call siclaw_wait_task until it finishes unless the user explicitly requested fire-and-forget. The A2A key selected by \"agent\" fixes which Siclaw agent is used."
        + ` ${hint}${requireAgent}`,
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            minLength: 1,
            description: "The concrete operational question for Siclaw, including relevant target names and time window when known.",
          },
          agent,
          context_id: {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description: "Optional context_id from a prior task to continue the same Siclaw investigation session. It belongs to the same agent that created it.",
          },
          wait_seconds: {
            type: "integer",
            minimum: 0,
            maximum: 50,
            default: 20,
            description: "How long to wait for a terminal result before returning the task as working. The 50-second ceiling stays below common MCP client request timeouts; use siclaw_wait_task later when it is still running.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    {
      name: "siclaw_wait_task",
      description:
        "Wait for an existing Siclaw investigation without creating another task. Use this as the same-turn watchdog: call it repeatedly while the task is non-terminal, unless the user asks to stop or the overall investigation deadline is exhausted. Working responses are compact; the full report is returned once the task reaches a terminal state."
        + ` ${hint}${routeNote}`,
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 255 },
          agent,
          wait_seconds: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 45,
            description: "Bounded watchdog wait. Keep this below the MCP client's request timeout.",
          },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "siclaw_get_task",
      description:
        "Get one immediate snapshot of a Siclaw investigation task. Use siclaw_wait_task instead when actively waiting for completion."
        + ` ${hint}${routeNote}`,
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 255 },
          agent,
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "siclaw_cancel_task",
      description:
        "Cancel a non-terminal Siclaw investigation task."
        + ` ${hint}${routeNote}`,
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 255 },
          agent,
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "siclaw_list_tasks",
      description:
        "List Siclaw investigation tasks. Use this to recover task IDs after a local client restart."
        + ` ${hint}${listNote}`,
      inputSchema: {
        type: "object",
        properties: {
          agent,
          context_id: { type: "string", minLength: 1, maxLength: 255 },
          status: {
            type: "string",
            enum: ["submitted", "working", "completed", "failed", "canceled", "rejected"],
          },
          page_size: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          page_token: { type: "integer", minimum: 0, default: 0 },
        },
        additionalProperties: false,
      },
    },
  ] as const;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type TaskToolView = Omit<SiclawTask, "result"> & {
  agent: string;
  result?: string | null;
  progress_chars: number;
  routing_note?: string;
  wait_error?: string;
};

function taskView(task: SiclawTask, alias: string, includeTerminalResult: boolean): TaskToolView {
  const { result, ...summary } = task;
  return {
    agent: alias,
    ...summary,
    progress_chars: result?.length ?? 0,
    ...(includeTerminalResult && task.is_terminal ? { result } : {}),
  };
}

function argsRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") > 255 && name !== "question") {
    throw new Error(`${name} must be 255 bytes or less`);
  }
  return trimmed;
}

function intArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

interface TaskAnnotations {
  waitError?: string;
  routingNote?: string;
}

function taskText(task: SiclawTask, alias: string, notes: TaskAnnotations = {}): string {
  const lines = [
    `Siclaw task ${task.task_id}: ${task.state}`,
    `agent: ${alias}`,
    `context_id: ${task.context_id}`,
  ];
  if (task.updated_at) lines.push(`updated_at: ${task.updated_at}`);
  if (task.status_message) lines.push(`status: ${task.status_message}`);
  if (notes.routingNote) lines.push(`routing_note: ${notes.routingNote}`);
  if (notes.waitError) lines.push(`wait_error: ${notes.waitError} (status polling failed, but the task was already created)`);
  if (task.is_terminal && task.result) lines.push("", task.result);
  if (!task.is_terminal) {
    const progressChars = task.result?.length ?? 0;
    if (progressChars > 0) lines.push(`progress_chars: ${progressChars} (partial report withheld until terminal)`);
    lines.push("", "The investigation is still running. Call siclaw_wait_task with the task_id; do not submit the same investigation again.");
  }
  return lines.join("\n");
}

function taskResult(task: SiclawTask, alias: string, notes: TaskAnnotations = {}): ToolResult {
  const view = taskView(task, alias, true);
  if (notes.routingNote) view.routing_note = notes.routingNote;
  if (notes.waitError) view.wait_error = notes.waitError;
  return {
    content: [{ type: "text", text: taskText(task, alias, notes) }],
    structuredContent: view as unknown as Record<string, unknown>,
  };
}

interface TaggedTask {
  task: SiclawTask;
  alias: string;
}

function listResult(
  tagged: TaggedTask[],
  meta: { totalSize: number; pageSize: number; nextPageToken: number | null; truncatedAgents?: string[] },
): ToolResult {
  const lines: string[] = [];
  if (tagged.length === 0) {
    lines.push("No Siclaw tasks matched this query.");
  } else {
    lines.push(`Siclaw tasks (${tagged.length}/${meta.totalSize}):`);
    for (const { task, alias } of tagged) {
      lines.push(`${task.task_id}\t${task.state}\tagent=${alias}\tcontext=${task.context_id}`);
    }
  }
  if (meta.truncatedAgents && meta.truncatedAgents.length > 0) {
    lines.push(
      "",
      `More tasks exist for agents: ${meta.truncatedAgents.join(", ")}. `
      + "Query siclaw_list_tasks again with that agent and page_token to page through them.",
    );
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      tasks: tagged.map(({ task, alias }) => taskView(task, alias, false)),
      total_size: meta.totalSize,
      page_size: meta.pageSize,
      next_page_token: meta.nextPageToken,
      ...(meta.truncatedAgents && meta.truncatedAgents.length > 0
        ? { truncated_agents: meta.truncatedAgents }
        : {}),
    } as unknown as Record<string, unknown>,
  };
}

export function createToolHandler(router: AgentRouter) {
  return async (name: string, rawArgs: unknown): Promise<ToolResult> => {
    try {
      const args = argsRecord(rawArgs ?? {});
      const agentArg = stringArg(args, "agent");

      if (name === "siclaw_investigate") {
        const entry = router.selectExplicit(agentArg);
        const question = stringArg(args, "question", true)!;
        if (Buffer.byteLength(question, "utf8") > 512 * 1024) {
          throw new Error("question must be 512 KiB or less");
        }
        const contextId = stringArg(args, "context_id");
        const waitSeconds = intArg(args, "wait_seconds", 20, 0, 50);
        const submitted = await entry.api.sendMessage(question, contextId);
        router.remember(submitted.task_id, entry.alias);
        if (waitSeconds === 0 || submitted.is_terminal) return taskResult(submitted, entry.alias);
        try {
          const done = await entry.api.waitForTask(submitted.task_id, waitSeconds);
          router.remember(done.task_id, entry.alias);
          return taskResult(done, entry.alias);
        } catch (error) {
          // The task exists server-side at this point; a plain error would drop the
          // task_id and invite the client to resubmit a duplicate investigation.
          return taskResult(submitted, entry.alias, {
            waitError: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (name === "siclaw_get_task") {
        const taskId = stringArg(args, "task_id", true)!;
        const { entry, note } = router.selectForTask(taskId, agentArg);
        const task = await entry.api.getTask(taskId);
        router.remember(task.task_id, entry.alias);
        return taskResult(task, entry.alias, { routingNote: note });
      }

      if (name === "siclaw_wait_task") {
        const taskId = stringArg(args, "task_id", true)!;
        const waitSeconds = intArg(args, "wait_seconds", 45, 1, 50);
        const { entry, note } = router.selectForTask(taskId, agentArg);
        const task = await entry.api.waitForTask(taskId, waitSeconds);
        router.remember(task.task_id, entry.alias);
        return taskResult(task, entry.alias, { routingNote: note });
      }

      if (name === "siclaw_cancel_task") {
        const taskId = stringArg(args, "task_id", true)!;
        const { entry, note } = router.selectForTask(taskId, agentArg);
        const task = await entry.api.cancelTask(taskId);
        router.remember(task.task_id, entry.alias);
        return taskResult(task, entry.alias, { routingNote: note });
      }

      if (name === "siclaw_list_tasks") {
        const status = stringArg(args, "status");
        if (status && !STATUS_TO_A2A[status]) throw new Error("status is invalid");
        const options = {
          contextId: stringArg(args, "context_id"),
          status: status ? STATUS_TO_A2A[status] : undefined,
          pageSize: intArg(args, "page_size", 20, 1, 100),
          pageToken: intArg(args, "page_token", 0, 0, Number.MAX_SAFE_INTEGER),
        };

        // Aggregate across every agent only when none is named and several exist.
        if (agentArg === undefined && !router.isSingle) {
          const perAgent = await Promise.all(
            router.listEntries().map(async (entry) => ({ entry, list: await entry.api.listTasks(options) })),
          );
          const tagged: TaggedTask[] = [];
          const truncatedAgents: string[] = [];
          let totalSize = 0;
          for (const { entry, list } of perAgent) {
            for (const task of list.tasks) {
              router.remember(task.task_id, entry.alias);
              tagged.push({ task, alias: entry.alias });
            }
            totalSize += list.total_size;
            if (list.next_page_token !== null) truncatedAgents.push(entry.alias);
          }
          // A combined cursor across agents would be meaningless; page per agent instead.
          return listResult(tagged, {
            totalSize,
            pageSize: options.pageSize,
            nextPageToken: null,
            truncatedAgents,
          });
        }

        const entry = router.selectExplicit(agentArg);
        const list = await entry.api.listTasks(options);
        for (const task of list.tasks) router.remember(task.task_id, entry.alias);
        return listResult(
          list.tasks.map((task) => ({ task, alias: entry.alias })),
          { totalSize: list.total_size, pageSize: list.page_size, nextPageToken: list.next_page_token },
        );
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  };
}
