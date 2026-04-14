import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { KubeconfigRef } from "../../core/types.js";

interface ClusterProbeParams {
  name: string;
}

/**
 * cluster_probe — actively test connectivity to one bound cluster.
 *
 * Bypasses the broker's TTL cache (forces a fresh acquire) and runs
 * `kubectl version` against the resulting kubeconfig. Returns reachable
 * status and server version, or an error if unreachable.
 */
export function createClusterProbeTool(kubeconfigRef: KubeconfigRef): ToolDefinition {
  return {
    name: "cluster_probe",
    label: "Cluster Probe",
    renderCall(args: any, theme: any) {
      const name = args?.name ?? "";
      return new Text(
        theme.fg("toolTitle", theme.bold("cluster_probe")) + " " + theme.fg("accent", name),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Probe connectivity to a single cluster by name.
Forces a fresh credential acquire (bypasses cache) and runs \`kubectl version\`.
Returns { name, reachable, server_version?, probe_error? }.`,
    parameters: Type.Object({
      name: Type.String({ description: "Cluster name (from cluster_list)" }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ClusterProbeParams;
      if (!params.name) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "name is required" }) }],
          details: {},
        };
      }

      const broker = kubeconfigRef.credentialBroker;
      if (!broker) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Credential broker not initialized for this session" }) }],
          details: {},
        };
      }

      const result = await broker.probe(params.name);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createClusterProbeTool(refs.kubeconfigRef),
  platform: true,
};
