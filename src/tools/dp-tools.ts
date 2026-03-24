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

// --- DP lifecycle status ---

export type DpStatus =
  | "idle"                    // No investigation active
  | "investigating"           // Model is triaging / gathering context
  | "awaiting_confirmation"   // Hypotheses presented, waiting for user decision
  | "validating"              // User confirmed — deep_search executing Phase 3
  | "concluding"              // Phase 4 or user skipped validation — model presenting conclusion
  | "completed";              // Investigation finished

export interface DpHypothesis {
  id: string;
  text: string;
  confidence: number;
  description?: string;
}

/**
 * Mutable DP state — shared reference between tools and the session layer.
 * For SDK brain, this lives on ManagedSession so http-server can inspect it.
 *
 * This is the explicit state machine for the DP lifecycle.
 * Status drives checklist rendering, tool gating, and frontend sync.
 */
export interface DpState {
  checklist: DpChecklist | null;
  status: DpStatus;
  /** The investigation question. */
  question?: string;
  /** Triage context draft — saved by propose_hypotheses, used by deep_search. */
  triageContextDraft?: string;
  /** Hypotheses draft — saved by propose_hypotheses, pending user confirmation. */
  hypothesesDraft?: DpHypothesis[];
  /** Confirmed hypotheses — promoted from draft when user approves. Source of truth for deep_search. */
  confirmedHypotheses?: DpHypothesis[];
  /** Number of propose_hypotheses rounds completed. */
  round: number;
  /** Last user feedback when they requested adjustments. */
  lastUserFeedback?: string;
}

/** Create a fresh DpState in idle. */
export function createDpState(): DpState {
  return { checklist: null, status: "idle", round: 0 };
}

/**
 * Read-only ref for tools that need to inspect DP state without mutating it.
 * Used by deep_search to gate execution and read confirmed data.
 */
export interface DpStateRef {
  readonly status: DpStatus;
  readonly triageContextDraft?: string;
  readonly confirmedHypotheses?: DpHypothesis[];
  readonly question?: string;
  readonly round?: number;
}

/**
 * Writable version of DpStateRef — held only by the extension (single writer).
 * Tools and agentbox receive the readonly DpStateRef view of the same object.
 */
export interface MutableDpStateRef {
  status: DpStatus;
  triageContextDraft?: string;
  confirmedHypotheses?: DpHypothesis[];
  question?: string;
  round?: number;
}

/**
 * Unconditionally rebuild checklist item states from dpState.status.
 * This is a pure state→view derivation: the status enum fully determines
 * all 4 item states. No forward-only guards — supports regression
 * (e.g. awaiting_confirmation → investigating when user adjusts).
 */
