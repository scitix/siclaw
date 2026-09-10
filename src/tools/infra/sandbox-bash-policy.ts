import type { ScriptRequest } from "../../script-sandbox/types.js";
import { identifier, record } from "../../script-sandbox/validation.js";
import { parseArgs, shellEscape } from "./command-sets.js";
import { validateKubectlInPipeline } from "./kubectl-readonly-policy.js";
import { preExecSecurity } from "./security-pipeline.js";

const NODE_COLUMNS = new Set([
  ".metadata.name", ".status.nodeInfo.kubeletVersion", ".status.nodeInfo.kernelVersion",
  ".status.nodeInfo.osImage", ".status.nodeInfo.architecture", ".status.nodeInfo.containerRuntimeVersion",
  ".status.capacity.cpu", ".status.capacity.memory", ".status.allocatable.cpu", ".status.allocatable.memory",
  ".spec.unschedulable",
]);
const POD_COLUMNS = new Set([".metadata.name", ".metadata.namespace", ".status.phase", ".spec.nodeName"]);

export interface SandboxBashRequest { cluster: string; command: string; timeout_seconds: number }

/** Additional authorization profile for UNTRUSTED code. Never expose the full Bash/Skill surface. */
export function validateSandboxBash(args: unknown, scope: Pick<ScriptRequest, "clusters">): SandboxBashRequest {
  const deny = (): never => { throw new Error("Sandbox Bash request denied"); };
  if (!record(args) || Object.keys(args).some(k => !["cluster", "command", "timeout_seconds"].includes(k)) ||
      !identifier(args.cluster) || typeof args.command !== "string" || args.command.length > 4096) return deny();
  const grant = scope.clusters?.find(c => c.name === args.cluster);
  if (!grant) return deny();
  const timeout = args.timeout_seconds ?? 10;
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 15) return deny();
  // A deliberately small grammar. Reject shell metacharacters even inside quotes;
  // accepted argv are rebuilt below, so parser/shell disagreements cannot add work.
  if (!/^[a-zA-Z0-9_./,:= \-'\"]+$/.test(args.command)) return deny();
  const argv = parseArgs(args.command);
  if (argv[0] !== "kubectl" || argv[1] !== "get") return deny();
  const resource = new Map([["node", "nodes"], ["nodes", "nodes"], ["pod", "pods"], ["pods", "pods"]]).get(argv[2]);
  if (!resource) return deny();
  let name: string | undefined;
  let namespace: string | undefined;
  let output: string | undefined;
  const seen = new Set<string>();
  for (let i = 3; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-")) {
      if (name || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(token)) return deny();
      name = token; continue;
    }
    const split = token.indexOf("=");
    const key = split < 0 ? token : token.slice(0, split);
    const flag = key === "-n" || key === "--namespace" ? "namespace" : key === "-o" || key === "--output" ? "output" : "";
    if (!flag || seen.has(flag)) return deny();
    seen.add(flag);
    const value = split < 0 ? argv[++i] : token.slice(split + 1);
    if (!value) return deny();
    if (flag === "namespace") namespace = value;
    else output = value;
  }
  if (resource === "nodes" ? !grant.nodes || namespace !== undefined : !namespace || !grant.namespaces?.includes(namespace)) return deny();
  if (namespace && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) return deny();
  if (output && !["wide", "name"].includes(output)) {
    if (!output.startsWith("custom-columns=")) return deny();
    const columns = output.slice("custom-columns=".length).split(",");
    const paths = resource === "nodes" ? NODE_COLUMNS : POD_COLUMNS;
    if (!columns.length || columns.length > 12 || columns.some(column => {
      const parts = column.split(":");
      return parts.length !== 2 || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(parts[0]) || !paths.has(parts[1]);
    })) return deny();
  }
  const canonical = ["kubectl", "get", resource, ...(name ? [name] : []),
    ...(namespace ? ["--namespace", namespace] : []), ...(output ? ["--output", output] : []),
    "--request-timeout=10s", "--chunk-size=100"];
  const command = canonical.map((arg, i) => i === 0 ? arg : shellEscape(arg)).join(" ");
  const pre = preExecSecurity(command, { context: "local", extraAllowed: new Set(["kubectl"]),
    blockPipeline: true, pipelineValidators: [validateKubectlInPipeline] });
  if (pre.error) return deny();
  return { cluster: args.cluster, command, timeout_seconds: Number(timeout) };
}
