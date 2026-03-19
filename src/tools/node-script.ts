import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { checkNodeReady } from "./k8s-checks.js";
import { resolveScript } from "./script-resolver.js";
import { renderTextResult } from "./tool-render.js";
import { loadConfig } from "../core/config.js";
import { parseArgs, shellEscape } from "./command-sets.js";
import {
  validateNodeName,
  prepareExecEnv,
  formatExecOutput,
} from "./exec-utils.js";
import { runInDebugPod } from "./debug-pod.js";
import { resolveRequiredKubeconfig } from "./kubeconfig-resolver.js";

interface NodeScriptParams {
  node: string;
  skill?: string;
  script: string;
  args?: string;
  kubeconfig?: string;
  image?: string;
  timeout_seconds?: number;
}

export function createNodeScriptTool(kubeconfigRef?: KubeconfigRef, userId?: string): ToolDefinition {
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
          description: "Timeout in seconds (default: 180, max: 300)",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as NodeScriptParams;

      const kubeResult = resolveRequiredKubeconfig(kubeconfigRef?.credentialsDir, params.kubeconfig);
      if ("error" in kubeResult) {
        return {
          content: [{ type: "text", text: `Error: ${kubeResult.error}` }],
          details: { error: true },
        };
      }
      const env = prepareExecEnv(kubeconfigRef, kubeResult.path);

      // Validate node name format
      const nodeErr = validateNodeName(params.node);
      if (nodeErr) {
        return {
          content: [{ type: "text", text: `Error: ${nodeErr}` }],
          details: { error: true },
        };
      }

      // Check node exists and is Ready
      const nodeCheckErr = await checkNodeReady(
        params.node, env.childEnv, env.kubeconfigPath ?? undefined,
      );
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

      const image = params.image || loadConfig().debugImage;
      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;
      const args = params.args?.trim() || "";
      // Security: shell-escape each argument to prevent injection via args parameter
      const escapedArgs = args ? parseArgs(args).map(shellEscape).join(" ") : "";

      // Base64 encode script content
      const b64 = Buffer.from(resolved.content).toString("base64");

      // Build the command that runs inside nsenter
      const ext = resolved.interpreter === "python3" ? ".py" : ".sh";
      const innerCmd = escapedArgs
        ? `echo '${b64}' | base64 -d > /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext} ${escapedArgs}`
        : `echo '${b64}' | base64 -d > /tmp/_s${ext} && ${resolved.interpreter} /tmp/_s${ext}`;

      const nsenterCmd = [
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p",
        "--", "sh", "-c", innerCmd,
      ];

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
