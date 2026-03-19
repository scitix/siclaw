import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { renderTextResult } from "./tool-render.js";
import { checkNodeReady } from "./k8s-checks.js";
import { loadConfig } from "../core/config.js";
import { parseArgs } from "./command-sets.js";
import { validateCommand, extractCommands } from "./command-validator.js";
import {
  validateNodeName,
  prepareExecEnv,
  runInDebugPod,
  formatExecOutput,
} from "./exec-utils.js";
import { resolveRequiredKubeconfig } from "./kubeconfig-resolver.js";

// Re-export for backward compatibility (tests + downstream imports)
export { ALLOWED_COMMANDS } from "./command-sets.js";
export { validateNodeName, validatePodName } from "./exec-utils.js";
export { validateCommand } from "./command-validator.js";

interface NodeExecParams {
  node: string;
  command: string;
  kubeconfig?: string;
  image?: string;
  timeout_seconds?: number;
}

export function createNodeExecTool(kubeconfigRef?: KubeconfigRef, userId?: string): ToolDefinition {
  return {
    name: "node_exec",
    label: "Node Exec",
    description: `Execute diagnostic commands directly on a Kubernetes node.
Creates a privileged debug pod with nsenter to run the command in the host's full namespaces (mount, UTS, IPC, network, PID).
The pod is automatically cleaned up after execution (--rm).

Commands run on the HOST — they have access to the host's tools, filesystem, devices, /proc, /sys, and /dev.

Use this tool for host-level diagnostics that cannot be done from within a pod, such as:
- Inspecting host network interfaces, routes, and RDMA devices
- Running RDMA perftest tools (ib_write_bw, ib_read_bw, etc.) on the node
- Checking GPU status with nvidia-smi on the node
- Reading host kernel parameters (sysctl, dmesg, lsmod)
- Listing host hardware (lspci, lsblk, dmidecode)
- Checking network connectivity with curl

Allowed commands (ONLY these are permitted — do NOT use \`which\` to check, just run the command directly):
  network: ip, ifconfig, ping, traceroute, tracepath, ss, netstat, route, arp, ethtool, mtr, bridge, tc, conntrack, nslookup, dig, host, curl
  RDMA/RoCE: ibstat, ibstatus, ibv_devinfo, ibv_devices, rdma, ibaddr, iblinkinfo, ibportstate, show_gids, ibdev2netdev
  perftest: ib_write_bw, ib_write_lat, ib_read_bw, ib_read_lat, ib_send_bw, ib_send_lat, ib_atomic_bw, ib_atomic_lat, raw_ethernet_bw, raw_ethernet_lat, raw_ethernet_burst_lat
  GPU: nvidia-smi, gpustat, nvtopo
  hardware: lspci, lsusb, lsblk, lscpu, lsmem, lshw, dmidecode
  kernel: uname, hostname, uptime, dmesg, sysctl, lsmod, modinfo
  process: ps, pgrep, top, free, vmstat, iostat, mpstat, df, du, mount, findmnt, nproc
  file (read-only): cat, head, tail, ls, stat, file, wc, find, grep, diff, md5sum, sha256sum
  text processing: sort, uniq, cut, tr, jq, yq, column
  logs/services: journalctl, systemctl, timedatectl, hostnamectl
  container: crictl, ctr
  firewall (read-only): iptables, ip6tables
  general: date, whoami, id, env, printenv, which, readlink, echo

Pipes (|), && and ; are supported — each command in the pipeline must be in the whitelist.
Output redirection (> file), input redirection (< file), $() and backticks are blocked.
Some commands have extra restrictions: find blocks -exec/-delete, sysctl blocks -w, mount blocks actual mounting,
curl blocks -o/-O/-T (file output/upload), env only allows listing (no command execution),
systemctl only allows read-only subcommands, iptables only allows list operations.

Examples:
- node: "node-1", command: "ip addr show"
- node: "node-1", command: "ip addr show | grep 10.0.0"
- node: "node-1", command: "nvidia-smi"
- node: "node-1", command: "ibstat"
- node: "node-1", command: "ib_write_bw --help"
- node: "node-1", command: "dmesg --level=err"
- node: "node-1", command: "sysctl net.ipv4.ip_forward"
- node: "node-1", command: "cat /etc/os-release"
- node: "node-1", command: "curl -s http://10.0.0.1:8080/healthz"
- node: "node-1", command: "ps aux | head -20"
- node: "node-1", command: "journalctl -u kubelet -n 100 | grep error"`,
    parameters: Type.Object({
      node: Type.String({
        description: "Kubernetes node name to debug",
      }),
      command: Type.String({
        description:
          'Diagnostic command to run on the node (e.g. "ip addr show", "nvidia-smi")',
      }),
      kubeconfig: Type.Optional(
        Type.String({
          description: "Credential name of the target cluster (from credential_list). If omitted, uses the default kubeconfig.",
        })
      ),
      image: Type.Optional(
        Type.String({
          description: "Debug container image (default: SICLAW_DEBUG_IMAGE)",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, max: 120)",
        })
      ),
    }),
    renderCall(args: any, theme: any) {
      const node = args?.node || "...";
      const cmd = args?.command || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("node_exec")) +
          " " + theme.fg("accent", node) +
          " " + theme.fg("toolTitle", theme.bold("$")) +
          " " + cmd,
        0, 0,
      );
    },
    renderResult: renderTextResult,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as NodeExecParams;

      const kubeResult = resolveRequiredKubeconfig(kubeconfigRef?.credentialsDir, params.kubeconfig);
      if ("error" in kubeResult) {
        return {
          content: [{ type: "text", text: `Error: ${kubeResult.error}` }],
          details: { error: true },
        };
      }
      const env = prepareExecEnv(kubeconfigRef, kubeResult.path);

      // Validate node name
      const nodeErr = validateNodeName(params.node);
      if (nodeErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: nodeErr }, null, 2) }],
          details: { blocked: true, reason: "invalid_node_name" },
        };
      }

      // Validate command
      const cmdErr = validateCommand(params.command, { context: "node" });
      if (cmdErr) {
        return {
          content: [{ type: "text", text: cmdErr }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Check node exists and is Ready
      const nodeCheckErr = await checkNodeReady(
        params.node, env.childEnv, env.kubeconfigPath ?? undefined,
      );
      if (nodeCheckErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: nodeCheckErr }, null, 2) }],
          details: { error: true },
        };
      }

      const image = params.image || loadConfig().debugImage;
      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
      const commands = extractCommands(params.command);
      const needsShell = commands.length > 1;
      const cmdArgs = parseArgs(params.command);

      // Build nsenter command
      const nsenterCmd = needsShell
        ? ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", params.command]
        : ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", ...cmdArgs];

      const execResult = await runInDebugPod(
        { userId: userId ?? "unknown", nodeName: params.node, command: nsenterCmd, image },
        env,
        { timeoutMs: timeout, signal },
      );

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      return formatExecOutput(execResult);
    },
  };
}
