import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { renderTextResult, processToolOutput } from "./tool-render.js";
import { checkPodRunning } from "./k8s-checks.js";
import { resolveKubeconfigPath } from "./kubeconfig-resolver.js";
import { sanitizeEnv } from "./sanitize-env.js";
import { validateCommand } from "./node-exec.js";
import { parseArgs } from "./command-sets.js";

const execFileAsync = promisify(execFile);

// Valid pod name: RFC 1123 subdomain
const POD_NAME_RE = /^[a-z0-9][a-z0-9.\-]*$/;

export function validatePodName(pod: string): string | null {
  if (!pod || !pod.trim()) {
    return "Pod name must not be empty.";
  }
  if (!POD_NAME_RE.test(pod)) {
    return `Invalid pod name "${pod}". Pod names may only contain lowercase letters, digits, hyphens, and dots.`;
  }
  return null;
}

interface PodExecParams {
  pod: string;
  namespace?: string;
  container?: string;
  command: string;
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

Shell features (pipes, redirects) are NOT supported.
Some commands have extra restrictions: find blocks -exec/-delete, sysctl blocks -w, mount blocks actual mounting,
curl blocks -o/-O/-T (file output/upload), env only allows listing (no command execution).

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
      const kubeconfigPath = resolveKubeconfigPath(kubeconfigRef?.credentialsDir);
      const kubeconfigArgs = kubeconfigPath ? [`--kubeconfig=${kubeconfigPath}`] : [];
      const childEnv = {
        ...sanitizeEnv(process.env as Record<string, string>),
        ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
        KUBECONFIG: "/dev/null",
      };
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

      // Validate command (reuse node-exec's validation — same whitelist + metachar + restrictions)
      const cmdErr = validateCommand(params.command);
      if (cmdErr) {
        return {
          content: [{ type: "text", text: cmdErr }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Check pod exists and is Running
      const podCheckErr = await checkPodRunning(pod, namespace, childEnv, kubeconfigPath ?? undefined);
      if (podCheckErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: podCheckErr }, null, 2) }],
          details: { error: true },
        };
      }

      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
      const cmdArgs = parseArgs(params.command);

      // Build kubectl exec args
      const kubectlArgs = [...kubeconfigArgs, "exec", pod, "-n", namespace];
      if (params.container?.trim()) {
        kubectlArgs.push("-c", params.container.trim());
      }
      kubectlArgs.push("--", ...cmdArgs);

      try {
        const { stdout, stderr } = await execFileAsync(
          "kubectl",
          kubectlArgs,
          { timeout, env: childEnv },
        );

        const output = stdout.trim() + (stderr.trim() ? `\n\nSTDERR:\n${stderr.trim()}` : "");
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        const stdout = (err.stdout?.trim() ?? "") as string;
        const stderr = (err.stderr?.trim() ?? err.message) as string;
        const exitCode = err.code ?? "unknown";
        const output = `Exit code: ${exitCode}\n${stdout}${stderr ? `\n${stderr}` : ""}`;
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode, error: true },
        };
      }
    },
  };
}
