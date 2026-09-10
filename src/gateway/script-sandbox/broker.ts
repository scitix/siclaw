import { SANDBOX_NODE_CONCURRENCY } from "../../tools/infra/sandbox-debug.js";
import { createMcpToolDefinition } from "../../core/mcp-client.js";
import { normalizeAgentType, effectiveCapabilityKeys } from "../../core/agent-types.js";
import { resolveCapabilities } from "../../core/tool-capabilities.js";
import { kubeConnection } from "../../tools/infra/inline-kubeconfig.js";
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
  private activeNodeExecutions = 0;
  constructor(private readonly controlPlane: SandboxControlPlane, private readonly config: ScriptSandboxConfig, private readonly builtin?: SandboxBuiltinExecutor,
    private readonly verifyCaller?: (principal: ScriptPrincipal) => void) {}

  private async resolve(p: ScriptPrincipal, source = "", name = "", signal: AbortSignal, requiredTool?: string): Promise<SandboxGrant> {
    signal.throwIfAborted();
    this.verifyCaller?.(p);
    const agent = await this.controlPlane.request("config.getAgent", { agentId: p.agentId }, 5000) as any;
    if (!agent || agent.status !== "active") throw new ScriptSandboxError("Sandbox authorization denied", 403);
    const tools = resolveCapabilities(effectiveCapabilityKeys(normalizeAgentType(agent.agent_type), agent.tool_capabilities ?? null));
    if (tools !== null && (!tools.includes("run_script") || (requiredTool !== undefined && !tools.includes(requiredTool)))) throw new ScriptSandboxError("Sandbox capability denied", 403);
    const value = await this.controlPlane.request("sandbox.resolve", { agent_id: p.agentId, session_id: p.sessionId, source, name }, 10_000) as SandboxGrant;
    signal.throwIfAborted();
    // The turn can end or change owner while either control-plane RPC is pending.
    this.verifyCaller?.(p);
    if (!value?.user_id || (p.userId && p.userId !== value.user_id)) throw new ScriptSandboxError("Sandbox authorization denied", 403);
    p.userId = value.user_id;
    return value;
  }

  async authorize(p: ScriptPrincipal, signal: AbortSignal): Promise<void> { await this.resolve(p, "", "", signal); }

  async authorizeResult(p: ScriptPrincipal, scope: ScriptRequest, call: ScriptToolCall, signal: AbortSignal): Promise<void> {
    // This call is the immutable original operation, retained only after it
    // passed call()'s scope/argument checks. Transfer requests cannot replace it.
    const a = call.arguments;
    if (["bash", "node_exec", "pod_exec"].includes(call.tool)) {
      if (!identifier(a.cluster) || !scope.clusters?.some(c => c.name === a.cluster)) throw new Error("Outside cluster scope");
      await this.resolve(p, "cluster", a.cluster, signal, call.tool === "node_exec" || call.tool === "pod_exec" ? call.tool : "bash");
    } else if (call.tool === "host_exec") {
      if (!identifier(a.host) || !scope.hosts?.includes(a.host)) throw new Error("Outside host scope");
      await this.resolve(p, "host", a.host, signal, "host_exec");
    } else if (call.tool === "mcp.call") {
      if (!identifier(a.server) || !scope.mcp?.some(m => m.server === a.server && m.tools.includes(String(a.tool)))) throw new Error("Outside MCP scope");
      await this.resolve(p, "mcp", a.server, signal);
    } else throw new Error("Unknown result resource");
  }

  async call(p: ScriptPrincipal, scope: ScriptRequest, call: ScriptToolCall, signal: AbortSignal): Promise<unknown> {
    const a = call.arguments;
    let allowed = false;
    try {
      if (call.tool === "bash") {
        const request = resolveSandboxBuiltin(call, scope).arguments;
        if (!this.builtin || !p.callbackToken) throw new Error("Builtin tool unavailable");
        const grant = await this.resolve(p, "cluster", request.cluster!, signal, "bash");
        const file = grant.credential?.files.find(f => f.name.endsWith(".kubeconfig"));
        if (!file || grant.credential?.type !== "kubeconfig") throw new Error("No Kubernetes credential");
        kubeConnection(file.content);
        const result = await this.builtin(p, a, signal, { tool: "bash", credential: grant.credential });
        allowed = true; return sanitizeSandboxResult(result);
      }
      if (call.tool === "host_exec" || call.tool === "node_exec" || call.tool === "pod_exec") {
        const request = resolveSandboxBuiltin(call, scope).arguments;
        if (!this.builtin || !p.callbackToken) throw new Error("Builtin tool unavailable");
        const source = call.tool === "host_exec" ? "host" : "cluster";
        const grant = await this.resolve(p, source, request.host ?? request.cluster!, signal, call.tool);
        if (!grant.credential) throw new Error("No approved credential");
        const approval: SandboxBuiltinApproval = { tool: call.tool, credential: grant.credential };
        if (source === "host") {
          approval.hostKeyPins = {};
          const hops = [{ name: request.host, metadata: grant.credential.metadata }, ...(grant.credential.jump_chain ?? [])];
          for (const hop of hops) {
            const pin = hop.name && Object.hasOwn(this.config.hostKeyPins, hop.name) ? this.config.hostKeyPins[hop.name] : undefined;
            if (!pin || !hop.metadata) throw new Error("Host key pin required for every SSH hop");
            approval.hostKeyPins[`${hop.metadata.ip}:${hop.metadata.port ?? 22}`] = pin;
          }
        } else {
          const file = grant.credential.files.find(f => f.name.endsWith(".kubeconfig"));
          if (grant.credential.type !== "kubeconfig" || !file) throw new Error("No Kubernetes credential");
          kubeConnection(file.content);
        }
        const node = call.tool === "node_exec";
        if (node && this.activeNodeExecutions >= SANDBOX_NODE_CONCURRENCY) throw new Error("Sandbox node diagnostics busy");
        if (node) this.activeNodeExecutions++;
        try {
          signal.throwIfAborted();
          const result = await this.builtin(p, a, signal, approval);
          allowed = true; return sanitizeSandboxResult(result);
        } finally { if (node) this.activeNodeExecutions--; }
      }
      if (call.tool === "mcp.call") {
        only(a, ["server", "tool", "arguments"]);
        if (!identifier(a.server) || !identifier(a.tool) || !record(a.arguments) || !scope.mcp?.some(m => m.server === a.server && m.tools.includes(a.tool as string))) throw new Error("Outside MCP scope");
        const policy = Object.hasOwn(this.config.mcpPolicy, a.server) && Object.hasOwn(this.config.mcpPolicy[a.server], a.tool) ? this.config.mcpPolicy[a.server][a.tool] : undefined;
        if (!policy) throw new Error("MCP operation has not been reviewed");
        for (const [key, value] of Object.entries(policy.fixedArguments ?? {})) {
          if (Object.hasOwn(a.arguments, key) && JSON.stringify(a.arguments[key]) !== JSON.stringify(value)) throw new Error("Fixed MCP scope cannot be overridden");
        }
        const grant = await this.resolve(p, "mcp", a.server, signal);
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
          const details = result.details as { rawResult?: unknown };
          if (!details?.rawResult) throw new Error("MCP tool failed");
          allowed = true; return sanitizeSandboxResult(details.rawResult);
        } finally { await client.close().catch(() => {}); }
      }
      throw new Error("Unknown script tool");
    } finally {
      const { callbackToken: _token, ...audit } = p;
      console.info(JSON.stringify({ event: "script_tool", ...audit, tool: call.tool, allowed }));
    }
  }
}
