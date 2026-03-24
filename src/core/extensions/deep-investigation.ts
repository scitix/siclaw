import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { deepSearchEvents, type ProgressEvent } from "../../tools/deep-search/events.js";
import {
  type ChecklistItemStatus,
  type DpChecklist,
  type MutableDpStateRef,
  type DpStatus,
  type DpHypothesis,
  createChecklist,
  syncChecklistFromStatus,
  buildActivationMessage,
} from "../../tools/dp-tools.js";
import type { MemoryRef } from "../../tools/deep-search/tool.js";
import { FEEDBACK_SIGNALS, type FeedbackStatus } from "../../memory/types.js";


/**
 * Deep Investigation extension — system-event-driven checklist.
 *
 * Phase progress is driven by deterministic engine events (Phase 1/4 ~ 4/4)
 * from the deep_search tool, not by LLM tool calls. The frontend maps these
 * phase events to checklist item statuses.
 *
 * Entry points:
 * - `/dp [question]` command
 * - Ctrl+I keyboard shortcut
 * - `--dp` CLI flag
 *
 * Progress rendering (unchanged from original):
 * - Widget (above editor): persistent tree view of all hypotheses
 * - Spinner (setWorkingMessage): current action one-liner
 */

const WIDGET_ID = "deep-search-tree";

function markItem(cl: DpChecklist, id: string, status: ChecklistItemStatus, summary?: string): void {
  const item = cl.items.find((i) => i.id === id);
  if (item) {
    item.status = status;
    if (summary) item.summary = summary;
  }
}

// --- Theme safety ---

/** Check if the TUI theme is actually initialized (false in RPC/gateway mode). */
function isThemeUsable(ctx: { ui: { theme: any } }): boolean {
  try {
    // Accessing any property on the theme proxy triggers the check
    return typeof ctx.ui.theme.fg === "function";
  } catch {
    return false;
  }
}

// --- Helpers ---

interface HypothesisState {
  id: string;
  text: string;
  status: string;
  confidence: number;
  lastTool: string;
  callsUsed: number;
  maxCalls: number;
}

function statusIcon(status: string): string {
  switch (status) {
    case "pending": return "\u25cb";       // ○
    case "validating": return "\u25d4";    // ◔
    case "validated": return "\u2714";     // ✔
    case "invalidated": return "\u2718";   // ✘
    case "inconclusive": return "?";
    case "skipped": return "\u2298";       // ⊘
    default: return "\u25cb";
  }
}


/**
 * Parse hypotheses from various markdown formats into a compact list.
 * Supports: ## Hypothesis N / ### H1 / ## Hypothesis N / numbered lists / bold-prefixed / raw lines.
 */
function parseHypotheses(text: string): Array<{ title: string; confidence?: number }> {
  const results: Array<{ title: string; confidence?: number }> = [];

  // Helper: extract confidence % and clean title
  function extract(raw: string): { title: string; confidence?: number } {
    const confMatch = raw.match(/(\d+)\s*%/);
    // Strip markdown bold markers and leading/trailing punctuation like : —
    let title = raw.replace(/\*\*/g, "").replace(/(\d+)\s*%/, "").replace(/[()]/g, "").trim();
    title = title.replace(/^[:：\s—\-–]+/, "").replace(/[:：\s—\-–]+$/, "").trim();
    return { title, confidence: confMatch ? parseInt(confMatch[1], 10) : undefined };
  }

  // Strategy 1: Structured headers — ## Hypothesis N / ### H1 / ### #1 (supports CJK)
  // Requires a number after the keyword to distinguish individual hypotheses
  // from summary headings like "## 假设列表（按可能性排序）".
  const headerPattern = /^#{2,3}\s*(?:Hypothesis|假设|假說|H|#)\s*\d[^:：\n]*[:：\s]*(.*)/gim;
  let m: RegExpExecArray | null;
  while ((m = headerPattern.exec(text)) !== null) {
    const titleLine = m[1]?.trim();
    if (titleLine) results.push(extract(titleLine));
  }
  if (results.length > 0) return results;

  // Strategy 2: Numbered lists — 1. ... / 1) ... / (1) ... (allows leading whitespace)
  const numberedPattern = /^\s*(?:\d+[.)]\s*|\(\d+\)\s*)(.+)/gm;
  while ((m = numberedPattern.exec(text)) !== null) {
    const line = m[1]?.trim();
    if (line && line.length > 5) results.push(extract(line));
  }
  if (results.length > 0) return results;

  // Strategy 3: Bold-prefixed — **Hypothesis 1**: ... (supports CJK)
  const boldPattern = /^\*\*(?:Hypothesis|假设|假說|H)\s*\d[^*]*\*\*[:：\s]*(.*)/gim;
  while ((m = boldPattern.exec(text)) !== null) {
    const line = m[1]?.trim();
    if (line) results.push(extract(line));
  }
  if (results.length > 0) return results;

  // Strategy 4: Grouped fallback — group bullet/indented lines under their parent
  // Mirrors HypothesesCard.tsx parseNumberedList logic to avoid splitting sub-items
  const lines = text.split("\n");
  let current: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isSubItem = /^- /.test(trimmed) || /^\* /.test(trimmed) || /^\s/.test(line);
    if (!isSubItem && trimmed.length > 5) {
      if (current !== null) results.push(extract(current));
      current = trimmed;
    }
  }
  if (current !== null) results.push(extract(current));
  return results.slice(0, 8);
}

