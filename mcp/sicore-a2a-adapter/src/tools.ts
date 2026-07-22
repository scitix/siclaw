import type { SiclawA2aApi, SiclawTask, SiclawTaskList } from "./a2a-client.js";

const STATUS_TO_A2A: Record<string, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
  rejected: "TASK_STATE_REJECTED",
};

export const TOOL_DEFINITIONS = [
  {
    name: "siclaw_investigate",
    description: "Ask the configured Siclaw SRE agent to investigate an operational question. This creates an asynchronous Sicore A2A task. Reuse context_id to continue the same investigation; tasks with distinct context_ids run in parallel server-side, so submit independent hypotheses concurrently. If the returned task is not terminal, do not submit it again: call siclaw_wait_task until it finishes unless the user explicitly requested fire-and-forget. The configured A2A key fixes which Siclaw agent is used.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          description: "The concrete operational question for Siclaw, including relevant target names and time window when known.",
        },
        context_id: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Optional context_id from a prior task to continue the same Siclaw investigation session.",
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
    description: "Wait for an existing Siclaw investigation without creating another task. Use this as the same-turn watchdog: call it repeatedly while the task is non-terminal, unless the user asks to stop or the overall investigation deadline is exhausted. Working responses are compact; the full report is returned once the task reaches a terminal state.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1, maxLength: 255 },
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
    description: "Get one immediate snapshot of a Siclaw investigation task created with this same A2A key. Use siclaw_wait_task instead when actively waiting for completion.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "siclaw_cancel_task",
    description: "Cancel a non-terminal Siclaw investigation task created with this same A2A key.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "siclaw_list_tasks",
    description: "List Siclaw investigation tasks scoped to this configured agent and A2A key. Use this to recover task IDs after a local client restart.",
    inputSchema: {
      type: "object",
      properties: {
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

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type TaskToolView = Omit<SiclawTask, "result"> & {
  result?: string | null;
  progress_chars: number;
  wait_error?: string;
};

function taskView(task: SiclawTask, includeTerminalResult: boolean): TaskToolView {
  const { result, ...summary } = task;
  return {
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

function taskText(task: SiclawTask, waitError?: string): string {
  const lines = [
    `Siclaw task ${task.task_id}: ${task.state}`,
    `context_id: ${task.context_id}`,
  ];
  if (task.updated_at) lines.push(`updated_at: ${task.updated_at}`);
  if (task.status_message) lines.push(`status: ${task.status_message}`);
  if (waitError) lines.push(`wait_error: ${waitError} (status polling failed, but the task was already created)`);
  if (task.is_terminal && task.result) lines.push("", task.result);
  if (!task.is_terminal) {
    const progressChars = task.result?.length ?? 0;
    if (progressChars > 0) lines.push(`progress_chars: ${progressChars} (partial report withheld until terminal)`);
    lines.push("", "The investigation is still running. Call siclaw_wait_task with the task_id; do not submit the same investigation again.");
  }
  return lines.join("\n");
}

function taskResult(task: SiclawTask, waitError?: string): ToolResult {
  const view = taskView(task, true);
  if (waitError) view.wait_error = waitError;
  return {
    content: [{ type: "text", text: taskText(task, waitError) }],
    structuredContent: view as unknown as Record<string, unknown>,
  };
}

function listText(list: SiclawTaskList): string {
  if (list.tasks.length === 0) return "No Siclaw tasks matched this query.";
  const rows = list.tasks.map((task) => `${task.task_id}\t${task.state}\tcontext=${task.context_id}`);
  return [`Siclaw tasks (${list.tasks.length}/${list.total_size}):`, ...rows].join("\n");
}

export function createToolHandler(api: SiclawA2aApi) {
  return async (name: string, rawArgs: unknown): Promise<ToolResult> => {
    try {
      const args = argsRecord(rawArgs ?? {});
      if (name === "siclaw_investigate") {
        const question = stringArg(args, "question", true)!;
        if (Buffer.byteLength(question, "utf8") > 512 * 1024) {
          throw new Error("question must be 512 KiB or less");
        }
        const contextId = stringArg(args, "context_id");
        const waitSeconds = intArg(args, "wait_seconds", 20, 0, 50);
        const submitted = await api.sendMessage(question, contextId);
        if (waitSeconds === 0 || submitted.is_terminal) return taskResult(submitted);
        try {
          return taskResult(await api.waitForTask(submitted.task_id, waitSeconds));
        } catch (error) {
          // The task exists server-side at this point; a plain error would drop the
          // task_id and invite the client to resubmit a duplicate investigation.
          return taskResult(submitted, error instanceof Error ? error.message : String(error));
        }
      }
      if (name === "siclaw_get_task") {
        return taskResult(await api.getTask(stringArg(args, "task_id", true)!));
      }
      if (name === "siclaw_wait_task") {
        const taskId = stringArg(args, "task_id", true)!;
        const waitSeconds = intArg(args, "wait_seconds", 45, 1, 50);
        return taskResult(await api.waitForTask(taskId, waitSeconds));
      }
      if (name === "siclaw_cancel_task") {
        return taskResult(await api.cancelTask(stringArg(args, "task_id", true)!));
      }
      if (name === "siclaw_list_tasks") {
        const status = stringArg(args, "status");
        if (status && !STATUS_TO_A2A[status]) throw new Error("status is invalid");
        const list = await api.listTasks({
          contextId: stringArg(args, "context_id"),
          status: status ? STATUS_TO_A2A[status] : undefined,
          pageSize: intArg(args, "page_size", 20, 1, 100),
          pageToken: intArg(args, "page_token", 0, 0, Number.MAX_SAFE_INTEGER),
        });
        return {
          content: [{ type: "text", text: listText(list) }],
          structuredContent: {
            ...list,
            tasks: list.tasks.map((task) => taskView(task, false)),
          } as unknown as Record<string, unknown>,
        };
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
