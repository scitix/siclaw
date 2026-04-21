/**
 * Gateway Client for AgentBox
 *
 * HTTP client that uses mTLS client certificates to call Gateway's internal APIs.
 * Used by AgentBox to query metadata (settings, agent tasks, etc.)
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

export interface GatewayClientOptions {
  gatewayUrl: string;
  certPath?: string; // Directory containing tls.crt, tls.key, ca.crt
  /**
   * Chat session ID threaded through to the Gateway's internal-api so it can
   * resolve the user identity via sessionRegistry. Required on task mutation
   * calls (create/update/delete) if the task's `created_by` should be attributed
   * to the chat user rather than left blank — without it, the Runtime-side
   * sessionRegistry.resolveUser falls back to empty string and downstream
   * cron-task notifications can't route to a user.
   */
  sessionId?: string;
}

export interface AgentTask {
  id: string;
  name: string;
  schedule: string;
  status: string;
  description?: string | null;
  prompt?: string | null;
  lastRunAt?: string | null;
  lastResult?: string | null;
  agentId?: string | null;
}

export class GatewayClient {
  private gatewayUrl: string;
  private tlsOptions: https.RequestOptions | null = null;
  private sessionId?: string;

  constructor(options: GatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, ""); // Remove trailing slash
    this.sessionId = options.sessionId;

    // Load client certificates if certPath provided
    const certPath = options.certPath || process.env.SICLAW_CERT_PATH || "/etc/siclaw/certs";

    const certFile = path.join(certPath, "tls.crt");
    const keyFile = path.join(certPath, "tls.key");
    const caFile = path.join(certPath, "ca.crt");

    // Check if certificate files exist
    if (fs.existsSync(certFile) && fs.existsSync(keyFile) && fs.existsSync(caFile)) {
      this.tlsOptions = {
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
        ca: fs.readFileSync(caFile),
        rejectUnauthorized: true, // Verify Gateway's certificate
      };
      console.log(`[gateway-client] Loaded client certificates from ${certPath}`);
    } else {
      console.warn(`[gateway-client] Client certificates not found at ${certPath}, will use plain HTTP`);
    }
  }

  /**
   * Fetch settings (providers, models, embedding config) from Gateway
   */
  async fetchSettings(): Promise<any> {
    return this.request("/api/internal/settings", "GET");
  }

  /**
   * List the agent's scheduled tasks. Agent identity is derived from the
   * mTLS client certificate by the Gateway — no userId/agentId needed here.
   */
  async listAgentTasks(): Promise<AgentTask[]> {
    const data = await this.request("/api/internal/agent-tasks", "GET");
    return data.tasks || [];
  }

  async createAgentTask(input: {
    name: string;
    schedule: string;
    prompt: string;
    description?: string;
    status?: "active" | "paused";
  }): Promise<AgentTask> {
    return this.request("/api/internal/agent-tasks", "POST", this.withSession(input));
  }

  async updateAgentTask(
    taskId: string,
    updates: Partial<{
      name: string;
      schedule: string;
      prompt: string;
      description: string;
      status: "active" | "paused";
    }>,
  ): Promise<AgentTask> {
    return this.request(
      `/api/internal/agent-tasks/${encodeURIComponent(taskId)}`,
      "PUT",
      this.withSession(updates),
    );
  }

  async deleteAgentTask(taskId: string): Promise<void> {
    // DELETE has no body; the internal-api handler reads session_id from the
    // URL query string (see src/gateway/internal-api.ts handleAgentTasksDelete).
    const qs = this.sessionId ? `?session_id=${encodeURIComponent(this.sessionId)}` : "";
    await this.request(`/api/internal/agent-tasks/${encodeURIComponent(taskId)}${qs}`, "DELETE");
  }

  /** Spread the current session_id into a request body (no-op if not set). */
  private withSession<T extends object>(body: T): T & { session_id?: string } {
    if (!this.sessionId) return body;
    return { ...body, session_id: this.sessionId };
  }

  /**
   * Search the team knowledge base
   */
  async searchKnowledge(query: string, topK = 5, minScore = 0.35): Promise<import("../memory/types.js").MemorySearchResult> {
    const url = `/api/internal/knowledge-search?query=${encodeURIComponent(query)}&topK=${topK}&minScore=${minScore}`;
    return this.request(url, "GET");
  }

  /**
   * Return a GatewaySyncClientLike adapter for use with sync handlers.
   * Keeps `request()` private while exposing a minimal interface.
   */
  toClientLike(): import("../shared/gateway-sync.js").GatewaySyncClientLike {
    return {
      request: (p: string, m: "GET" | "POST" | "PUT" | "DELETE", b?: unknown) => this.request(p, m, b),
    };
  }

  /**
   * Make HTTP(S) request to Gateway with mTLS authentication
   */
  private request(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.gatewayUrl);
      const isHttps = url.protocol === "https:";

      const requestOptions: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
        },
        ...(isHttps && this.tlsOptions ? this.tlsOptions : {}),
      };

      const client = isHttps ? https : http;
      const req = client.request(requestOptions, (res: any) => {
        let data = "";

        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });

        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (res.statusCode === 204 || !data) {
              resolve(undefined);
              return;
            }
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (err) {
              reject(new Error(`Failed to parse JSON response: ${data}`));
            }
          } else {
            reject(new Error(`Gateway returned ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", (err: Error) => {
        reject(new Error(`Gateway request failed: ${err.message}`));
      });

      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Gateway request timeout"));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }
}
