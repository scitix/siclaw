/**
 * Chat gateway — bridges the frontend (HTTP/SSE) to the Runtime (WebSocket).
 *
 * POST /api/v1/siclaw/agents/:id/chat/send  → SSE streaming (JWT auth, web frontend)
 * POST /api/v1/run                           → synchronous execution (API key auth, external)
 */

import crypto from "node:crypto";
import http from "node:http";
import {
  sendJson,
  parseBody,
  parseQuery,
  RequestBodyTooLargeError,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";
import { verifyJwt } from "../gateway/jwt.js";
import type { ResolvedModelBinding } from "../gateway/agent-model-binding.js";
import { getDb } from "../gateway/db.js";
import {
  ErrorCodes,
  errorBody,
  isErrorDetail,
  type ErrorDetail,
} from "../lib/error-envelope.js";
import { defaultProviderModelCompat } from "../core/model-compat.js";
import { resolveAgentModelRouting } from "./model-routing-config.js";

interface ChatAttachment {
  kind?: string;
  filename?: string;
  mimeType?: string;
  mime_type?: string;
  data?: string;
}

interface ChatRequestBody {
  text?: string;
  session_id?: string;
  attachments?: ChatAttachment[];
}

const MAX_CHAT_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BASE64_CHARS = 8 * 1024 * 1024;
const MAX_CHAT_REQUEST_BODY_BYTES = MAX_CHAT_ATTACHMENTS * MAX_ATTACHMENT_BASE64_CHARS + 512 * 1024;
const OCR_DEFAULT_TIMEOUT_MS = 120_000;
const OCR_DEFAULT_MAX_EVIDENCE_TEXT_CHARS = 32 * 1024;
const OCR_DEFAULT_MAX_TOTAL_EVIDENCE_TEXT_CHARS = 64 * 1024;
const ATTACHMENT_ONLY_PROMPT = "Please analyze the attached file(s).";
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function ocrBackendUrl(): string | undefined {
  return process.env.SICLAW_OCR_BACKEND_URL?.trim() || undefined;
}

function ocrTimeoutMs(): number {
  const raw = process.env.SICLAW_OCR_TIMEOUT_MS?.trim();
  if (!raw) return OCR_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : OCR_DEFAULT_TIMEOUT_MS;
}

function ocrMaxEvidenceTextChars(): number {
  const raw = process.env.SICLAW_OCR_MAX_EVIDENCE_TEXT_CHARS?.trim();
  if (!raw) return OCR_DEFAULT_MAX_EVIDENCE_TEXT_CHARS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : OCR_DEFAULT_MAX_EVIDENCE_TEXT_CHARS;
}

function ocrMaxTotalEvidenceTextChars(): number {
  const raw = process.env.SICLAW_OCR_MAX_TOTAL_EVIDENCE_TEXT_CHARS?.trim();
  if (!raw) return OCR_DEFAULT_MAX_TOTAL_EVIDENCE_TEXT_CHARS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : OCR_DEFAULT_MAX_TOTAL_EVIDENCE_TEXT_CHARS;
}

function normalizeChatAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CHAT_ATTACHMENTS).filter((item): item is ChatAttachment => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as ChatAttachment;
    const mimeType = normalizeMimeType(candidate.mimeType ?? candidate.mime_type, candidate.filename);
    const isImage = candidate.kind === "image" && SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
    const isPdf = candidate.kind === "pdf" && mimeType === "application/pdf";
    return (isImage || isPdf)
      && typeof candidate.filename === "string"
      && typeof candidate.data === "string"
      && candidate.data.length > 0
      && candidate.data.length <= MAX_ATTACHMENT_BASE64_CHARS;
  }).map((attachment) => ({
    ...attachment,
    filename: safeAttachmentFilename(attachment.filename),
  }));
}

