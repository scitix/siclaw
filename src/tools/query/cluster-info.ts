import type { ToolEntry } from "../../core/tool-registry.js";
import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { KubeconfigRef } from "../../core/types.js";
import { loadConfig } from "../../core/config.js";

interface ManifestEntry {
  name: string;
  type: string;
  description?: string | null;
}

/**
 * Tool to retrieve cluster infrastructure descriptions.
 * Returns cluster names and their admin-provided descriptions containing
 * infrastructure context (network type, scheduler, CNI, etc.) that is
 * not discoverable via kubectl.
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
    description: `Get infrastructure descriptions for available Kubernetes clusters.
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
      const credentialsDir = kubeconfigRef.credentialsDir || path.resolve(process.cwd(), loadConfig().paths.credentialsDir);

      if (!credentialsDir) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Credentials directory not configured" }) }],
          details: {},
        };
      }

      const manifestPath = path.join(credentialsDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ clusters: [], message: "No clusters configured" }) }],
          details: {},
        };
      }

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ManifestEntry[];
        let clusters = manifest.filter((c) => c.type === "kubeconfig");

        if (params.name) {
          const needle = params.name.toLowerCase();
          clusters = clusters.filter((c) => c.name.toLowerCase().includes(needle));
        }

        const result = clusters.map((c) => ({
          name: c.name,
          infra_context: c.description ?? null,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify({ clusters: result }, null, 2) }],
          details: {},
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          details: {},
        };
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createClusterInfoTool(refs.kubeconfigRef),
  platform: true,
};
