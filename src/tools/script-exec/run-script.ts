import { Type } from "@sinclair/typebox";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateScriptRequest } from "../../script-sandbox/validation.js";

export function createRunScriptTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "run_script", label: "Run Script",
    description: "Prefer direct built-in tools for simple diagnostics. Use this for multi-step aggregation or batch processing. Run Python stdlib or Bash in a disposable container. No production credentials, AgentBox/host files or package installation. " +
      "The working directory is /work. You may create, read, update and delete your own files in /work and use /tmp for scratch data, subject to storage, memory and execution limits. Files exist only for this run and cannot be shared with later runs. Treat image and SDK files as read-only. " +
      "Local Python/Shell file processing needs no SDK call. To access a cluster, host, Pod or MCP service, use the SDK tools below; local file access does not grant access to remote files or production credentials. " +
      "Python: from siclaw import call, call_to_file, input_data. " +
      "input_data() is a zero-argument function that returns the input parameter as a decoded JSON value; omitted or null input returns None. " +
      "Example with input {\"numbers\": [1, 2, 3]}:\n```python\nfrom siclaw import input_data\npayload = input_data()\nprint(sum(payload[\"numbers\"]))\n```\n" +
      "Shell: siclaw-tool TOOL JSON; read the input JSON from $SICLAW_INPUT_FILE. " +
      "Large results: call_to_file(TOOL, ARGS, '/work/result.json') or siclaw-tool --output /work/result.json TOOL JSON saves complete sanitized JSON and returns only path/bytes/checksum. " +
      "Inline results are capped at 128 KiB; file results at 4 MiB each and 16 MiB per run. Read/process files inside the same run and print only the final summary; files disappear afterward. " +
      "SDK operations call the Agent's existing tools with their normal command policies: bash {cluster,command,timeout_seconds?}, host_exec {host,command,timeout_seconds?}, node_exec {cluster,node,command,timeout_seconds?}, pod_exec {cluster,namespace?,pod,container?,command,timeout_seconds?}. " +
      "Use bash for all Kubernetes queries, for example kubectl get nodes -o json, kubectl describe pod NAME -n NAMESPACE, or kubectl logs NAME -n NAMESPACE --tail=100. Follow the existing tool's whitelist, rate limits and output sanitization; there is no separate sandbox Kubernetes API or command whitelist. " +
      "These tools require run_commands and an explicit declared cluster or host. Tool timeouts are 1-15 seconds; background execution and image/credential overrides are unavailable. node_exec needs an explicit node and creates a managed diagnostic Job: at most 10 concurrent node callbacks per Runtime and 10 diagnostic Pods per target cluster. pod_exec needs timeout in the target container. " +
      "mcp.call {server,tool,arguments} uses the shared Agent MCP implementation with service-authorized tools and resource arguments. Declare each resource in the run scope. " +
      "Use exact bound resource names supplied by the user or available context; if discovery tools are unavailable, ask for missing names. Do not guess names or read credential files. " +
      "Built-in command results contain text (sanitized stdout only), stderr, notices, exit_code and exit_class. For kubectl -o json, parse result['text'] as JSON; warnings and redaction notices are separate. call_to_file saves the same result envelope. Inspect exit_class and notices before treating output as complete; failed/truncated calls are rejected. File delivery does not bypass the tool's limits: logs are bounded windows. " +
      "Access is reauthorized for every call and result chunk. Cluster declarations name bound resources; namespace/resource permissions remain with the existing tools and the credential's Kubernetes RBAC. Never embed secrets in code/input. Network isolation defaults off unless configured or required by the administrator; " +
      "when on, socket creation is denied, including SSH/HTTP from subprocesses. Controlled tools work over pipes in both modes.",
    parameters: Type.Object({
      language: Type.Union([Type.Literal("python"), Type.Literal("shell")]), code: Type.String({ maxLength: 131072 }),
      input: Type.Optional(Type.Unknown({
        description: "JSON value supplied to this script. Python reads it by calling input_data() with no arguments; Shell reads $SICLAW_INPUT_FILE. Omitted or null input becomes Python None.",
      })), network_isolation: Type.Optional(Type.Boolean()),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
      clusters: Type.Optional(Type.Array(Type.Object({ name: Type.String() }, { additionalProperties: false }))),
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
