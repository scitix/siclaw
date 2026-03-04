import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { resolveScript } from "./script-resolver.js";
import { processToolOutput, renderTextResult } from "./tool-render.js";
import { checkNodeReady } from "./k8s-checks.js";
import { loadConfig } from "../core/config.js";
import { sanitizeEnv } from "./sanitize-env.js";
import { parseArgs, shellEscape } from "./command-sets.js";

const DEFAULT_IMAGE = loadConfig().debugImage;

// Valid pod name: RFC 1123 subdomain
const POD_NAME_RE = /^[a-z0-9][a-z0-9.\-]*$/;

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
          Object.assign(new Error(`exit ${code}`), { code, stdout, stderr }),
        );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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

interface NetnsScriptParams {
  pod: string;
  namespace?: string;
  container?: string;
  skill?: string;
  script: string;
  args?: string;
  image?: string;
  timeout_seconds?: number;
}

export function createNetnsScriptTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "pod_netns_script",
    label: "Pod Netns Script",
    renderCall(args: any, theme: any) {
      const ns = args?.namespace && args.namespace !== "default" ? `-n ${args.namespace}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("pod_netns_script")) +
          " " + theme.fg("accent", args?.pod || "") +
          (ns ? " " + theme.fg("muted", ns) : "") +
          " " + theme.fg("accent", args?.node || "") +
          " " + theme.fg("muted", (args?.skill || "") + "/" + (args?.script || "")) +
          (args?.args ? " " + args.args : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute a skill or user script in a pod's network namespace using the host's tools.

Creates a privileged debug pod on the same node as the target pod, then uses double nsenter:
1. Outer nsenter: enters the host's full namespaces (to access host tools like tcpdump, ss, ip, etc.)
2. Inner nsenter: enters only the pod's network namespace (to see the pod's network interfaces, IPs, routes)

This gives the ideal environment for network diagnostics: host tools + pod's network view.

Scripts must come from a skill's scripts/ directory or from user-uploaded scripts.

Node requirements: the host must have jq and crictl installed.

Parameters:
- pod: Target pod name (the pod whose network namespace to enter)
- namespace: Namespace (default: "default")
- container: Container name (for multi-container pods, to determine which netns)
- skill: Skill name. If omitted, looks in user scripts
- script: Script filename
- args: Optional arguments to pass to the script
- image: Debug container image (default: SICLAW_DEBUG_IMAGE)
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- pod: "my-app-pod", namespace: "production", skill: "pod-network-debug", script: "capture-traffic.sh", args: "--port 8080"
- pod: "gateway-pod", script: "check-routes.sh"`,
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
      skill: Type.Optional(
        Type.String({
          description: "Skill name (omit to use user scripts)",
        }),
      ),
      script: Type.String({ description: "Script filename" }),
      args: Type.Optional(
        Type.String({ description: "Arguments to pass to the script" }),
      ),
      image: Type.Optional(
        Type.String({
          description: `Debug container image (default: ${DEFAULT_IMAGE})`,
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as NetnsScriptParams;
      const env = {
        ...sanitizeEnv(process.env as Record<string, string>),
        ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
        KUBECONFIG: "/dev/null",
      };
      const pod = params.pod?.trim();
      const namespace = params.namespace?.trim() || "default";

      if (!pod || !POD_NAME_RE.test(pod)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid pod name "${pod}". Pod names may only contain lowercase letters, digits, hyphens, and dots.`,
            },
          ],
          details: { error: true },
        };
      }

      // Resolve script
      const resolved = resolveScript({
        skill: params.skill,
        script: params.script,
      });
      if ("error" in resolved) {
        return {
          content: [{ type: "text", text: `Error: ${resolved.error}` }],
          details: { error: true },
        };
      }

      const image = params.image || DEFAULT_IMAGE;
      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;
      const args = params.args?.trim() || "";

      // Step 1: Get pod phase + node in one call
      let nodeName: string;
      try {
        const result = await spawnAsync(
          "kubectl",
          [
            "get",
            "pod",
            pod,
            "-n",
            namespace,
            "-o",
            "jsonpath={.status.phase},{.spec.nodeName}",
          ],
          10_000,
          env,
        );
        const parts = result.stdout.trim().split(",");
        const phase = parts[0];
        nodeName = parts[1] || "";
        if (phase !== "Running") {
          return {
            content: [
              {
                type: "text",
                text: `Error: Pod "${pod}" in namespace "${namespace}" is not Running (phase: ${phase || "unknown"}). Cannot enter its network namespace.`,
              },
            ],
            details: { error: true },
          };
        }
        if (!nodeName) {
          return {
            content: [
              {
                type: "text",
                text: `Error: could not determine node for pod "${pod}" in namespace "${namespace}".`,
              },
            ],
            details: { error: true },
          };
        }
      } catch (err: any) {
        const stderr = (err.stderr?.trim() || err.message) as string;
        if (stderr.includes("not found")) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Pod "${pod}" not found in namespace "${namespace}". Check the pod name and namespace.`,
              },
            ],
            details: { error: true },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Error: failed to get pod info: ${stderr}`,
            },
          ],
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
            content: [
              {
                type: "text",
                text: `Error: could not determine container ID for pod "${pod}". Is the pod running?`,
              },
            ],
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
          content: [
            {
              type: "text",
              text: `Error: failed to get container ID: ${err.stderr?.trim() || err.message}`,
            },
          ],
          details: { error: true },
        };
      }

      // Step 3: Build debug pod with double nsenter
      const b64 = Buffer.from(resolved.content).toString("base64");
      const ext = resolved.interpreter === "python3" ? ".py" : ".sh";
      // Security: shell-escape each argument to prevent injection via args parameter
      const escapedArgs = args ? parseArgs(args).map(shellEscape).join(" ") : "";
      const scriptArgs = escapedArgs ? ` ${escapedArgs}` : "";

      // The inner script that runs inside nsenter on the host.
      // Uses unshare --mount + sysfs remount so that /sys reflects the pod's
      // network namespace (sysfs is mount-namespace-dependent, not netns-dependent).
      const innerScript = `
CONTAINER_ID="${containerID}"
PID=$(crictl inspect "$CONTAINER_ID" 2>/dev/null | jq -r ".info.pid")
if [ -z "$PID" ] || [ "$PID" = "null" ]; then
  echo "Error: cannot find PID for container $CONTAINER_ID" >&2
  exit 1
fi
echo '${b64}' | base64 -d > /tmp/_s${ext}
unshare --mount nsenter -t "$PID" -n -- sh -c 'mount -t sysfs none /sys 2>/dev/null; ${resolved.interpreter} /tmp/_s${ext}${scriptArgs}'
`.trim();

      const podId = randomBytes(4).toString("hex");
      const podName = `node-debug-${podId}`;

      const cleanup = () => {
        spawnAsync(
          "kubectl",
          ["delete", "pod", podName, "--force", "--grace-period=0"],
          10_000,
          env,
        ).catch(() => {});
      };

      const overrides = JSON.stringify({
        spec: {
          nodeName: nodeName,
          hostPID: true,
          hostNetwork: true,
          containers: [
            {
              name: podName,
              image,
              securityContext: { privileged: true },
              command: [
                "nsenter",
                "-t",
                "1",
                "-m",
                "-u",
                "-i",
                "-n",
                "-p",
                "--",
                "sh",
                "-c",
                innerScript,
              ],
            },
          ],
          restartPolicy: "Never",
        },
      });

      try {
        // Phase 1: Create pod
        await spawnAsync(
          "kubectl",
          [
            "run",
            podName,
            "--restart=Never",
            `--image=${image}`,
            `--overrides=${overrides}`,
          ],
          30_000,
          env,
          signal,
        );

        // Phase 2: Wait for pod to complete
        const waitTimeout = Math.ceil(timeout / 1000);
        try {
          await spawnAsync(
            "kubectl",
            [
              "wait",
              `--for=jsonpath={.status.phase}=Succeeded`,
              `pod/${podName}`,
              `--timeout=${waitTimeout}s`,
            ],
            timeout + 5_000,
            env,
            signal,
          );
        } catch {
          // Pod may have failed — still fetch logs
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
          const logsResult = await spawnAsync(
            "kubectl",
            ["logs", podName],
            10_000,
            env,
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
              "get",
              "pod",
              podName,
              "-o",
              "jsonpath={.status.containerStatuses[0].state.terminated.exitCode}",
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
        cleanup();

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
