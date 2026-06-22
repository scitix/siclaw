import crypto from "node:crypto";
import type http from "node:http";
import {
  parseBody,
  parseQuery,
  RequestBodyTooLargeError,
  type RestRouter,
} from "../gateway/rest-router.js";
import { getDb } from "../gateway/db.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";
import { authenticateApiKey, type ApiKeyAuthResult } from "./api-key-auth.js";
import { resolveAgentModelBinding } from "./chat-gateway.js";

const A2A_VERSION = "1.0";
const A2A_JSON = "application/a2a+json; charset=utf-8";
const MAX_A2A_BODY_BYTES = 1024 * 1024;
const MAX_A2A_ID_BYTES = 255;
const ASSISTANT_ARTIFACT_ID = "assistant-text";

type A2aTaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

const A2A_TASK_STATES = new Set<A2aTaskState>([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

interface A2aMessage {
  messageId?: string;
  contextId?: string;
  taskId?: string;
  role?: string;
  parts?: Array<{ text?: string; raw?: string; url?: string; data?: unknown; mediaType?: string }>;
  metadata?: Record<string, unknown>;
}

interface NormalizedA2aMessage extends A2aMessage {
  messageId: string;
  contextId?: string;
}

interface SendMessageRequest {
  message?: A2aMessage;
  configuration?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface A2aTaskRecord {
  id: string;
  agentId: string;
  userId: string;
  apiKeyId: string | null;
  contextId: string;
  sessionId: string;
  state: A2aTaskState;
  statusMessage: string | null;
  artifactText: string;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastEventAt: string | null;
  completedAt: string | null;
}

type A2aStreamResponse =
  | { task: Record<string, unknown> }
  | { message: Record<string, unknown> }
  | { statusUpdate: Record<string, unknown> }
  | { artifactUpdate: Record<string, unknown> };

interface ActiveTracker {
  unsubscribe: () => void;
  artifactText: string;
}

const activeTrackers = new Map<string, ActiveTracker>();
const streamSubscribers = new Map<string, Set<(response: A2aStreamResponse) => void>>();

class A2aHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function isTerminalState(state: A2aTaskState): boolean {
  return state === "TASK_STATE_COMPLETED"
    || state === "TASK_STATE_FAILED"
    || state === "TASK_STATE_CANCELED"
    || state === "TASK_STATE_REJECTED";
}

// Terminal states as a SQL literal list, for the terminal-immutable guard in setTaskState.
// Constant enum values (not user input), safe to inline; portable across SQLite and MySQL.
const TERMINAL_STATES_SQL = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
].map((s) => `'${s}'`).join(", ");

function sendA2aJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": A2A_JSON,
    "A2A-Version": A2A_VERSION,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendA2aError(res: http.ServerResponse, err: A2aHttpError): void {
  sendA2aJson(res, err.status, {
    error: {
      code: err.status,
      status: grpcStatusForHttp(err.status),
      message: err.message,
      details: [{
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: err.code,
        domain: "a2a-protocol.org",
        metadata: {
          timestamp: new Date().toISOString(),
        },
      }],
    },
  });
}

function respondA2aError(req: http.IncomingMessage, res: http.ServerResponse, err: unknown): void {
  if (err instanceof A2aHttpError) {
    sendA2aError(res, err);
    return;
  }
  // Unexpected internal failure (DB error, programming bug). Each A2A handler catches
  // before the REST router's own catch can see it, so without logging here the 500
  // would be completely invisible server-side.
  console.error(`[a2a-gateway] ${req.method ?? "?"} ${(req.url ?? "").split("?")[0]} failed:`, err);
  sendA2aError(res, new A2aHttpError(500, "INTERNAL", "Internal server error"));
}

function writeA2aSseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "A2A-Version": A2A_VERSION,
    "X-Accel-Buffering": "no",
  });
  res.socket?.setNoDelay(true);
}

function grpcStatusForHttp(status: number): string {
  switch (status) {
    case 400: return "INVALID_ARGUMENT";
    case 401: return "UNAUTHENTICATED";
    case 403: return "PERMISSION_DENIED";
    case 404: return "NOT_FOUND";
    case 409: return "ABORTED";
    case 413:
    case 429: return "RESOURCE_EXHAUSTED";
    case 500: return "INTERNAL";
    case 501: return "UNIMPLEMENTED";
    case 502:
    case 503:
    case 504:
      return "UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL" : "UNKNOWN";
  }
}

