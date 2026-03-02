import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderTextResult } from "./tool-render.js";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { loadConfig } from "../core/config.js";

interface CredentialListParams {
  type?: string;
  name?: string;
}

/**
 * Tool to list available credentials and their metadata.
 * Reads manifest.json from the credentials directory.
 */
export function createCredentialListTool(kubeconfigRef: KubeconfigRef): ToolDefinition {
  return {
    name: "credential_list",
    label: "Credential List",
    renderCall(args: any, theme: any) {
      const filter = args?.type || args?.name || "all";
      return new Text(
        theme.fg("toolTitle", theme.bold("credential_list")) +
          " " + theme.fg("accent", filter),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `List available credentials in the current workspace.
Returns credential names, types, descriptions, file paths, and metadata (e.g. cluster URLs, SSH hosts).
Use this to discover which credentials are available before running kubectl, ssh, or API commands.

Optional filters:
- type: Filter by credential type (kubeconfig, ssh_key, ssh_password, api_token, api_basic_auth)
- name: Filter by name (substring match)`,
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Filter by credential type" })),
      name: Type.Optional(Type.String({ description: "Filter by name (substring match)" })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as CredentialListParams;
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
          content: [{ type: "text", text: JSON.stringify({ credentials: [], message: "No credentials configured for this workspace" }) }],
          details: {},
        };
      }

      try {
        let credentials = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Array<{
          name: string; type: string; description?: string | null;
          files: string[]; metadata?: Record<string, unknown>;
        }>;

        // Apply filters
        if (params.type) {
          credentials = credentials.filter((c) => c.type === params.type);
        }
        if (params.name) {
          const needle = params.name.toLowerCase();
          credentials = credentials.filter((c) => c.name.toLowerCase().includes(needle));
        }

        // Enrich with full paths
        const result = credentials.map((c) => ({
          ...c,
          files: c.files.map((f) => `${credentialsDir}/${f}`),
        }));

        return {
          content: [{ type: "text", text: JSON.stringify({ credentials: result }, null, 2) }],
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