function normalizeMimeType(raw: string | undefined, filename: string | undefined): string {
  const mimeType = (raw ?? "").trim().toLowerCase();
  if (mimeType === "application/pdf") return mimeType;
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return mimeType;

  const lowerName = (filename ?? "").toLowerCase();
  if (lowerName.endsWith(".pdf")) return "application/pdf";
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";
  return mimeType;
}

function safeAttachmentFilename(value: string | undefined): string {
  const basename = (value ?? "attachment")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? "attachment";
  const cleaned = basename.replace(/[\r\n\t]/g, "_").trim();
  return cleaned.slice(0, 160) || "attachment";
}

function safeLogValue(value: unknown): string {
  const text = String(value ?? "-").trim() || "-";
  return text
    .slice(0, 160)
    .replace(/[^\p{L}\p{N}._:/@-]+/gu, "_");
}

async function appendOcrEvidence(text: string, attachments: ChatAttachment[] | undefined): Promise<string> {
  const normalizedAttachments = normalizeChatAttachments(attachments);
  if (normalizedAttachments.length === 0) return text;

  const backendUrl = ocrBackendUrl();
  const sections = await Promise.all(normalizedAttachments.map(async (attachment) => {
    const mimeType = normalizeMimeType(attachment.mimeType ?? attachment.mime_type, attachment.filename);
    const kindHint = ocrKindHint(attachment, mimeType);
    const started = Date.now();
    const requestId = crypto.randomUUID();
    if (!backendUrl) {
      return `### ${attachment.filename}\nOCR unavailable: OCR backend is not configured`;
    }
    try {
      const res = await fetch(backendUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          request_id: requestId,
          input: attachment.filename,
          kind_hint: kindHint,
          language_hint: "auto",
          expected_output: "siclaw_screenshot_evidence_v1",
          source: {
            type: "file_base64",
            data: attachment.data,
            filename: attachment.filename,
            mime_type: mimeType,
          },
        }),
        signal: AbortSignal.timeout(ocrTimeoutMs()),
      });

      const responseText = await res.text();
      const elapsedMs = Date.now() - started;
      if (!res.ok) {
        const reason = summarizeOcrError(responseText);
        console.warn(`[portal-chat] OCR failed for ${safeLogValue(attachment.filename)}: HTTP ${res.status} request_id=${requestId} kind_hint=${safeLogValue(kindHint)} elapsed_ms=${elapsedMs}${reason ? ` ${reason}` : ""}`);
        return `### ${attachment.filename}\nOCR failed: HTTP ${res.status}${reason ? ` - ${reason}` : ""}`;
      }

      let evidence: Record<string, unknown>;
      try {
        evidence = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
      } catch (err) {
        console.warn(
          `[portal-chat] OCR malformed response for ${safeLogValue(attachment.filename)}: request_id=${requestId} `
          + `kind_hint=${safeLogValue(kindHint)} elapsed_ms=${elapsedMs} error=${safeLogValue(errorMessage(err))}`,
        );
        return `### ${attachment.filename}\nOCR failed: malformed backend response`;
      }
      console.log(
        `[portal-chat] OCR parsed ${safeLogValue(attachment.filename)}: request_id=${requestId} kind_hint=${safeLogValue(kindHint)} `
        + `kind=${String(evidence.kind ?? "unknown")} route=${String(evidence.route ?? "unknown")} `
        + `elapsed_ms=${elapsedMs}`,
      );
      const warnings = Array.isArray(evidence.warnings)
        ? evidence.warnings.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      const boundedText = boundedOcrEvidenceText(evidence.text);
      const warningLines = boundedText.warning ? [...warnings, boundedText.warning] : warnings;
      return [
        `### ${attachment.filename}`,
        `kind: ${String(evidence.kind ?? "unknown")}`,
        `route: ${String(evidence.route ?? "unknown")}`,
        `language: ${String(evidence.language ?? "unknown")}`,
        `confidence: ${String(evidence.confidence ?? "unknown")}`,
        `elapsed_ms: ${elapsedMs}`,
        warningLines.length ? `warnings: ${warningLines.join("; ")}` : "",
        "",
        boundedText.text,
      ].filter((line) => line !== "").join("\n");
    } catch (err) {
      const elapsedMs = Date.now() - started;
      console.warn(
        `[portal-chat] OCR exception for ${safeLogValue(attachment.filename)}: request_id=${requestId} `
        + `kind_hint=${safeLogValue(kindHint)} elapsed_ms=${elapsedMs} error=${safeLogValue(errorMessage(err))}`,
      );
      return `### ${attachment.filename}\nOCR failed: ${errorMessage(err)}`;
    }
  }));

  return [
    text.trim() || ATTACHMENT_ONLY_PROMPT,
    "",
    "[System: The user pasted image or PDF attachment(s). OCR evidence extracted by Siclaw is below. Use it as evidence, preserve exact command/table text when possible, and mention if OCR appears incomplete or uncertain.]",
    "",
    boundedOcrEvidenceSections(sections),
  ].join("\n");
}

