/**
 * /agent command — show which agent the current TUI session is running as
 * and list the other agents Portal has configured, so the user knows how
 * to switch (exit + re-run with --agent <name>).
 *
 * In-session switching is intentionally NOT implemented — re-launching with
 * a flag is simpler, matches Unix conventions (each tab / pane is its own
 * session), and avoids the complexity of rebuilding pi-agent's resource
 * loader mid-session. Multi-agent parallel use = multiple terminals.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CliSnapshotAgentMeta, CliSnapshotActiveAgent } from "../../portal/cli-snapshot-api.js";

export interface AgentExtensionDeps {
  activeAgent: CliSnapshotActiveAgent | null;
  availableAgents: CliSnapshotAgentMeta[];
  /** Base URL of the running Portal; drives the "add / edit" hint line. */
  portalUrl?: string | null;
}

export default function agentExtension(api: ExtensionAPI, deps: AgentExtensionDeps): void {
  api.registerCommand("agent", {
    description: "Show current Portal agent and list available ones (read-only).",
    handler: async (_args, ctx) => {
      const lines: string[] = [];

      if (deps.availableAgents.length === 0) {
        lines.push("No Portal agents configured.");
        lines.push("(Running with the global unscoped snapshot — all providers, skills, credentials.)");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const currentName = deps.activeAgent?.name;
      lines.push(currentName
        ? `Current : ${currentName}`
        : "Current : (unscoped — no --agent was passed)"
      );
      lines.push("");
      lines.push("Available agents:");
      for (const a of deps.availableAgents) {
        const marker = a.name === currentName ? "*" : " ";
        const desc = a.description ? ` — ${a.description}` : "";
        lines.push(`  ${marker} ${a.name}${desc}`);
      }
      lines.push("");
      lines.push("To switch: exit this session (Ctrl+D) and run `siclaw --agent <name>`.");
      lines.push("For parallel use: open another terminal and run `siclaw --agent <other-name>`.");
      if (deps.portalUrl) {
        const base = deps.portalUrl.replace(/\/$/, "");
        lines.push(`To add / edit agents: open ${base}/agents in Portal Web UI.`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
