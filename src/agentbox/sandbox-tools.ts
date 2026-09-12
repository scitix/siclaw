import { DISPATCH_WINDOW_MS, CLOCK_SKEW_MS } from "../script-sandbox/budgets.js";
import fs from "node:fs";
import { SandboxToolError, type ToolExecution } from "../script-sandbox/errors.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SandboxBuiltinApproval } from "../shared/sandbox-tool-types.js";
import { CredentialBroker, resolveGroupGid } from "./credential-broker.js";
import type { ClusterMeta, HostMeta } from "./credential-transport.js";
import { kubeConnection } from "../tools/infra/inline-kubeconfig.js";
import { createRestrictedBashTool } from "../tools/cmd-exec/restricted-bash.js";
import { createHostExecTool } from "../tools/cmd-exec/host-exec.js";
import { createNodeExecTool } from "../tools/cmd-exec/node-exec.js";
import { createPodExecTool } from "../tools/cmd-exec/pod-exec.js";
import { debugPodCache } from "../tools/infra/debug-pod.js";
import { withSandboxKubeconfig } from "./sandbox-kubeconfig.js";
import { SCRIPT_FILE_RESULT_BYTES } from "../script-sandbox/result-transfer.js";
import { record } from "../script-sandbox/validation.js";
import type { SandboxBuiltinRequest } from "../script-sandbox/tool-dispatch.js";
import type { ToolOutputData, TrustedToolOutputOptions } from "../tools/infra/security-pipeline.js";

/** Run the SAME tool factories used by the Agent, against an immutable,
 * freshly authorized credential snapshot. No fallback to its ambient broker.
 */
