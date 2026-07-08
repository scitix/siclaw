/**
 * AgentBox HTTP Client
 *
 * Client used by the Gateway to call the AgentBox HTTP API.
 * Supports mTLS when TLS options are provided.
 */

import https from "node:https";
import { GATEWAY_SYNC_DESCRIPTORS, type GatewaySyncType } from "../../shared/gateway-sync.js";
import { modelOptionsSupportImageInput, type ModelRoutePolicy } from "../../core/model-routing.js";
import { enrichImagesFromText, redactImageUrlsInText } from "./image-url-ingest.js";

export interface AgentBoxTlsOptions {
  cert: string;
  key: string;
  ca: string;
}

export interface PromptOptions {
  sessionId?: string;
  text: string;
  /** string = use this env, null = explicitly no env, undefined = keep current */
  kubeconfigPath?: string | null;
  /** Session mode — "web" | "channel" */
  mode?: string;
  /** Model provider to use for this prompt */
  modelProvider?: string;
  /** Model ID to use for this prompt */
  modelId?: string;
  /** Agent ID (for logging/context) */
  agentId?: string;
  /** Custom system prompt template from agent settings */
  systemPromptTemplate?: string;
  /** Full provider config for dynamic registration (from gateway DB) */
  modelConfig?: {
    name: string;
    baseUrl: string;
    apiKey: string;
    api: string;
    authHeader: boolean;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: string[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat?: Record<string, unknown>;
    }>;
  };
  /** Optional ordered model fallback policy. Omitted means legacy single-model behavior. */
  modelRouting?: ModelRoutePolicy;
  /** Image attachments (raw base64, no data: prefix) forwarded as vision input. */
  images?: Array<{ mimeType: string; data: string }>;
  /** File attachments forwarded as native model file input. */
  files?: Array<{ mimeType: string; filename: string; data: string }>;
}

export type PromptMediaOptions = Pick<PromptOptions, "images" | "files">;

