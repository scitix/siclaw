import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { KubeconfigRef } from "../../core/types.js";

/**
 * host_list — list SSH-reachable hosts bound to the current agent.
 *
 * Pulls metadata from the gateway-side CredentialService through the
 * CredentialBroker. Only hosts explicitly bound via agent_hosts are returned.
 * Returns metadata only — no password / private_key. Connection credentials
 * are materialized on disk lazily by ensureHost when an SSH-using tool is
 * invoked (no such tool exists yet — host_list is the first host-aware tool).
 */
export function createHostListTool(kubeconfigRef: KubeconfigRef): ToolDefinition {
  return {
    name: "host_list",
    label: "Host List",
    renderCall(_args: any, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("host_list")), 0, 0);
    },
    renderResult: renderTextResult,
    description: `List SSH-reachable hosts bound to the current agent.
Returns host names, IPs, ports, usernames, auth_type ("password" or "key"), and is_production.
Does NOT return password or private_key — those are materialized to disk only when an SSH-using tool actually runs.
Use this to discover hosts that the agent can reach via SSH (for node-level diagnostics outside the K8s API).`,
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
      // kept fresh by notify-driven refresh (POST /api/reload-host).
      if (!broker.isHostsReady()) {
        try {
          await broker.refreshHosts();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Failed to list hosts: ${message}` }) }],
            details: {},
          };
        }
      }

      const entries = broker.getHostsLocal().map((meta) => ({
        name: meta.name,
        ip: meta.ip,
        port: meta.port,
        username: meta.username,
        auth_type: meta.auth_type,
        is_production: meta.is_production,
        ...(meta.description ? { description: meta.description } : {}),
      }));

      let hint = "";
      if (entries.length === 0) {
        hint = "\n\nNo hosts are bound to this agent. Ask the user to bind hosts in the Portal (Agent detail page).";
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ hosts: entries }, null, 2) + hint }],
        details: {},
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createHostListTool(refs.kubeconfigRef),
  platform: true,
};
