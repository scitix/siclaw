import { AgentRetiredError } from "../../shared/agent-retirement.js";
import { DISPATCH_WINDOW_MS } from "../../script-sandbox/budgets.js";
import { createHash } from "node:crypto";
import { LocalScriptTraffic, type ScriptTrafficAdmission } from "../../script-sandbox/traffic.js";
import { SandboxCallbackUncertainError } from "../../shared/sandbox-tool-types.js";
import { SandboxToolError } from "../../script-sandbox/errors.js";
import { createMcpToolDefinition } from "../../core/mcp-client.js";
import { normalizeAgentType, effectiveCapabilityKeys } from "../../core/agent-types.js";
import { resolveCapabilities } from "../../core/tool-capabilities.js";
import { kubeConnection } from "../../tools/infra/inline-kubeconfig.js";
import { sshEndpoint } from "../../tools/infra/ssh-endpoint.js";
export { kubeConnection } from "../../tools/infra/inline-kubeconfig.js";
import { resolveSandboxBuiltin } from "../../script-sandbox/tool-dispatch.js";
import type { SandboxBuiltinApproval } from "../../shared/sandbox-tool-types.js";
import { sanitizeSandboxResult } from "../../script-sandbox/sanitize.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CredentialPayload } from "../../shared/credential-types.js";
import type { ScriptBroker } from "../../script-sandbox/service.js";
import { ScriptSandboxError, type ScriptPrincipal, type ScriptRequest, type ScriptSandboxConfig, type ScriptToolCall } from "../../script-sandbox/types.js";
import { identifier, record } from "../../script-sandbox/validation.js";
import { SCRIPT_FILE_RESULT_BYTES, SCRIPT_INLINE_RESULT_BYTES } from "../../script-sandbox/result-transfer.js";

export interface SandboxControlPlane {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface SandboxGrant {
  user_id: string;
  credential?: CredentialPayload["credential"];
  mcp?: { transport: string; url: string; headers?: Record<string, string> };
}

function only(args: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(args).some(k => !fields.includes(k))) throw new Error("Unknown operation argument");
}


export type SandboxBuiltinExecutor = (principal: ScriptPrincipal, args: Record<string, unknown>, signal: AbortSignal, approval: SandboxBuiltinApproval) => Promise<unknown>;

export class ReadOnlyScriptBroker implements ScriptBroker {
  private readonly deliveredGrant = new WeakMap<ScriptToolCall, string>();
  private readonly deliveredPolicy = new WeakMap<ScriptToolCall, string>();
  constructor(private readonly controlPlane: SandboxControlPlane, private readonly config: ScriptSandboxConfig, private readonly builtin?: SandboxBuiltinExecutor,
    private readonly verifyCaller?: (principal: ScriptPrincipal, signal: AbortSignal) => void | Promise<void>,
    private readonly traffic: ScriptTrafficAdmission = new LocalScriptTraffic()) {}

