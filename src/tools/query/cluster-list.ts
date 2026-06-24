import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import { flattenClusterMeta } from "./cluster-meta.js";
import type { KubeconfigRef } from "../../core/types.js";

/**
 * cluster_list — list and search the clusters bound to the current agent.
 * The single tool for cluster info (absorbed the former cluster_info).
 *
 * Pulls metadata from the gateway-side CredentialService through the
 * CredentialBroker. Only clusters explicitly bound via agent_clusters are
 * returned. Optional `name` filters by case-insensitive substring of the
 * cluster name. Emits admin-maintained structured `meta` when present. Does
 * NOT probe connectivity — use cluster_probe for that.
 */
export function createClusterListTool(kubeconfigRef: KubeconfigRef): ToolDefinition {
  return {
    name: "cluster_list",
    label: "Cluster List",
    renderCall(args: any, theme: any) {
      const name = args?.name ? " " + theme.fg("accent", args.name) : "";
      return new Text(theme.fg("toolTitle", theme.bold("cluster_list")) + name, 0, 0);
    },
    renderResult: renderTextResult,
    description: `List and search the Kubernetes clusters bound to this agent — the
authoritative source for which clusters exist and their admin-maintained context.
Each cluster always has \`name\` and \`is_production\`; the following appear only
when set: \`description\`, \`api_server\`, kube-context names (\`contexts\`/
\`current_context\`), and \`meta\` — structured infrastructure facts the admin
maintains that are NOT discoverable via kubectl (e.g. RDMA type, GPU scheduler,
CNI plugin, node model, storage backend), given as key→value pairs.
Pass \`name\` to narrow the list to clusters whose NAME contains that substring
(case-insensitive). This does NOT test connectivity — use \`cluster_probe\` for
reachability. Call it before any kubectl/script work to discover the available
clusters; when several remain, ask the user which to use rather than guessing.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Narrow to clusters whose name contains this substring (case-insensitive). Omit to list all bound clusters." })),
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

      // Lazy fill: pay one transport round-trip only on first access.
      // Subsequent calls serve the cached Map synchronously; the Map is
      // kept fresh by notify-driven refresh (POST /api/reload-cluster).
      if (!broker.isClustersReady()) {
        try {
          await broker.refreshClusters();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Failed to list clusters: ${message}` }) }],
            details: {},
          };
        }
      }

      let metas = broker.getClustersLocal();
      const boundTotal = metas.length;
      if (params.name) {
        const needle = params.name.toLowerCase();
        metas = metas.filter((meta) => meta.name.toLowerCase().includes(needle));
      }

      const entries = metas.map((meta) => ({
        name: meta.name,
        description: meta.description ?? null,
        api_server: meta.api_server ?? null,
        is_production: meta.is_production,
        ...(meta.contexts ? { contexts: meta.contexts } : {}),
        ...(meta.current_context ? { current_context: meta.current_context } : {}),
        ...flattenClusterMeta(meta.meta),
      }));

      let hint = "";
      if (boundTotal === 0) {
        hint = "\n\nNo clusters are bound to this agent. Ask the user to bind clusters in the Portal (Agent detail page).";
      } else if (entries.length === 0) {
        hint = `\n\nNo clusters match "${params.name}". Call cluster_list without a name to see all ${boundTotal} bound cluster(s).`;
      } else if (entries.length > 1) {
        const scope = params.name ? `match "${params.name}"` : "are bound";
        hint = `\n\nIMPORTANT: ${entries.length} clusters ${scope}. Ask the user which one to use, then set the \`cluster\` parameter (the cluster's name) on every kubectl/script tool call. Do NOT pick one yourself.`;
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ clusters: entries }, null, 2) + hint }],
        details: {},
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createClusterListTool(refs.kubeconfigRef),
};