function writeA2aSse(res: http.ServerResponse, data: A2aStreamResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function externalOrigin(req: http.IncomingMessage): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const proto = forwardedProto || ((req.socket as any).encrypted ? "https" : "http");
  const host = forwardedHost || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function buildAgentCard(req: http.IncomingMessage, agentId: string): Record<string, unknown> {
  const baseUrl = `${externalOrigin(req)}/api/v1/a2a/agents/${encodeURIComponent(agentId)}`;
  return {
    name: "Siclaw SRE Agent",
    description: "Delegates Kubernetes and infrastructure diagnostics to a Siclaw SRE agent.",
    supportedInterfaces: [
      {
        url: baseUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_VERSION,
        tenant: agentId,
      },
    ],
    provider: {
      organization: "Siclaw",
      url: "https://github.com/scitix/siclaw",
    },
    version: A2A_VERSION,
    documentationUrl: "https://github.com/scitix/siclaw",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      siclawApiKey: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "Siclaw agent API key",
          description: "Use an agent API key generated in Siclaw Portal.",
        },
      },
    },
    securityRequirements: [{ siclawApiKey: [] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/markdown", "text/plain"],
    skills: [
      {
        id: "sre_cluster_diagnosis",
        name: "SRE Cluster Diagnosis",
        description: "Investigate Kubernetes, host, GPU, network, storage, and service health issues and return an operational diagnosis.",
        tags: ["sre", "kubernetes", "diagnostics", "operations"],
        examples: [
          "Diagnose why pods in kube-system are restarting.",
          "Check whether a GPU node is healthy and summarize the evidence.",
        ],
        inputModes: ["text/plain"],
        outputModes: ["text/markdown", "text/plain"],
        securityRequirements: [{ siclawApiKey: [] }],
      },
    ],
  };
}

async function requireAgentApiKey(
  req: http.IncomingMessage,
  agentId: string,
): Promise<ApiKeyAuthResult> {
  const auth = await authenticateApiKey(req);
  if (!auth) throw new A2aHttpError(401, "AUTHENTICATION_REQUIRED", "A valid Siclaw agent API key is required");
  if (auth.agentId !== agentId) {
    throw new A2aHttpError(403, "FORBIDDEN", "API key is not authorized for this agent");
  }
  return auth;
}

async function parseA2aBody(req: http.IncomingMessage): Promise<SendMessageRequest> {
  try {
    return await parseBody<SendMessageRequest>(req, { maxBytes: MAX_A2A_BODY_BYTES });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      throw new A2aHttpError(413, "RESOURCE_EXHAUSTED", "A2A JSON body is too large");
    }
    throw new A2aHttpError(400, "INVALID_ARGUMENT", "Invalid A2A JSON body");
  }
}

function optionalStringId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new A2aHttpError(400, "INVALID_ARGUMENT", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new A2aHttpError(400, "INVALID_ARGUMENT", `${field} must not be empty`);
  if (Buffer.byteLength(trimmed, "utf8") > MAX_A2A_ID_BYTES) {
    throw new A2aHttpError(400, "INVALID_ARGUMENT", `${field} must be ${MAX_A2A_ID_BYTES} bytes or less`);
  }
  return trimmed;
}

function extractTextMessage(body: SendMessageRequest): { text: string; message: NormalizedA2aMessage } {
  const message = body.message;
  if (!message) throw new A2aHttpError(400, "INVALID_ARGUMENT", "message is required");
  const messageId = optionalStringId(message.messageId, "message.messageId") ?? crypto.randomUUID();
  const contextId = optionalStringId(message.contextId, "message.contextId");
  const taskId = optionalStringId(message.taskId, "message.taskId");
  if (message.role && message.role !== "ROLE_USER") {
    throw new A2aHttpError(400, "INVALID_ARGUMENT", "message.role must be ROLE_USER");
  }
  if (taskId) {
    throw new A2aHttpError(400, "UNSUPPORTED_OPERATION", "taskId continuation is not supported in the first A2A cut; use contextId for a new task in the same conversation");
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const textParts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      throw new A2aHttpError(400, "INVALID_ARGUMENT", "message.parts must contain objects");
    }
    const hasText = typeof part.text === "string";
    const hasOther = part.raw !== undefined || part.url !== undefined || part.data !== undefined;
    if (!hasText || hasOther) {
      throw new A2aHttpError(400, "UNSUPPORTED_OPERATION", "Only text parts are supported by this Siclaw A2A endpoint");
    }
    if (part.text?.trim()) textParts.push(part.text);
  }
  const text = textParts.join("\n\n").trim();
  if (!text) throw new A2aHttpError(400, "INVALID_ARGUMENT", "message.parts must include non-empty text");
  return { text, message: { ...message, messageId, ...(contextId ? { contextId } : {}) } };
}

function toNullableIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToTask(row: Record<string, unknown>): A2aTaskRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    userId: String(row.user_id),
    apiKeyId: row.api_key_id == null ? null : String(row.api_key_id),
    contextId: String(row.context_id),
    sessionId: String(row.session_id),
    state: String(row.state) as A2aTaskState,
    statusMessage: row.status_message == null ? null : String(row.status_message),
    artifactText: row.artifact_text == null ? "" : String(row.artifact_text),
    error: row.error == null ? null : String(row.error),
    createdAt: toNullableIso(row.created_at),
    updatedAt: toNullableIso(row.updated_at),
    lastEventAt: toNullableIso(row.last_event_at),
    completedAt: toNullableIso(row.completed_at),
  };
}

async function createTaskRecord(params: {
  id: string;
  agentId: string;
  userId: string;
  apiKeyId: string;
  contextId: string;
  sessionId: string;
}): Promise<A2aTaskRecord> {
  const db = getDb();
  await db.query(
    `INSERT INTO a2a_tasks
       (id, agent_id, user_id, api_key_id, context_id, session_id, state, status_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.id,
      params.agentId,
      params.userId,
      params.apiKeyId,
      params.contextId,
      params.sessionId,
      "TASK_STATE_SUBMITTED",
      "Task submitted to Siclaw",
    ],
  );
  return {
    id: params.id,
    agentId: params.agentId,
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    contextId: params.contextId,
    sessionId: params.sessionId,
    state: "TASK_STATE_SUBMITTED",
    statusMessage: "Task submitted to Siclaw",
    artifactText: "",
    error: null,
    createdAt: null,
    updatedAt: null,
    lastEventAt: null,
    completedAt: null,
  };
}

async function loadTaskRecord(agentId: string, taskId: string, apiKeyId: string): Promise<A2aTaskRecord | null> {
  const db = getDb();
  const [rows] = await db.query(
    `SELECT id, agent_id, user_id, api_key_id, context_id, session_id, state,
            status_message, artifact_text, error, created_at, updated_at, last_event_at, completed_at
       FROM a2a_tasks
      WHERE id = ? AND agent_id = ? AND api_key_id = ?
      LIMIT 1`,
    [taskId, agentId, apiKeyId],
  ) as any;
  return rows.length ? rowToTask(rows[0]) : null;
}

async function loadSessionIdForContext(agentId: string, apiKeyId: string, contextId: string): Promise<string | null> {
  const db = getDb();
  const [rows] = await db.query(
    `SELECT session_id
       FROM a2a_tasks
      WHERE agent_id = ? AND api_key_id = ? AND context_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [agentId, apiKeyId, contextId],
  ) as any;
  return rows.length ? String(rows[0].session_id) : null;
}

async function loadTaskRecordById(taskId: string): Promise<A2aTaskRecord | null> {
  const db = getDb();
  const [rows] = await db.query(
    `SELECT id, agent_id, user_id, api_key_id, context_id, session_id, state,
            status_message, artifact_text, error, created_at, updated_at, last_event_at, completed_at
       FROM a2a_tasks
      WHERE id = ?
      LIMIT 1`,
    [taskId],
  ) as any;
  return rows.length ? rowToTask(rows[0]) : null;
}

async function listTaskRecords(params: {
  agentId: string;
  apiKeyId: string;
  contextId?: string;
  status?: A2aTaskState;
  pageSize: number;
  pageToken: number;
}): Promise<{ tasks: A2aTaskRecord[]; totalSize: number; nextPageToken: string }> {
  const where = ["agent_id = ?", "api_key_id = ?"];
  const values: unknown[] = [params.agentId, params.apiKeyId];
  if (params.contextId) {
    where.push("context_id = ?");
    values.push(params.contextId);
  }
  if (params.status) {
    where.push("state = ?");
    values.push(params.status);
  }

  const db = getDb();
  const whereSql = where.join(" AND ");
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS c FROM a2a_tasks WHERE ${whereSql}`,
    values,
  ) as any;
  const totalSize = Number(countRows[0]?.c ?? 0);
  const [rows] = await db.query(
    `SELECT id, agent_id, user_id, api_key_id, context_id, session_id, state,
            status_message, artifact_text, error, created_at, updated_at, last_event_at, completed_at
       FROM a2a_tasks
      WHERE ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...values, params.pageSize, params.pageToken],
  ) as any;
  const nextOffset = params.pageToken + rows.length;
  return {
    tasks: rows.map(rowToTask),
    totalSize,
    nextPageToken: nextOffset < totalSize ? String(nextOffset) : "",
  };
}

