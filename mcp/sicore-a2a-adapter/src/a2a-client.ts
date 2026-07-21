import { setTimeout as delay } from "node:timers/promises";
import type { AdapterConfig, ResolvedAdapterConfig } from "./config.js";

export const TERMINAL_A2A_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

const READ_RETRY_DELAYS_MS = [100, 300] as const;

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
  next_page_token: number | null;
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
    retriable: isRetriableHttpStatus(status),
  });
}

function isRetriableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500
    || status === 502 || status === 503 || status === 504;
}

function normalizeNextPageToken(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const token = typeof value === "number"
    ? value
    : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(token) || token < 0) {
    throw new A2aClientError("Sicore returned an invalid A2A page token", {
      reason: "INVALID_A2A_RESPONSE",
    });
  }
  return token;
}

async function a2aRequest<T>(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  method: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref();
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: "application/a2a+json, application/json",
          authorization: `Bearer ${apiKey}`,
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

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new A2aClientError(
        `Could not read Sicore A2A response: ${error instanceof Error ? error.message : String(error)}`,
        {
          httpStatus: response.status,
          reason: "A2A_RESPONSE_READ_FAILED",
          retriable: method === "GET",
        },
      );
    }
    let payload: unknown = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new A2aClientError("Sicore returned a non-JSON A2A response", {
          httpStatus: response.status,
          reason: "INVALID_A2A_RESPONSE",
          retriable: method === "GET" && (response.ok || isRetriableHttpStatus(response.status)),
        });
      }
    }
    if (!response.ok) throw errorFromResponse(response.status, payload);
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

async function retryIdempotentRead<T>(
  requestTimeoutMs: number,
  operation: (timeoutMs: number) => Promise<T>,
  overallDeadline?: number,
): Promise<T> {
  const operationDeadline = Math.min(
    overallDeadline ?? Number.POSITIVE_INFINITY,
    Date.now() + requestTimeoutMs,
  );
  let lastError: A2aClientError | null = null;

  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    const remaining = operationDeadline - Date.now();
    if (remaining <= 0) {
      throw lastError ?? new A2aClientError("Sicore A2A request timed out", {
        reason: "A2A_TIMEOUT",
        retriable: true,
      });
    }
    try {
      return await operation(remaining);
    } catch (error) {
      if (!(error instanceof A2aClientError) || !error.retriable) throw error;
      lastError = error;
      const retryDelayMs = READ_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || Date.now() + retryDelayMs >= operationDeadline) throw error;
      await delay(retryDelayMs);
    }
  }

  throw lastError ?? new A2aClientError("Sicore A2A read failed");
}

// resolveAgentId asks Sicore which agent the configured key is bound to
// (GET /api/v1/a2a/self). Keys are per-agent, so this spares the operator
// from copying the agent UUID into client config. Older Sicore deployments
// without the endpoint require SICLAW_AGENT_ID to be set explicitly.
export async function resolveAgentId(
  config: AdapterConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  let payload: { agentId?: unknown } | null;
  try {
    payload = await retryIdempotentRead(config.requestTimeoutMs, (timeoutMs) =>
      a2aRequest(fetchImpl, config.apiKey, `${config.baseUrl}/api/v1/a2a/self`, "GET", undefined, timeoutMs));
  } catch (error) {
    if (error instanceof A2aClientError && error.httpStatus === 404) {
      throw new A2aClientError(
        "This Sicore does not support key self-resolution (GET /api/v1/a2a/self); set SICLAW_AGENT_ID explicitly",
        { httpStatus: 404, reason: "SELF_RESOLUTION_UNSUPPORTED" },
      );
    }
    throw error;
  }
  const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
  if (!agentId) {
    throw new A2aClientError("Sicore /self returned no agentId", { reason: "INVALID_A2A_RESPONSE" });
  }
  return agentId;
}

export class SicoreA2aClient implements SiclawA2aApi {
  private readonly agentBaseUrl: string;

  constructor(
    private readonly config: ResolvedAdapterConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.agentBaseUrl = `${config.baseUrl}/api/v1/a2a/agents/${encodeURIComponent(config.agentId)}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.config.requestTimeoutMs,
  ): Promise<T> {
    return a2aRequest(this.fetchImpl, this.config.apiKey, `${this.agentBaseUrl}${path}`, method, body, timeoutMs);
  }

  private async readWithRetry<T>(
    operation: (timeoutMs: number) => Promise<T>,
    overallDeadline?: number,
  ): Promise<T> {
    return retryIdempotentRead(this.config.requestTimeoutMs, operation, overallDeadline);
  }

  private async loadTask(taskId: string, overallDeadline?: number): Promise<SiclawTask> {
    return this.readWithRetry(async (timeoutMs) => {
      const payload = await this.request<{ task?: unknown }>(
        "GET",
        `/tasks/${encodeURIComponent(taskId)}`,
        undefined,
        timeoutMs,
      );
      return normalizeTask(payload.task);
    }, overallDeadline);
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
    return this.loadTask(taskId);
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
    return this.readWithRetry(async (timeoutMs) => {
      const payload = await this.request<{
        tasks?: unknown[];
        totalSize?: number;
        pageSize?: number;
        nextPageToken?: unknown;
      }>("GET", `/tasks${suffix}`, undefined, timeoutMs);
      return {
        tasks: Array.isArray(payload.tasks) ? payload.tasks.map(normalizeTask) : [],
        total_size: typeof payload.totalSize === "number" ? payload.totalSize : 0,
        page_size: typeof payload.pageSize === "number" ? payload.pageSize : 0,
        next_page_token: normalizeNextPageToken(payload.nextPageToken),
      };
    });
  }

  async waitForTask(taskId: string, waitSeconds: number): Promise<SiclawTask> {
    if (waitSeconds <= 0) return this.getTask(taskId);
    const deadline = Date.now() + waitSeconds * 1_000;
    let current: SiclawTask | null = null;
    let lastError: A2aClientError | null = null;

    while (Date.now() < deadline) {
      try {
        current = await this.loadTask(taskId, deadline);
        lastError = null;
      } catch (error) {
        if (!(error instanceof A2aClientError) || !error.retriable) throw error;
        lastError = error;
      }
      if (current?.is_terminal) return current;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(this.config.pollIntervalMs, remaining));
    }
    if (current) return current;
    throw lastError ?? new A2aClientError("Sicore A2A wait timed out before receiving a task snapshot", {
      reason: "A2A_TIMEOUT",
      retriable: true,
    });
  }
}
