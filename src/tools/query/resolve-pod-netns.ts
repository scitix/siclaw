import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import {
  validatePodName,
  prepareExecEnv,
} from "../infra/exec-utils.js";
import { resolvePodNetnsViaKubectl } from "../infra/pod-netns-resolve.js";
import { resolveRequiredKubeconfig, resolveDebugImage } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";
import { loadConfig } from "../../core/config.js";

interface ResolvePodNetnsParams {
  pod: string;
  namespace?: string;
  container?: string;
  cluster?: string;
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
  node_script(node=<node>, netns=<netns>, skill="gateway-diagnostics", script="ping-gateway.sh")

This is a prerequisite for running host tools in a pod's network namespace.
The result can be reused for multiple commands on the same pod.

Parameters:
- pod: Target pod name
- namespace: Pod namespace (default: "default")
- container: Container name (for multi-container pods)
- cluster: Cluster name (from cluster_list)
- image: Debug container image (default: SICLAW_DEBUG_IMAGE)`,
    parameters: Type.Object({
      pod: Type.String({ description: "Target pod name" }),
      namespace: Type.Optional(Type.String({ description: 'Namespace (default: "default")' })),
      container: Type.Optional(Type.String({ description: "Container name (for multi-container pods)" })),
      cluster: Type.Optional(Type.String({ description: "Cluster name (from cluster_list)." })),
      image: Type.Optional(Type.String({ description: "Debug container image (default: SICLAW_DEBUG_IMAGE)" })),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as ResolvePodNetnsParams;

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "resolve_pod_netns");
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
      const pod = params.pod?.trim();
      const namespace = params.namespace?.trim() || "default";

      const podErr = validatePodName(pod);
      if (podErr) {
        return {
          content: [{ type: "text", text: `Error: ${podErr}` }],
          details: { error: true },
        };
      }

      // Resolve node (kubectl API) + netns (crictl via a privileged debug pod). Shared with the
      // one-step `pod=` path on node_exec/node_script (see pod-netns-resolve.ts).
      const clusterKey = params.cluster || "default";
      const image = params.image || resolveDebugImage({ broker: kubeconfigRef?.credentialBroker }, params.cluster) || loadConfig().debugImage;
      const resolved = await resolvePodNetnsViaKubectl({
        pod, namespace, container: params.container, env,
        userId: userId ?? "unknown", clusterKey, image, signal,
      });
      if ("error" in resolved) {
        return {
          content: [{ type: "text", text: `Error: ${resolved.error}` }],
          details: { error: true },
        };
      }

      return {
        content: [{
          type: "text",
          text: `Pod "${pod}" in namespace "${namespace}" is on node "${resolved.node}" with network namespace "${resolved.netns}".\n\nTip: you can skip this step — node_exec/node_script accept pod= directly (kubectl), and host_exec/host_script accept host=<node> + pod= (SSH). To reuse the netns across many commands:\n  node_exec: node="${resolved.node}", netns="${resolved.netns}", command="ip addr show"\n  node_script: node="${resolved.node}", netns="${resolved.netns}", skill="...", script="..."`,
        }],
        details: { node: resolved.node, netns: resolved.netns },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createResolvePodNetnsTool(refs.kubeconfigRef, refs.userId),
};