async function setTaskState(
  taskId: string,
  state: A2aTaskState,
  statusMessage: string,
  error?: string | null,
): Promise<void> {
  const terminal = isTerminalState(state);
  const db = getDb();
  // Terminal state is immutable: the first terminal write wins. The `AND state NOT IN
  // (terminal…)` guard makes every transition idempotent against races — e.g. a cancel
  // and a runtime stream_error landing together, or a late tool_execution_* event trying
  // to flip a CANCELED task back to WORKING. Without it the last writer would win and
  // mislabel the task (user clicked cancel, DB ends up FAILED).
  const sql = terminal
    ? `UPDATE a2a_tasks
          SET state = ?, status_message = ?, error = ?, updated_at = CURRENT_TIMESTAMP,
              last_event_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state NOT IN (${TERMINAL_STATES_SQL})`
    : `UPDATE a2a_tasks
          SET state = ?, status_message = ?, error = ?, updated_at = CURRENT_TIMESTAMP,
              last_event_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state NOT IN (${TERMINAL_STATES_SQL})`;
  await db.query(sql, [state, statusMessage, error ?? null, taskId]);
}

async function setTaskArtifact(taskId: string, artifactText: string): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE a2a_tasks
        SET artifact_text = ?, updated_at = CURRENT_TIMESTAMP, last_event_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [artifactText, taskId],
  );
}

function buildStatusMessage(task: A2aTaskRecord, text: string): Record<string, unknown> {
  return {
    messageId: `status-${task.id}`,
    contextId: task.contextId,
    taskId: task.id,
    role: "ROLE_AGENT",
    parts: [{ text }],
  };
}

function buildTask(task: A2aTaskRecord, stateOverride?: A2aTaskState): Record<string, unknown> {
  const state = stateOverride ?? task.state;
  const statusText = task.statusMessage ?? (state === "TASK_STATE_WORKING" ? "Siclaw is working" : "Task submitted to Siclaw");
  const result: Record<string, unknown> = {
    id: task.id,
    contextId: task.contextId,
    status: {
      state,
      message: buildStatusMessage(task, statusText),
      timestamp: task.lastEventAt ?? task.updatedAt ?? new Date().toISOString(),
    },
    metadata: {
      agentId: task.agentId,
      sessionId: task.sessionId,
      lastEventAt: task.lastEventAt,
      completedAt: task.completedAt,
    },
  };
  if (task.artifactText) {
    result.artifacts = [{
      artifactId: ASSISTANT_ARTIFACT_ID,
      name: "Siclaw diagnosis",
      parts: [{ text: task.artifactText, mediaType: "text/markdown" }],
    }];
  }
  return result;
}

function buildStatusUpdate(
  task: A2aTaskRecord,
  state: A2aTaskState,
  text: string,
  metadata?: Record<string, unknown>,
): A2aStreamResponse {
  return {
    statusUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      status: {
        state,
        message: buildStatusMessage(task, text),
        timestamp: new Date().toISOString(),
      },
      ...(metadata ? { metadata } : {}),
    },
  };
}

function buildArtifactUpdate(task: A2aTaskRecord, delta: string, lastChunk = false): A2aStreamResponse {
  return {
    artifactUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      artifact: {
        artifactId: ASSISTANT_ARTIFACT_ID,
        name: "Siclaw diagnosis",
        parts: [{ text: delta, mediaType: "text/markdown" }],
      },
      append: true,
      lastChunk,
    },
  };
}

function subscribeTask(taskId: string, callback: (response: A2aStreamResponse) => void): () => void {
  let set = streamSubscribers.get(taskId);
  if (!set) {
    set = new Set();
    streamSubscribers.set(taskId, set);
  }
  set.add(callback);
  return () => {
    set!.delete(callback);
    if (set!.size === 0) streamSubscribers.delete(taskId);
  };
}

function emitTask(taskId: string, response: A2aStreamResponse): void {
  const set = streamSubscribers.get(taskId);
  if (!set) return;
  for (const cb of set) {
    try { cb(response); } catch { /* one broken stream must not break others */ }
  }
}

function extractDelta(evt: Record<string, unknown>): string {
  if (evt.type === "agent_message" && typeof evt.text === "string") return evt.text;
  if (evt.type === "message_update") {
    const ame = (evt as any).assistantMessageEvent;
    if (ame?.type === "text_delta" && typeof ame.delta === "string") return ame.delta;
  }
  return "";
}

