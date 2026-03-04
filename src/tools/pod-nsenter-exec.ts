import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { renderTextResult, processToolOutput } from "./tool-render.js";
import { checkNodeReady, waitForPodDone } from "./k8s-checks.js";
import { validateCommand } from "./node-exec.js";
import { parseArgs } from "./command-sets.js";
import { validatePodName } from "./pod-exec.js";
import { loadConfig } from "../core/config.js";

const DEFAULT_IMAGE = loadConfig().debugImage;

// Valid pod name: RFC 1123 subdomain
const POD_NAME_RE = /^[a-z0-9][a-z0-9.\-]*$/;

function spawnAsync(
  cmd: string,
  args: string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
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
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          Object.assign(new Error(`exit ${code}`), { code, stdout, stderr }),
        );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function filterPodNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.match(/^pod "node-debug-.*" deleted$/))
    .join("\n")
    .trim();
}

interface PodNsenterExecParams {
  pod: string;
  namespace?: string;
  container?: string;
  command: string;
  image?: string;
  timeout_seconds?: number;
}

export function createPodNsenterExecTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
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
      image: Type.Optional(
        Type.String({
          description: `Debug container image (default: ${DEFAULT_IMAGE})`,
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
    async execute(_toolCallId, rawParams) {
      const params = rawParams as PodNsenterExecParams;
      const env = {
        ...process.env,
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

      // Validate command
      const cmdErr = validateCommand(params.command);
      if (cmdErr) {
        return {
          content: [{ type: "text", text: cmdErr }],
          details: { blocked: true, reason: "command_blocked" },
        };
      }

      // Step 1: Get pod phase + node in one call
      let nodeName: string;
      try {
        const result = await spawnAsync(
          "kubectl",
          [
            "get", "pod", pod, "-n", namespace,
            "-o", "jsonpath={.status.phase},{.spec.nodeName}",
          ],
          10_000,
          env,
        );
        const parts = result.stdout.trim().split(",");
        const phase = parts[0];
        nodeName = parts[1] || "";
        if (phase !== "Running") {
          return {
            content: [{
              type: "text",
              text: `Error: Pod "${pod}" in namespace "${namespace}" is not Running (phase: ${phase || "unknown"}). Cannot enter its network namespace.`,
            }],
            details: { error: true },
          };
        }
        if (!nodeName) {
          return {
            content: [{
              type: "text",
              text: `Error: could not determine node for pod "${pod}" in namespace "${namespace}".`,
            }],
            details: { error: true },
          };
        }
      } catch (err: any) {
        const stderr = (err.stderr?.trim() || err.message) as string;
        if (stderr.includes("not found")) {
          return {
            content: [{
              type: "text",
              text: `Error: Pod "${pod}" not found in namespace "${namespace}". Check the pod name and namespace.`,
            }],
            details: { error: true },
          };
        }
        return {
          content: [{
            type: "text",
            text: `Error: failed to get pod info: ${stderr}`,
          }],
          details: { error: true },
        };
      }

      // Check node is Ready before creating debug pod
      const nodeCheckErr = await checkNodeReady(nodeName, env);
      if (nodeCheckErr) {
        return {
          content: [{ type: "text", text: `Error: ${nodeCheckErr}` }],
          details: { error: true },
        };
      }

      // Step 2: Get the container ID
      let containerID: string;
      try {
        const jsonpathExpr = params.container?.trim()
          ? `{.status.containerStatuses[?(@.name=="${params.container.trim()}")].containerID}`
          : "{.status.containerStatuses[0].containerID}";
        const result = await spawnAsync(
          "kubectl",
          ["get", "pod", pod, "-n", namespace, "-o", `jsonpath=${jsonpathExpr}`],
          10_000,
          env,
        );
        containerID = result.stdout.trim();
        if (!containerID) {
          return {
            content: [{
              type: "text",
              text: `Error: could not determine container ID for pod "${pod}". Is the pod running?`,
            }],
            details: { error: true },
          };
        }
        // Strip the runtime prefix (e.g. "containerd://")
        const prefixIdx = containerID.indexOf("://");
        if (prefixIdx !== -1) {
          containerID = containerID.slice(prefixIdx + 3);
        }
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: `Error: failed to get container ID: ${err.stderr?.trim() || err.message}`,
          }],
          details: { error: true },
        };
      }

      // Step 3: Build debug pod with nsenter into pod's netns
      const image = params.image || DEFAULT_IMAGE;
      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
      const cmdArgs = parseArgs(params.command);

      // Escape single quotes in command args for embedding in shell script
      const escapedArgs = cmdArgs.map(a => a.replace(/'/g, "'\\''")).map(a => `'${a}'`).join(" ");

      // The inner script runs on the host via outer nsenter,
      // then uses inner nsenter to enter only the pod's network namespace.
      // unshare --mount + sysfs remount ensures /sys reflects the pod's netns.
      const innerScript = `
CONTAINER_ID="${containerID}"
PID=$(crictl inspect "$CONTAINER_ID" 2>/dev/null | jq -r ".info.pid")
if [ -z "$PID" ] || [ "$PID" = "null" ]; then
  echo "Error: cannot find PID for container $CONTAINER_ID" >&2
  exit 1
fi
unshare --mount sh -c 'nsenter -t '"$PID"' -n -- mount -t sysfs none /sys 2>/dev/null; nsenter -t '"$PID"' -n -- ${escapedArgs}'
`.trim();

      const podId = randomBytes(4).toString("hex");
      const podName = `node-debug-${podId}`;

      const overrides = JSON.stringify({
        spec: {
          nodeName,
          hostPID: true,
          hostNetwork: true,
          containers: [{
            name: podName,
            image,
            securityContext: { privileged: true },
            command: [
              "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p",
              "--", "sh", "-c", innerScript,
            ],
          }],
          restartPolicy: "Never",
        },
      });

      try {
        // Phase 1: Create pod
        await spawnAsync(
          "kubectl",
          [
            "run", podName,
            "--restart=Never",
            `--image=${image}`,
            `--overrides=${overrides}`,
          ],
          30_000,
          env,
        );

        // Phase 2: Wait for pod to reach terminal phase (Succeeded or Failed)
        try {
          await waitForPodDone(podName, timeout, env);
        } catch {
          // Timed out — still fetch logs before cleanup
        }

        // Phase 3: Fetch logs
        let stdout = "";
        let stderr = "";
        try {
          const logsResult = await spawnAsync(
            "kubectl", ["logs", podName], 10_000, env,
          );
          stdout = logsResult.stdout;
          stderr = logsResult.stderr;
        } catch (logErr: any) {
          stdout = logErr.stdout ?? "";
          stderr = logErr.stderr ?? "";
        }

        // Phase 4: Get exit code
        let exitCode: number | null = null;
        try {
          const statusResult = await spawnAsync(
            "kubectl",
            [
              "get", "pod", podName,
              "-o", "jsonpath={.status.containerStatuses[0].state.terminated.exitCode}",
            ],
            5_000,
            env,
          );
          const code = parseInt(statusResult.stdout.trim(), 10);
          if (!isNaN(code)) exitCode = code;
        } catch {
          // ignore
        }

        // Phase 5: Cleanup
        spawnAsync(
          "kubectl",
          ["delete", "pod", podName, "--force", "--grace-period=0"],
          10_000,
          env,
        ).catch(() => {});

        const filteredStderr = filterPodNoise(stderr);
        const output =
          stdout.trim() +
          (filteredStderr ? `\n\nSTDERR:\n${filteredStderr}` : "");

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
        // Cleanup on unexpected error
        spawnAsync(
          "kubectl",
          ["delete", "pod", podName, "--force", "--grace-period=0"],
          10_000,
          env,
        ).catch(() => {});
        const output = `Exit code: ${err.code ?? "unknown"}\n${err.stdout?.trim() ?? ""}\n${err.stderr?.trim() ?? err.message}`;
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode: err.code, error: true },
        };
      }
    },
  };
}
