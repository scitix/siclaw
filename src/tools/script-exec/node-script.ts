import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/agent-factory.js";
import { checkNodeReady } from "../infra/k8s-checks.js";
import { resolveScript } from "../infra/script-resolver.js";
import { renderTextResult } from "../infra/tool-render.js";
import { loadConfig } from "../../core/config.js";
import { parseArgs, shellEscape } from "../infra/command-sets.js";
import {
  validateNodeName,
  prepareExecEnv,
  filterPodNoise,
  stdinExecCmd,
} from "../infra/exec-utils.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { runInDebugPod } from "../infra/debug-pod.js";
import { resolveRequiredKubeconfig, resolveDebugImage } from "../infra/kubeconfig-resolver.js";

interface NodeScriptParams {
  node: string;
  skill?: string;
  script: string;
  args?: string;
  netns?: string;
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
- node: "node-1", script: "my-check.sh"
- node: "node-1", netns: "abc123", skill: "pod-ping-gateway", script: "ping.sh", args: "--interface net1"`,
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
      netns: Type.Optional(
        Type.String({
          description: 'Network namespace name (from resolve_pod_netns). When set, script runs inside that netns via "ip netns exec".',
        }),
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

      const clusterKey = params.kubeconfig || "default";
      const image = params.image || resolveDebugImage(kubeconfigRef?.credentialsDir, params.kubeconfig) || loadConfig().debugImage;
      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;
      const args = params.args?.trim() || "";
      // Security: shell-escape each argument to prevent injection via args parameter
      const escapedArgs = args ? parseArgs(args).map(shellEscape).join(" ") : "";

      // Validate netns name if provided (prevent shell injection)
      const netns = params.netns?.trim();
      if (netns && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(netns)) {
        return {
          content: [{ type: "text", text: `Error: invalid netns name "${netns}". Must be alphanumeric, dashes, underscores (max 64 chars).` }],
          details: { error: true },
        };
      }

      // Build the command that runs inside nsenter — pipe script via stdin.
      // When netns is specified, wrap with "ip netns exec" for pod network namespace.
      const baseCmd = stdinExecCmd(resolved.interpreter, escapedArgs || undefined);
      const innerCmd = netns
        ? `ip netns exec ${netns} ${baseCmd}`
        : baseCmd;

      const nsenterCmd = [
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p",
        "--", "sh", "-c", innerCmd,
      ];

      const execResult = await runInDebugPod(
        { userId: userId ?? "unknown", nodeName: params.node, command: nsenterCmd, image, clusterKey, stdinData: resolved.content },
        env,
        { timeoutMs: timeout, signal },
      );

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      const filteredStderr = filterPodNoise(execResult.stderr);
      const isError = execResult.exitCode !== 0 &&
        !(execResult.exitCode === null && execResult.stdout.trim());
      const stdout = isError
        ? `Exit code: ${execResult.exitCode ?? "unknown"}\n${execResult.stdout.trim()}`
        : execResult.stdout.trim();
      return {
        content: [{ type: "text", text: postExecSecurity(stdout, null, { stderr: filteredStderr || undefined }) }],
        details: { exitCode: execResult.exitCode ?? 0, ...(isError && { error: true }) },
      };
    },
  };
}