function toolName(evt: Record<string, unknown>): string | undefined {
  const name = (evt as any).toolName ?? (evt as any).name;
  return typeof name === "string" && name ? name : undefined;
}

function streamErrorMessage(evt: Record<string, unknown>): string {
  const err = (evt as any).error;
  if (typeof err?.message === "string") return err.message;
  if (typeof err === "string") return err;
  return "Siclaw stream failed";
}

function ensureTaskTracker(task: A2aTaskRecord, connectionMap: RuntimeConnectionMap): void {
  if (activeTrackers.has(task.id)) return;

  const tracker: ActiveTracker = {
    artifactText: task.artifactText,
    unsubscribe: () => {},
  };

  tracker.unsubscribe = connectionMap.subscribe(task.agentId, "chat.event", (data: unknown) => {
    const envelope = data as { sessionId?: string; event?: Record<string, unknown> } | undefined;
    if (!envelope?.event) return;
    // Strict session match: chat.event is broadcast to every tracker on this agent, and
    // the A2A path persists artifact text, so a sessionId-less event must NOT fall through
    // to all sessions (that would cross-contaminate artifacts). Runtime always sets it.
    if (envelope.sessionId !== task.sessionId) return;
    void handleTrackedEvent(task, tracker, envelope.event).catch((err) => {
      console.error(`[a2a-gateway] tracked-event handling failed for task ${task.id}:`, err);
    });
  });

  activeTrackers.set(task.id, tracker);
}

async function handleTrackedEvent(
  task: A2aTaskRecord,
  tracker: ActiveTracker,
  evt: Record<string, unknown>,
): Promise<void> {
  // Text deltas accumulate in the in-memory tracker and are flushed to a2a_tasks.artifact_text
  // only at terminal events (prompt_done / stream_error). The a2a_tasks row is a protocol
  // projection, not the durable transcript — chat_messages is the audit source of truth — so a
  // crash mid-turn loses the partial artifact from the projection but never from chat history.
  const delta = extractDelta(evt);
  if (delta) {
    tracker.artifactText += delta;
    emitTask(task.id, buildArtifactUpdate(task, delta));
    return;
  }

  if (evt.type === "tool_execution_start") {
    const name = toolName(evt);
    const text = name ? `Running tool: ${name}` : "Running a Siclaw tool";
    await setTaskState(task.id, "TASK_STATE_WORKING", text);
    emitTask(task.id, buildStatusUpdate(task, "TASK_STATE_WORKING", text, name ? { currentTool: name } : undefined));
    return;
  }

  if (evt.type === "tool_execution_end") {
    const name = toolName(evt);
    const text = name ? `Finished tool: ${name}` : "Siclaw tool finished";
    await setTaskState(task.id, "TASK_STATE_WORKING", text);
    emitTask(task.id, buildStatusUpdate(task, "TASK_STATE_WORKING", text, name ? { currentTool: name } : undefined));
    return;
  }

  if (evt.type === "stream_error") {
    // Mirror prompt_done: if the task already reached a terminal state (e.g. the user
    // canceled and the runtime then emitted stream_error as part of aborting), do not
    // overwrite it or emit a spurious FAILED. setTaskState is terminal-immutable too,
    // so this is belt-and-suspenders against the same race.
    const latest = await loadTaskRecordById(task.id);
    if (latest && isTerminalState(latest.state)) {
      stopTaskTracker(task.id);
      return;
    }
    const message = streamErrorMessage(evt);
    await setTaskArtifact(task.id, tracker.artifactText);
    await setTaskState(task.id, "TASK_STATE_FAILED", message, message);
    emitTask(task.id, buildStatusUpdate(task, "TASK_STATE_FAILED", message));
    stopTaskTracker(task.id);
    return;
  }

  if (evt.type === "prompt_done" || evt.type === "done") {
    const latest = await loadTaskRecordById(task.id);
    if (latest && isTerminalState(latest.state)) {
      stopTaskTracker(task.id);
      return;
    }
    await setTaskArtifact(task.id, tracker.artifactText);
    await setTaskState(task.id, "TASK_STATE_COMPLETED", "Siclaw task completed");
    emitTask(task.id, buildArtifactUpdate(task, "", true));
    emitTask(task.id, buildStatusUpdate(task, "TASK_STATE_COMPLETED", "Siclaw task completed"));
    stopTaskTracker(task.id);
  }
}

function stopTaskTracker(taskId: string): void {
  const tracker = activeTrackers.get(taskId);
  if (!tracker) return;
  activeTrackers.delete(taskId);
  tracker.unsubscribe();
}

