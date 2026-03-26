import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { renderTextResult, processToolOutput } from "./tool-render.js";
import { analyzeOutput, applySanitizer } from "./output-sanitizer.js";
import { checkPodRunning } from "./k8s-checks.js";
import { parseArgs, CONTAINER_SENSITIVE_PATHS } from "./command-sets.js";
import { validateCommand } from "./command-validator.js";
import { validatePodName, prepareExecEnv } from "./exec-utils.js";
import { resolveRequiredKubeconfig } from "./kubeconfig-resolver.js";

const execFileAsync = promisify(execFile);

// Re-export for backward compatibility (tests + downstream imports)
export { validatePodName } from "./exec-utils.js";

interface PodExecParams {
  pod: string;
  namespace?: string;
  container?: string;
  command: string;
  kubeconfig?: string;
  timeout_seconds?: number;
}

export function createPodExecTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "pod_exec",
    label: "Pod Exec",
    description: `Execute a diagnostic command inside a running Kubernetes pod via kubectl exec.

Runs a single whitelisted command directly inside the target pod's container.
The command runs in the pod's own environment — it uses whatever tools are available in the container image.

Use this tool for in-pod diagnostics such as:
- Checking network from the pod's perspective (ip addr, ss, netstat, ping, curl)
- Inspecting processes inside the pod (ps, top, pgrep)
- Reading config or log files (cat, head, tail, ls, find, grep)
- Checking resource usage (df, du, free)

Allowed commands (ONLY these are permitted):
  network: ip, ifconfig, ping, traceroute, tracepath, ss, netstat, route, arp, ethtool, mtr, bridge, tc, conntrack, nslookup, dig, host, curl
  text: grep, egrep, fgrep, sort, uniq, wc, head, tail, cut, tr, jq, yq, column
  process: ps, pgrep, top, free, vmstat, iostat, mpstat, df, du, mount, findmnt, nproc
  file (read-only): cat, ls, pwd, stat, file, find, readlink, realpath, basename, dirname, diff, md5sum, sha256sum
  kernel: uname, hostname, uptime, dmesg, sysctl, lsmod, modinfo
  general: date, whoami, id, env, printenv, which, echo, printf, sleep

Shell features (pipes, redirects) are NOT supported — commands are passed as argv, not through a shell.
The following will be rejected: find with -exec/-delete, sysctl with -w, mount with actual mounting,
curl with -o/-O/-T (file output/upload), env with command arguments (only listing allowed).

Examples:
- pod: "my-app-abc", namespace: "production", command: "ip addr show"
- pod: "nginx-xyz", command: "cat /etc/nginx/nginx.conf"
- pod: "my-app-abc", command: "ps aux"
- pod: "my-app-abc", namespace: "production", command: "curl -s http://localhost:8080/healthz"`,
    parameters: Type.Object({
      pod: Type.String({
        description: "Target pod name",
      }),
      namespace: Type.Optional(
        Type.String({
          description: 'Namespace (default: "default")',
        }),
      ),
      container: Type.Optional(
        Type.String({
          description: "Container name (for multi-container pods)",
        }),
      ),
      command: Type.String({
        description:
          'Diagnostic command to run in the pod (e.g. "ip addr show", "ps aux")',
      }),
      kubeconfig: Type.Optional(
        Type.String({
          description: "Credential name of the target cluster (from credential_list). If omitted, uses the default kubeconfig.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, max: 120)",
        }),
      ),
    }),
    renderCall(args: any, theme: any) {
      const pod = args?.pod || "...";
      const ns = args?.namespace || "default";
      const cmd = args?.command || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("pod_exec")) +
          " " + theme.fg("accent", `${ns}/${pod}`) +
          " " + theme.fg("toolTitle", theme.bold("$")) +
          " " + cmd,
        0, 0,
      );
    },
    renderResult: renderTextResult,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as PodExecParams;

      const kubeResult = resolveRequiredKubeconfig(kubeconfigRef?.credentialsDir, params.kubeconfig);
      if ("error" in kubeResult) {
        return {
          content: [{ type: "text", text: `Error: ${kubeResult.error}` }],
          details: { error: true },
        };
      }
      const env = prepareExecEnv(kubeconfigRef, kubeResult.path);
      const pod = params.pod?.trim();
      const namespace = params.namespace?.trim() || "default";

      // Validate pod name
      const podErr = validatePodName(pod);
      if (podErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: podErr }, null, 2) }],
          details: { blocked: true, reason: "invalid_pod_name" },
        };
      }

      // Validate command
      const cmdErr = validateCommand(params.command, { context: "pod", sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS, blockPipeline: true });
      if (cmdErr) {
        return {
          content: [{ type: "text", text: cmdErr }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Check pod exists and is Running
      const podCheckErr = await checkPodRunning(
        pod, namespace, env.childEnv, env.kubeconfigPath ?? undefined,
      );
      if (podCheckErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: podCheckErr }, null, 2) }],
          details: { error: true },
        };
      }

      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
      const cmdArgs = parseArgs(params.command);

      // Post-execution output sanitization
      // Convention: binary is separate, args does NOT include binary itself
      const binary = cmdArgs[0]?.split("/").pop() ?? "";
      const action = analyzeOutput(binary, cmdArgs.slice(1));

      // Build kubectl exec args (use rewritten args if action requires it)
      const execArgs = action?.type === "rewrite" ? action.newArgs : cmdArgs;
      const kubectlArgs = [...env.kubeconfigArgs, "exec", pod, "-n", namespace];
      if (params.container?.trim()) {
        kubectlArgs.push("-c", params.container.trim());
      }
      kubectlArgs.push("--", ...execArgs);

      try {
        const { stdout, stderr } = await execFileAsync(
          "kubectl",
          kubectlArgs,
          { timeout, env: env.childEnv },
        );

        const sanitized = applySanitizer(stdout.trim(), action);
        const output = sanitized + (stderr.trim() ? `\n\nSTDERR:\n${stderr.trim()}` : "");
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        const stdout = (err.stdout?.trim() ?? "") as string;
        const sanitizedStdout = applySanitizer(stdout, action);
        const stderr = (err.stderr?.trim() ?? err.message) as string;
        const exitCode = err.code ?? "unknown";
        const output = `Exit code: ${exitCode}\n${sanitizedStdout}${stderr ? `\n${stderr}` : ""}`;
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode, error: true },
        };
      }
    },
  };
}
