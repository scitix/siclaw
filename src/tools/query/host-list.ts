import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
    description: `List SSH-reachable hosts bound to the current agent (server-side search; results are capped).
Returns id, name, IP, port, username, auth_type ("password"/"key"/"managed"), is_production, and jump_host (the bastion name when the host is reached via ProxyJump — host_exec/host_script tunnel through it automatically).
Does NOT return password or private_key — those are materialized to disk only when an SSH-using tool actually runs.
Pass "query" to filter by name / IP / description (an IP-looking query matches the IP exactly); omit it to browse all bound hosts (still capped).
The response includes "total" (full match count) and "next_cursor": if total exceeds what's shown, narrow the query or page with cursor.`,
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Filter by name / IP / description (server-side; an IP-looking value matches the IP exactly). Omit to browse all bound hosts.",
      })),
      limit: Type.Optional(Type.Number({
        description: "Max results per page (default 20, max 100).",
      })),
      cursor: Type.Optional(Type.String({
        description: "Opaque pagination cursor from a previous response's next_cursor.",
      })),
    }),
    async execute(_toolCallId, rawParams) {
      const broker = kubeconfigRef.credentialBroker;
      if (!broker) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Credential broker not initialized for this session" }) }],
          details: {},
        };
      }

      const params = (rawParams ?? {}) as { query?: string; limit?: number; cursor?: string };
      const query = typeof params.query === "string" ? params.query.trim() : "";

      // Always go through the server-side search (a blank query = browse). This
      // keeps results capped and never loads the full host list into the broker.
      let result;
      try {
        result = await broker.queryHosts(query, { limit: params.limit, cursor: params.cursor });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Failed to list hosts: ${message}` }) }],
          details: {},
        };
      }

      const entries = result.hosts.map((meta) => ({
        ...(meta.id ? { id: meta.id } : {}),
        name: meta.name,
        ip: meta.ip,
        port: meta.port,
        username: meta.username,
        auth_type: meta.auth_type,
        is_production: meta.is_production,
        ...(meta.description ? { description: meta.description } : {}),
        // Surfaced so the model knows a host is reached through a bastion; the
        // jump chain is dialed automatically by host_exec / host_script.
        ...(meta.jump_host ? { jump_host: meta.jump_host } : {}),
      }));

      let hint = "";
      if (entries.length === 0) {
        hint = query
          ? `\n\nNo hosts match "${query}".`
          : "\n\nNo hosts are bound to this agent. Ask the user to bind hosts in the Portal (Agent detail page).";
      } else if (result.next_cursor) {
        hint = `\n\nShowing ${entries.length} of ${result.total}. Narrow the query, or pass cursor="${result.next_cursor}" for the next page.`;
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ hosts: entries, total: result.total, next_cursor: result.next_cursor }, null, 2) + hint }],
        details: {},
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createHostListTool(refs.kubeconfigRef),
  readOnlyDelegable: true,
};
