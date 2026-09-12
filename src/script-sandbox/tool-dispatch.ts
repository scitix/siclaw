import type { ScriptRequest, ScriptToolCall } from "./types.js";
import { identifier, record } from "./validation.js";
import { normalizeExecTarget } from "../tools/infra/exec-utils.js";

export type SandboxBuiltinTool = "bash" | "host_exec" | "node_exec" | "pod_exec";

export interface SandboxBuiltinRequest {
  tool: SandboxBuiltinTool;
  arguments: Record<string, unknown> & {
    cluster?: string;
    host?: string;
    node?: string;
    timeout_seconds: number;
  };
}

/** Resolve resource authority and execution budgets, never inspect command syntax.
 * The selected built-in owns argument validation, command policy and execution.
 */
export function resolveSandboxBuiltin(call: ScriptToolCall, scope: ScriptRequest): SandboxBuiltinRequest {
  if (!record(call) || !record(call.arguments)) throw new Error("Invalid sandbox tool request");
  if (!["bash", "host_exec", "node_exec", "pod_exec"].includes(call.tool)) throw new Error("Sandbox tool unavailable");
  const a = normalizeExecTarget(call.arguments);
  if (call.tool === "host_exec") {
    if (!identifier(a.host) || !scope.hosts?.includes(a.host)) throw new Error("Outside host scope");
  } else {
    if (!identifier(a.cluster) || !scope.clusters?.some(c => c.name === a.cluster)) throw new Error("Outside cluster scope");
    // An explicit node owns this invocation's diagnostic Job and cleanup entry.
    if (call.tool === "node_exec" && !identifier(a.node)) throw new Error("An explicit node is required");
  }
  const timeout = a.timeout_seconds ?? 10;
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 15) throw new Error("Tool timeout must be 1–15 seconds");
  return { tool: call.tool as SandboxBuiltinTool, arguments: { ...a, timeout_seconds: Number(timeout) } };
}