  private trafficKeys(grant: SandboxGrant, call: ScriptToolCall): string[] {
    const key = (kind: string, value: unknown) => `${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
    if (call.tool === "mcp.call") {
      if (!grant.mcp) throw new Error("Missing MCP endpoint");
      return [key("mcp", new URL(grant.mcp.url).origin)];
    }
    if (call.tool === "host_exec") {
      const host = grant.credential?.metadata;
      if (typeof host?.ip !== "string") throw new Error("Missing host endpoint");
      const endpoint = sshEndpoint(host.ip, host.port);
      return [key("host", [endpoint.host, endpoint.port])];
    }
    const file = grant.credential?.files.find(f => f.name.endsWith(".kubeconfig"));
    if (!file) throw new Error("Missing cluster endpoint");
    const endpoint = kubeConnection(file.content).url.origin;
    const keys = [key("cluster", endpoint)];
    if (call.tool === "node_exec") keys.push(key("node", [endpoint, call.arguments.node]));
    // Omitted container resolves remotely; group the whole Pod so an explicit
    // container name cannot bypass a simultaneous default-container invocation.
    if (call.tool === "pod_exec") keys.push(key("pod", [endpoint, call.arguments.namespace ?? "default", call.arguments.pod]));
    return keys;
  }

  private async admit(p: ScriptPrincipal, source: string, name: string, call: ScriptToolCall, signal: AbortSignal, requiredTool?: string) {
    const initial = await this.resolve(p, source, name, signal, requiredTool);
    const keys = this.trafficKeys(initial, call);
    const deadlineMs = Math.min(p.deadlineMs ?? Infinity, Date.now() + DISPATCH_WINDOW_MS);
    const release = await this.traffic.acquire(keys, p.userId, signal);
    try {
      // Never execute a credential snapshot that waited in the admission queue.
      const grant = await this.resolve(p, source, name, signal, requiredTool);
      if (JSON.stringify(keys) !== JSON.stringify(this.trafficKeys(grant, call))) throw new Error("Target changed while queued");
      if (Date.now() >= deadlineMs) throw new SandboxToolError("TARGET_BUSY");
      this.deliveredGrant.set(call, this.grantIdentity(grant));
      return { grant, release, deadlineMs };
    } catch (error) { await release(); throw error; }
  }

  private async resolve(p: ScriptPrincipal, source = "", name = "", signal: AbortSignal, requiredTool?: string): Promise<SandboxGrant> {
    signal.throwIfAborted();
    await this.verifyCaller?.(p, signal);
    const budget = (maximum: number) => {
      const remaining = Math.min(maximum, (p.deadlineMs ?? Infinity) - Date.now());
      if (remaining <= 0) throw new SandboxToolError("TARGET_BUSY");
      return remaining;
    };
    const agent = await this.controlPlane.request("config.getAgent", { agentId: p.agentId }, budget(5000)) as any;
    if (agent?.agent_type === "coordinator") throw new AgentRetiredError();
    if (!agent || agent.status !== "active") throw new ScriptSandboxError("Sandbox authorization denied", 403);
    const tools = resolveCapabilities(effectiveCapabilityKeys(normalizeAgentType(agent.agent_type), agent.tool_capabilities ?? null));
    if (tools !== null && (!tools.includes("run_script") || (requiredTool !== undefined && !tools.includes(requiredTool)))) throw new ScriptSandboxError("Sandbox capability denied", 403);
    const value = await this.controlPlane.request("sandbox.resolve", { agent_id: p.agentId, session_id: p.sessionId, source, name }, budget(10_000)) as SandboxGrant;
    signal.throwIfAborted();
    // The turn can end or change owner while either control-plane RPC is pending.
    await this.verifyCaller?.(p, signal);
    signal.throwIfAborted();
    if (!value?.user_id || (p.userId && p.userId !== value.user_id)) throw new ScriptSandboxError("Sandbox authorization denied", 403);
    p.userId = value.user_id;
    return value;
  }

  async authorize(p: ScriptPrincipal, signal: AbortSignal): Promise<void> {
    await this.resolve(p, "", "", signal);
    await this.traffic.prepare?.();
  }

  private grantIdentity(grant: SandboxGrant): string {
    // Hash the authorized snapshot, never retain another cleartext credential.
    return createHash("sha256").update(JSON.stringify([grant.credential, grant.mcp])).digest("hex");
  }

  async authorizeResult(p: ScriptPrincipal, scope: ScriptRequest, call: ScriptToolCall, signal: AbortSignal): Promise<void> {
    // This call is the immutable original operation, retained only after it
    // passed call()'s scope/argument checks. Transfer requests cannot replace it.
    const a = call.arguments;
    let grant: SandboxGrant;
    if (["bash", "node_exec", "pod_exec"].includes(call.tool)) {
      if (!identifier(a.cluster) || !scope.clusters?.some(c => c.name === a.cluster)) throw new Error("Outside cluster scope");
      grant = await this.resolve(p, "cluster", a.cluster, signal, call.tool === "node_exec" || call.tool === "pod_exec" ? call.tool : "bash");
    } else if (call.tool === "host_exec") {
      if (!identifier(a.host) || !scope.hosts?.includes(a.host)) throw new Error("Outside host scope");
      grant = await this.resolve(p, "host", a.host, signal, "host_exec");
    } else if (call.tool === "mcp.call") {
      if (!identifier(a.server) || !scope.mcp?.some(m => m.server === a.server && m.tools.includes(String(a.tool)))) throw new Error("Outside MCP scope");
      const policy = this.reviewedMcpPolicy(a);
      const previous = this.deliveredPolicy.get(call);
      if (previous !== undefined && previous !== JSON.stringify(policy)) throw new Error("MCP policy changed");
      grant = await this.resolve(p, "mcp", a.server, signal);
    } else throw new Error("Unknown result resource");
    if (this.deliveredGrant.get(call) !== this.grantIdentity(grant)) throw new Error("Result authorization changed");
  }

  private reviewedMcpPolicy(a: Record<string, unknown>) {
    if (!identifier(a.server) || !identifier(a.tool) || !record(a.arguments)) throw new Error("Invalid MCP arguments");
    const policies = this.config.mcpPolicy;
    const policy = Object.hasOwn(policies, a.server) && Object.hasOwn(policies[a.server], a.tool) ? policies[a.server][a.tool] : undefined;
    if (!policy) throw new Error("MCP operation has not been reviewed");
    for (const [key, value] of Object.entries(policy.fixedArguments ?? {})) {
      if (Object.hasOwn(a.arguments, key) && JSON.stringify(a.arguments[key]) !== JSON.stringify(value)) throw new Error("Fixed MCP scope cannot be overridden");
    }
    return policy;
  }

  async call(p: ScriptPrincipal, scope: ScriptRequest, call: ScriptToolCall, signal: AbortSignal): Promise<unknown> {
    let allowed = false;
    let release: (() => Promise<void>) | undefined;
    let uncertain = false;
    try {
      if (["bash", "host_exec", "node_exec", "pod_exec"].includes(call.tool)) {
        call.arguments = resolveSandboxBuiltin(call, scope).arguments;
      }
      const a = call.arguments;
      if (call.tool === "bash") {
        const request = resolveSandboxBuiltin(call, scope).arguments;
        if (!this.builtin || !p.callbackToken) throw new Error("Builtin tool unavailable");
        const admitted = await this.admit(p, "cluster", request.cluster!, call, signal, "bash");
        const grant = admitted.grant; release = admitted.release;
        const file = grant.credential?.files.find(f => f.name.endsWith(".kubeconfig"));
        if (!file || grant.credential?.type !== "kubeconfig") throw new Error("No Kubernetes credential");
        kubeConnection(file.content);
        const result = await this.builtin(p, a, signal, { tool: "bash", credential: grant.credential, callId: call.id, deadlineMs: admitted.deadlineMs });
        allowed = true; return sanitizeSandboxResult(result);
      }
      if (call.tool === "host_exec" || call.tool === "node_exec" || call.tool === "pod_exec") {
        const request = resolveSandboxBuiltin(call, scope).arguments;
        if (!this.builtin || !p.callbackToken) throw new Error("Builtin tool unavailable");
        const source = call.tool === "host_exec" ? "host" : "cluster";
        const admitted = await this.admit(p, source, request.host ?? request.cluster!, call, signal, call.tool);
        const grant = admitted.grant; release = admitted.release;
        if (!grant.credential) throw new Error("No approved credential");
        const approval: SandboxBuiltinApproval = { tool: call.tool, credential: grant.credential, callId: call.id, deadlineMs: admitted.deadlineMs };
        if (source === "host") {
          approval.hostKeyPins = {};
          const hops = [{ name: grant.credential.name, metadata: grant.credential.metadata }, ...(grant.credential.jump_chain ?? [])];
          for (const hop of hops) {
            const pin = hop.name && Object.hasOwn(this.config.hostKeyPins, hop.name) ? this.config.hostKeyPins[hop.name] : undefined;
            if (!pin || !hop.metadata) throw new Error("Host key pin required for every SSH hop");
            approval.hostKeyPins[sshEndpoint(hop.metadata.ip, hop.metadata.port).key] = pin;
          }
        } else {
          const file = grant.credential.files.find(f => f.name.endsWith(".kubeconfig"));
          if (grant.credential.type !== "kubeconfig" || !file) throw new Error("No Kubernetes credential");
          kubeConnection(file.content);
        }
        signal.throwIfAborted();
        const result = await this.builtin(p, a, signal, approval);
        allowed = true; return sanitizeSandboxResult(result);
      }
      if (call.tool === "mcp.call") {
        only(a, ["server", "tool", "arguments"]);
        if (!identifier(a.server) || !identifier(a.tool) || !record(a.arguments) || !scope.mcp?.some(m => m.server === a.server && m.tools.includes(a.tool as string))) throw new Error("Outside MCP scope");
        this.reviewedMcpPolicy(a);
        const admitted = await this.admit(p, "mcp", a.server, call, signal);
        const grant = admitted.grant; release = admitted.release;
        const policy = this.reviewedMcpPolicy(a);
        this.deliveredPolicy.set(call, JSON.stringify(policy));
        if (grant.mcp?.transport !== "streamable-http") throw new Error("Only reviewed HTTP MCP is supported");
        const url = new URL(grant.mcp.url);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("MCP requires HTTPS");
        const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: grant.mcp.headers, signal: boundedSignal, redirect: "error" },
          fetch: async (input, init) => {
            const res = await fetch(input, { ...init, redirect: "error", signal: boundedSignal });
            let size = 0;
            return new Response(res.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
              size += chunk.length;
              if (size > (call.delivery === "file" ? SCRIPT_FILE_RESULT_BYTES : SCRIPT_INLINE_RESULT_BYTES)) throw new Error("MCP response too large");
              controller.enqueue(chunk);
            } })), { status: res.status, statusText: res.statusText, headers: res.headers });
          } });
        const client = new McpClient({ name: "siclaw-script-broker", version: "1.0.0" }, { capabilities: {} });
        try {
          await client.connect(transport);
          // Share the exact Agent MCP tool factory while keeping this transport's
          // byte limits, credential snapshot, HTTPS and no-redirect policy.
          const tool = createMcpToolDefinition(a.server, undefined, { name: a.tool }, client, 15_000, { includeRawResult: true });
          const result = await tool.execute(call.id, { ...a.arguments, ...policy.fixedArguments }, boundedSignal, undefined, {} as any);
          const details = result.details as { rawResult?: unknown; execution?: "NOT_DISPATCHED" | "FINISHED" | "UNKNOWN" };
          if (!details?.rawResult) {
            const execution = details?.execution ?? "UNKNOWN";
            throw new SandboxToolError(execution === "UNKNOWN" ? "EXECUTION_UNKNOWN" : execution === "NOT_DISPATCHED" ? "INVALID_ARGUMENTS" : "TARGET_ERROR", execution);
          }
          allowed = true; return sanitizeSandboxResult(details.rawResult);
        } finally { uncertain ||= boundedSignal.aborted; await client.close().catch(() => {}); }
      }
      throw new Error("Unknown script tool");
    } catch (error) {
      uncertain ||= error instanceof SandboxCallbackUncertainError || error instanceof SandboxToolError && error.retainsCapacity;
      throw error;
    } finally {
      // Transport loss cannot prove remote completion. Retain the shared lease
      // until its bounded expiry instead of admitting replacement work early.
      try { if (!uncertain) await release?.(); }
      finally {
        const { callbackToken: _token, ...audit } = p;
        console.info(JSON.stringify({ event: "script_tool", ...audit, tool: call.tool, allowed }));
      }
    }
  }
}
