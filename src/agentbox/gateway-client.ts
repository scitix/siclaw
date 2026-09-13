import { PRIVATE_WORKSPACE_PATH, WorkspaceTransportError, type WorkspaceRequest } from "../shared/private-workspace.js";
/**
 * Gateway Client for AgentBox
 *
 * HTTP client that uses mTLS client certificates to call Gateway's internal APIs.
 * Used by AgentBox to query metadata (settings, agent tasks, etc.)
 */

import { SandboxInvocations } from "./sandbox-invocations.js";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { DelegationPersistenceEvent, DelegationPersistenceResponse } from "../shared/delegation-persistence.js";
import type { MetricsFlushPayload } from "../shared/metrics-types.js";
import { SESSION_HISTORY_PATH, type SessionHistoryResponse } from "../shared/session-history.js";
import { HANDOFF_TARGETS_PATH, HANDOFF_SEARCH_PATH, type HandoffSearchQuery, type HandoffSearchResponse, type HandoffTargetsResponse } from "../shared/agent-handoff.js";
import { certificateHasExpired, readCertificateNotAfter } from "../shared/cert-validity.js";

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
  readonly sandboxInvocations = new SandboxInvocations();

  async exchange<T>(request: WorkspaceRequest): Promise<T> {
    if (!this.tlsOptions) throw new Error("Private workspace requires authenticated transport");
    // Bound the whole renewal, including connect/TLS and response reads, so a
    // stalled request cannot occupy all subsequent 30-second renewal slots.
    const renewing = request.action === "renew";
    return this.request(PRIVATE_WORKSPACE_PATH, "POST", request, renewing ? 10_000 : 90_000,
      renewing ? AbortSignal.timeout(10_000) : undefined) as Promise<T>;
  }
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
      const cert = fs.readFileSync(certFile);
      this.tlsOptions = {
        cert,
        key: fs.readFileSync(keyFile),
        ca: fs.readFileSync(caFile),
        rejectUnauthorized: true, // Verify Gateway's certificate
      };
      // Say so when the certificate is already dead, because NOTHING else will. The Runtime
      // rejects it during the TLS handshake, which reaches this process as `socket hang up`
      // — a message that names neither certificates nor expiry, and which every startup
      // sync then repeats three times. The certificate is loaded anyway: refusing to start
      // would trade a diagnosable box for one that is not there at all, and the same
      // process also serves HTTPS with this certificate.
      const notAfter = readCertificateNotAfter(cert.toString("utf8"));
      if (certificateHasExpired(notAfter)) {
        console.error(
          `[gateway-client] CLIENT CERTIFICATE EXPIRED at ${notAfter?.toISOString()} — every call to the Gateway will fail ` +
          `the mTLS handshake and surface as "socket hang up". This pod needs to be recreated so it picks up a re-issued certificate.`,
        );
      } else {
        console.log(`[gateway-client] Loaded client certificates from ${certPath} (expires ${notAfter?.toISOString() ?? "unknown"})`);
      }
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
   * Send subagent and background-job persistence/audit events to Runtime.
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
   * Fetch the agents this one may TRANSFER the conversation to. Empty for an
   * ordinary agent, which then grows no transfer tool at all.
   */
  async searchHandoffTargets(query: HandoffSearchQuery): Promise<HandoffSearchResponse> {
    return this.request(HANDOFF_SEARCH_PATH, "POST", query);
  }

  async fetchHandoffTargets(): Promise<HandoffTargetsResponse> {
    return this.request(`${HANDOFF_TARGETS_PATH}?indexOnly=true`, "GET");
  }

  /**
   * Pull a session's full transcript from the control plane, oldest first.
   * The checkpointer read: called when this box holds no local context for a
   * session it has been asked to continue.
   */
  async fetchSessionHistory(sessionId: string): Promise<SessionHistoryResponse> {
    return this.request(`${SESSION_HISTORY_PATH}?sessionId=${encodeURIComponent(sessionId)}`, "GET");
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

  private scriptInfoCache?: { expires: number; value: import("../script-sandbox/types.js").ScriptSandboxInfo };
  private scriptInfoPending?: Promise<import("../script-sandbox/types.js").ScriptSandboxInfo>;
  async scriptSandboxInfo(): Promise<import("../script-sandbox/types.js").ScriptSandboxInfo> {
    if (this.scriptInfoCache && this.scriptInfoCache.expires > Date.now()) return this.scriptInfoCache.value;
    return this.scriptInfoPending ??= this.fetchScriptSandboxInfo().then(value => {
      this.scriptInfoCache = { value, expires: Date.now() + 30_000 }; return value;
    }).catch(() => ({ enabled: false, network_isolation: false, require_network_isolation: false }))
      .finally(() => { this.scriptInfoPending = undefined; });
  }

  private async fetchScriptSandboxInfo(): Promise<import("../script-sandbox/types.js").ScriptSandboxInfo> {
    const disabled = { enabled: false, network_isolation: false, require_network_isolation: false };
    const info = await this.request("/api/internal/script-runs", "GET");
    if (info?.enabled !== true) return disabled;
    const raw = info.limits;
    // Explicitly project the public fields; never pass arbitrary service config to model tools.
    const limits = raw && [raw.default_timeout_seconds, raw.max_timeout_seconds, raw.max_tool_calls, raw.max_output_bytes]
      .every(value => Number.isSafeInteger(value) && value > 0) && raw.default_timeout_seconds <= raw.max_timeout_seconds
      ? { default_timeout_seconds: raw.default_timeout_seconds, max_timeout_seconds: raw.max_timeout_seconds,
        max_tool_calls: raw.max_tool_calls, max_output_bytes: raw.max_output_bytes,
        ...(Number.isSafeInteger(raw.max_concurrent_tools) && raw.max_concurrent_tools > 0 && raw.max_concurrent_tools <= 10
          ? { max_concurrent_tools: raw.max_concurrent_tools } : {}) } : undefined;
    return { enabled: true, network_isolation: info.network_isolation === true,
      require_network_isolation: info.require_network_isolation === true, ...(limits ? { limits } : {}) };
  }

  async runScript(request: import("../script-sandbox/types.js").ScriptRequest, sessionId: string, signal?: AbortSignal): Promise<import("../script-sandbox/types.js").ScriptResult> {
    const invocation = this.sandboxInvocations.open(sessionId, request, signal);
    try {
      return await this.request("/api/internal/script-runs", "POST", { session_id: sessionId, callback_token: invocation.token, request }, 720_000, signal);
    } finally { invocation.close(); }
  }

  /**
   * Make HTTP(S) request to Gateway with mTLS authentication
   */
  private request(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: any, timeoutMs = 5000, signal?: AbortSignal): Promise<any> {
    const privateRequest = path === PRIVATE_WORKSPACE_PATH;
    const transportError = () => new WorkspaceTransportError();
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.gatewayUrl);
      const isHttps = url.protocol === "https:";

      const requestOptions: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        signal,
        headers: {
          "Content-Type": "application/json",
        },
        ...(isHttps && this.tlsOptions ? this.tlsOptions : {}),
      };

      const client = isHttps ? https : http;
      const req = client.request(requestOptions, (res: any) => {
        // Every sync payload lands here — skills, knowledge, tools, credentials.
        // Decoding per data event corrupted a character that happened to straddle a
        // chunk boundary (an em dash in a SKILL.md arrived as two U+FFFD in the
        // agent's materialized copy while the DB row was byte-exact), so let Node
        // carry the partial bytes across events.
        res.setEncoding("utf8");
        let data = "";

        res.on("data", (chunk: string) => {
          data += chunk;
        });
        // An interrupted response may never emit end. In private mode it must
        // reject the pending renewal so a later interval can retry.
        if (privateRequest) res.on("error", () => reject(transportError()));

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
              reject(new Error(privateRequest ? "Invalid private workspace response" : `Failed to parse JSON response: ${data}`));
            }
          } else {
            reject(privateRequest ? new WorkspaceTransportError(res.statusCode) : new Error(`Gateway returned ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", (err: Error) => {
        reject(privateRequest ? transportError() : new Error(`Gateway request failed: ${err.message}`));
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(privateRequest ? transportError() : new Error("Gateway request timeout"));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }
}
