import { setTimeout as delay } from "node:timers/promises";
import type { AdapterConfig } from "./config.js";

export const TERMINAL_A2A_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

const SIMPLE_STATE: Record<string, SiclawTaskState> = {
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "canceled",
  TASK_STATE_REJECTED: "rejected",
};

export type SiclawTaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "unknown";

export interface SiclawTask {
  task_id: string;
  context_id: string;
  state: SiclawTaskState;
  a2a_state: string;
  is_terminal: boolean;
  status_message: string | null;
  result: string | null;
  error: string | null;
  updated_at: string | null;
}

export interface SiclawTaskList {
  tasks: SiclawTask[];
  total_size: number;
  page_size: number;
  next_page_token: string | null;
}

export interface ListTaskOptions {
  contextId?: string;
  status?: string;
  pageSize?: number;
  pageToken?: number;
}

export interface SiclawA2aApi {
  sendMessage(question: string, contextId?: string): Promise<SiclawTask>;
  getTask(taskId: string): Promise<SiclawTask>;
  cancelTask(taskId: string): Promise<SiclawTask>;
  listTasks(options?: ListTaskOptions): Promise<SiclawTaskList>;
  waitForTask(taskId: string, waitSeconds: number): Promise<SiclawTask>;
}

interface A2aErrorEnvelope {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: Array<{ reason?: string }>;
  };
}

export class A2aClientError extends Error {
  readonly httpStatus: number | null;
  readonly reason: string;
  readonly retriable: boolean;

  constructor(message: string, options: { httpStatus?: number; reason?: string; retriable?: boolean } = {}) {
    super(message);
    this.name = "A2aClientError";
    this.httpStatus = options.httpStatus ?? null;
    this.reason = options.reason ?? "A2A_REQUEST_FAILED";
    this.retriable = options.retriable ?? false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record && typeof record.text === "string" && record.text.trim()) out.push(record.text);
  }
  return out;
}

function statusMessage(task: Record<string, unknown>): string | null {
  const status = asRecord(task.status);
  const message = asRecord(status?.message);
  const text = textParts(message?.parts).join("\n\n").trim();
  return text || null;
}

function artifactText(task: Record<string, unknown>): string | null {
  if (!Array.isArray(task.artifacts)) return null;
  const parts: string[] = [];
  for (const artifactValue of task.artifacts) {
    const artifact = asRecord(artifactValue);
    parts.push(...textParts(artifact?.parts));
  }
  const text = parts.join("\n\n").trim();
  return text || null;
}

export function normalizeTask(value: unknown): SiclawTask {
  const task = asRecord(value);
  if (!task || typeof task.id !== "string" || !task.id) {
    throw new A2aClientError("Sicore returned an invalid A2A task", { reason: "INVALID_A2A_RESPONSE" });
  }
  const status = asRecord(task.status);
  const rawState = typeof status?.state === "string" ? status.state : "TASK_STATE_UNSPECIFIED";
  const message = statusMessage(task);
  const state = SIMPLE_STATE[rawState] ?? "unknown";
  const failed = state === "failed" || state === "rejected";
  return {
    task_id: task.id,
    context_id: typeof task.contextId === "string" ? task.contextId : "",
    state,
    a2a_state: rawState,
    is_terminal: TERMINAL_A2A_STATES.has(rawState),
    status_message: message,
    result: artifactText(task),
    error: failed ? message ?? "Siclaw task failed" : null,
    updated_at: typeof status?.timestamp === "string" ? status.timestamp : null,
  };
}

function errorFromResponse(status: number, payload: unknown): A2aClientError {
  const envelope = payload as A2aErrorEnvelope;
  const message = envelope?.error?.message || `Sicore A2A request failed with HTTP ${status}`;
  const reason = envelope?.error?.details?.[0]?.reason || envelope?.error?.status || "A2A_REQUEST_FAILED";
  return new A2aClientError(message, {
    httpStatus: status,
    reason,
    retriable: status === 429 || status === 502 || status === 503 || status === 504,
  });
}

export class SicoreA2aClient implements SiclawA2aApi {
  private readonly agentBaseUrl: string;

  constructor(
    private readonly config: AdapterConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.agentBaseUrl = `${config.baseUrl}/api/v1/a2a/agents/${encodeURIComponent(config.agentId)}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    timer.unref();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.agentBaseUrl}${path}`, {
          method,
          headers: {
            accept: "application/a2a+json, application/json",
            authorization: `Bearer ${this.config.apiKey}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new A2aClientError("Sicore A2A request timed out", {
            reason: "A2A_TIMEOUT",
            retriable: true,
          });
        }
        throw new A2aClientError(
          `Could not reach Sicore A2A endpoint: ${error instanceof Error ? error.message : String(error)}`,
          { reason: "A2A_UNREACHABLE", retriable: true },
        );
      }

      const raw = await response.text();
      let payload: unknown = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new A2aClientError("Sicore returned a non-JSON A2A response", {
            httpStatus: response.status,
            reason: "INVALID_A2A_RESPONSE",
            retriable: response.status >= 500,
          });
        }
      }
      if (!response.ok) throw errorFromResponse(response.status, payload);
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendMessage(question: string, contextId?: string): Promise<SiclawTask> {
    const payload = await this.request<{ task?: unknown }>("POST", "/message:send", {
      message: {
        role: "ROLE_USER",
        parts: [{ text: question }],
        ...(contextId ? { contextId } : {}),
      },
    });
    return normalizeTask(payload.task);
  }

  async getTask(taskId: string): Promise<SiclawTask> {
    const payload = await this.request<{ task?: unknown }>("GET", `/tasks/${encodeURIComponent(taskId)}`);
    return normalizeTask(payload.task);
  }

  async cancelTask(taskId: string): Promise<SiclawTask> {
    const payload = await this.request<{ task?: unknown }>("POST", `/tasks/${encodeURIComponent(taskId)}:cancel`);
    return normalizeTask(payload.task);
  }

  async listTasks(options: ListTaskOptions = {}): Promise<SiclawTaskList> {
    const query = new URLSearchParams();
    if (options.contextId) query.set("contextId", options.contextId);
    if (options.status) query.set("status", options.status);
    if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
    if (options.pageToken !== undefined) query.set("pageToken", String(options.pageToken));
    const suffix = query.size > 0 ? `?${query}` : "";
    const payload = await this.request<{
      tasks?: unknown[];
      totalSize?: number;
      pageSize?: number;
      nextPageToken?: string;
    }>("GET", `/tasks${suffix}`);
    return {
      tasks: Array.isArray(payload.tasks) ? payload.tasks.map(normalizeTask) : [],
      total_size: typeof payload.totalSize === "number" ? payload.totalSize : 0,
      page_size: typeof payload.pageSize === "number" ? payload.pageSize : 0,
      next_page_token: payload.nextPageToken ? payload.nextPageToken : null,
    };
  }

  async waitForTask(taskId: string, waitSeconds: number): Promise<SiclawTask> {
    let current = await this.getTask(taskId);
    if (current.is_terminal || waitSeconds <= 0) return current;
    const deadline = Date.now() + waitSeconds * 1_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await delay(Math.min(this.config.pollIntervalMs, Math.max(remaining, 0)));
      current = await this.getTask(taskId);
      if (current.is_terminal) return current;
    }
    return current;
  }
}
