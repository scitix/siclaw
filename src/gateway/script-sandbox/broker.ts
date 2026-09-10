import { normalizeAgentType, effectiveCapabilityKeys } from "../../core/agent-types.js";
import { resolveCapabilities } from "../../core/tool-capabilities.js";
import https from "node:https";
import { createHash } from "node:crypto";
import { kubeConnection } from "../../tools/infra/inline-kubeconfig.js";
export { kubeConnection } from "../../tools/infra/inline-kubeconfig.js";
import { validateSandboxBash } from "../../tools/infra/sandbox-bash-policy.js";
import { sanitizeSandboxResult } from "../../script-sandbox/sanitize.js";
import { Client as SshClient } from "ssh2";
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


function readKube(content: string, path: string, signal: AbortSignal, maxBytes = 128 * 1024): Promise<string> {
  const { url, options } = kubeConnection(content);
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path, url), { ...options, method: "GET", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }, res => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) req.destroy(new Error("Kubernetes response too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("Kubernetes read failed")));
      res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

export type SandboxBuiltinExecutor = (principal: ScriptPrincipal, args: Record<string, unknown>, signal: AbortSignal, approvedKubeconfig: string) => Promise<unknown>;

export class ReadOnlyScriptBroker implements ScriptBroker {
  constructor(private readonly controlPlane: SandboxControlPlane, private readonly config: ScriptSandboxConfig, private readonly builtin?: SandboxBuiltinExecutor,
    private readonly verifyCaller?: (principal: ScriptPrincipal) => void) {}

  private async resolve(p: ScriptPrincipal, source = "", name = "", signal: AbortSignal): Promise<SandboxGrant> {
    signal.throwIfAborted();
    this.verifyCaller?.(p);
    const agent = await this.controlPlane.request("config.getAgent", { agentId: p.agentId }, 5000) as any;
    if (!agent || agent.status !== "active") throw new ScriptSandboxError("Sandbox authorization denied", 403);
    const tools = resolveCapabilities(effectiveCapabilityKeys(normalizeAgentType(agent.agent_type), agent.tool_capabilities ?? null));
    if (tools !== null && !tools.includes("run_script")) throw new ScriptSandboxError("Sandbox capability denied", 403);
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
    if (call.tool === "bash" || ["k8s.list_nodes", "k8s.list_pods", "k8s.pod_logs"].includes(call.tool)) {
      if (!identifier(a.cluster) || !scope.clusters?.some(c => c.name === a.cluster)) throw new Error("Outside cluster scope");
      await this.resolve(p, "cluster", a.cluster, signal);
    } else if (call.tool === "host.inspect") {
      if (!identifier(a.host) || !scope.hosts?.includes(a.host)) throw new Error("Outside host scope");
      await this.resolve(p, "host", a.host, signal);
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
        const request = validateSandboxBash(a, scope);
        if (!this.builtin || !p.callbackToken) throw new Error("Builtin tool unavailable");
        const grant = await this.resolve(p, "cluster", request.cluster, signal);
        const file = grant.credential?.files.find(f => f.name.endsWith(".kubeconfig"));
        if (!file || grant.credential?.type !== "kubeconfig") throw new Error("No Kubernetes credential");
        kubeConnection(file.content);
        const result = await this.builtin(p, a, signal, file.content);
        allowed = true; return sanitizeSandboxResult(result);
      }
      if (call.tool === "k8s.list_nodes") {
        only(a, ["cluster", "continue"]);
        if (!identifier(a.cluster) || !scope.clusters?.some(c => c.name === a.cluster && c.nodes === true)) throw new Error("Outside node scope");
        if (a.continue !== undefined && (typeof a.continue !== "string" || a.continue.length > 4096)) throw new Error("Invalid continuation token");
        const grant = await this.resolve(p, "cluster", a.cluster, signal);
        const file = grant.credential?.files.find(f => f.name.endsWith(".kubeconfig"));
        if (!file || grant.credential?.type !== "kubeconfig") throw new Error("No Kubernetes credential");
        const query = new URLSearchParams({ limit: "10" });
        if (a.continue) query.set("continue", a.continue as string);
        // Node objects include large image inventories; cap the upstream page at 1 MiB
        // and expose only fixed diagnostic fields, never the original object.
        const body = JSON.parse(await readKube(file.content, `/api/v1/nodes?${query}`, signal, 1024 * 1024));
        const nodes = body.items.map((node: any) => ({ name: node.metadata?.name,
          ready: node.status?.conditions?.find((c: any) => c.type === "Ready")?.status ?? "Unknown",
          unschedulable: node.spec?.unschedulable === true,
          kubelet_version: node.status?.nodeInfo?.kubeletVersion, kernel_version: node.status?.nodeInfo?.kernelVersion,
          os_image: node.status?.nodeInfo?.osImage, architecture: node.status?.nodeInfo?.architecture,
          container_runtime: node.status?.nodeInfo?.containerRuntimeVersion,
          capacity: node.status?.capacity, allocatable: node.status?.allocatable }));
        allowed = true;
        return { nodes, continue: body.metadata?.continue || null };
      }
      if (call.tool === "k8s.list_pods" || call.tool === "k8s.pod_logs") {
        only(a, call.tool === "k8s.list_pods" ? ["cluster", "namespace", "continue"] : ["cluster", "namespace", "pod", "container", "tail_lines"]);
        if (!identifier(a.cluster) || !identifier(a.namespace) || !scope.clusters?.some(c => c.name === a.cluster && c.namespaces?.includes(a.namespace as string))) throw new Error("Outside cluster scope");
        if (a.continue !== undefined && (typeof a.continue !== "string" || a.continue.length > 4096)) throw new Error("Invalid continuation token");
        const grant = await this.resolve(p, "cluster", a.cluster, signal);
        const file = grant.credential?.files.find(f => f.name.endsWith(".kubeconfig"));
        if (!file || grant.credential?.type !== "kubeconfig") throw new Error("No Kubernetes credential");
        let path = `/api/v1/namespaces/${encodeURIComponent(a.namespace)}/pods`;
        if (call.tool === "k8s.pod_logs") {
          if (!identifier(a.pod) || (a.container !== undefined && !identifier(a.container))) throw new Error("Invalid pod");
          const tail = a.tail_lines ?? 100;
          if (!Number.isSafeInteger(tail) || Number(tail) < 1 || Number(tail) > 1000) throw new Error("Invalid tail limit");
          path += `/${encodeURIComponent(a.pod)}/log?tailLines=${tail}&limitBytes=65536`;
          if (a.container) path += `&container=${encodeURIComponent(a.container as string)}`;
          const text = await readKube(file.content, path, signal);
          allowed = true; return sanitizeSandboxResult({ text });
        }
        const query = new URLSearchParams({ limit: "10" });
        if (a.continue) query.set("continue", a.continue as string);
        const body = JSON.parse(await readKube(file.content, `${path}?${query}`, signal, 1024 * 1024));
        allowed = true;
        // Return diagnostics, without pod env/volume/service account configuration.
        return { pods: body.items.map((pod: any) => ({ name: pod.metadata?.name, namespace: pod.metadata?.namespace,
          phase: pod.status?.phase, node: pod.spec?.nodeName,
          conditions: pod.status?.conditions?.map((c: any) => ({ type: c.type, status: c.status })) })), continue: body.metadata?.continue || null };
      }
      if (call.tool === "host.inspect") {
        only(a, ["host", "check"]);
        if (!identifier(a.host) || !scope.hosts?.includes(a.host) || !["os", "memory", "sysctl"].includes(String(a.check))) throw new Error("Outside host scope");
        const pin = this.config.hostKeyPins[a.host];
        if (!pin) throw new Error("Host key pin required");
        const grant = await this.resolve(p, "host", a.host, signal);
        if (!grant.credential || grant.credential.type !== "ssh") throw new Error("No host credential");
        const result = await inspectHost(grant.credential, pin, String(a.check), signal);
        allowed = true; return sanitizeSandboxResult(result);
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
          const result = await client.callTool({ name: a.tool, arguments: { ...a.arguments, ...policy.fixedArguments } }, undefined, { signal: boundedSignal, timeout: 15_000 });
          allowed = true; return sanitizeSandboxResult(result);
        } finally { await client.close().catch(() => {}); }
      }
      throw new Error("Unknown script tool");
    } finally {
      const { callbackToken: _token, ...audit } = p;
      console.info(JSON.stringify({ event: "script_tool", ...audit, tool: call.tool, allowed }));
    }
  }
}

