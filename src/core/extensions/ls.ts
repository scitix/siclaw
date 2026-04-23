/**
 * /ls command — observation-only view of the current Siclaw workspace.
 *
 *   /ls              — one-screen count summary (providers / skills / mcp / creds / knowledge)
 *   /ls skills       — full skill list with one-line descriptions
 *   /ls knowledge    — full knowledge page list
 *   /ls mcp          — full MCP server list (transport + URL / command)
 *   /ls credentials  — full credential list (grouped by type)
 *   /ls agents       — available Portal agents + current scope
 *
 * All subcommands are read-only. Management still happens in Portal Web UI
 * (when snapshot is active) or via `/setup` / filesystem edits (standalone).
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { CliSnapshotAgentMeta, CliSnapshotActiveAgent } from "../../portal/cli-snapshot-api.js";
import { loadConfig } from "../config.js";
import { listCredentials } from "../../tools/infra/credential-manager.js";

export interface LsExtensionDeps {
  getLoadedSkills: () => Skill[];
  credentialsDir: string;
  knowledgeDir: string;
  activeAgentName?: string | null;
  availableAgents?: CliSnapshotAgentMeta[];
  activeAgent?: CliSnapshotActiveAgent | null;
}

export default function lsExtension(api: ExtensionAPI, deps: LsExtensionDeps): void {
  api.registerCommand("ls", {
    description: "Show current workspace snapshot. Use `/ls <skills|knowledge|mcp|credentials|agents>` for full lists.",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().toLowerCase();

      if (sub === "skills") {
        ctx.ui.notify(renderSkills(deps), "info");
        return;
      }
      if (sub === "knowledge") {
        ctx.ui.notify(renderKnowledge(deps), "info");
        return;
      }
      if (sub === "mcp" || sub === "mcp-servers") {
        ctx.ui.notify(renderMcp(), "info");
        return;
      }
      if (sub === "credentials" || sub === "creds") {
        ctx.ui.notify(await renderCredentials(deps), "info");
        return;
      }
      if (sub === "agents") {
        ctx.ui.notify(renderAgents(deps), "info");
        return;
      }
      if (sub && sub !== "") {
        ctx.ui.notify(
          `Unknown subcommand: ${sub}\nTry: skills | knowledge | mcp | credentials | agents\n(Or just /ls for the summary.)`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(renderSummary(deps), "info");
    },
  });
}

function renderSummary(deps: LsExtensionDeps): string {
  const config = loadConfig();
  const lines: string[] = [];

  if (deps.activeAgentName) {
    lines.push(`Agent       : ${deps.activeAgentName} (Portal-scoped)`);
  }

  const providerNames = Object.keys(config.providers);
  const def = config.default;
  if (providerNames.length === 0) {
    lines.push("Providers   : (none — run /setup)");
  } else {
    const marked = providerNames.map((n) => (n === def?.provider ? `${n}*` : n)).join(", ");
    lines.push(`Providers   : ${marked}${def ? `   default → ${def.modelId}` : ""}`);
  }

  lines.push(`Skills      : ${deps.getLoadedSkills().length} active      (use /ls skills to list)`);

  const mcpNames = Object.keys(config.mcpServers ?? {});
  lines.push(`MCP servers : ${mcpNames.length === 0 ? "(none)" : `${mcpNames.length} configured — ${mcpNames.join(", ")}`}${mcpNames.length > 0 ? "   (/ls mcp)" : ""}`);

  const credCount = readManifestCount(deps.credentialsDir);
  lines.push(`Credentials : ${credCount} entries${credCount > 0 ? "   (/ls credentials)" : ""}`);

  const knowledgeCount = countKnowledge(deps.knowledgeDir);
  lines.push(`Knowledge   : ${knowledgeCount} page${knowledgeCount === 1 ? "" : "s"}${knowledgeCount > 0 ? "   (/ls knowledge)" : ""}`);

  lines.push("");
  lines.push(
    "To change any of this, edit in Portal Web UI (if running) — restart TUI to pick up changes.",
  );

  return lines.join("\n");
}

function renderSkills(deps: LsExtensionDeps): string {
  const skills = deps.getLoadedSkills();
  if (skills.length === 0) return "No skills loaded.";
  const lines: string[] = [];
  lines.push(`Loaded skills (${skills.length}):`);
  lines.push("");
  const maxName = Math.min(40, Math.max(10, ...skills.map((s) => s.name.length)));
  for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const desc = (s.description || "").replace(/\s+/g, " ").trim();
    const shortDesc = desc.length > 80 ? desc.slice(0, 77) + "…" : desc;
    lines.push(`  ${s.name.padEnd(maxName)}  ${shortDesc}`);
  }
  return lines.join("\n");
}

function renderKnowledge(deps: LsExtensionDeps): string {
  if (!fs.existsSync(deps.knowledgeDir)) {
    return "No knowledge dir found.";
  }
  const files = fs
    .readdirSync(deps.knowledgeDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) return "No knowledge pages.";
  const lines: string[] = [];
  lines.push(`Knowledge pages (${files.length}):   [source: ${deps.knowledgeDir}]`);
  lines.push("");
  const maxName = Math.max(10, ...files.map((f) => f.length));
  for (const f of files) {
    const summary = firstContentLine(path.join(deps.knowledgeDir, f));
    lines.push(`  ${f.padEnd(maxName)}   ${summary}`);
  }
  return lines.join("\n");
}

function renderMcp(): string {
  const config = loadConfig();
  const entries = Object.entries(config.mcpServers ?? {});
  if (entries.length === 0) return "No MCP servers configured.";
  const lines: string[] = [];
  lines.push(`MCP servers (${entries.length}):`);
  lines.push("");
  for (const [name, cfg] of entries) {
    const c = cfg as { transport?: string; url?: string; command?: string };
    const target = c.url ?? c.command ?? "(no target)";
    lines.push(`  ${name}`);
    lines.push(`    transport: ${c.transport ?? "?"}`);
    lines.push(`    target:    ${target}`);
  }
  return lines.join("\n");
}

async function renderCredentials(deps: LsExtensionDeps): Promise<string> {
  try {
    const creds = await listCredentials(deps.credentialsDir);
    if (creds.length === 0) return "No credentials configured.";
    const lines: string[] = [];
    lines.push(`Credentials (${creds.length}):`);
    lines.push("");
    const maxName = Math.max(10, ...creds.map((c) => c.name.length));
    const maxType = Math.max(8, ...creds.map((c) => c.type.length));
    for (const c of creds) {
      const hint = c.type === "kubeconfig"
        ? (c.reachable === undefined ? "" : c.reachable ? "  (reachable)" : "  (unreachable)")
        : "";
      lines.push(`  ${c.name.padEnd(maxName)}  ${c.type.padEnd(maxType)}${hint}`);
    }
    return lines.join("\n");
  } catch (err) {
    return `Credentials dir error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderAgents(deps: LsExtensionDeps): string {
  const available = deps.availableAgents ?? [];
  const current = deps.activeAgent?.name ?? deps.activeAgentName ?? null;

  if (available.length === 0) {
    return current
      ? `Current agent: ${current}\n(Portal did not return any agent list — inconsistent state.)`
      : "No Portal agents configured — TUI is running with the global unscoped view.";
  }

  const lines: string[] = [];
  lines.push(current ? `Current: ${current}` : "Current: (unscoped — no --agent was passed)");
  lines.push("");
  lines.push("Available agents:");
  for (const a of available) {
    const marker = a.name === current ? "*" : " ";
    const model = a.modelProvider && a.modelId ? `[${a.modelProvider}/${a.modelId}]` : "";
    const desc = a.description ? ` — ${a.description}` : "";
    lines.push(`  ${marker} ${a.name} ${model}${desc}`);
  }
  lines.push("");
  lines.push("Switch: exit this session and run `siclaw --agent <name>`.");
  return lines.join("\n");
}

function readManifestCount(credentialsDir: string): number {
  try {
    const manifestPath = path.join(credentialsDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) return 0;
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")).length;
  } catch {
    return 0;
  }
}

function countKnowledge(knowledgeDir: string): number {
  if (!fs.existsSync(knowledgeDir)) return 0;
  return fs.readdirSync(knowledgeDir).filter((f) => f.endsWith(".md")).length;
}

function firstContentLine(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // Skip YAML frontmatter if present.
    let body = content;
    if (body.startsWith("---\n")) {
      const end = body.indexOf("\n---\n", 4);
      if (end >= 0) body = body.slice(end + 5);
    }
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        const header = trimmed.replace(/^#+\s*/, "");
        return header.length > 60 ? header.slice(0, 57) + "…" : header;
      }
      return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
    }
    return "(empty)";
  } catch {
    return "(read error)";
  }
}
