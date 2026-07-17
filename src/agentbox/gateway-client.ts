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
import type { DelegationPersistenceEvent, DelegationPersistenceResponse } from "../shared/delegation-persistence.js";
import type { MetricsFlushPayload } from "../shared/metrics-types.js";
import type { DelegateRequest, DelegateResponse, DelegatesResponse } from "../shared/agent-delegate.js";

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
   * Fetch the GLOBAL tracing config (TracingConfig) for a hot-reload. Distinct
   * from fetchSettings: this proxies to config.getTracingConfig (no agentId), so
   * it never drops tracing for an agent without a bound provider.
   */
  async fetchTracingConfig(): Promise<any> {
    return this.request("/api/internal/tracing-config", "GET");
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
   * Send background delegation persistence/audit events to Runtime.
   *
   * AgentBox must not import Gateway DB/RPC modules directly: in K8s it runs in
   * a separate pod, while Runtime owns the Portal RPC connection.
   */
  async sendDelegationPersistenceEvent(event: DelegationPersistenceEvent): Promise<DelegationPersistenceResponse> {
    return this.request("/api/internal/delegation-events", "POST", event);
  }

  /**
   * SIGTERM final flush: push this process's cumulative prom snapshot to the Gateway
   * so the last <pull-interval of increments isn't lost when the pod is recycled
   * (metrics-federation-DESIGN.md module 5). The Gateway derives boxId from our mTLS
   * cert — we send only the incarnation + prom snapshot.
   *
   * Best-effort: callers must not let this block pod shutdown (the underlying request
   * already has a 5s timeout); a dropped final frame is better than a stuck pod.
   */
  async sendMetricsFlush(payload: MetricsFlushPayload): Promise<void> {
    await this.request("/api/internal/metrics-flush", "POST", payload);
  }

  /**
   * Agent-to-agent delegation (caller side), LIVE-streaming: ask the gateway to
   * run a bounded read-only task on a PEER agent. The gateway streams the peer's
   * events back as Server-Sent Events; `onPeerEvent` fires per peer chat.event
   * (so the coordinator can render the peer's steps live), and the promise
   * resolves with the final result when the `delegate_result` frame arrives.
   * The gateway re-validates the peer is in this box's coordinator roster.
   *
   * Generous timeout (10 min, matching the exec ceiling) — a real read-only
   * investigation easily exceeds the 5s default.
   */
  delegateStream(req: DelegateRequest, onPeerEvent: (evt: Record<string, unknown>) => void, signal?: AbortSignal): Promise<DelegateResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve({ ok: false, peerAgentId: req.peerAgentId, status: "failed", steps: [], error: "delegation stopped" });
        return;
      }
      const url = new URL("/api/internal/delegate", this.gatewayUrl);
      const isHttps = url.protocol === "https:";
      const requestOptions: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        ...(isHttps && this.tlsOptions ? this.tlsOptions : {}),
      };
      const client = isHttps ? https : http;
      let result: DelegateResponse | undefined;
      const request = client.request(requestOptions, (res: any) => {
        // Pre-stream error (non-200): body is a plain JSON error.
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let body = "";
          res.on("data", (c: Buffer) => { body += c.toString(); });
          res.on("end", () => {
            let error = `Gateway returned ${res.statusCode}`;
            try { error = (JSON.parse(body) as { error?: string }).error ?? error; } catch { /* keep */ }
            resolve({ ok: false, peerAgentId: req.peerAgentId, status: "failed", steps: [], error });
          });
          return;
        }
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).replace(/^ /, "");
            if (!data) continue;
            let frame: any;
            try { frame = JSON.parse(data); } catch { continue; }
            if (frame?.type === "peer_event" && frame.event) {
              try { onPeerEvent(frame.event as Record<string, unknown>); } catch { /* best-effort render */ }
            } else if (frame?.type === "delegate_session" && frame.peerSessionId) {
              // Early frame: peer session id, known at delegation start. Forward as a
              // synthetic event so the translator can surface it to the card live.
              try { onPeerEvent({ type: "delegate_session", peerSessionId: frame.peerSessionId }); } catch { /* best-effort */ }
            } else if (frame?.type === "delegate_result" && frame.result) {
              result = frame.result as DelegateResponse;
            }
          }
        });
        res.on("end", () => {
          resolve(result ?? { ok: false, peerAgentId: req.peerAgentId, status: "failed", steps: [], error: "delegation stream ended without a result" });
        });
      });
      request.on("error", (err: Error) => reject(new Error(`Delegate request failed: ${err.message}`)));
      // A delegated diagnosis is a long-running task — the peer runs its sub-agents
      // FOREGROUND, so a multi-node investigation legitimately takes many minutes
      // (observed 7-8 min). The old 10 min ceiling cut those off ("coordinator got
      // no report"). Allow up to 30 min; on timeout the request is destroyed, which
      // the gateway detects and uses to abort the peer turn.
      request.setTimeout(1_800_000, () => { request.destroy(); reject(new Error("Delegate request timed out after 30 min")); });
      // Stop: tearing down the request closes the connection, which the gateway
      // detects and uses to cancel the peer's turn. Resolve cleanly (the request's
      // subsequent 'error' is ignored once the promise has settled).
      if (signal) {
        signal.addEventListener("abort", () => {
          try { request.destroy(); } catch { /* already gone */ }
          resolve(result ?? { ok: false, peerAgentId: req.peerAgentId, status: "failed", steps: [], error: "delegation stopped" });
        }, { once: true });
      }
      request.write(JSON.stringify(req));
      request.end();
    });
  }

  /** Fetch this coordinator's delegation roster (authorization + manifest). */
  async fetchDelegates(): Promise<DelegatesResponse> {
    return this.request("/api/internal/delegates", "GET");
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
  private request(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: any, timeoutMs = 5000): Promise<any> {
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

      req.setTimeout(timeoutMs, () => {
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
