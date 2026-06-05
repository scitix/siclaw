import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
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
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";

interface NodeScriptParams {
  node: string;
  skill?: string;
  script: string;
  args?: string;
  netns?: string;
  cluster?: string;
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

PREFER host_script when the node is reachable via SSH (check host_list by the node's IP or name): SSH runs the script with NO debug pod. Use node_script when the node is NOT a bound SSH host, or when the script needs pod-namespace access (e.g. a pod's netns) that only the debug pod provides.

The script runs in the host's full namespaces (mount, UTS, IPC, network, PID) — it has access to the host's tools, filesystem, devices, /proc, /sys, and /dev.

Use this for complex node-level diagnostics that need scripts (pipes, loops, functions), not just single commands.
For single commands, use node_exec instead.

Scripts must come from a skill's scripts/ directory or from user-uploaded scripts. Read the skill's SKILL.md first for the exact script name, arguments, and usage — don't guess the filename.

Parameters:
- node: Target Kubernetes node name
- skill: Skill name (e.g. "node-logs"). If omitted, looks in user scripts
- script: Script filename (e.g. "get-node-logs.sh")
- args: Optional arguments to pass to the script
- netns: Optional network namespace id to enter a pod's netns on the node (from resolve_pod_netns)
- cluster: Cluster name (from cluster_list); omit to use the default cluster when only one is available
- image: Debug container image (default: SICLAW_DEBUG_IMAGE)
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- node: "node-1", skill: "node-logs", script: "get-node-logs.sh", args: "--lines 100"
- node: "node-1", script: "my-check.sh"
- node: "node-1", netns: "abc123", skill: "gateway-diagnostics", script: "ping-gateway.sh", args: "--interface net1"`,
    parameters: Type.Object({
      node: Type.String({ description: "Kubernetes node name" }),
      skill: Type.Optional(
        Type.String({
          description: "Skill name (omit to use user scripts)",
        }),
      ),
      script: Type.String({ description: "Exact script filename from the skill's scripts/ directory, as listed in its SKILL.md. Use it verbatim — do not guess or modify the name." }),
      args: Type.Optional(
        Type.String({ description: "Arguments to pass to the script" }),
      ),
      netns: Type.Optional(
        Type.String({
          description: 'Network namespace name (from resolve_pod_netns). When set, script runs inside that netns via "ip netns exec".',
        }),
      ),
      cluster: Type.Optional(
        Type.String({
          description: "Cluster name (from cluster_list). If omitted, uses the default cluster when only one is available.",
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

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "node_script");
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true, reason: "kubeconfig_ensure_failed" },
        };
      }

      const kubeResult = resolveRequiredKubeconfig({ broker: kubeconfigRef?.credentialBroker }, params.cluster);
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

      const clusterKey = params.cluster || "default";
      const image = params.image || resolveDebugImage({ broker: kubeconfigRef?.credentialBroker }, params.cluster) || loadConfig().debugImage;
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
      const out = execResult.stdout.trim();
      const stdout = isError
        ? `${out || "(no output)"}\n[exit code: ${execResult.exitCode ?? "unknown"}]`
        : out;
      return {
        content: [{ type: "text", text: postExecSecurity(stdout, null, { stderr: filteredStderr || undefined }) }],
        details: { exitCode: execResult.exitCode ?? 0, ...(isError && { error: true }) },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) => createNodeScriptTool(refs.kubeconfigRef, refs.userId),
};
