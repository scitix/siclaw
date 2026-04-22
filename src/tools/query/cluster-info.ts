import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { KubeconfigRef } from "../../core/types.js";

/**
 * cluster_info — return admin-provided infrastructure descriptions for the
 * clusters bound to the current agent.
 *
 * Data source: CredentialBroker's in-memory registry. The Map is populated
 * lazily on first call (one refresh from the gateway's CredentialService)
 * and kept fresh thereafter via notify-driven refreshes (POST
 * /api/reload-cluster from the Gateway on CRUD / binding changes).
 * The description field typically carries context that is not discoverable
 * via kubectl — RDMA/CNI/scheduler etc.
 */
export function createClusterInfoTool(kubeconfigRef: KubeconfigRef): ToolDefinition {
  return {
    name: "cluster_info",
    label: "Cluster Info",
    renderCall(_args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("cluster_info")),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Get infrastructure descriptions for Kubernetes clusters bound to this agent.
Returns cluster names and their admin-provided descriptions containing critical
infrastructure context — e.g. RDMA network type (SR-IOV/macvlan/ipvlan), GPU
scheduler (volcano/kueue), CNI plugin (calico/cilium), storage backend, etc.

Use this tool when diagnosing cluster issues to understand the infrastructure
setup. This information is NOT discoverable via kubectl — it is provided by
the cluster administrator.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Filter by cluster name (substring match)" })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as { name?: string };
      const broker = kubeconfigRef.credentialBroker;
      if (!broker) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Credential broker not initialized for this session" }) }],
          details: {},
        };
      }

      try {
        if (!broker.isClustersReady()) await broker.refreshClusters();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Failed to list clusters: ${message}` }) }],
          details: {},
        };
      }

      let clusters = broker.listClustersLocalInfo();
      if (params.name) {
        const needle = params.name.toLowerCase();
        clusters = clusters.filter((c) => c.meta.name.toLowerCase().includes(needle));
      }

      const result = clusters.map((c) => ({
        name: c.meta.name,
        infra_context: c.meta.description ?? null,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify({ clusters: result }, null, 2) }],
        details: {},
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createClusterInfoTool(refs.kubeconfigRef),
  platform: true,
};