async function submitA2aTask(params: {
  agentId: string;
  auth: ApiKeyAuthResult;
  text: string;
  message: NormalizedA2aMessage;
  connectionMap: RuntimeConnectionMap;
}): Promise<A2aTaskRecord> {
  const { agentId, auth, text, message, connectionMap } = params;
  if (!connectionMap.isConnected(agentId)) {
    throw new A2aHttpError(503, "UNAVAILABLE", "Agent runtime is not connected");
  }

  const modelBinding = await resolveAgentModelBinding(agentId);
  if (!modelBinding) {
    throw new A2aHttpError(400, "FAILED_PRECONDITION", "Agent has no model configured");
  }

  const taskId = crypto.randomUUID();
  const contextId = message.contextId || crypto.randomUUID();
  const sessionId = message.contextId
    ? (await loadSessionIdForContext(agentId, auth.keyId, contextId)) ?? crypto.randomUUID()
    : contextId;
  const task = await createTaskRecord({
    id: taskId,
    agentId,
    userId: auth.createdBy,
    apiKeyId: auth.keyId,
    contextId,
    sessionId,
  });

  ensureTaskTracker(task, connectionMap);

  const result = await connectionMap.sendCommand(agentId, "chat.send", {
    agentId,
    userId: auth.createdBy,
    text,
    sessionId,
    mode: "a2a",
    modelProvider: modelBinding.modelProvider,
    modelId: modelBinding.modelId,
    modelConfig: modelBinding.modelConfig,
    modelRouting: modelBinding.modelRouting,
    turnStartMs: Date.now(),
  });

  if (!result.ok) {
    stopTaskTracker(task.id);
    await setTaskState(task.id, "TASK_STATE_FAILED", result.error ?? "Runtime command failed", result.error ?? null);
    throw new A2aHttpError(502, "RUNTIME_ERROR", result.error ?? "Runtime command failed");
  }

  await setTaskState(task.id, "TASK_STATE_WORKING", "Siclaw is working");
  emitTask(task.id, buildStatusUpdate(task, "TASK_STATE_WORKING", "Siclaw is working"));
  return { ...task, state: "TASK_STATE_WORKING", statusMessage: "Siclaw is working" };
}

async function loadAuthorizedTask(
  req: http.IncomingMessage,
  agentId: string,
  taskId: string,
): Promise<{ auth: ApiKeyAuthResult; task: A2aTaskRecord }> {
  const auth = await requireAgentApiKey(req, agentId);
  const task = await loadTaskRecord(agentId, taskId, auth.keyId);
  if (!task) throw new A2aHttpError(404, "NOT_FOUND", "A2A task not found");
  return { auth, task };
}