export interface PromptResponse {
  ok: boolean;
  sessionId: string;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface HealthResponse {
  status: string;
  sessions: number;
  timestamp: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface ContextUsageResponse {
  tokens: number;
  contextWindow: number;
  percent: number;
  isCompacting: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export class AgentBoxClient {
  private endpoint: string;
  private timeoutMs: number;
  private httpsAgent: https.Agent | null = null;

  constructor(endpoint: string, timeoutMs = 30000, tlsOptions?: AgentBoxTlsOptions) {
    this.endpoint = endpoint.replace(/\/$/, ""); // Remove trailing slash
    this.timeoutMs = timeoutMs;

    if (tlsOptions) {
      this.httpsAgent = new https.Agent({
        cert: tlsOptions.cert,
        key: tlsOptions.key,
        ca: tlsOptions.ca,
        checkServerIdentity: () => undefined, // Skip hostname verification (cert CN=userId, not hostname)
        rejectUnauthorized: true,
      });
    }
  }

  /**
   * Generic GET request returning parsed JSON (used by metrics snapshot pull, etc.)
   */
  async getJson<T = unknown>(path: string): Promise<T> {
    const resp = await this.fetch(path);
    return resp.json();
  }

  /**
   * Health check
   */
  async health(): Promise<HealthResponse> {
    const resp = await this.fetch("/health");
    return resp.json();
  }

  /**
   * Resolve image URLs in the prompt text into vision `images`, but ONLY when the
   * prompt's model/route can take image input (see DESIGN decision 1). Non-vision:
   * the URL is left as plain text — the model replies it can't open it; no
   * fail-closed turn.
   *
   * This is the SINGLE backend place text-URL images are resolved, covering ALL
   * front-ends that reach AgentBox via this client — Feishu, DingTalk, Web chat,
   * a2a, and cron (every `client.prompt` caller). Only user→agent prompts
   * flow through THIS client; system/synthetic prompts run inside the AgentBox
   * process and never reach here, so this never scans system text. The fetch +
   * SSRF allowlist stay in the Gateway process (the AgentBox pod is
   * network-isolated and must not fetch arbitrary user URLs).
   *
   * The text forwarded to AgentBox (model context + session history) has any
   * signed-URL credentials stripped — the fetch above already used the full URL,
   * so resolution is unaffected, but `Signature`/`AccessKeyId` don't get
   * persisted/sent in plaintext.
   */
  async #withResolvedImageUrls(opts: PromptOptions): Promise<PromptOptions> {
    const images = modelOptionsSupportImageInput(opts)
      ? await enrichImagesFromText(opts.text, opts.images ?? [])
      : opts.images;
    const text = redactImageUrlsInText(opts.text);
    if (text === opts.text && images === opts.images) return opts;
    const next: PromptOptions = { ...opts, text };
    if (images && images.length) next.images = images;
    return next;
  }

  /**
   * Send a prompt
   */
  async prompt(opts: PromptOptions): Promise<PromptResponse> {
    const sendOpts = await this.#withResolvedImageUrls(opts);
    console.log(`[agentbox-client] prompt sessionId=${sendOpts.sessionId ?? "new"}`);
    const resp = await this.fetch("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sendOpts),
    });
    const result: PromptResponse = await resp.json();
    console.log(`[agentbox-client] prompt → ok=${result.ok} sessionId=${result.sessionId}`);
    return result;
  }

  /**
   * Get session list
   */
  async listSessions(): Promise<{ sessions: SessionInfo[] }> {
    const resp = await this.fetch("/api/sessions");
    return resp.json();
  }

  /**
   * Generic sync reload — POST to the descriptor's reloadPath.
   */
  async reloadResource(type: GatewaySyncType): Promise<unknown> {
    const descriptor = GATEWAY_SYNC_DESCRIPTORS[type];
    const resp = await this.fetch(descriptor.reloadPath, {
      method: "POST",
    });
    return resp.json();
  }

  /**
   * POST to an arbitrary path on the AgentBox.
   */
  async post(path: string): Promise<unknown> {
    const resp = await this.fetch(path, { method: "POST" });
    return resp.json();
  }

  /**
   * POST a JSON body to an arbitrary path, returning parsed JSON.
   * Used by the capability session driver (POST /sources, /session, /message).
   */
  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const resp = await this.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  /**
   * Get context usage
   */
  async getContextUsage(sessionId: string): Promise<ContextUsageResponse> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/context`);
    return resp.json();
  }

  /**
   * Send a steer instruction (inserts a user message after interrupting the current tool)
   */
  async steerSession(sessionId: string, text: string, media?: PromptMediaOptions): Promise<void> {
    const images = media?.images;
    const files = media?.files;
    await this.fetch(`/api/sessions/${sessionId}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...(images && images.length > 0 ? { images } : {}),
        ...(files && files.length > 0 ? { files } : {}),
      }),
    });
  }

  /**
   * Clear queued steer/followUp messages
   */
  async clearQueue(sessionId: string): Promise<{ steering: string[]; followUp: string[] }> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/clear-queue`, {
      method: "POST",
    });
    return resp.json();
  }

  /**
   * Abort the current prompt execution
   */
  async abortSession(sessionId: string): Promise<void> {
    console.log(`[agentbox-client] abort sessionId=${sessionId}`);
    await this.fetch(`/api/sessions/${sessionId}/abort`, {
      method: "POST",
    });
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
  }

  /**
   * Reset memory indexer after Gateway has cleared PVC files.
   */
  async resetMemory(): Promise<{ ok: boolean }> {
    const resp = await this.fetch("/api/memory", {
      method: "DELETE",
    });
    return resp.json();
  }

  /**
   * Get DP mode flag for recovery.
   * Returns { active } — the session's current DP on/off state.
   */
  async getDpState(sessionId: string): Promise<{ active: boolean }> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/dp-state`);
    return resp.json();
  }

  /**
   * Liveness of a session's in-progress turn (agentbox activity flags). Used by the Portal
   * reconnect-after-refresh flow to decide whether to re-attach to the live event stream.
   */
  async sessionStatus(sessionId: string): Promise<{ running: boolean }> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/status`);
    return resp.json();
  }

  /**
   * List available models
   */
  async listModels(): Promise<{ models: ModelInfo[] }> {
    const resp = await this.fetch("/api/models");
    return resp.json();
  }

  /**
   * Get the current model
   */
  async getModel(sessionId: string): Promise<{ model: ModelInfo | null }> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/model`);
    return resp.json();
  }

  /**
   * Switch model
   */
  async setModel(sessionId: string, provider: string, modelId: string): Promise<{ ok: boolean; model: ModelInfo }> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId }),
    });
    return resp.json();
  }

  /**
   * Subscribe to a session's SSE event stream.
   *
   * Returns an AsyncIterable that can be iterated with for-await-of.
   */
  async *streamEvents(sessionId: string): AsyncIterable<unknown> {
    yield* this.streamPath(`/api/stream/${sessionId}`);
  }

  /**
   * Subscribe to an SSE event stream on an arbitrary path. The kb box
   * streams structured events on /events/:runId; agentbox uses /api/stream/:id.
   * Both speak `data: <json>\n\n` with `: heartbeat` comment lines.
   */
  async *streamPath(path: string, opts?: { onComment?: () => void }): AsyncIterable<unknown> {
    const url = `${this.endpoint}${path}`;

    // Use https.request for HTTPS with mTLS
    if (this.httpsAgent && this.endpoint.startsWith("https://")) {
      yield* this.streamPathHttps(path, opts);
      return;
    }

    const resp = await fetch(url, {
      headers: { Accept: "text/event-stream" },
    });

    if (!resp.ok) {
      throw new Error(`Stream request failed: ${resp.status}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    console.log(`[agentbox-client] SSE open path=${path}`);
    const decoder = new TextDecoder();
    let buffer = "";
    let eventCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Retain incomplete line

        for (const line of lines) {
          if (line.startsWith("data:")) {
            // SSE spec: the value is everything after the colon, minus ONE
            // optional leading space — "data:x" is as valid as "data: x".
            const data = line.slice(5).replace(/^ /, "");
            try {
              eventCount++;
              yield JSON.parse(data);
            } catch {
              console.warn(`[agentbox-client] SSE parse error path=${path}: ${data.slice(0, 100)}`);
            }
          } else if (line.startsWith(":")) {
            // SSE comment — the box's keep-alive. Callers that watchdog on data
            // events can opt in to hear it (a healthy-but-quiet compile must not
            // be reaped as stale); it is never yielded as an event.
            opts?.onComment?.();
          }
        }
      }
    } catch (err) {
      console.error(`[agentbox-client] SSE stream error path=${path}:`, err instanceof Error ? err.message : err);
      throw err;
    } finally {
      console.log(`[agentbox-client] SSE closed path=${path} (${eventCount} events)`);
      reader.releaseLock();
    }
  }

  /**
   * SSE stream over HTTPS with mTLS, on an arbitrary path.
   */
  private async *streamPathHttps(path: string, opts?: { onComment?: () => void }): AsyncIterable<unknown> {
    const urlObj = new URL(path, this.endpoint);

    const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: "GET",
          headers: { Accept: "text/event-stream" },
          agent: this.httpsAgent!,
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });

    if (res.statusCode !== 200) {
      throw new Error(`Stream request failed: ${res.statusCode}`);
    }

    console.log(`[agentbox-client] SSE open (HTTPS) path=${path}`);
    let buffer = "";
    let eventCount = 0;

    try {
      for await (const chunk of res) {
        buffer += chunk.toString();

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            // SSE spec: the value is everything after the colon, minus ONE
            // optional leading space — "data:x" is as valid as "data: x".
            const data = line.slice(5).replace(/^ /, "");
            try {
              eventCount++;
              yield JSON.parse(data);
            } catch {
              console.warn(`[agentbox-client] SSE parse error path=${path}: ${data.slice(0, 100)}`);
            }
          } else if (line.startsWith(":")) {
            // SSE comment — the box's keep-alive. Callers that watchdog on data
            // events can opt in to hear it (a healthy-but-quiet compile must not
            // be reaped as stale); it is never yielded as an event.
            opts?.onComment?.();
          }
        }
      }
    } catch (err) {
      console.error(`[agentbox-client] SSE stream error path=${path}:`, err instanceof Error ? err.message : err);
      throw err;
    } finally {
      console.log(`[agentbox-client] SSE closed (HTTPS) path=${path} (${eventCount} events)`);
    }
  }

  /**
   * Base fetch wrapper (supports both HTTP and HTTPS with mTLS)
   */
  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.endpoint}${path}`;
    const method = init?.method ?? "GET";

    // Use https.request for HTTPS with mTLS
    if (this.httpsAgent && this.endpoint.startsWith("https://")) {
      return this.httpsRequest(path, init);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error(`[agentbox-client] HTTP error: ${method} ${path} → ${resp.status} ${text.slice(0, 200)}`);
        // Carry the HTTP status structurally so callers can branch on it (e.g.
        // materialize's 409 = box-already-live) without parsing the message.
        const e = new Error(`AgentBox request failed: ${resp.status} ${text}`) as Error & { status: number };
        e.status = resp.status;
        throw e;
      }

      return resp;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`[agentbox-client] HTTP timeout: ${method} ${path} (${this.timeoutMs}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * HTTPS request with mTLS (returns a Response-compatible object)
   */
  private httpsRequest(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const urlObj = new URL(path, this.endpoint);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method,
          headers: init?.headers as Record<string, string>,
          agent: this.httpsAgent!,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 500;
            if (status >= 200 && status < 300) {
              resolve(new Response(body, { status, statusText: res.statusMessage }));
            } else {
              console.error(`[agentbox-client] HTTPS error: ${method} ${path} → ${status} ${body.slice(0, 200)}`);
              const e = new Error(`AgentBox request failed: ${status} ${body}`) as Error & { status: number };
              e.status = status;
              reject(e);
            }
          });
        },
      );

      req.on("error", reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new Error(`AgentBox HTTPS request timeout: ${method} ${path} (${this.timeoutMs}ms)`));
      });

      if (init?.body) {
        req.write(init.body);
      }
      req.end();
    });
  }
}
