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

/**
 * Apply a phase number (1-4) to checklist items.
 * Forward-only: items already done/skipped are not regressed.
 * Phase mapping: 1→triage, 2→hypotheses, 3→deep_search, 4→conclusion
 * (coupled to createChecklist() item order at indices 0-3).
 */
export function applyPhaseToChecklist(items: ChecklistItem[], phaseNum: number): void {
  for (let i = 0; i < items.length; i++) {
    if (i < phaseNum - 1) {
      if (items[i].status !== "done" && items[i].status !== "skipped") {
        items[i].status = "done";
      }
    } else if (i === phaseNum - 1) {
      if (items[i].status !== "done" && items[i].status !== "skipped") {
        items[i].status = "in_progress";
      }
    }
  }
}

/** Parse phase number from engine phase string (e.g. "Phase 3/4" → 3). Returns 0 if unparseable. */
export function parsePhaseNum(phaseStr: string): number {
  const m = phaseStr.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
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
 * Create the propose_hypotheses tool.
 * Non-blocking: shows hypotheses to user and immediately proceeds to deep_search.
 */
export function createProposeHypothesesTool(dpState: DpState): ToolDefinition {
  return {
    name: "propose_hypotheses",
    label: "Propose Hypotheses",
    description:
      "Present hypotheses to the user as a structured UI card. " +
      "Use this to communicate your investigation thinking and align direction before committing to deep_search. " +
      "Works both inside and outside Deep Investigation mode. " +
      "Always prefer this tool over plain-text hypotheses — it renders a proper interactive card.",
    parameters: Type.Object({
      hypotheses: Type.Array(
        Type.Object({
          id: Type.String({ description: "Hypothesis identifier: H1, H2, H3, etc." }),
          text: Type.String({
            description:
              "A specific, testable hypothesis statement (one sentence). " +
              "NOT a title, category name, or group heading. " +
              'Good: "Firewall rules blocking inter-node communication on port 6443". ' +
              'Bad: "Check cluster demo".',
          }),
          confidence: Type.Number({ description: "Prior confidence 0-100" }),
          description: Type.Optional(
            Type.String({
              description:
                "Brief explanation: why this hypothesis is plausible and how to validate it. " +
                "Include relevant technical context, affected components, and key validation commands.",
            })
          ),
        }),
        {
          description:
            "Each element is one distinct, independent hypothesis. " +
            "Do NOT include overall titles or summary items — only concrete hypotheses.",
        }
      ),
    }),
    async execute(_toolCallId, params) {
      const isDpMode = dpState.checklist !== null;
      if (!dpState.checklist) {
        // Outside DP mode — don't create a checklist, just present hypotheses
      }

      const { hypotheses: rawHypotheses } = params as {
        hypotheses: Array<{ id: string; text: string; confidence: number; description?: string }>;
      };

      // Post-validation: filter out non-hypothesis items the model sometimes includes
      const hypotheses = rawHypotheses.filter((h) => {
        const text = h.text.trim();
        // Markdown table rows / headers
        if (text.startsWith("|")) return false;
        // Meta-text about the hypotheses themselves (titles, proposal headings)
        if (/假设提案|(?:revised|proposed|updated)\s*hypothes[ei]s/i.test(text)) return false;
        return true;
      });

      const responseText = isDpMode
        ? "Hypotheses presented. In DP mode — consider waiting for user confirmation before proceeding to deep_search."
        : "Hypotheses presented to user. Decide whether to proceed based on user engagement.";

      return {
        content: [{ type: "text" as const, text: responseText }],
        details: { hypotheses },
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
      "Automatically marks ALL remaining pending phases as skipped and exits DP mode.\n" +
      "Use when: 1) User confirms triage is sufficient (MUST ask first) " +
      "2) User explicitly requests to stop/terminate.",
    parameters: Type.Object({
      reason: Type.String({
        description: 'Why ending early, e.g. "Information sufficient from triage" or "User requested termination"',
      }),
    }),
    async execute(_toolCallId, params) {
      if (!dpState.checklist) {
        return { content: [{ type: "text" as const, text: "No investigation in progress." }], details: {} };
      }
      const { reason } = params as { reason: string };
      for (const item of dpState.checklist.items) {
        if (item.status === "pending" || item.status === "in_progress") {
          item.status = "skipped";
          item.summary = reason;
        }
      }
      dpState.checklist = null;
      return {
        content: [{ type: "text" as const, text: `Investigation ended: ${reason}` }],
        details: {},
      };
    },
  };
}