function orphanGraceMs(): number {
  const v = Number(process.env.SICLAW_A2A_ORPHAN_GRACE_MS ?? 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}

// A non-terminal task whose Runtime has disconnected can never reach a terminal event on
// its own (a Runtime restart drops the in-memory turn; pi-agent does not resume it). But a
// brief phone-home blip would also read as "disconnected", so we only fail the task after
// observing the disconnect for a full grace window across polls. App-clock only — never
// parse DB timestamps here (SQLite/MySQL store CURRENT_TIMESTAMP in the DB's own zone).
const orphanFirstSeenMs = new Map<string, number>();

async function reconcileOrphanedTask(task: A2aTaskRecord): Promise<A2aTaskRecord | null> {
  const now = Date.now();
  const firstSeen = orphanFirstSeenMs.get(task.id) ?? now;
  if (!orphanFirstSeenMs.has(task.id)) orphanFirstSeenMs.set(task.id, now);
  if (now - firstSeen < orphanGraceMs()) return null;
  orphanFirstSeenMs.delete(task.id);
  const message = "Siclaw runtime disconnected before the task finished";
  await setTaskState(task.id, "TASK_STATE_FAILED", message, message);
  emitTask(task.id, buildStatusUpdate(task, "TASK_STATE_FAILED", message));
  stopTaskTracker(task.id);
  return { ...task, state: "TASK_STATE_FAILED", statusMessage: message, error: message };
}

/** Drop all in-memory A2A state. For graceful shutdown and to isolate tests from each other. */
export function __resetA2aGatewayState(): void {
  for (const tracker of activeTrackers.values()) {
    try { tracker.unsubscribe(); } catch { /* best-effort */ }
  }
  activeTrackers.clear();
  streamSubscribers.clear();
  orphanFirstSeenMs.clear();
}

async function currentTaskForResponse(
  task: A2aTaskRecord,
  connectionMap: RuntimeConnectionMap,
): Promise<Record<string, unknown>> {
  if (task.state === "TASK_STATE_SUBMITTED" || task.state === "TASK_STATE_WORKING") {
    if (!connectionMap.isConnected(task.agentId)) {
      const reconciled = await reconcileOrphanedTask(task);
      return buildTask(reconciled ?? task);
    }
    const result = await connectionMap.sendCommand(task.agentId, "chat.sessionStatus", {
      agentId: task.agentId,
      userId: task.userId,
      sessionId: task.sessionId,
    }, 10_000);
    if (result.ok && (result.payload as any)?.running) {
      orphanFirstSeenMs.delete(task.id);
      return buildTask(task, "TASK_STATE_WORKING");
    }
    // Connected but the Runtime is not running this session. If an in-process tracker is
    // still driving the task, a terminal event is imminent (this poll just raced the
    // done/stream_error event) — keep it WORKING and let the tracker finish it. With no
    // tracker the task is orphaned: Portal restarted (in-memory trackers are gone) or the
    // terminal event was missed, so it would otherwise stay WORKING forever. Fail it through
    // the same grace window the disconnect path uses.
    if (!activeTrackers.has(task.id)) {
      const reconciled = await reconcileOrphanedTask(task);
      return buildTask(reconciled ?? task);
    }
    orphanFirstSeenMs.delete(task.id);
  }
  return buildTask(task);
}

function streamTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  task: A2aTaskRecord,
  connectionMap: RuntimeConnectionMap,
): void {
  writeA2aSseHead(res);

  // Already terminal: emit the final snapshot once and close. No tracker, no live stream.
  if (isTerminalState(task.state)) {
    void currentTaskForResponse(task, connectionMap)
      .then((snapshot) => writeA2aSse(res, { task: snapshot }))
      .catch(() => writeA2aSse(res, { task: buildTask(task) }))
      .finally(() => { if (!res.writableEnded && !res.destroyed) res.end(); });
    return;
  }

  // Keep a tracker advancing the task's DB/state for its whole lifetime, independent of
  // this client connection (so a disconnecting client never strands the task).
  ensureTaskTracker(task, connectionMap);

  let closed = false;
  let snapshotSent = false;
  const buffered: A2aStreamResponse[] = [];
  let unsubscribe: () => void = () => {};

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    try { res.write(": keepalive\n\n"); } catch { clearInterval(heartbeat); }
  }, 25_000);
  heartbeat.unref?.();

  const endStream = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  const writeEvent = (event: A2aStreamResponse) => {
    if (closed) return;
    writeA2aSse(res, event);
    const state = (event as any).statusUpdate?.status?.state as A2aTaskState | undefined;
    if (state && isTerminalState(state)) endStream();
  };

  // Subscribe synchronously so no live event is dropped while the snapshot loads, but hold
  // events in a buffer until the initial Task frame is written. A2A clients expect the
  // snapshot as the first stream event, and producing it involves an awaited Runtime
  // round-trip — without buffering a fast first delta could race ahead of the snapshot.
  unsubscribe = subscribeTask(task.id, (event) => {
    if (closed) return;
    if (!snapshotSent) { buffered.push(event); return; }
    writeEvent(event);
  });

  req.on("close", endStream);
  res.on("close", endStream);
  res.on("error", endStream);

  const flushAfterSnapshot = (snapshotState: A2aTaskState | undefined) => {
    snapshotSent = true;
    if (closed) return;
    if (snapshotState && isTerminalState(snapshotState)) { endStream(); return; }
    for (const event of buffered.splice(0)) {
      if (closed) break;
      writeEvent(event);
    }
  };

  void currentTaskForResponse(task, connectionMap).then((snapshot) => {
    if (!closed) writeA2aSse(res, { task: snapshot });
    flushAfterSnapshot((snapshot as any)?.status?.state as A2aTaskState | undefined);
  }).catch(() => {
    if (!closed) writeA2aSse(res, { task: buildTask(task) });
    flushAfterSnapshot(isTerminalState(task.state) ? task.state : undefined);
  });
}

