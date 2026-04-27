/**
 * AgentBox HTTP Client
 *
 * Client used by the Gateway to call the AgentBox HTTP API.
 * Supports mTLS when TLS options are provided.
 */

import https from "node:https";
import { GATEWAY_SYNC_DESCRIPTORS, type GatewaySyncType } from "../../shared/gateway-sync.js";

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
}

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
   * Send a prompt
   */
  async prompt(opts: PromptOptions): Promise<PromptResponse> {
    console.log(`[agentbox-client] prompt sessionId=${opts.sessionId ?? "new"}`);
    const resp = await this.fetch("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
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
   * Get context usage
   */
  async getContextUsage(sessionId: string): Promise<ContextUsageResponse> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/context`);
    return resp.json();
  }

  /**
   * Send a steer instruction (inserts a user message after interrupting the current tool)
   */
  async steerSession(sessionId: string, text: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
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
   * Subscribe to the SSE event stream
   *
   * Returns an AsyncIterable that can be iterated with for-await-of.
   */
  async *streamEvents(sessionId: string): AsyncIterable<unknown> {
    const url = `${this.endpoint}/api/stream/${sessionId}`;

    // Use https.request for HTTPS with mTLS
    if (this.httpsAgent && this.endpoint.startsWith("https://")) {
      yield* this.streamEventsHttps(sessionId);
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

    console.log(`[agentbox-client] SSE open sessionId=${sessionId}`);
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
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              eventCount++;
              yield JSON.parse(data);
            } catch {
              console.warn(`[agentbox-client] SSE parse error sessionId=${sessionId}: ${data.slice(0, 100)}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[agentbox-client] SSE stream error sessionId=${sessionId}:`, err instanceof Error ? err.message : err);
      throw err;
    } finally {
      console.log(`[agentbox-client] SSE closed sessionId=${sessionId} (${eventCount} events)`);
      reader.releaseLock();
    }
  }

  /**
   * SSE stream over HTTPS with mTLS
   */
  private async *streamEventsHttps(sessionId: string): AsyncIterable<unknown> {
    const urlObj = new URL(`/api/stream/${sessionId}`, this.endpoint);

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

    console.log(`[agentbox-client] SSE open (HTTPS) sessionId=${sessionId}`);
    let buffer = "";
    let eventCount = 0;

    try {
      for await (const chunk of res) {
        buffer += chunk.toString();

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              eventCount++;
              yield JSON.parse(data);
            } catch {
              console.warn(`[agentbox-client] SSE parse error sessionId=${sessionId}: ${data.slice(0, 100)}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[agentbox-client] SSE stream error sessionId=${sessionId}:`, err instanceof Error ? err.message : err);
      throw err;
    } finally {
      console.log(`[agentbox-client] SSE closed (HTTPS) sessionId=${sessionId} (${eventCount} events)`);
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
        throw new Error(`AgentBox request failed: ${resp.status} ${text}`);
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
              reject(new Error(`AgentBox request failed: ${status} ${body}`));
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
