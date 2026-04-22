import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import {
  validatePodName,
  prepareExecEnv,
  resolveContainerNetns,
} from "../infra/exec-utils.js";
import { runInDebugPod } from "../infra/debug-pod.js";
import { resolveRequiredKubeconfig, resolveDebugImage } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";
import { loadConfig } from "../../core/config.js";

interface ResolvePodNetnsParams {
  pod: string;
  namespace?: string;
  container?: string;
  kubeconfig?: string;
  image?: string;
}

export function createResolvePodNetnsTool(kubeconfigRef?: KubeconfigRef, userId?: string): ToolDefinition {
  return {
    name: "resolve_pod_netns",
    label: "Resolve Pod Netns",
    renderCall(args: any, theme: any) {
      const ns = args?.namespace && args.namespace !== "default" ? `-n ${args.namespace}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("resolve_pod_netns")) +
          " " + theme.fg("accent", args?.pod || "") +
          (ns ? " " + theme.fg("muted", ns) : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Resolve a pod's network namespace name and the node it runs on.

Returns the node name and netns name so you can use them with node_exec or node_script:
  node_exec(node=<node>, netns=<netns>, command="ip addr show")
  node_script(node=<node>, netns=<netns>, skill="pod-ping-gateway", script="ping.sh")

This is a prerequisite for running host tools in a pod's network namespace.
The result can be reused for multiple commands on the same pod.

Parameters:
- pod: Target pod name
- namespace: Pod namespace (default: "default")
- container: Container name (for multi-container pods)
- kubeconfig: Credential name of the target cluster`,
    parameters: Type.Object({
      pod: Type.String({ description: "Target pod name" }),
      namespace: Type.Optional(Type.String({ description: 'Namespace (default: "default")' })),
      container: Type.Optional(Type.String({ description: "Container name (for multi-container pods)" })),
      kubeconfig: Type.Optional(Type.String({ description: "Credential name of the target cluster (from cluster_list)." })),
      image: Type.Optional(Type.String({ description: "Debug container image (default: SICLAW_DEBUG_IMAGE)" })),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as ResolvePodNetnsParams;

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.kubeconfig, "resolve_pod_netns");
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true, reason: "kubeconfig_ensure_failed" },
        };
      }

      const kubeResult = resolveRequiredKubeconfig({ broker: kubeconfigRef?.credentialBroker }, params.kubeconfig);
      if ("error" in kubeResult) {
        return {
          content: [{ type: "text", text: `Error: ${kubeResult.error}` }],
          details: { error: true },
        };
      }
      const env = prepareExecEnv(kubeconfigRef, kubeResult.path);
      const pod = params.pod?.trim();
      const namespace = params.namespace?.trim() || "default";

      const podErr = validatePodName(pod);
      if (podErr) {
        return {
          content: [{ type: "text", text: `Error: ${podErr}` }],
          details: { error: true },
        };
      }

      // Step 1: Get pod node via kubectl API (also verifies pod is Running and node is Ready)
      const netns = await resolveContainerNetns(pod, namespace, params.container, env);
      if ("error" in netns) {
        return {
          content: [{ type: "text", text: `Error: ${netns.error}` }],
          details: { error: true },
        };
      }

      // Step 2: Get netns name via crictl inspectp (pod sandbox level) on the node.
      // Network namespace is a pod-level concept (shared by all containers in the pod),
      // so we use crictl pods + crictl inspectp (sandbox), not crictl inspect (container).
      // The runtime already creates /var/run/netns/<name> — ip netns exec works directly.
      const clusterKey = params.kubeconfig || "default";
      const image = params.image || resolveDebugImage({ broker: kubeconfigRef?.credentialBroker }, params.kubeconfig) || loadConfig().debugImage;

      const innerScript = [
        // Find sandbox ID by pod name and namespace
        `SANDBOX_ID=$(crictl pods --name "^${pod}$" --namespace "${namespace}" -q 2>/dev/null | head -1)`,
        `if [ -z "$SANDBOX_ID" ]; then echo "Error: cannot find sandbox for pod ${pod} in namespace ${namespace}" >&2; exit 1; fi`,
        // Get netns path from sandbox inspect
        `NETNS_PATH=$(crictl inspectp "$SANDBOX_ID" 2>/dev/null | jq -r '.info.runtimeSpec.linux.namespaces[] | select(.type=="network") | .path')`,
        `if [ -z "$NETNS_PATH" ]; then echo "Error: cannot find network namespace for sandbox $SANDBOX_ID" >&2; exit 1; fi`,
        `basename "$NETNS_PATH"`,
      ].join("\n");

      const nsenterCmd = [
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p",
        "--", "sh", "-c", innerScript,
      ];

      const execResult = await runInDebugPod(
        { userId: userId ?? "unknown", nodeName: netns.nodeName, command: nsenterCmd, image, clusterKey },
        env,
        { timeoutMs: 30_000, signal },
      );

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { error: true },
        };
      }

      const netnsName = execResult.stdout.trim();
      if (execResult.exitCode !== 0 || !netnsName) {
        const errMsg = execResult.stderr.trim() || "Failed to resolve network namespace";
        return {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          details: { error: true },
        };
      }

      return {
        content: [{
          type: "text",
          text: `Pod "${pod}" in namespace "${namespace}" is on node "${netns.nodeName}" with network namespace "${netnsName}".\n\nTo run commands in this pod's network namespace using host tools:\n  node_exec: node="${netns.nodeName}", netns="${netnsName}", command="ip addr show"\n  node_script: node="${netns.nodeName}", netns="${netnsName}", skill="...", script="..."`,
        }],
        details: { node: netns.nodeName, netns: netnsName },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createResolvePodNetnsTool(refs.kubeconfigRef, refs.userId),
};
