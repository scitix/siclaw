/**
 * AgentBox HTTP Client
 *
 * Client used by the Gateway to call the AgentBox HTTP API.
 */

export interface PromptOptions {
  sessionId?: string;
  text: string;
  /** string = use this env, null = explicitly no env, undefined = keep current */
  kubeconfigPath?: string | null;
  /** Environment ID for schedule filtering — string = use this env, null = no env */
  envId?: string | null;
  /** Whether this is a test environment (use .skills-dev skills) */
  isTestEnv?: boolean;
  /** Session mode — "web" | "channel" */
  mode?: string;
  /** Model provider to use for this prompt */
  modelProvider?: string;
  /** Model ID to use for this prompt */
  modelId?: string;
  /** Brain type — "pi-agent" | "claude-sdk" */
  brainType?: string;
  /** Workspace ID (for logging/context) */
  workspaceId?: string;
  /** Workspace-specific credentials directory (absolute path, from gateway sync) */
  credentialsDir?: string;
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
  brainType?: string;
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

  constructor(endpoint: string, timeoutMs = 30000) {
    this.endpoint = endpoint.replace(/\/$/, ""); // Remove trailing slash
    this.timeoutMs = timeoutMs;
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
   * Hot-reload skills — notify AgentBox to rescan the skills directory
   */
  async reloadSkills(): Promise<{ ok: boolean; reloaded: number; errors: string[] }> {
    const resp = await this.fetch("/api/reload-skills", {
      method: "POST",
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
   * Confirm hypotheses — directly clears the deep_search gate
   */
  async confirmHypotheses(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/confirm-hypotheses`, {
      method: "POST",
    });
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
    await this.fetch(`/api/sessions/${sessionId}/close`, {
      method: "POST",
    });
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
  async getModel(sessionId: string): Promise<{ model: ModelInfo | null; brainType?: string }> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/model`);
    return resp.json();
  }

  /**
   * Switch model
   */
  async setModel(sessionId: string, provider: string, modelId: string): Promise<{ ok: boolean; model: ModelInfo }> {
    const resp = await this.fetch(`/api/sessions/${sessionId}/model`, {
      method: "POST",
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
   * Base fetch wrapper
   */
  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.endpoint}${path}`;
    const method = init?.method ?? "GET";

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
}