function ocrKindHint(attachment: ChatAttachment, mimeType: string): string {
  const filename = (attachment.filename ?? "").toLowerCase();
  if (mimeType === "application/pdf" || filename.endsWith(".pdf")) return "pdf";
  return "auto";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function summarizeOcrError(raw: string): string {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error.slice(0, 500);
  } catch {
    // Fall through to plain text summary.
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 500);
}

function boundedOcrEvidenceText(raw: unknown): { text: string; warning?: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { text: "(no OCR text extracted)" };

  const maxChars = ocrMaxEvidenceTextChars();
  if (text.length <= maxChars) return { text };

  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[OCR evidence truncated after ${maxChars} characters; original length ${text.length} characters.]`,
    warning: `OCR text truncated after ${maxChars} characters; original length ${text.length} characters.`,
  };
}

function boundedOcrEvidenceSections(sections: string[]): string {
  const evidence = sections.join("\n\n");
  const maxChars = ocrMaxTotalEvidenceTextChars();
  if (evidence.length <= maxChars) return evidence;
  return `${evidence.slice(0, maxChars).trimEnd()}\n\n[OCR evidence truncated after ${maxChars} total characters; original length ${evidence.length} characters.]`;
}

async function parseChatRequestBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<ChatRequestBody | null> {
  try {
    return await parseBody<ChatRequestBody>(req, { maxBytes: MAX_CHAT_REQUEST_BODY_BYTES });
  } catch (err) {
    const tooLarge = err instanceof RequestBodyTooLargeError;
    sendJson(res, tooLarge ? 413 : 400, errorBody({
      code: ErrorCodes.BAD_REQUEST,
      message: tooLarge ? err.message : "Invalid JSON body",
      retriable: false,
    }));
    return null;
  }
}

/** Resolve model binding directly from Portal's own DB. */
async function resolveAgentModelBinding(agentId: string): Promise<ResolvedModelBinding | null> {
  const db = getDb();
  const [agentRows] = await db.query(
    "SELECT model_provider, model_id, model_routing FROM agents WHERE id = ?",
    [agentId],
  ) as any;
  const agent = agentRows[0] as { model_provider?: string; model_id?: string; model_routing?: unknown } | undefined;
  if (!agent?.model_provider || !agent?.model_id) return null;

  const [providerRows] = await db.query(
    "SELECT id, name, base_url, api_key, api_type FROM model_providers WHERE name = ? LIMIT 1",
    [agent.model_provider],
  ) as any;
  const provider = providerRows[0] as
    | { id: string; name: string; base_url: string; api_key: string | null; api_type: string }
    | undefined;
  if (!provider) return null;

  const [entryRows] = await db.query(
    "SELECT model_id, name, reasoning, context_window, max_tokens FROM model_entries WHERE provider_id = ?",
    [provider.id],
  ) as any;
  const models = (entryRows as any[]).map((m: any) => ({
    id: m.model_id,
    name: m.name ?? m.model_id,
    reasoning: !!m.reasoning,
    input: ["text"] as string[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context_window,
    maxTokens: m.max_tokens,
    compat: defaultProviderModelCompat({ api: provider.api_type, baseUrl: provider.base_url }),
  }));

  const modelRouting = await resolveAgentModelRouting(agent.model_routing, {
    provider: agent.model_provider,
    modelId: agent.model_id,
  });

  return {
    modelProvider: provider.name,
    modelId: agent.model_id,
    modelConfig: {
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: provider.api_key ?? "",
      api: provider.api_type,
      authHeader: true,
      models,
    },
    ...(modelRouting ? { modelRouting } : {}),
  };
}

// ── API key authentication ──────────────────────────────────

interface ApiKeyAuthResult {
  agentId: string;
  keyId: string;
  keyName: string;
  createdBy: string;
}

async function authenticateApiKey(req: http.IncomingMessage): Promise<ApiKeyAuthResult | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer sk-")) return null;

  const plaintext = auth.slice(7);
  const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");

  const db = getDb();
  const [rows] = await db.query(
    `SELECT id, agent_id, name, expires_at, created_by
     FROM agent_api_keys WHERE key_hash = ? LIMIT 1`,
    [keyHash],
  ) as any;

  if (rows.length === 0) return null;
  const key = rows[0];

  if (key.expires_at && new Date(key.expires_at) < new Date()) return null;

  db.query("UPDATE agent_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [key.id]).catch(() => {});

  return { agentId: key.agent_id, keyId: key.id, keyName: key.name, createdBy: key.created_by };
}
import type { RuntimeConnectionMap } from "./runtime-connection.js";

/**
 * Open an SSE response: the event-stream headers + disable Nagle so each frame is its own
 * TCP segment (small text_delta frames are exactly what Nagle's 40ms coalescing hurts).
 */
function writeSseHead(res: import("node:http").ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.socket?.setNoDelay(true);
}

/** Send an SSE event to the response stream. No-op if the stream is already closed. */
function sseWrite(res: import("node:http").ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Authorize that `userSub` may read a chat session's event/liveness channel: the session must
 * belong to them. A not-yet-persisted (brand-new) session has no row → "ok" (nothing flows until
 * the owner's own agent produces events). A row owned by someone else → "forbidden" (cross-tenant
 * leak). A DB error → "error". Mirrors the user_id scoping every chat-session endpoint in
 * siclaw-api.ts enforces; shared by the read-only /events and /status channels.
 */
async function authorizeSessionOwnership(
  agentId: string,
  sessionId: string,
  userSub: string,
): Promise<"ok" | "forbidden" | "error"> {
  try {
    const [rows] = await getDb().query(
      "SELECT user_id FROM chat_sessions WHERE id = ? AND agent_id = ? AND deleted_at IS NULL",
      [sessionId, agentId],
    ) as any;
    if (rows.length > 0 && rows[0].user_id !== userSub) return "forbidden";
    return "ok";
  } catch {
    return "error";
  }
}

export function registerChatRoutes(
  router: RestRouter,
  connectionMap: RuntimeConnectionMap,
  jwtSecret: string,
): void {
  // POST /api/v1/siclaw/agents/:id/chat/send — SSE streaming
  router.post("/api/v1/siclaw/agents/:id/chat/send", async (req, res, params) => {
    // Capture the earliest possible server-side turn anchor: the moment the
    // POST request lands at portal. This is closer to "user clicked send"
    // than the runtime's sse-consumer entry, shaving the portal→runtime RPC
    // overhead off of timing measurements. Single clock by design — passed
    // down through chat.send so the runtime uses the same epoch.
    const turnStartMs = Date.now();
    const auth = requireAuth(req, jwtSecret);
    if (!auth) {
      sendJson(res, 401, errorBody({ code: ErrorCodes.INTERNAL, message: "Authentication required", retriable: false }));
      return;
    }

    const body = await parseChatRequestBody(req, res);
    if (!body) return;
    if (!body.text && !normalizeChatAttachments(body.attachments).length) {
      sendJson(res, 400, errorBody({ code: ErrorCodes.BAD_REQUEST, message: "text or supported attachment is required", retriable: false }));
      return;
    }

    const agentId = params.id;
    const sessionId = body.session_id ?? crypto.randomUUID();

    if (!connectionMap.isConnected(agentId)) {
      sendJson(res, 503, errorBody({
        code: ErrorCodes.CONNECTION_FAILED,
        message: `Agent runtime is not connected for agent ${agentId}`,
        retriable: true,
      }));
      return;
    }

    // Resolve agent's bound model + provider config from DB
    const modelBinding = await resolveAgentModelBinding(agentId);
    if (!modelBinding) {
      sendJson(res, 400, errorBody({
        code: ErrorCodes.BAD_REQUEST,
        message: "Agent has no model configured, or the bound provider/model was not found",
        retriable: false,
      }));
      return;
    }

    // Set up SSE response
    writeSseHead(res);

    // Subscribe to chat events for this agent, filter by sessionId
    let unsubscribe: (() => void) | null = null;

    function cleanup(): void {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }

    req.on("close", cleanup);

    unsubscribe = connectionMap.subscribe(agentId, "chat.event", (data: unknown) => {
      const envelope = data as { sessionId?: string; event?: Record<string, unknown> } | undefined;
      if (!envelope?.event) return;
      if (envelope.sessionId && envelope.sessionId !== sessionId) return;

      const evt = envelope.event;

      // Translate stream_error events to a canonical SSE error frame so the
      // frontend handles them via the same code path as RPC-level failures.
      if (evt.type === "stream_error") {
        const detail = isErrorDetail(evt.error)
          ? (evt.error as ErrorDetail)
          : { code: ErrorCodes.STREAM_INTERRUPTED, message: "Stream error", retriable: true };
        sseWrite(res, "error", detail);
        return;
      }

      sseWrite(res, "chat.event", evt);

      // Stream complete — only on prompt_done (sent by Runtime after ALL agent
      // turns finish). agent_end fires after each individual turn and must NOT
      // close the stream, or multi-turn responses (tool calls → text) get cut off.
      if (evt.type === "prompt_done" || evt.type === "done") {
        sseWrite(res, "done", {});
        res.end();
        cleanup();
      }
    });

    const promptText = await appendOcrEvidence(body.text ?? "", body.attachments);

    // Send chat.send command
    const result = await connectionMap.sendCommand(agentId, "chat.send", {
      agentId,
      userId: auth.userId,
      text: promptText,
      sessionId,
      modelProvider: modelBinding.modelProvider,
      modelId: modelBinding.modelId,
      modelConfig: modelBinding.modelConfig,
      modelRouting: modelBinding.modelRouting,
      turnStartMs,
    });

    if (!result.ok) {
      sseWrite(res, "error", {
        code: ErrorCodes.INTERNAL,
        message: result.error ?? "RPC failed",
        retriable: true,
      });
      res.end();
      cleanup();
      return;
    }

    // Initial response — send session info
    sseWrite(res, "session", { sessionId: (result.payload as Record<string, unknown>)?.sessionId ?? sessionId });
  });

  // GET /api/v1/siclaw/agents/:id/chat/sessions/:sessionId/events — persistent SSE.
  //
  // Unlike /send (which subscribes to chat.event only for the duration of one prompt and
  // closes on prompt_done), this stream stays open for the lifetime of the viewed session,
  // so the frontend can receive server-pushed turns that land while the user is idle — e.g.
  // a background job's completion turn, generated after the /send stream already closed.
  //
  // EventSource cannot set the Authorization header, so the JWT is passed as a ?token=
  // query param (same pattern as /ws/notifications). The frontend keys on the
  // `background_turn_done` event to silently refetch history; other chat.event types are
  // ignored client-side (the synthetic turn's body is loaded from DB, not rendered live —
  // message_update text deltas are intentionally not emitted on this channel).
  router.get("/api/v1/siclaw/agents/:id/chat/sessions/:sessionId/events", async (req, res, params) => {
    const token = parseQuery(req.url ?? "").token;
    const payload = token ? verifyJwt(token, jwtSecret) : null;
    if (!payload?.sub) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const agentId = params.id;
    const sessionId = params.sessionId;

    // Authorization: this is a read channel for the session's chat.event stream, so the
    // caller MUST own it. A brand-new (not-yet-persisted) session has no row → allowed, so the
    // frontend's EventSource doesn't 404-storm before the first message lands.
    const authz = await authorizeSessionOwnership(agentId, sessionId, payload.sub);
    if (authz === "forbidden") { sendJson(res, 403, { error: "Forbidden" }); return; }
    if (authz === "error") { sendJson(res, 500, { error: "Failed to authorize session" }); return; }

    writeSseHead(res);

    let unsubscribe: (() => void) | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    function cleanup(): void {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
    }
    // Tear down on ANY connection-end signal. A half-open socket (proxy/NAT drop without a
    // clean 'close') would otherwise keep the subscription + interval alive, and EventSource
    // reconnects open fresh ones — an unbounded subscriber/timer leak. res 'close'/'error'
    // cover the cases req 'close' misses.
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    unsubscribe = connectionMap.subscribe(agentId, "chat.event", (data: unknown) => {
      const envelope = data as { sessionId?: string; event?: Record<string, unknown> } | undefined;
      if (!envelope?.event) return;
      if (envelope.sessionId && envelope.sessionId !== sessionId) return;
      sseWrite(res, "chat.event", envelope.event);
    });

    // Open the stream (fires the client's onopen) + a heartbeat so proxies don't reap the
    // idle connection. EventSource auto-reconnects on drop, but a dropped window could miss
    // a trigger — the heartbeat keeps it alive. unref so it never holds the process open.
    res.write(": connected\n\n");
    keepalive = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch { cleanup(); }
    }, 25_000);
    keepalive.unref?.();
  });

  // GET /api/v1/siclaw/agents/:id/chat/sessions/:sessionId/status — explicit turn liveness.
  //
  // Read-only. The Portal frontend calls this right after loading history on a fresh page
  // (hard refresh / reconnect): if the turn is still running it re-attaches to the live
  // /events stream and keeps rendering, instead of showing a static snapshot. Liveness is the
  // runtime/agentbox's own activity flags (chat.sessionStatus RPC → agentbox /status), never a
  // chat-row inference. Any failure is fail-safe `{running:false}` — better a static page than
  // a stuck spinner.
  router.get("/api/v1/siclaw/agents/:id/chat/sessions/:sessionId/status", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const authz = await authorizeSessionOwnership(params.id, params.sessionId, auth.userId);
    if (authz === "forbidden") { sendJson(res, 403, { error: "Forbidden" }); return; }
    if (authz === "error") { sendJson(res, 500, { error: "Failed to authorize session" }); return; }

    const result = await connectionMap.sendCommand(params.id, "chat.sessionStatus", {
      agentId: params.id,
      userId: auth.userId,
      sessionId: params.sessionId,
    });
    sendJson(res, 200, { running: result.ok && !!(result.payload as Record<string, unknown> | undefined)?.running });
  });

  // POST /api/v1/siclaw/agents/:id/chat/steer — inject steer message
  router.post("/api/v1/siclaw/agents/:id/chat/steer", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseChatRequestBody(req, res);
    if (!body) return;
    if (!body.session_id || (!body.text && !normalizeChatAttachments(body.attachments).length)) { sendJson(res, 400, { error: "session_id and text or attachments are required" }); return; }
    const promptText = await appendOcrEvidence(body.text ?? "", body.attachments);

    const result = await connectionMap.sendCommand(params.id, "chat.steer", {
      agentId: params.id,
      userId: auth.userId,
      sessionId: body.session_id,
      text: promptText,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // POST /api/v1/siclaw/agents/:id/chat/abort — abort current execution
  router.post("/api/v1/siclaw/agents/:id/chat/abort", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ session_id?: string }>(req);
    if (!body.session_id) { sendJson(res, 400, { error: "session_id is required" }); return; }

    const result = await connectionMap.sendCommand(params.id, "chat.abort", {
      agentId: params.id,
      userId: auth.userId,
      sessionId: body.session_id,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // POST /api/v1/siclaw/agents/:id/chat/clear-queue — clear queued steer/followUp messages
  router.post("/api/v1/siclaw/agents/:id/chat/clear-queue", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const body = await parseBody<{ session_id?: string }>(req);
    if (!body.session_id) { sendJson(res, 400, { error: "session_id is required" }); return; }

    const result = await connectionMap.sendCommand(params.id, "chat.clearQueue", {
      agentId: params.id,
      userId: auth.userId,
      sessionId: body.session_id,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // POST /api/v1/siclaw/agents/:id/clear-memory — clear agent memory
  router.post("/api/v1/siclaw/agents/:id/clear-memory", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const result = await connectionMap.sendCommand(params.id, "agent.clearMemory", {
      agentId: params.id,
      userId: auth.userId,
    });

    sendJson(res, result.ok ? 200 : 502, result);
  });

  // ================================================================
  // POST /api/v1/run — External API (API key auth, agent resolved from key)
  // ================================================================

  router.post("/api/v1/run", async (req, res) => {
    const keyAuth = await authenticateApiKey(req);
    if (!keyAuth) {
      sendJson(res, 401, {
        error: "Invalid or expired API key",
        hint: "Use Authorization: Bearer sk-xxx header with a valid API key",
      });
      return;
    }

    const body = await parseBody<{ text?: string; session_id?: string }>(req);
    if (!body.text) { sendJson(res, 400, { error: "text is required" }); return; }

    const agentId = keyAuth.agentId;
    const sessionId = body.session_id ?? crypto.randomUUID();

    if (!connectionMap.isConnected(agentId)) {
      sendJson(res, 503, { error: "Agent runtime is not connected" });
      return;
    }

    const modelBinding = await resolveAgentModelBinding(agentId);
    if (!modelBinding) {
      sendJson(res, 400, { error: "Agent has no model configured" });
      return;
    }

    let assistantText = "";
    let resolved = false;

    function cleanup(): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }

    req.on("close", () => {
      cleanup();
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        sendJson(res, 504, { error: "Execution timeout" });
      }
    }, 300_000);

    let unsubscribe: (() => void) | null = connectionMap.subscribe(agentId, "chat.event", (data: unknown) => {
      if (resolved) return;
      const envelope = data as { sessionId?: string; event?: Record<string, unknown> } | undefined;
      if (!envelope?.event) return;
      if (envelope.sessionId && envelope.sessionId !== sessionId) return;

      const evt = envelope.event;
      if (evt.type === "agent_message" && typeof evt.text === "string") assistantText += evt.text;
      if (evt.type === "message_update") {
        const ame = (evt as any).assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") assistantText += ame.delta;
      }
      if (evt.type === "prompt_done" || evt.type === "done") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          sendJson(res, 200, { session_id: sessionId, agent_id: agentId, text: assistantText, status: "success" });
        }
      }
    });

    const result = await connectionMap.sendCommand(agentId, "chat.send", {
      agentId,
      userId: keyAuth.createdBy,
      text: body.text,
      sessionId,
      mode: "api",
      modelProvider: modelBinding.modelProvider,
      modelId: modelBinding.modelId,
      modelConfig: modelBinding.modelConfig,
      modelRouting: modelBinding.modelRouting,
    });

    if (!result.ok && !resolved) {
      resolved = true;
      clearTimeout(timeout);
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      sendJson(res, 500, { error: result.error ?? "Execution failed" });
    }
  });
}