export async function executeSandboxBuiltin(request: SandboxBuiltinRequest, approval: SandboxBuiltinApproval,
  credentialsDir: string | undefined, signal: AbortSignal): Promise<unknown> {
  let completed: unknown;
  let execution: ToolExecution = "NOT_DISPATCHED";
  try {
    if (!credentialsDir || approval.tool !== request.tool) throw new Error("Invalid sandbox approval");
    if (approval.deadlineMs !== undefined) {
      if (!Number.isSafeInteger(approval.deadlineMs) || approval.deadlineMs <= Date.now() || approval.deadlineMs > Date.now() + DISPATCH_WINDOW_MS + CLOCK_SKEW_MS) throw new SandboxToolError("UNAUTHORIZED");
      signal = AbortSignal.any([signal, AbortSignal.timeout(approval.deadlineMs - Date.now())]);
    }
    signal.throwIfAborted();
    const captured: { data?: ToolOutputData } = {};
    const trusted: TrustedToolOutputOptions = {
      outputMode: "data", onOutputData: data => { captured.data = data; },
    };
    const execute = async (tool: ToolDefinition) => {
      // The same schema advertised by the built-in, including which optional
      // execution features are available. Do not maintain a second SDK schema.
      const parameters = tool.parameters as unknown as TSchema;
      if (!Value.Check({ ...parameters, additionalProperties: false }, request.arguments)) throw new SandboxToolError("INVALID_ARGUMENTS");
      execution = "UNKNOWN";
      const output = await tool.execute(`sandbox-${randomUUID()}`, request.arguments, signal, undefined, {} as Parameters<typeof tool.execute>[4]);
      const details = output.details as { blocked?: boolean; reason?: string; error?: unknown; truncated?: boolean; exitCode?: number | string | null; exit_class?: string } | undefined;
      execution = details?.blocked ? "NOT_DISPATCHED" : "FINISHED";
      if (details?.blocked) throw new SandboxToolError(details.reason === "sandbox_facilities_unavailable" ? "DIAGNOSTICS_UNAVAILABLE" : "UNAUTHORIZED");
      completed = captured.data ? { ...captured.data, exit_code: details?.exitCode ?? null, exit_class: details?.exit_class ?? "unknown" } : undefined;
      if (details?.exit_class === "channel_failure" || details?.exit_class === "timeout") execution = "UNKNOWN";
      if (completed && Buffer.byteLength(JSON.stringify(completed)) > SCRIPT_FILE_RESULT_BYTES) {
        completed = undefined; throw new SandboxToolError("RESULT_TOO_LARGE", execution);
      }
      if (details?.error || details?.truncated || !completed) throw new SandboxToolError(
        execution === "UNKNOWN" ? "EXECUTION_UNKNOWN" : "TARGET_ERROR", execution, "not_required", completed);
      return completed;
    };
    const payload = structuredClone(approval.credential);
    const isHost = request.tool === "host_exec";
    if (!record(payload) || !Array.isArray(payload.files) || payload.files.length > 8
        || (payload.jump_chain !== undefined && (!Array.isArray(payload.jump_chain) || payload.jump_chain.length > 3))) throw new Error("Invalid credential snapshot");
    for (const entry of [payload, ...(payload.jump_chain ?? [])]) {
      if (!record(entry) || !Array.isArray(entry.files) || entry.files.length > 8 || entry.files.some(f => !record(f)
          || typeof f.name !== "string" || f.name !== path.basename(f.name) || typeof f.content !== "string")) throw new Error("Invalid credential files");
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024) throw new Error("Credential snapshot too large");
    if (isHost && (!record(approval.hostKeyPins) || !Object.keys(approval.hostKeyPins).length
        || Object.values(approval.hostKeyPins).some(pin => typeof pin !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(pin)))) throw new Error("Host key pins required");
    if (payload.type !== (isHost ? "ssh" : "kubeconfig")) throw new Error("Wrong credential kind");
    if (!isHost) {
      const file = payload.files.find(f => f.name.endsWith(".kubeconfig"));
      if (!file) throw new Error("Missing kubeconfig");
      kubeConnection(file.content);
      if (request.tool === "bash") return await withSandboxKubeconfig(credentialsDir, file.content,
        kubeconfigPath => execute(createRestrictedBashTool(undefined, undefined, { ...trusted, kubeconfigPath, validateKubeconfig: kubeConnection })));
      payload.files = [{ name: "approved.kubeconfig", content: file.content }];
    }
    const args = request.arguments as { host?: string; cluster?: string; node?: string };
    const name = isHost ? args.host! : args.cluster!;
    payload.name = name;
    const cluster: ClusterMeta = { name, is_production: true,
      ...(typeof payload.metadata?.debug_image === "string" ? { debug_image: payload.metadata.debug_image } : {}) };
    const host = { ...payload.metadata, name } as HostMeta;
    const deny = async (): Promise<never> => { throw new Error("Credential outside sandbox approval"); };
    const get = async (requested: string) => {
      signal.throwIfAborted();
      if (requested !== name) return deny();
      return { credential: payload };
    };
    const dir = fs.mkdtempSync(path.join(credentialsDir, "sandbox-tool-"));
    let broker: CredentialBroker | undefined;
    const owner = `sandbox-${randomUUID()}`;
    try {
      // setgid kubectl must traverse this parent as well as the broker subdir.
      const gid = isHost ? null : resolveGroupGid("kubecred");
      if (!isHost && process.env.NODE_ENV === "production" && gid === null) {
        throw new Error("Credential reader group required");
      }
      if (gid !== null) fs.chownSync(dir, -1, gid);
      fs.chmodSync(dir, gid === null ? 0o700 : 0o750);
      broker = new CredentialBroker({
        listClusters: async () => isHost ? [] : [cluster],
        listHosts: async () => isHost ? [host] : [], queryHosts: deny,
        getClusterCredential: isHost ? deny : get, getHostCredential: isHost ? get : deny,
      }, dir);
      const ref = { credentialsDir: dir, credentialBroker: broker };
      // A unique cache owner prevents cross-run reuse, and lets us remove ONLY this
      // invocation's diagnostic Job before deleting its credential snapshot.
      if (request.tool === "host_exec") return await execute(createHostExecTool(ref, undefined,
        { ...trusted, hostKeyPins: approval.hostKeyPins }));
      if (request.tool === "pod_exec") return await execute(createPodExecTool(ref, undefined, { ...trusted, remoteTimeoutSeconds: request.arguments.timeout_seconds }));
      if (request.tool === "node_exec") return await execute(createNodeExecTool(ref, owner, undefined, { ...trusted, sandboxDiagnostics: true, expiresAtMs: approval.deadlineMs }));
      throw new Error("Unsupported sandbox tool");
    } finally {
      try {
        if (request.tool === "node_exec") await debugPodCache.evictFor(owner, name, args.node!);
      } catch {
        throw new SandboxToolError("CLEANUP_PENDING", execution, "pending", completed);
      } finally {
        broker?.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if (error instanceof SandboxToolError) throw error;
    const finalExecution = execution as ToolExecution; // Updated by the awaited tool callback.
    if (finalExecution === "FINISHED") throw new SandboxToolError("CLEANUP_PENDING", finalExecution, "pending", completed);
    throw new SandboxToolError(finalExecution === "UNKNOWN" ? "EXECUTION_UNKNOWN" : "SERVICE_UNAVAILABLE", finalExecution);
  }

}