/** No model command, script or path crosses SSH. Remote helper is root-owned and fixed. */
function inspectHost(credential: CredentialPayload["credential"], pin: string, check: string, signal: AbortSignal): Promise<unknown> {
  if (credential.jump_chain?.length || credential.metadata?.auth_type === "managed") throw new Error("Host helper requires a direct explicit credential");
  const meta = credential.metadata ?? {};
  const file = (name: string) => credential.files.find(f => f.name === name)?.content;
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const timer = setTimeout(() => finish(new Error("Host inspection timed out")), 10_000);
    const abort = () => finish(new Error("Host inspection cancelled"));
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort); client.destroy();
      error ? reject(error) : resolve(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    client.on("error", () => finish(new Error("Host connection failed")));
    client.on("ready", () => client.exec("/usr/local/libexec/siclaw-inspect", (error, stream) => {
      if (error) { finish(new Error("Host helper unavailable")); return; }
      const chunks: Buffer[] = []; let size = 0;
      stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) finish(new Error("Host output too large")); else chunks.push(chunk); });
      stream.stderr.resume();
      stream.on("error", () => finish(new Error("Host helper failed")));
      stream.on("close", (code: number) => {
        try { if (code !== 0) throw new Error(); finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(new Error("Host helper failed")); }
      });
      stream.end(JSON.stringify({ check }) + "\n");
    }));
    if (signal.aborted) { abort(); return; }
    client.connect({ host: String(meta.ip), port: Number(meta.port ?? 22), username: String(meta.username),
      password: file("host.password"), privateKey: file("host.key"), passphrase: file("host.passphrase"), readyTimeout: 5000,
      hostVerifier: (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` === pin });
  });
}
