import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { renderTextResult, processToolOutput } from "./tool-render.js";
import { checkNodeReady, waitForPodDone } from "./k8s-checks.js";
import { loadConfig } from "../core/config.js";
import {
  ALLOWED_COMMANDS,
  parseArgs,
  getCommandBinary,
  validateCommandRestrictions,
} from "./command-sets.js";
import { validateShellOperators, extractCommands } from "./restricted-bash.js";

function spawnAsync(
  cmd: string,
  args: string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          Object.assign(new Error(`exit ${code}`), { code, stdout, stderr })
        );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

const DEFAULT_IMAGE = loadConfig().debugImage;

// Re-export shared ALLOWED_COMMANDS for backward compatibility
export { ALLOWED_COMMANDS } from "./command-sets.js";

// Valid node name: alphanumeric, hyphens, dots only
const NODE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]*$/;

/**
 * Validate a Kubernetes node name.
 * Returns an error message if invalid, or null if valid.
 */
export function validateNodeName(node: string): string | null {
  if (!node || !node.trim()) {
    return "Node name must not be empty.";
  }
  if (!NODE_NAME_RE.test(node)) {
    return `Invalid node name "${node}". Node names may only contain letters, digits, hyphens, and dots.`;
  }
  return null;
}

/**
 * Validate a command intended for node-exec.
 * Uses the same validation pipeline as restricted-bash:
 * 1. validateShellOperators — blocks dangerous shell constructs
 * 2. extractCommands — splits pipelines
 * 3. Per-command: whitelist check + validateCommandRestrictions
 * Returns an error message if blocked, or null if allowed.
 */
export function validateCommand(command: string): string | null {
  if (!command || !command.trim()) {
    return "Command must not be empty.";
  }

  // Block dangerous shell operators ($(), backticks, redirections, process substitution)
  const shellOpErr = validateShellOperators(command);
  if (shellOpErr) return shellOpErr;

  // Split pipelines (|, &&, ;, ||) and validate each sub-command
  const commands = extractCommands(command);
  if (commands.length === 0) {
    return "Command must not be empty.";
  }

  for (const cmd of commands) {
    const baseName = getCommandBinary(cmd);
    if (!baseName) continue;

    if (!ALLOWED_COMMANDS.has(baseName)) {
      return JSON.stringify(
        {
          error: `Command "${baseName}" is not in the allowed command list.`,
          allowed_categories: {
            network: "ip, ifconfig, ping, traceroute, tracepath, ss, netstat, route, arp, ethtool, mtr, bridge, tc, conntrack, nslookup, dig, host, curl",
            rdma: "ibstat, ibstatus, ibv_devinfo, ibv_devices, rdma, ibaddr, iblinkinfo, ibportstate, ibswitches, ibroute, show_gids, ibdev2netdev",
            perftest: "ib_write_bw, ib_write_lat, ib_read_bw, ib_read_lat, ib_send_bw, ib_send_lat, ib_atomic_bw, ib_atomic_lat, raw_ethernet_bw, raw_ethernet_lat, raw_ethernet_burst_lat",
            gpu: "nvidia-smi, gpustat, nvtopo",
            hardware: "lspci, lsusb, lsblk, lscpu, lsmem, lshw, dmidecode",
            kernel: "uname, hostname, uptime, dmesg, sysctl, lsmod, modinfo",
            process: "ps, pgrep, top, free, vmstat, iostat, mpstat, df, du, mount, findmnt, nproc",
            file: "cat, ls, pwd, stat, file, find, readlink, realpath, basename, dirname, diff, md5sum, sha256sum",
            general: "date, whoami, id, env, printenv, which",
          },
        },
        null,
        2
      );
    }

    // Apply unified command-level restrictions (find -exec, sysctl -w, curl -o, etc.)
    const restrictionErr = validateCommandRestrictions(cmd);
    if (restrictionErr) return restrictionErr;
  }

  return null;
}

interface NodeExecParams {
  node: string;
  command: string;
  image?: string;
  timeout_seconds?: number;
}

