import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { KubeconfigRef } from "../../core/types.js";

/**
 * cluster_list — list clusters bound to the current agent.
 *
 * Pulls metadata from the gateway-side CredentialService through the
 * CredentialBroker. Only clusters explicitly bound via agent_clusters
 * are returned. Does NOT probe connectivity — use cluster_probe for that.
 */
export function createClusterListTool(kubeconfigRef: KubeconfigRef): ToolDefinition {
  return {
    name: "cluster_list",
    label: "Cluster List",
    renderCall(_args: any, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("cluster_list")), 0, 0);
    },
    renderResult: renderTextResult,
    description: `List clusters bound to the current agent.
Returns cluster names, descriptions, api_server, and kubeconfig contexts.
Does NOT test connectivity — use the \`cluster_probe\` tool for that.
Use this before running any kubectl command to discover available clusters.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams) {
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

      const entries = broker.getClustersLocal().map((meta) => ({
        name: meta.name,
        description: meta.description ?? null,
        api_server: meta.api_server ?? null,
        is_production: meta.is_production,
        ...(meta.contexts ? { contexts: meta.contexts } : {}),
        ...(meta.current_context ? { current_context: meta.current_context } : {}),
      }));

      let hint = "";
      if (entries.length === 0) {
        hint = "\n\nNo clusters are bound to this agent. Ask the user to bind clusters in the Portal (Agent detail page).";
      } else if (entries.length > 1) {
        hint = `\n\nIMPORTANT: ${entries.length} clusters available. Ask the user which one to use and pass --kubeconfig=<name> on every kubectl invocation. Do NOT pick one yourself.`;
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
  platform: true,
};
