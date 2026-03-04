import { execFile } from "node:child_process";
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

interface CredentialEntry {
  name: string;
  type: string;
  description?: string | null;
  files: string[];
  metadata?: Record<string, unknown>;
  reachable?: boolean;
  server_version?: string;
  probe_error?: string;
}

/** Probe a kubeconfig with `kubectl version` (3s timeout, parallel-safe). */
function probeKubeconfig(kubeconfigPath: string): Promise<{ reachable: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      "kubectl",
      ["version", "--output=json", `--kubeconfig=${kubeconfigPath}`, "--request-timeout=3s"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          const msg = err.message?.includes("timed out")
            ? "connection timeout"
            : err.message?.split("\n")[0] ?? "unknown error";
          resolve({ reachable: false, error: msg });
          return;
        }
        try {
          const info = JSON.parse(stdout);
          const ver = info.serverVersion?.gitVersion ?? "unknown";
          resolve({ reachable: true, version: ver });
        } catch {
          resolve({ reachable: true, version: "unknown" });
        }
      },
    );
  });
}

/**
 * Tool to list available credentials and their metadata.
 * Reads manifest.json from the credentials directory.
 * Probes kubeconfig connectivity in parallel before returning.
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
Returns credential names, types, descriptions, and connectivity status.
For kubeconfig credentials, a connectivity probe is included.
Use this to discover which credentials are available before running kubectl commands.

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
        let credentials = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CredentialEntry[];

        // Apply filters
        if (params.type) {
          credentials = credentials.filter((c) => c.type === params.type);
        }
        if (params.name) {
          const needle = params.name.toLowerCase();
          credentials = credentials.filter((c) => c.name.toLowerCase().includes(needle));
        }

        // Internal enrichment: resolve full paths for probing (NOT returned to model)
        const enriched: CredentialEntry[] = credentials.map((c) => ({
          ...c,
          files: c.files.map((f) => `${credentialsDir}/${f}`),
        }));

        // Probe kubeconfig connectivity in parallel
        const kubeconfigs = enriched.filter((c) => c.type === "kubeconfig");
        if (kubeconfigs.length > 0) {
          const probes = await Promise.all(
            kubeconfigs.map(async (c) => {
              const kubeconfigFile = c.files.find((f) => f.endsWith(".kubeconfig")) ?? c.files[0];
              return { name: c.name, probe: await probeKubeconfig(kubeconfigFile) };
            }),
          );
          for (const { name, probe } of probes) {
            const cred = enriched.find((c) => c.name === name);
            if (cred) {
              cred.reachable = probe.reachable;
              if (probe.version) cred.server_version = probe.version;
              if (probe.error) cred.probe_error = probe.error;
            }
          }
        }

        // Map to safe return structure — strip files[], metadata, and other sensitive fields
        const safeResult = enriched.map((c) => ({
          name: c.name,
          type: c.type,
          description: c.description ?? null,
          ...(c.reachable !== undefined ? { reachable: c.reachable } : {}),
          ...(c.server_version ? { server_version: c.server_version } : {}),
          ...(c.probe_error ? { probe_error: c.probe_error } : {}),
        }));

        // Build selection hint for the agent
        const reachableKubeconfigs = kubeconfigs.filter((c) => c.reachable);
        let hint = "";
        if (kubeconfigs.length > 1) {
          hint = `\n\nIMPORTANT: ${kubeconfigs.length} kubeconfigs found, ${reachableKubeconfigs.length} reachable. Ask the user which one to use BEFORE running any kubectl command. Do NOT pick one yourself.`;
        } else if (kubeconfigs.length === 1 && !kubeconfigs[0].reachable) {
          hint = `\n\nWARNING: The only kubeconfig (${kubeconfigs[0].name}) is unreachable: ${kubeconfigs[0].probe_error}. Inform the user.`;
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ credentials: safeResult }, null, 2) + hint }],
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
