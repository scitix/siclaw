import type { IncomingMessage, ServerResponse } from "node:http";
import type { CertificateIdentity } from "../security/cert-manager.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import { ScriptSandboxPool } from "../../script-sandbox/pool.js";
import { ReadyScriptSandboxProvider } from "../../script-sandbox/ready-provider.js";
import { ScriptSandboxService } from "../../script-sandbox/service.js";
import { ScriptSandboxError } from "../../script-sandbox/types.js";
import { identifier, record } from "../../script-sandbox/validation.js";
import { ReadOnlyScriptBroker, type SandboxControlPlane, type SandboxBuiltinExecutor } from "./broker.js";
import { K8sScriptSandboxProvider } from "./k8s-provider.js";
import { E2bScriptSandboxProvider } from "./e2b-provider.js";
import { ExternalScriptTools } from "./external-tools.js";
import { RemoteScriptTraffic } from "../../script-sandbox/traffic.js";

export function createScriptSandboxApi(deploymentMode: string, controlPlane: SandboxControlPlane, builtin?: SandboxBuiltinExecutor,
  currentUser?: (sessionId: string, agentId: string) => string,
  validateExecution?: (principal: import("../../script-sandbox/types.js").ScriptPrincipal, signal: AbortSignal) => Promise<void>) {
  // The actual spawner, not environment flags, determines whether this Runtime
  // can expose untrusted code execution. Ignore even malformed provider/secret
  // configuration in local mode; it must neither initialize nor prewarm runners.
  const config = loadScriptSandboxConfig(deploymentMode === "k8s" ? process.env : {});
  if (config.enabled && config.provider === "docker") throw new Error("Docker sandbox is only supported by the standalone smoke harness");
  const external = new ExternalScriptTools(controlPlane);
  const provider = config.enabled ? new ScriptSandboxPool(new ReadyScriptSandboxProvider(config.provider === "e2b"
    ? new E2bScriptSandboxProvider(config, external) : new K8sScriptSandboxProvider(config)), config) : undefined;
  const service = provider ? new ScriptSandboxService(config, provider, new ReadOnlyScriptBroker(controlPlane, config, builtin, async (p, signal) => {
    if (!p.userId || currentUser?.(p.sessionId, p.agentId) !== p.userId) throw new ScriptSandboxError("Active Web caller required", 403);
    await validateExecution?.(p, signal);
    if (currentUser?.(p.sessionId, p.agentId) !== p.userId) throw new ScriptSandboxError("Active Web caller required", 403);
  }, new RemoteScriptTraffic(controlPlane))) : undefined;
  provider?.prewarm();
  return {
    externalTool: async (params: unknown) => {
      if (!service) throw new ScriptSandboxError("Script sandbox is disabled", 503);
      return external.call(params);
    },
    async handle(req: IncomingMessage, res: ServerResponse, identity: CertificateIdentity | undefined): Promise<void> {
      const send = (status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); } };
      if (!identity) { send(401, { error: "Client identity required" }); return; }
      if (req.method === "GET") {
        send(200, { enabled: !!service, network_isolation: config.requireNetworkIsolation || config.networkIsolation,
          require_network_isolation: config.requireNetworkIsolation,
          ...(service ? { limits: { default_timeout_seconds: Math.min(60, config.maxTimeoutSeconds),
            max_timeout_seconds: config.maxTimeoutSeconds, max_tool_calls: config.maxToolCalls, max_output_bytes: config.maxOutputBytes,
            max_concurrent_tools: 10 } } : {}) });
        return;
      }
      if (!service) { send(503, { error: "Script sandbox is disabled" }); return; }
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      const timer = setTimeout(() => { controller.abort(); req.destroy(); }, 10_000);
      try {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 512 * 1024) throw new ScriptSandboxError("Script request too large", 413);
          chunks.push(chunk);
        }
        clearTimeout(timer);
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ScriptSandboxError("Invalid JSON"); }
        if (!record(body) || Object.keys(body).some(k => k !== "session_id" && k !== "request" && k !== "callback_token") || !identifier(body.session_id)) throw new ScriptSandboxError("Session and script request required");
        if (body.callback_token !== undefined && (typeof body.callback_token !== "string" || !/^[a-f0-9]{64}$/.test(body.callback_token))) throw new ScriptSandboxError("Invalid callback grant");
        const userId = currentUser?.(body.session_id, identity.agentId);
        if (!userId) throw new ScriptSandboxError("Active Web caller required", 403);
        const result = await service.run(body.request, { agentId: identity.agentId, boxId: identity.boxId, sessionId: body.session_id, userId, callbackToken: body.callback_token as string | undefined }, controller.signal);
        send(200, result);
      } catch (error) {
        send(error instanceof ScriptSandboxError ? error.statusCode : 403, { error: error instanceof ScriptSandboxError ? error.message : "Script execution denied or unavailable" });
      } finally { clearTimeout(timer); res.off("close", abort); }
    },
    async shutdown(): Promise<void> { await service?.shutdown(); },
  };
}