export function createNodeExecTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
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
      image: Type.Optional(
        Type.String({
          description: `Debug container image (default: ${DEFAULT_IMAGE})`,
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
      const childEnv = {
        ...process.env,
        ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
        KUBECONFIG: "/dev/null",
      };

      // Validate node name
      const nodeErr = validateNodeName(params.node);
      if (nodeErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: nodeErr }, null, 2) }],
          details: { blocked: true, reason: "invalid_node_name" },
        };
      }

      // Validate command
      const cmdErr = validateCommand(params.command);
      if (cmdErr) {
        return {
          content: [{ type: "text", text: cmdErr }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Check node exists and is Ready (after all local validation passes)
      const nodeCheckErr = await checkNodeReady(params.node, childEnv);
      if (nodeCheckErr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: nodeCheckErr }, null, 2) }],
          details: { error: true },
        };
      }

      const image = params.image || DEFAULT_IMAGE;
      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
      const commands = extractCommands(params.command);
      const needsShell = commands.length > 1;
      const cmdArgs = parseArgs(params.command);

      // Generate a unique pod name
      const podId = randomBytes(4).toString("hex");
      const podName = `node-debug-${podId}`;

      const cleanup = () => {
        spawnAsync("kubectl", [
          "delete", "pod", podName, "--force", "--grace-period=0",
        ], 10_000, childEnv).catch(() => {});
      };

      // Build overrides: privileged + hostPID + hostNetwork + nsenter
      // Single command: pass args directly (no shell overhead)
      // Pipeline: wrap in sh -c for shell interpretation
      const nsenterCmd = needsShell
        ? ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", params.command]
        : ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", ...cmdArgs];
      const overrides = JSON.stringify({
        spec: {
          nodeName: params.node,
          hostPID: true,
          hostNetwork: true,
          containers: [{
            name: podName,
            image,
            securityContext: { privileged: true },
            command: nsenterCmd,
          }],
        },
      });

      try {
        // Phase 1: Create pod
        await spawnAsync("kubectl", [
          "run", podName,
          "--restart=Never",
          `--image=${image}`,
          `--overrides=${overrides}`,
        ], 30_000, childEnv, signal);

        // Phase 2: Wait for pod to reach terminal phase (Succeeded or Failed)
        try {
          await waitForPodDone(podName, timeout, childEnv, signal);
        } catch {
          // Timed out — still fetch logs before cleanup
        }

        if (signal?.aborted) {
          cleanup();
          return {
            content: [{ type: "text", text: "Aborted." }],
            details: { error: true },
          };
        }

        // Phase 3: Fetch logs
        let stdout = "";
        let stderr = "";
        try {
          const logsResult = await spawnAsync("kubectl", [
            "logs", podName,
          ], 10_000, childEnv);
          stdout = logsResult.stdout;
          stderr = logsResult.stderr;
        } catch (logErr: any) {
          stdout = logErr.stdout ?? "";
          stderr = logErr.stderr ?? "";
        }

        // Phase 4: Get exit code from pod status
        let exitCode: number | null = null;
        try {
          const statusResult = await spawnAsync("kubectl", [
            "get", "pod", podName,
            "-o", "jsonpath={.status.containerStatuses[0].state.terminated.exitCode}",
          ], 5_000, childEnv);
          const code = parseInt(statusResult.stdout.trim(), 10);
          if (!isNaN(code)) exitCode = code;
        } catch {
          // ignore — exitCode stays null
        }

        // Phase 5: Cleanup
        cleanup();

        const filteredStderr = filterPodNoise(stderr);
        const output = stdout.trim() + (filteredStderr ? `\n\nSTDERR:\n${filteredStderr}` : "");

        if (exitCode === 0 || (exitCode === null && stdout.trim())) {
          return {
            content: [{ type: "text", text: processToolOutput(output) }],
            details: { exitCode: exitCode ?? 0 },
          };
        } else {
          const errOutput = `Exit code: ${exitCode ?? "unknown"}\n${output}`;
          return {
            content: [{ type: "text", text: processToolOutput(errOutput) }],
            details: { exitCode, error: true },
          };
        }
      } catch (err: any) {
        cleanup();
        const output = `Exit code: ${err.code ?? "unknown"}\n${err.stdout?.trim() ?? ""}\n${err.stderr?.trim() ?? err.message}`;
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode: err.code, error: true },
        };
      }
    },
  };
}

/**
 * Filter out kubectl run informational lines from stderr
 * (e.g. 'pod "node-debug-xxx" deleted').
 */
function filterPodNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.match(/^pod "node-debug-.*" deleted$/))
    .join("\n")
    .trim();
}
