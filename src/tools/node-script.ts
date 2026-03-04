import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { validateNodeName } from "./node-exec.js";
import { checkNodeReady, waitForPodDone } from "./k8s-checks.js";
import { resolveScript } from "./script-resolver.js";
import { processToolOutput, renderTextResult } from "./tool-render.js";
import { loadConfig } from "../core/config.js";

const DEFAULT_IMAGE = loadConfig().debugImage;

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

interface NodeScriptParams {
  node: string;
  skill?: string;
  script: string;
  args?: string;
  image?: string;
  timeout_seconds?: number;
}

export function createNodeScriptTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "node_script",
    label: "Node Script",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("node_script")) +
          " " + theme.fg("accent", args?.node || "") +
          " " + theme.fg("muted", (args?.skill || "") + "/" + (args?.script || "")) +
          (args?.args ? " " + args.args : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute a skill or user script on a Kubernetes node via a privileged debug pod with nsenter.

The script runs in the host's full namespaces (mount, UTS, IPC, network, PID) — it has access to the host's tools, filesystem, devices, /proc, /sys, and /dev.

Use this for complex node-level diagnostics that need scripts (pipes, loops, functions), not just single commands.
For single commands, use node_exec instead.

Scripts must come from a skill's scripts/ directory or from user-uploaded scripts.

Parameters:
- node: Target Kubernetes node name
- skill: Skill name (e.g. "node-logs"). If omitted, looks in user scripts
- script: Script filename (e.g. "get-node-logs.sh")
- args: Optional arguments to pass to the script
- image: Debug container image (default: SICLAW_DEBUG_IMAGE)
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- node: "node-1", skill: "node-logs", script: "get-node-logs.sh", args: "--lines 100"
- node: "node-1", script: "my-check.sh"`,
    parameters: Type.Object({
      node: Type.String({ description: "Kubernetes node name" }),
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
      const params = rawParams as NodeScriptParams;
      const env = {
        ...process.env,
        ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
        KUBECONFIG: "/dev/null",
      };

      // Validate node name format
      const nodeErr = validateNodeName(params.node);
      if (nodeErr) {
        return {
          content: [{ type: "text", text: `Error: ${nodeErr}` }],
          details: { error: true },
        };
      }

      // Check node exists and is Ready
      const nodeCheckErr = await checkNodeReady(params.node, env);
      if (nodeCheckErr) {
        return {
          content: [{ type: "text", text: `Error: ${nodeCheckErr}` }],
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

      // Base64 encode script content
      const b64 = Buffer.from(resolved.content).toString("base64");

      // Build the command that runs inside nsenter
      const ext = resolved.interpreter === "python3" ? ".py" : ".sh";
      const innerCmd = args
        ? `echo '${b64}' | base64 -d > /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext} ${args}`
        : `echo '${b64}' | base64 -d > /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext}`;

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
          nodeName: params.node,
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
                innerCmd,
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

        // Phase 2: Wait for pod to reach terminal phase (Succeeded or Failed)
        try {
          await waitForPodDone(podName, timeout, env, signal);
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
