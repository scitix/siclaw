/**
 * Deep Investigation (DP) tools — shared types and ToolDefinition factories.
 *
 * Extracted from the pi-agent extension (deep-investigation.ts) so that
 * both pi-agent and Claude SDK brains can use the same DP tool logic.
 *
 * - Pi-agent brain: extension uses these types + its own TUI rendering
 * - SDK brain: agent-factory creates tools via the factory functions here
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { deepSearchGate } from "./deep-search/events.js";

// --- Shared types ---

export type ChecklistItemStatus = "pending" | "in_progress" | "done" | "skipped";

export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistItemStatus;
  summary?: string;
}

export interface DpChecklist {
  question: string;
  items: ChecklistItem[];
}

/**
 * Mutable DP state — shared reference between tools and the session layer.
 * For SDK brain, this lives on ManagedSession so http-server can inspect it.
 */
export interface DpState {
  enabled: boolean;
  checklist: DpChecklist | null;
}

// --- Shared helpers ---

export function createChecklist(question: string): DpChecklist {
  return {
    question,
    items: [
      { id: "triage", label: "Quick triage", status: "pending" },
      { id: "hypotheses", label: "Propose hypotheses", status: "pending" },
      { id: "deep_search", label: "Deep search validation", status: "pending" },
      { id: "conclusion", label: "Present findings", status: "pending" },
    ],
  };
}

// --- Load SKILL.md workflow (one-time, at module init) ---

const __dirname = dirname(fileURLToPath(import.meta.url));
let dpWorkflow = "";
try {
  const raw = readFileSync(resolve(__dirname, "../../skills/core/deep-investigation/SKILL.md"), "utf-8");
  dpWorkflow = raw.replace(/^---[\s\S]*?---\n*/, "").trim();
} catch { /* SKILL.md not found — workflow injection disabled */ }

export function getDpWorkflow(): string {
  return dpWorkflow;
}

export function buildActivationMessage(question: string): string {
  const parts = [`[DEEP_INVESTIGATION] User requested a deep investigation:\n\n${question}`];
  if (dpWorkflow) {
    parts.push(`\n<dp-workflow>\n${dpWorkflow}\n</dp-workflow>`);
  }
  parts.push("\nPlease begin the investigation following the workflow.");
  return parts.join("");
}

// --- Tool factories (for SDK brain) ---

/**
 * Create the manage_checklist tool.
 * Updates checklist item statuses. When conclusion is marked done,
 * automatically disables DP mode.
 */
export function createManageChecklistTool(dpState: DpState): ToolDefinition {
  return {
    name: "manage_checklist",
    label: "Manage Investigation Checklist",
    description:
      "Update checklist item status during deep investigation. " +
      "Supports batch updates in one call. Items: triage, hypotheses, deep_search, conclusion.",
    parameters: Type.Object({
      updates: Type.Array(Type.Object({
        id: Type.String({ description: "Checklist item id: triage | hypotheses | deep_search | conclusion" }),
        status: Type.Optional(Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("done"),
          Type.Literal("skipped"),
        ], { description: "New status" })),
        summary: Type.Optional(Type.String({ description: "Brief summary (1-2 sentences)" })),
      })),
    }),
    async execute(_toolCallId, params) {
      if (!dpState.enabled || !dpState.checklist) {
        return {
          content: [{ type: "text" as const, text: "Not in deep investigation mode. Use /dp to start." }],
          details: {},
        };
      }

      const { updates } = params as { updates: Array<{ id: string; status?: string; summary?: string }> };
      const results: string[] = [];

      for (const upd of updates) {
        const found = dpState.checklist.items.find((i) => i.id === upd.id);
        if (!found) {
          results.push(`update ${upd.id}: not found`);
          continue;
        }
        if (upd.status) found.status = upd.status as ChecklistItemStatus;
        if (upd.summary) found.summary = upd.summary;
        results.push(`update ${upd.id}: ${upd.status ?? "ok"}`);
      }

      // Auto-exit DP mode when conclusion is marked done
      const conclusionItem = dpState.checklist.items.find((i) => i.id === "conclusion");
      if (conclusionItem?.status === "done") {
        dpState.enabled = false;
        deepSearchGate.blocked = false;
      }

      return {
        content: [{ type: "text" as const, text: results.length > 0 ? results.join("; ") : "No operations specified." }],
        details: {},
      };
    },
  };
}

/**
 * Create the propose_hypotheses tool.
 * In SDK/gateway mode: returns "waiting for confirmation" + blocks the gate.
 */
export function createProposeHypothesesTool(dpState: DpState): ToolDefinition {
  return {
    name: "propose_hypotheses",
    label: "Propose Hypotheses",
    description:
      "Present hypotheses to the user for confirmation during deep investigation. " +
      "Call this after triage to propose 3-5 ranked hypotheses. " +
      "The tool will show the hypotheses to the user and wait for their confirmation or edits. " +
      "Only available in deep investigation mode.",
    parameters: Type.Object({
      hypotheses: Type.String({
        description:
          "Formatted hypothesis list in markdown. Each hypothesis should include: " +
          "description, validation method (skill script paths), and confidence percentage.",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!dpState.enabled || !dpState.checklist) {
        return {
          content: [{ type: "text" as const, text: "Not in deep investigation mode. Use /dp to start." }],
          details: {},
        };
      }

      const { hypotheses: hypothesesText } = params as { hypotheses: string };

      // Gateway/SDK mode — block gate, wait for user confirmation
      deepSearchGate.blocked = true;
      const userResponse = "Hypotheses submitted for user review. Please wait for the user's confirmation before continuing — do not call deep_search on your own.";

      return {
        content: [{ type: "text" as const, text: userResponse }],
        details: { hypotheses: hypothesesText, autoConfirmed: false },
      };
    },
  };
}

/**
 * Create the end_investigation tool.
 * Marks all remaining pending/in_progress items as skipped and exits DP mode.
 */
export function createEndInvestigationTool(dpState: DpState): ToolDefinition {
  return {
    name: "end_investigation",
    label: "End Investigation",
    description:
      "End the current deep investigation early with a single call. " +
      "Automatically marks ALL remaining pending phases as skipped and exits DP mode. " +
      "Do NOT manually skip phases via manage_checklist — use this tool instead.\n" +
      "Use when: 1) User confirms triage is sufficient (MUST ask first) " +
      "2) User explicitly requests to stop/terminate.",
    parameters: Type.Object({
      reason: Type.String({
        description: 'Why ending early, e.g. "Information sufficient from triage" or "User requested termination"',
      }),
    }),
    async execute(_toolCallId, params) {
      if (!dpState.enabled || !dpState.checklist) {
        return { content: [{ type: "text" as const, text: "Not in investigation mode." }], details: {} };
      }
      const { reason } = params as { reason: string };
      for (const item of dpState.checklist.items) {
        if (item.status === "pending" || item.status === "in_progress") {
          item.status = "skipped";
          item.summary = reason;
        }
      }
      dpState.enabled = false;
      deepSearchGate.blocked = false;
      return {
        content: [{ type: "text" as const, text: `Investigation ended: ${reason}` }],
        details: {},
      };
    },
  };
}