/**
 * Format hypotheses into a compact widget (≤10 lines).
 * One line per hypothesis: number + truncated title + optional confidence.
 */
function formatHypothesesWidget(text: string, theme: any): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("── 🔍 Hypotheses ──────────────────────────────")));

  const parsed = parseHypotheses(text);
  const maxItems = 8; // header(1) + items(8) + footer(1) = 10
  for (let i = 0; i < Math.min(parsed.length, maxItems); i++) {
    const h = parsed[i];
    const num = theme.fg("accent", theme.bold(` ${i + 1}.`));
    const title = h.title.length > 60 ? h.title.slice(0, 57) + "..." : h.title;
    const conf = h.confidence ? " " + theme.fg("warning", `(${h.confidence}%)`) : "";
    lines.push(`${num} ${title}${conf}`);
  }

  lines.push(theme.fg("muted", "──────────────────────────────────────────────────"));
  return lines;
}

// --- Extension ---

export default function deepInvestigationExtension(api: ExtensionAPI, memoryRef?: MemoryRef, dpStateRef?: MutableDpStateRef): void {
  // --- DP state machine (source of truth) ---
  // All status transitions happen via setDpStatus() which is driven ONLY by
  // deterministic system events (tool_call, tool_result, user UI actions, agent_end).
  // Model text must NEVER drive status changes.
  let dpStatus: DpStatus = "idle";
  let dpQuestion: string | undefined;
  let dpTriageContextDraft: string | undefined;
  let dpHypothesesDraft: DpHypothesis[] | undefined;
  let dpConfirmedHypotheses: DpHypothesis[] | undefined;
  let dpRound = 0;
  let dpLastUserFeedback: string | undefined;

  function setDpStatus(status: DpStatus): void {
    dpStatus = status;
    // Sync the mutable ref so tools and agentbox can see current state
    if (dpStateRef) {
      dpStateRef.status = status;
      dpStateRef.triageContextDraft = dpTriageContextDraft;
      dpStateRef.confirmedHypotheses = dpConfirmedHypotheses;
      dpStateRef.question = dpQuestion;
      dpStateRef.round = dpRound;
    }
    // Derive checklist from status (single direction: status → checklist)
    if (checklist) syncChecklistFromStatus({ checklist, status, round: dpRound });
  }

  // --- Legacy mode state ---
  let checklist: DpChecklist | null = null;
  let pendingActivation = false;
  let pendingFeedbackId: string | null = null;
  let deepSearchRan = false;
  let feedbackCleanup: (() => void) | null = null;

  // --- Progress rendering state ---
  let activeUI: ExtensionUIContext | null = null;
  let progressPhase = "";
  const hypotheses = new Map<string, HypothesisState>();

  function resetProgressState(): void {
    hypotheses.clear();
    progressPhase = "";
  }

  // --- Status bar ---

  function updateStatus(ctx: ExtensionContext): void {
    if (!checklist) {
      ctx.ui.setStatus("dp-mode", undefined);
      return;
    }
    const done = checklist.items.filter((i) => i.status === "done" || i.status === "skipped").length;
    const total = checklist.items.length;
    const current = checklist.items.find((i) => i.status === "pending");
    const label = current ? current.label.split("(")[0].trim() : "Done";
    const text = `\uD83D\uDD0D DP: ${done}/${total} ${label}`;
    ctx.ui.setStatus(
      "dp-mode",
      isThemeUsable(ctx) ? ctx.ui.theme.fg("accent", text) : text,
    );
  }

  // --- Persistence ---

  function persistState(): void {
    api.appendEntry("dp-mode", {
      enabled: dpStatus !== "idle",
      checklist,
      // DP state snapshot — used for frontend sync and session restore
      dpStatus,
      dpQuestion,
      dpRound,
      dpTriageContextDraft,
      dpHypothesesDraft,
      dpConfirmedHypotheses,
      dpLastUserFeedback,
    });
  }

  // --- Toggle ---

  function enableDpMode(ctx: ExtensionContext): void {
    if (dpStatus !== "idle") return;
    checklist = createChecklist("");
    dpRound = 0;
    dpTriageContextDraft = undefined;
    dpHypothesesDraft = undefined;
    dpConfirmedHypotheses = undefined;
    dpLastUserFeedback = undefined;
    setDpStatus("investigating");
    updateStatus(ctx);
    persistState();
    if (ctx.hasUI) ctx.ui.notify("\uD83D\uDD0D Deep Investigation ON \u2014 Ctrl+I or /dp to exit");
    pendingActivation = true;
  }

  /** Show feedback hint in status bar if deep_search ran. Can be called independently of DP mode exit. */
  function showFeedbackIfNeeded(ctx: ExtensionContext): void {
    if (!deepSearchRan || !ctx.hasUI) {
      deepSearchRan = false;
      pendingFeedbackId = null;
      return;
    }
    deepSearchRan = false;
    const id = pendingFeedbackId;
    pendingFeedbackId = null;

    const cleanup = () => {
      ctx.ui.setStatus("dp-mode", undefined);
      unsubInput();
      clearTimeout(timer);
      feedbackCleanup = null;
    };

    const timer = setTimeout(cleanup, 60_000);

    const unsubInput = ctx.ui.onTerminalInput((data: string) => {
      if (ctx.ui.getEditorText().length > 0) return undefined;
      const keyMap: Record<string, FeedbackStatus> = { "1": "confirmed", "2": "corrected", "3": "rejected" };
      const status = keyMap[data];
      if (!status) return undefined;

      if (id && memoryRef?.indexer) {
        memoryRef.indexer.updateInvestigationFeedback(id, FEEDBACK_SIGNALS[status], status);
      }
      ctx.ui.notify(`Feedback recorded: ${status}`);
      cleanup();
      return { consume: true };
    });

    feedbackCleanup = cleanup;
    const hint = "Thanks! Rate: 1-\uD83D\uDC4D 2-\uD83D\uDC4E 3-\u274C";
    ctx.ui.setStatus("dp-mode", isThemeUsable(ctx) ? ctx.ui.theme.fg("muted", hint) : hint);
  }

  function disableDpMode(ctx: ExtensionContext): void {
    if (dpStatus === "idle") return;
    // Clear state before setDpStatus so dpStateRef snapshot is clean on idle
    checklist = null;
    dpQuestion = undefined;
    dpTriageContextDraft = undefined;
    dpHypothesesDraft = undefined;
    dpConfirmedHypotheses = undefined;
    dpRound = 0;
    dpLastUserFeedback = undefined;
    setDpStatus("idle");
    persistState();
    if (ctx.hasUI) ctx.ui.notify("Deep Investigation OFF");
    pendingActivation = false;
    showFeedbackIfNeeded(ctx);
    if (!feedbackCleanup) updateStatus(ctx);
  }

  function toggleDpMode(ctx: ExtensionContext): void {
    if (dpStatus !== "idle") {
      disableDpMode(ctx);
    } else {
      enableDpMode(ctx);
    }
  }

  // --- Message renderers ---

  api.registerMessageRenderer("dp-mode-toggle", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    if (!theme?.fg) return new Text(content, 0, 0);
    const lines = content.split("\n");
    const styled = lines.map((line) => theme.fg("muted", line));
    return new Text("\n" + styled.join("\n"), 0, 0);
  });

  // --- Hypothesis tree rendering ---

  function renderTree(): string[] {
    if (hypotheses.size === 0) return [];

    const lines: string[] = [];
    if (progressPhase) lines.push(progressPhase);

    for (const h of hypotheses.values()) {
      const icon = statusIcon(h.status);
      const label = h.text.length > 40 ? h.text.slice(0, 37) + "..." : h.text;
      let detail: string;

      if (h.status === "pending") {
        detail = "waiting";
      } else if (h.status === "skipped") {
        detail = "skipped (early exit)";
      } else if (h.status === "validated" || h.status === "invalidated" || h.status === "inconclusive") {
        detail = `${h.status} (${h.confidence}%)`;
      } else {
        detail = h.lastTool
          ? `[${h.callsUsed}/${h.maxCalls}] ${h.lastTool}`
          : "starting...";
      }

      lines.push(`  ${icon} ${h.id} ${label} \u2014 ${detail}`);
    }

    return lines;
  }

  // --- Registration: flag, shortcut, command ---

  api.registerFlag("dp", {
    description: "Start in deep investigation mode",
    type: "boolean",
    default: false,
  });

  api.registerShortcut(Key.ctrl("i"), {
    description: "Toggle deep investigation mode",
    handler: async (ctx) => toggleDpMode(ctx),
  });

  api.registerCommand("dp", {
    description: "Toggle deep investigation mode, or /dp <question> to start investigating",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        toggleDpMode(ctx);
        return;
      }
      if (dpStatus === "idle") {
        enableDpMode(ctx);
      }
      dpQuestion = prompt;
      if (checklist) checklist.question = prompt;
      persistState();
      api.sendUserMessage(buildActivationMessage(prompt));
    },
  });

  // --- end_investigation tool: early termination ---

  api.registerTool({
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (dpStatus === "idle") {
        return { content: [{ type: "text" as const, text: "No investigation in progress." }], details: {} };
      }
      const { reason } = params as { reason: string };
      // System event: end_investigation tool execute
      setDpStatus("completed");
      persistState();
      if (ctx.hasUI) updateStatus(ctx);
      disableDpMode(ctx);
      return {
        content: [{ type: "text" as const, text: `Investigation ended: ${reason}` }],
        details: { dpStatus: "completed" as const },
      };
    },
  });

  // --- propose_hypotheses tool: interactive user review ---
  // System event: tool execute → status transitions.
  // User choice (TUI select / web steer) → status transitions.

  api.registerTool({
    name: "propose_hypotheses",
    label: "Propose Hypotheses",
    description:
      "Present hypotheses to the user as an interactive review card. " +
      "In TUI: the tool BLOCKS until the user makes a decision (proceed / adjust / skip). " +
      "In web UI: returns immediately — you MUST wait for the user's next message. " +
      "Use this to align investigation direction before committing to deep_search. " +
      "Always prefer this tool over plain-text hypotheses — it renders a proper interactive card.\n" +
      "In Deep Investigation mode: you MUST wait for the user's response after calling this tool. " +
      "Do NOT call deep_search until the user explicitly confirms.",
    parameters: Type.Object({
      hypotheses: Type.String({
        description:
          "Formatted hypothesis list in markdown. Each hypothesis should include: " +
          "description, validation method (skill script paths), and confidence percentage.",
      }),
      triageContext: Type.String({
        description:
          "REQUIRED. Summary of triage findings so far: cluster mode, affected pods/namespaces, " +
          "key observations, commands run. This is saved and automatically passed to deep_search " +
          "when the user confirms hypotheses. Must not be empty.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const isDpMode = dpStatus !== "idle";
      const { hypotheses: hypothesesText, triageContext } = params as { hypotheses: string; triageContext: string };

      // --- Write DP state (system event: tool execute) ---
      if (isDpMode) {
        // Save drafts
        const parsed = parseHypotheses(hypothesesText);
        dpHypothesesDraft = parsed.map((h, i) => ({
          id: `H${i + 1}`,
          text: h.title,
          confidence: h.confidence ?? 50,
        }));
        dpTriageContextDraft = triageContext;
        dpRound++;
        // Status transition: investigating → awaiting_confirmation
        setDpStatus("awaiting_confirmation");
        persistState();
        updateStatus(ctx);
      }

      const hasTUI = ctx.hasUI && isThemeUsable(ctx);

      if (hasTUI) {
        const parsed = parseHypotheses(hypothesesText);
        const hypoLines = parsed.slice(0, 5).map((h, i) => {
          const title = h.title.length > 60 ? h.title.slice(0, 57) + "..." : h.title;
          const conf = h.confidence ? ` (${h.confidence}%)` : "";
          return `  ${i + 1}. ${title}${conf}`;
        }).join("\n");
        const selectTitle = `Review Hypotheses (round ${dpRound})\n\n${hypoLines}\n`;

        // Block until user reviews and decides
        const choice = await ctx.ui.select(
          selectTitle,
          [
            "Proceed to deep search",
            "Adjust hypotheses",
            "Skip to conclusion",
          ],
          { signal },
        );

        const widgetLines = formatHypothesesWidget(hypothesesText, ctx.ui.theme);
        ctx.ui.setWidget("dp-hypotheses", widgetLines);

        if (choice === "Adjust hypotheses") {
          ctx.ui.setWidget("dp-hypotheses", undefined);
          const feedback = await ctx.ui.input(
            "What should be adjusted?",
            "e.g., focus on #1 and #3, add a new hypothesis...",
            { signal },
          );
          ctx.ui.setWidget("dp-hypotheses", widgetLines);
          // System event: user chose "adjust"
          if (isDpMode) {
            dpLastUserFeedback = feedback ?? undefined;
            setDpStatus("investigating");
            persistState();
            updateStatus(ctx);
          }
          return {
            content: [{ type: "text" as const, text: `User wants adjustments: ${feedback ?? "(no details)"}. Revise hypotheses and call propose_hypotheses again.` }],
            details: { hypotheses: hypothesesText, userChoice: "adjust", feedback, dpStatus: dpStatus },
          };
        }

        if (choice === "Skip to conclusion") {
          // System event: user chose "skip" → concluding (model still needs to output conclusion)
          if (isDpMode) {
            setDpStatus("concluding");
            persistState();
            updateStatus(ctx);
          }
          return {
            content: [{ type: "text" as const, text: "User chose to skip deep search. Present conclusion based on current findings." }],
            details: { hypotheses: hypothesesText, userChoice: "skip", dpStatus: dpStatus },
          };
        }

        // "Proceed to deep search" — system event: user confirmed
        if (isDpMode) {
          dpConfirmedHypotheses = dpHypothesesDraft;
          setDpStatus("validating");
          persistState();
          updateStatus(ctx);
        }
        return {
          content: [{ type: "text" as const, text: "User approved hypotheses. Proceed with deep_search to validate them." }],
          details: { hypotheses: hypothesesText, userChoice: "proceed", dpStatus: dpStatus },
        };
      }

      // Non-TUI mode (web UI, RPC): no interactive dialog.
      // Status already set to awaiting_confirmation above.
      // CRITICAL: Use steer to interrupt the agent turn — prevents model from
      // continuing to call tools (deep_search, bash, etc.) without user confirmation.
      // "steer" mode = remaining tools in this turn are skipped.
      if (isDpMode) {
        api.sendUserMessage(
          "Hypotheses have been presented to the user. STOP and wait for the user to confirm, adjust, or skip. " +
          "Do NOT call any more tools until the user responds.",
          { deliverAs: "steer" },
        );
      }

      const responseText = isDpMode
        ? "Hypotheses presented to user. Waiting for user confirmation."
        : "Hypotheses presented to user. Decide whether to proceed based on user engagement.";

      return {
        content: [{ type: "text" as const, text: responseText }],
        details: { hypotheses: hypothesesText, triageContext, dpStatus: dpStatus },
      };
    },
  });

  // --- input: inject DP workflow when activated via Ctrl+I or /dp (no args) ---

  api.on("input", async (event, _ctx) => {
    if (!pendingActivation) return { action: "continue" as const };
    // Don't intercept if already has DP markers
    if (event.text.startsWith("[Deep Investigation]") || event.text.startsWith("[DP_EXIT]")
        || event.text.startsWith("[DP_CONFIRM]") || event.text.startsWith("[DP_ADJUST]") || event.text.startsWith("[DP_SKIP]")) {
      return { action: "continue" as const };
    }
    pendingActivation = false;
    // Directly build activation message (don't rely on handler chaining)
    const question = event.text.trim();
    if (!question) return { action: "continue" as const };
    dpQuestion = question;
    if (checklist) checklist.question = question;
    persistState();
    return {
      action: "transform" as const,
      text: buildActivationMessage(question),
    };
  });

  // --- input: detect [Deep Investigation] marker from web UI toggle ---
  // Frontend always prepends this when DP toggle is on.
  // Backend decides behavior based on dpStatus:
  //   idle → activate DP + inject workflow prompt
  //   non-idle → strip marker, passthrough as normal conversation

  api.on("input", async (event, ctx) => {
    const marker = "[Deep Investigation]\n";
    if (!event.text.startsWith(marker)) return { action: "continue" as const };

    const userText = event.text.slice(marker.length).trim();
    if (!userText) return { action: "continue" as const };

    if (dpStatus === "idle") {
      // First message: activate DP and inject workflow prompt
      enableDpMode(ctx);
      dpQuestion = userText;
      if (checklist) checklist.question = userText;
      persistState();
      return {
        action: "transform" as const,
        text: buildActivationMessage(userText),
      };
    }

    // Already in DP: strip marker.
    // If awaiting_confirmation, free-text input is implicit "adjust" — back to investigating.
    if (dpStatus === "awaiting_confirmation") {
      dpLastUserFeedback = userText;
      setDpStatus("investigating");
      persistState();
      updateStatus(ctx);
    }

    // Pass through the stripped text as normal conversation
    return {
      action: "transform" as const,
      text: userText,
    };
  });

  // --- input: handle [DP_CONFIRM] / [DP_ADJUST] / [DP_SKIP] from web UI ---

  api.on("input", async (event, ctx) => {
    if (dpStatus !== "awaiting_confirmation") return { action: "continue" as const };

    // --- Confirm: awaiting_confirmation → validating ---
    if (event.text.startsWith("[DP_CONFIRM]")) {
      dpConfirmedHypotheses = dpHypothesesDraft;
      setDpStatus("validating");
      persistState();
      updateStatus(ctx);
      const userText = event.text.replace(/^\[DP_CONFIRM\]\n?/, "").trim();
      return {
        action: "transform" as const,
        text: `The user has confirmed the proposed hypotheses. Proceed with deep_search to validate them.${userText ? `\n\nAdditional context: ${userText}` : ""}`,
      };
    }

    // --- Adjust: awaiting_confirmation → investigating ---
    if (event.text.startsWith("[DP_ADJUST]")) {
      const feedback = event.text.replace(/^\[DP_ADJUST\]\n?/, "").trim();
      dpLastUserFeedback = feedback || undefined;
      setDpStatus("investigating");
      persistState();
      updateStatus(ctx);
      return {
        action: "transform" as const,
        text: `The user has requested adjustments to the hypotheses. Their feedback:\n\n${feedback || "(no specific feedback)"}\n\nPlease revise your investigation based on this feedback, then call propose_hypotheses again with updated hypotheses.`,
      };
    }

    // --- Skip: awaiting_confirmation → concluding ---
    if (event.text.startsWith("[DP_SKIP]")) {
      setDpStatus("concluding");
      persistState();
      updateStatus(ctx);
      const userText = event.text.replace(/^\[DP_SKIP\]\n?/, "").trim();
      return {
        action: "transform" as const,
        text: `The user has chosen to skip deep_search validation. Present your conclusion based on the triage findings so far.${userText ? `\n\n${userText}` : ""}`,
      };
    }

    // --- Free-text during awaiting_confirmation → implicit adjust ---
    // Skip other DP markers (they have their own handlers)
    if (event.text.startsWith("[Deep Investigation]") || event.text.startsWith("[DP_EXIT]")) {
      return { action: "continue" as const };
    }
    // Any non-marker user input is treated as feedback → back to investigating
    const feedback = event.text.trim();
    if (feedback) {
      dpLastUserFeedback = feedback;
      setDpStatus("investigating");
      persistState();
      updateStatus(ctx);
      // Pass through as-is — let the model see the user's actual words
      return { action: "continue" as const };
    }

    return { action: "continue" as const };
  });

  // --- input: detect [DP_EXIT] marker from web UI manual exit ---

  api.on("input", async (event, ctx) => {
    const marker = "[DP_EXIT]\n";
    if (!event.text.startsWith(marker)) return { action: "continue" as const };

    const userText = event.text.slice(marker.length).trim();

    // Immediately clean up backend DP state
    if (checklist) {
      for (const item of checklist.items) {
        if (item.status === "pending" || item.status === "in_progress") {
          item.status = "skipped";
          item.summary = "User exited investigation";
        }
      }
      persistState();
    }
    disableDpMode(ctx);

    return {
      action: "transform" as const,
      text: `The user has exited deep investigation mode. ${userText}`,
    };
  });

  // --- session_start: restore persisted state ---

  api.on("session_start", async (_event, ctx) => {
    // Clean up stale feedback prompt from previous session
    feedbackCleanup?.();
    deepSearchRan = false;
    pendingFeedbackId = null;

    // Reset state — each session starts clean (prevents bleed from previous session)
    checklist = null;
    dpStatus = "idle";

    // From CLI flag
    if (api.getFlag("dp") === true) {
      checklist = createChecklist("");
      setDpStatus("investigating");
    }

    // From persisted entries — restore from dpStatus snapshot (source of truth)
    const entries = ctx.sessionManager.getEntries();
    const entry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "dp-mode")
      .pop() as { data?: {
        enabled: boolean;
        checklist?: DpChecklist;
        dpStatus?: DpStatus;
        dpQuestion?: string;
        dpRound?: number;
        dpTriageContextDraft?: string;
        dpHypothesesDraft?: DpHypothesis[];
        dpConfirmedHypotheses?: DpHypothesis[];
        dpLastUserFeedback?: string;
        // Legacy fields
        phase?: string;
        question?: string;
      } } | undefined;

    if (entry?.data) {
      if (entry.data.dpStatus && entry.data.dpStatus !== "idle") {
        // New format: restore from dpStatus snapshot
        checklist = entry.data.checklist ?? createChecklist(entry.data.dpQuestion ?? "");
        dpQuestion = entry.data.dpQuestion;
        dpRound = entry.data.dpRound ?? 0;
        dpTriageContextDraft = entry.data.dpTriageContextDraft;
        dpHypothesesDraft = entry.data.dpHypothesesDraft;
        dpConfirmedHypotheses = entry.data.dpConfirmedHypotheses;
        dpLastUserFeedback = entry.data.dpLastUserFeedback;
        setDpStatus(entry.data.dpStatus);
      } else if (entry.data.checklist) {
        // Legacy format with checklist but no dpStatus
        checklist = entry.data.checklist;
        setDpStatus("investigating");
      } else if (entry.data.phase && entry.data.phase !== "idle") {
        // Old phase-based format migration
        checklist = createChecklist(entry.data.question ?? "");
        setDpStatus("investigating");
      }
    }

    updateStatus(ctx);
  });

  // --- agent_end: system event → completed ---
  // When the model finishes its turn after deep_search, the conclusion has been
  // produced. This is the deterministic signal to transition concluding → completed.
  api.on("agent_end", (_event, ctx) => {
    if (dpStatus === "concluding") {
      setDpStatus("completed");
      updateStatus(ctx);
      // disableDpMode resets to idle and persists — no separate persistState() needed
      // (persisting "completed" then immediately "idle" would make the completed snapshot dead code)
      disableDpMode(ctx);
      return;
    }
    // Guardrail: model ended in DP mode without ever calling propose_hypotheses.
    // This means it bypassed the interactive loop — nudge it back on track.
    if (dpStatus === "investigating" && dpRound === 0) {
      api.sendUserMessage(
        "You are in Deep Investigation mode but ended without calling propose_hypotheses. " +
        "In DP mode, you MUST share your findings and hypotheses with the user via propose_hypotheses before concluding. " +
        "Please review what you've found so far and call propose_hypotheses now.",
        { deliverAs: "followUp" },
      );
    }
  });

  // --- tool_call: system event → status transition + progress rendering ---

  api.on("tool_call", (event, ctx) => {
    // Clear hypotheses widget when model proceeds to next tool
    if (event.toolName !== "propose_hypotheses") {
      ctx.ui.setWidget("dp-hypotheses", undefined);
    }
    // System event: deep_search tool_call → confirm validating status
    if (event.toolName === "deep_search") {
      if (dpStatus === "validating") {
        // Already validating (set by user confirm) — just sync checklist
        syncChecklistFromStatus({ checklist, status: dpStatus, round: dpRound });
        persistState();
        updateStatus(ctx);
      }
      activeUI = ctx.ui;
      resetProgressState();
    }
  });

  // --- tool_result: system event → concluding + progress cleanup ---

  api.on("tool_result", (event, ctx) => {
    if (event.toolName === "deep_search") {
      // Progress rendering cleanup
      if (activeUI) {
        activeUI.setWorkingMessage();
        activeUI.setWidget(WIDGET_ID, undefined);
      }
      activeUI = null;
      resetProgressState();

      // System event: deep_search tool_result → concluding
      // Model still needs to present its conclusion before we go to completed.
      if (dpStatus === "validating") {
        setDpStatus("concluding");
        persistState();
        updateStatus(ctx);
      }

      // Flag that deep_search ran; capture investigationId for feedback
      deepSearchRan = true;
      const details = event.details as Record<string, unknown> | undefined;
      pendingFeedbackId = (details?.investigationId as string) ?? null;
    }
  });

  // Clean up feedback hint when agent starts processing next message
  api.on("agent_start", () => {
    feedbackCleanup?.();
  });

  // --- context: filter UI-only custom messages ---

  // Custom types that are UI-only metadata — must never be sent to the LLM.
  const DP_FILTER_TYPES = new Set(["dp-mode", "dp-checklist-sync"]);

  api.on("context", async (event) => {
    return {
      messages: event.messages.filter((m: any) => !DP_FILTER_TYPES.has(m.customType)),
    };
  });

  // --- Progress rendering from deep_search engine events ---

  deepSearchEvents.on("progress", (event: ProgressEvent) => {
    if (!activeUI) return;

    switch (event.type) {
      case "phase": {
        progressPhase = `${event.phase}: ${event.detail ?? ""}`;
        activeUI.setWorkingMessage(progressPhase);
        break;
      }

      case "hypothesis": {
        const existing = hypotheses.get(event.id);
        if (existing) {
          existing.status = event.status;
          existing.confidence = event.confidence;
        } else {
          hypotheses.set(event.id, {
            id: event.id,
            text: event.text ?? event.id,
            status: event.status,
            confidence: event.confidence,
            lastTool: "",
            callsUsed: 0,
            maxCalls: 0,
          });
        }
        break;
      }

      case "tool_exec": {
        const hId = event.hypothesisId;
        if (hId) {
          const h = hypotheses.get(hId);
          if (h) {
            h.status = "validating";
            h.lastTool = `${event.tool}: ${event.command.slice(0, 40)}`;
            h.callsUsed = event.callsUsed;
            h.maxCalls = event.maxCalls;
          }
        }
        const prefix = hId ?? "";
        activeUI.setWorkingMessage(`${prefix} [${event.callsUsed}/${event.maxCalls}] ${event.tool}: ${event.command.slice(0, 50)}`);
        break;
      }

      case "budget_exhausted": {
        const hId = event.hypothesisId;
        if (hId) {
          const h = hypotheses.get(hId);
          if (h) h.lastTool = "budget exhausted, concluding...";
        }
        activeUI.setWorkingMessage(`${hId ?? ""} Budget exhausted (${event.callsUsed} calls)`);
        break;
      }

      default:
        return;
    }

    // Update tree widget after every meaningful event
    const treeLines = renderTree();
    if (treeLines.length > 0) {
      activeUI.setWidget(WIDGET_ID, treeLines);
    }
  });
}