export function registerA2aRoutes(
  router: RestRouter,
  connectionMap: RuntimeConnectionMap,
): void {
  router.get("/api/v1/a2a/agents/:agentId/.well-known/agent-card.json", (req, res, params) => {
    sendA2aJson(res, 200, buildAgentCard(req, params.agentId));
  });

  router.get("/api/v1/a2a/agents/:agentId/agent-card.json", (req, res, params) => {
    sendA2aJson(res, 200, buildAgentCard(req, params.agentId));
  });

  router.post("/api/v1/a2a/agents/:agentId/message:send", async (req, res, params) => {
    try {
      const auth = await requireAgentApiKey(req, params.agentId);
      const body = await parseA2aBody(req);
      const { text, message } = extractTextMessage(body);
      const task = await submitA2aTask({ agentId: params.agentId, auth, text, message, connectionMap });
      sendA2aJson(res, 200, { task: buildTask(task) });
    } catch (err) {
      respondA2aError(req, res, err);
    }
  });

  router.post("/api/v1/a2a/agents/:agentId/message:stream", async (req, res, params) => {
    try {
      const auth = await requireAgentApiKey(req, params.agentId);
      const body = await parseA2aBody(req);
      const { text, message } = extractTextMessage(body);
      const task = await submitA2aTask({ agentId: params.agentId, auth, text, message, connectionMap });
      streamTask(req, res, task, connectionMap);
    } catch (err) {
      respondA2aError(req, res, err);
    }
  });

  router.get("/api/v1/a2a/agents/:agentId/tasks/:taskId", async (req, res, params) => {
    try {
      const { task } = await loadAuthorizedTask(req, params.agentId, params.taskId);
      sendA2aJson(res, 200, { task: await currentTaskForResponse(task, connectionMap) });
    } catch (err) {
      respondA2aError(req, res, err);
    }
  });

  router.get("/api/v1/a2a/agents/:agentId/tasks", async (req, res, params) => {
    try {
      const auth = await requireAgentApiKey(req, params.agentId);
      const query = parseQuery(req.url ?? "");
      const rawPageSize = query.pageSize ? Number(query.pageSize) : 20;
      if (!Number.isFinite(rawPageSize) || rawPageSize < 1 || rawPageSize > 100) {
        throw new A2aHttpError(400, "INVALID_ARGUMENT", "pageSize must be between 1 and 100");
      }
      const rawPageToken = query.pageToken ? Number(query.pageToken) : 0;
      if (!Number.isFinite(rawPageToken) || rawPageToken < 0 || Math.floor(rawPageToken) !== rawPageToken) {
        throw new A2aHttpError(400, "INVALID_ARGUMENT", "pageToken must be a non-negative integer offset");
      }
      const status = query.status as A2aTaskState | undefined;
      if (status && !A2A_TASK_STATES.has(status)) {
        throw new A2aHttpError(400, "INVALID_ARGUMENT", `Invalid status: ${status}`);
      }

      const result = await listTaskRecords({
        agentId: params.agentId,
        apiKeyId: auth.keyId,
        contextId: query.contextId,
        status,
        pageSize: Math.floor(rawPageSize),
        pageToken: rawPageToken,
      });
      sendA2aJson(res, 200, {
        tasks: result.tasks.map((task) => buildTask(task)),
        totalSize: result.totalSize,
        pageSize: Math.floor(rawPageSize),
        nextPageToken: result.nextPageToken,
      });
    } catch (err) {
      respondA2aError(req, res, err);
    }
  });

  router.post("/api/v1/a2a/agents/:agentId/tasks/:taskId:subscribe", async (req, res, params) => {
    try {
      const { task } = await loadAuthorizedTask(req, params.agentId, params.taskId);
      if (isTerminalState(task.state)) {
        throw new A2aHttpError(400, "UNSUPPORTED_OPERATION", "Cannot subscribe to a terminal A2A task");
      }
      streamTask(req, res, task, connectionMap);
    } catch (err) {
      respondA2aError(req, res, err);
    }
  });

  router.post("/api/v1/a2a/agents/:agentId/tasks/:taskId:cancel", async (req, res, params) => {
    try {
      const { auth, task } = await loadAuthorizedTask(req, params.agentId, params.taskId);
      if (!isTerminalState(task.state)) {
        const result = await connectionMap.sendCommand(params.agentId, "chat.abort", {
          agentId: params.agentId,
          userId: auth.createdBy,
          sessionId: task.sessionId,
        });
        if (!result.ok) throw new A2aHttpError(502, "RUNTIME_ERROR", result.error ?? "Runtime cancel failed");
        await setTaskState(task.id, "TASK_STATE_CANCELED", "Task canceled by A2A client");
        emitTask(task.id, buildStatusUpdate(task, "TASK_STATE_CANCELED", "Task canceled by A2A client"));
        stopTaskTracker(task.id);
      }
      const latest = await loadTaskRecord(params.agentId, params.taskId, auth.keyId) ?? task;
      sendA2aJson(res, 200, { task: buildTask(latest) });
    } catch (err) {
      respondA2aError(req, res, err);
    }
  });
}
