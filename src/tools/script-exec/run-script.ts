import { Type } from "@sinclair/typebox";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateScriptRequest } from "../../script-sandbox/validation.js";

export function createRunScriptTool(refs: ToolRefs): ToolDefinition {
  const info = refs.scriptSandboxInfo;
  const limits = info?.limits;
  const budget = limits
    ? `Per run: default ${limits.default_timeout_seconds}s, max ${limits.max_timeout_seconds}s after startup; ${limits.max_tool_calls} SDK calls; ${limits.max_output_bytes} stdout/stderr bytes. `
    : "Runtime budgets unavailable; use small batches and conservative timeouts. ";
  const network = info?.require_network_isolation ? "required" : info?.network_isolation ? "on by default" : "off by default";
  return {
    name: "run_script", label: "Run Script",
    description: "Run Python stdlib or Bash in a disposable container for batch orchestration and aggregation. Prefer direct tools for simple tasks. " +
      "Before batching, reuse a successful sample or validate one representative direct tool call for arguments, authorization and output shape. If direct tools are unavailable, validate the first SDK result before continuing the batch. " +
      "Write the complete script from known tool schemas; avoid sandbox probes. Reuse existing input or one bulk query for local processing. Validate fields, catch per-resource errors, report successes and failures; do not retry denials or blindly repeat batches. " +
      budget + `Up to ${limits?.max_concurrent_tools ?? 10} concurrent SDK calls per run: use Python ThreadPoolExecutor(max_workers=${limits?.max_concurrent_tools ?? 10}) or bounded Shell workers. Target limits queue calls automatically; include waiting and diagnostic cleanup in the budget. ` +
      "No production credentials, AgentBox/host files or package installation. /work and /tmp are writable scratch space within storage/memory limits; files vanish after this run. Image/SDK files are read-only. Local file processing needs no SDK. " +
      "Python: from siclaw import call, call_to_file, input_data. input_data() takes no arguments and returns decoded input JSON (None if omitted/null). Example for input {\"numbers\":[1,2,3]}: payload = input_data(); print(sum(payload[\"numbers\"])). " +
      "call(TOOL, ARGS) returns a result; call_to_file(TOOL, ARGS, '/work/result.json') saves the same sanitized JSON envelope and returns path/bytes/checksum. Shell: siclaw-tool TOOL JSON; siclaw-tool --output /work/result.json TOOL JSON; input is $SICLAW_INPUT_FILE. " +
      "Inline results: 128 KiB; files: 4 MiB each, 16 MiB/run. Process files here and print a concise final summary. File delivery retains tool output limits; logs are bounded windows. " +
      "Remote access uses existing Agent tools and their policies: bash {cluster,command,timeout_seconds?}, host_exec {host,command,timeout_seconds?}, node_exec {cluster,node,command,timeout_seconds?}, pod_exec {cluster,namespace?,pod,container?,command,timeout_seconds?}. " +
      "Declare bound clusters/hosts; these calls require run_commands. Use bash for kubectl queries. Command timeout: 1-15s; no background or image/credential overrides. node_exec creates a managed diagnostic Job; pod_exec requires timeout in the target container. " +
      "Command results: text (sanitized stdout), stderr, notices, exit_code, exit_class. Parse text for kubectl JSON; inspect exit_class/notices for completeness. Failed/truncated calls are rejected. " +
      "Python ToolError exposes code, execution, cleanup and optional result. UNKNOWN or cleanup=pending must not be automatically retried; RESULT_TOO_LARGE calls should use call_to_file. " +
      "MCP: use the main Agent's existing tool schemas. mcp__metrics__query maps to call('mcp.call', {'server':'metrics','tool':'query','arguments':{...}}), with mcp:[{server:'metrics',tools:['query']}] declared. tool is the original MCP name. SDK entry points are fixed; no discovery or generated wrappers. " +
      "MCP returns its native result directly, also at the saved file's JSON root: content, optional structuredContent and optional isError (absent means false). Check result.get('isError', False); prefer structuredContent, otherwise parse text content per tool schema. Do not search nested wrappers. " +
      "Every call/chunk reauthorizes the caller and declared resources; existing tool policies and credential RBAC apply. Use known bound names; ask if missing. Never embed secrets. " +
      `Network isolation: ${network}. When on, sockets (including subprocess SSH/HTTP) are denied; SDK uses local messages and runner stdio.`,
    parameters: Type.Object({
      language: Type.Union([Type.Literal("python"), Type.Literal("shell")]), code: Type.String({ maxLength: 131072 }),
      input: Type.Optional(Type.Unknown({
        description: "JSON value supplied to this script. Python reads it by calling input_data() with no arguments; Shell reads $SICLAW_INPUT_FILE. Omitted or null input becomes Python None.",
      })), network_isolation: Type.Optional(Type.Boolean()),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: limits?.max_timeout_seconds ?? 600,
        ...(limits ? { default: limits.default_timeout_seconds } : {}), description: "Execution budget after runner startup. Include target queue waits, concurrent SDK batches and diagnostic cleanup." })),
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
  available: refs => !!refs.scriptExecutor && !refs.isSubagent,
  modes: ["web"],
};
