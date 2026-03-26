import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../../core/agent-factory.js";
import { renderTextResult } from "../infra/tool-render.js";
import { analyzeOutput, applySanitizer } from "../infra/output-sanitizer.js";
import { loadConfig } from "../../core/config.js";
import { parseArgs, CONTAINER_SENSITIVE_PATHS } from "../infra/command-sets.js";
import { validateCommand } from "../infra/command-validator.js";
import {
  validatePodName,
  prepareExecEnv,
  resolveContainerNetns,
  formatExecOutput,
} from "../infra/exec-utils.js";
import { runInDebugPod } from "../infra/debug-pod.js";
import { resolveRequiredKubeconfig, resolveDebugImage } from "../infra/kubeconfig-resolver.js";

interface PodNsenterExecParams {
  pod: string;
  namespace?: string;
  container?: string;
  command: string;
  kubeconfig?: string;
  image?: string;
  timeout_seconds?: number;
}

export function createPodNsenterExecTool(kubeconfigRef?: KubeconfigRef, userId?: string): ToolDefinition {
  return {
    name: "pod_nsenter_exec",
    label: "Pod Nsenter Exec",
    description: `Execute a diagnostic command in a pod's network namespace using the HOST's tools.

Creates a privileged debug pod on the same node as the target pod, then uses nsenter to:
1. Enter the host's full namespaces (to access host tools like tcpdump, ss, ip, ethtool, etc.)
2. Enter only the pod's network namespace (to see the pod's network interfaces, IPs, routes)

This gives the ideal environment for network diagnostics: host tools + pod's network view.
Use this when the pod image lacks diagnostic tools but you need to inspect its network.

Node requirements: the host must have jq and crictl installed.

Allowed commands (ONLY these are permitted — same whitelist as node_exec):
  network: ip, ifconfig, ping, traceroute, tracepath, ss, netstat, route, arp, ethtool, mtr, bridge, tc, conntrack, nslookup, dig, host, curl
  RDMA/RoCE: ibstat, ibstatus, ibv_devinfo, ibv_devices, rdma, ibaddr, iblinkinfo, ibportstate, show_gids, ibdev2netdev
  text: grep, egrep, fgrep, sort, uniq, wc, head, tail, cut, tr, jq, yq, column
  process: ps, pgrep, top, free, vmstat, iostat, mpstat, df, du, mount, findmnt, nproc
  file (read-only): cat, ls, pwd, stat, file, find, readlink, realpath, basename, dirname, diff, md5sum, sha256sum
  kernel: uname, hostname, uptime, dmesg, sysctl, lsmod, modinfo
  general: date, whoami, id, env, printenv, which, echo, printf, sleep

Shell features (pipes, redirects) are NOT supported.

Examples:
- pod: "my-app-abc", namespace: "production", command: "ip addr show"
- pod: "my-app-abc", command: "ss -tlnp"
- pod: "my-app-abc", command: "ethtool eth0"
- pod: "my-app-abc", command: "ping -c 3 10.0.0.1"`,
    parameters: Type.Object({
      pod: Type.String({
        description: "Target pod name (whose network namespace to enter)",
      }),
      namespace: Type.Optional(
        Type.String({ description: 'Namespace (default: "default")' }),
      ),
      container: Type.Optional(
        Type.String({
          description:
            "Container name (for multi-container pods, to determine netns)",
        }),
      ),
      command: Type.String({
        description:
          'Diagnostic command to run in the pod\'s network namespace (e.g. "ip addr show", "ss -tlnp")',
      }),
      kubeconfig: Type.Optional(
        Type.String({
          description: "Credential name of the target cluster (from credential_list). If omitted, uses the default kubeconfig.",
        }),
      ),
      image: Type.Optional(
        Type.String({
          description: "Debug container image (default: SICLAW_DEBUG_IMAGE)",
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
        theme.fg("toolTitle", theme.bold("pod_nsenter_exec")) +
          " " + theme.fg("accent", `${ns}/${pod}`) +
          " " + theme.fg("toolTitle", theme.bold("$")) +
          " " + cmd,
        0, 0,
      );
    },
    renderResult: renderTextResult,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as PodNsenterExecParams;

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
      const cmdErr = validateCommand(params.command, { context: "nsenter", sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS });
      if (cmdErr) {
        return {
          content: [{ type: "text", text: cmdErr }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Resolve container network namespace (pod phase + node + container ID)
      const netns = await resolveContainerNetns(pod, namespace, params.container, env);
      if ("error" in netns) {
        return {
          content: [{ type: "text", text: `Error: ${netns.error}` }],
          details: { error: true },
        };
      }

      const clusterKey = params.kubeconfig || "default";
      const image = params.image || resolveDebugImage(kubeconfigRef?.credentialsDir, params.kubeconfig) || loadConfig().debugImage;
      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
      const cmdArgs = parseArgs(params.command);

      // Post-execution output sanitization
      // Convention: binary is separate, args does NOT include binary itself
      const binary = cmdArgs[0]?.split("/").pop() ?? "";
      const action = analyzeOutput(binary, cmdArgs.slice(1));

      const execArgs = cmdArgs;

      // Escape single quotes in command args for embedding in shell script
      const escapedArgs = execArgs.map(a => a.replace(/'/g, "'\\''")).map(a => `'${a}'`).join(" ");

      // The inner script runs on the host via outer nsenter,
      // then uses inner nsenter to enter only the pod's network namespace.
      // unshare --mount + sysfs remount ensures /sys reflects the pod's netns.
      const innerScript = `
CONTAINER_ID="${netns.containerID}"
PID=$(crictl inspect "$CONTAINER_ID" 2>/dev/null | jq -r ".info.pid")
if [ -z "$PID" ] || [ "$PID" = "null" ]; then
  echo "Error: cannot find PID for container $CONTAINER_ID" >&2
  exit 1
fi
unshare --mount sh -c 'nsenter -t '"$PID"' -n -- mount -t sysfs none /sys 2>/dev/null; nsenter -t '"$PID"' -n -- ${escapedArgs}'
`.trim();

      const nsenterCmd = [
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p",
        "--", "sh", "-c", innerScript,
      ];

      const execResult = await runInDebugPod(
        { userId: userId ?? "unknown", nodeName: netns.nodeName, command: nsenterCmd, image, clusterKey },
        env,
        { timeoutMs: timeout, signal },
      );

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      // Apply output sanitization before formatting
      execResult.stdout = applySanitizer(execResult.stdout, action);
      return formatExecOutput(execResult);
    },
  };
}
