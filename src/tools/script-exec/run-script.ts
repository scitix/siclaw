import { Type } from "@sinclair/typebox";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateScriptRequest } from "../../script-sandbox/validation.js";

export function createRunScriptTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "run_script", label: "Run Script",
    description: "Run Python stdlib or Bash in a disposable container. No production credentials, local files or package installation. " +
      "Python: from siclaw import call, call_to_file, input_data; Shell: siclaw-tool TOOL JSON. " +
      "Large results: call_to_file(TOOL, ARGS, '/work/result.json') or siclaw-tool --output /work/result.json TOOL JSON saves complete sanitized JSON and returns only path/bytes/checksum. " +
      "Inline results are capped at 128 KiB; file results at 4 MiB each and 16 MiB per run. Read/process files inside the same run and print only the final summary; files disappear afterward. " +
      "Controlled operations: bash {cluster,command,timeout_seconds?} (single scoped kubectl get nodes/pods; table, wide, name, or approved custom-columns), k8s.list_pods {cluster,namespace,continue?} returns up to 10 pod summaries per page; k8s.pod_logs {cluster,namespace,pod,container?,tail_lines?}; " +
      "k8s.list_nodes {cluster,continue?} requires clusters[].nodes=true and returns up to 10 node summaries. For both list operations, pass the returned continue token on subsequent calls until null; report incomplete inventories on any failure or budget limit. " +
      "host.inspect {host,check:os|memory|sysctl}; mcp.call {server,tool,arguments}. Declare each resource in the run scope. " +
      "Use exact bound resource names supplied by the user or available context; if discovery tools are unavailable, ask for missing names. Do not guess names or read credential files. " +
      "Node fields: name, ready, unschedulable, kubelet_version, kernel_version, os_image, architecture, container_runtime, capacity, allocatable. " +
      "Access is reauthorized for every call and result chunk. Always follow resource pagination even with file delivery; log reads are bounded windows, not complete history. Never embed secrets in code/input. Network isolation defaults off unless configured or required by the administrator; " +
      "when on, socket creation is denied, including SSH/HTTP from subprocesses. Controlled tools work over pipes in both modes.",
    parameters: Type.Object({
      language: Type.Union([Type.Literal("python"), Type.Literal("shell")]), code: Type.String({ maxLength: 131072 }),
      input: Type.Optional(Type.Unknown()), network_isolation: Type.Optional(Type.Boolean()),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
      clusters: Type.Optional(Type.Array(Type.Object({ name: Type.String(),
        namespaces: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
        nodes: Type.Optional(Type.Boolean({ description: "Explicitly request cluster-scoped node summaries; still requires Kubernetes nodes/list RBAC." })),
      }, { additionalProperties: false }))),
      hosts: Type.Optional(Type.Array(Type.String())),
      mcp: Type.Optional(Type.Array(Type.Object({ server: Type.String(), tools: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }))),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (!refs.scriptExecutor) throw new Error("Script sandbox unavailable");
      const result = await refs.scriptExecutor(validateScriptRequest(params), refs.sessionIdRef.current, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

export const registration: ToolEntry = {
  category: "script-exec", create: createRunScriptTool,
  available: refs => !!refs.scriptExecutor && !refs.isSubagent && !refs.delegation,
  modes: ["web"],
};