export function syncChecklistFromStatus(state: DpState): void {
  if (!state.checklist) return;
  const items = state.checklist.items;
  if (items.length < 4) return;
  // Map: triage(0), hypotheses(1), deep_search(2), conclusion(3)
  switch (state.status) {
    case "idle":
      items[0].status = "pending";
      items[1].status = "pending";
      items[2].status = "pending";
      items[3].status = "pending";
      break;
    case "investigating":
      items[0].status = "in_progress";
      items[1].status = "pending";
      items[2].status = "pending";
      items[3].status = "pending";
      break;
    case "awaiting_confirmation":
      items[0].status = "done";
      items[1].status = "in_progress";
      items[2].status = "pending";
      items[3].status = "pending";
      break;
    case "validating":
      items[0].status = "done";
      items[1].status = "done";
      items[2].status = "in_progress";
      items[3].status = "pending";
      break;
    case "concluding":
      items[0].status = "done";
      items[1].status = "done";
      // deep_search ran → was "in_progress" during validating → mark done
      // deep_search skipped → was still "pending" → mark skipped
      items[2].status = (items[2].status === "in_progress" || items[2].status === "done") ? "done" : "skipped";
      items[3].status = "in_progress";
      break;
    case "completed":
      items[0].status = "done";
      items[1].status = "done";
      // Preserve skipped vs done for deep_search (may have been skipped)
      if (items[2].status !== "skipped") items[2].status = "done";
      items[3].status = "done";
      break;
  }
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
 *
 * In DP mode: writes hypothesesDraft + triageContextDraft to dpState,
 * transitions status to "awaiting_confirmation", and instructs the model
 * to STOP and wait for the user's decision.
 */
export function createProposeHypothesesTool(dpState: DpState): ToolDefinition {
  return {
    name: "propose_hypotheses",
    label: "Propose Hypotheses",
    description:
      "Present hypotheses to the user as a structured UI card. " +
      "The card IS your user-facing output — do NOT repeat hypotheses in your text response. " +
      "Your text before this tool call should be ≤3 sentences (triage summary + transition).\n" +
      "In Deep Investigation mode: you MUST wait for the user's response after calling this tool. " +
      "Do NOT call deep_search until the user explicitly confirms.",
    parameters: Type.Object({
      hypotheses: Type.Array(
        Type.Object({
          id: Type.String({ description: "Hypothesis identifier: H1, H2, H3, etc." }),
          text: Type.String({
            description:
              "A specific, testable hypothesis statement (one sentence). " +
              "NOT a title, category name, or group heading. " +
              'Good: "Evicted pods exhausted ResourceQuota, blocking new pod creation". ' +
              'Bad: "Check resource limits".',
          }),
          confidence: Type.Number({ description: "Prior confidence 0-100 based on evidence strength" }),
          description: Type.Optional(
            Type.String({
              description:
                "1-2 sentence explanation: why this is plausible and how to validate it.",
            })
          ),
        }),
        {
          description:
            "2-4 hypotheses max. Each must be a specific, testable claim — not a category or topic. " +
            "Quality over quantity: drop low-confidence filler hypotheses.",
        }
      ),
      triageContext: Type.Optional(
        Type.String({
          description:
            "Summary of triage findings so far: cluster mode, affected pods/namespaces, " +
            "key observations, commands run. This is saved and passed to deep_search when user confirms.",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const isDpMode = dpState.status !== "idle";

      const { hypotheses: rawHypotheses, triageContext } = params as {
        hypotheses: Array<{ id: string; text: string; confidence: number; description?: string }>;
        triageContext?: string;
      };

      // Post-validation: filter out non-hypothesis items the model sometimes includes
      const hypotheses = rawHypotheses.filter((h) => {
        const text = h.text.trim();
        if (text.startsWith("|")) return false;
        if (/假设提案|(?:revised|proposed|updated)\s*hypothes[ei]s/i.test(text)) return false;
        return true;
      });

      // Write state in DP mode
      if (isDpMode) {
        dpState.hypothesesDraft = hypotheses;
        if (triageContext) dpState.triageContextDraft = triageContext;
        dpState.status = "awaiting_confirmation";
        dpState.round = (dpState.round ?? 0) + 1;
        syncChecklistFromStatus(dpState);
      }

      const responseText = isDpMode
        ? "Hypotheses presented to user. You MUST wait for the user's next message before proceeding. " +
          "The user will either: (1) confirm to proceed with deep_search, (2) provide feedback to adjust hypotheses, " +
          "or (3) ask to skip. Do NOT call deep_search until the user explicitly confirms."
        : "Hypotheses presented to user. Decide whether to proceed based on user engagement.";

      return {
        content: [{ type: "text" as const, text: responseText }],
        details: { hypotheses, triageContext },
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
      if (dpState.status === "idle") {
        return { content: [{ type: "text" as const, text: "No investigation in progress." }], details: {} };
      }
      const { reason } = params as { reason: string };
      dpState.status = "completed";
      if (dpState.checklist) {
        for (const item of dpState.checklist.items) {
          if (item.status === "pending" || item.status === "in_progress") {
            item.status = "skipped";
            item.summary = reason;
          }
        }
      }
      return {
        content: [{ type: "text" as const, text: `Investigation ended: ${reason}` }],
        details: {},
      };
    },
  };
}
