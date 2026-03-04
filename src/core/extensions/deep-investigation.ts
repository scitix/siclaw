import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { deepSearchEvents, type ProgressEvent } from "../../tools/deep-search/events.js";
import {
  type ChecklistItemStatus,
  type DpChecklist,
  createChecklist,
  buildActivationMessage,
} from "../../tools/dp-tools.js";


/**
 * Deep Investigation extension — externalized checklist mode.
 *
 * Replaces the former Phase A→B→C→D state machine with an Azure-style
 * externalized checklist. The model manages its own progress via the
 * `manage_checklist` tool; there are no phase gates or structural signals.
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
    title = title.replace(/^[:\s—\-–]+/, "").replace(/[:\s—\-–]+$/, "").trim();
    return { title, confidence: confMatch ? parseInt(confMatch[1], 10) : undefined };
  }

  // Strategy 1: Structured headers — ## Hypothesis N / ### H1 / ## Hypothesis N
  const headerPattern = /^#{2,3}\s*(?:Hypothesis|H)\s*\d[^:\n]*[:\s]*(.*)/gim;
  let m: RegExpExecArray | null;
  while ((m = headerPattern.exec(text)) !== null) {
    const titleLine = m[1]?.trim();
    if (titleLine) results.push(extract(titleLine));
  }
  if (results.length > 0) return results;

  // Strategy 2: Numbered lists — 1. ... / 1) ... / (1) ...
  const numberedPattern = /^(?:\d+[.)]\s*|\(\d+\)\s*)(.+)/gm;
  while ((m = numberedPattern.exec(text)) !== null) {
    const line = m[1]?.trim();
    if (line && line.length > 5) results.push(extract(line));
  }
  if (results.length > 0) return results;

  // Strategy 3: Bold-prefixed — **Hypothesis 1**: ... / **H1**: ...
  const boldPattern = /^\*\*(?:Hypothesis|H)\s*\d[^*]*\*\*[:\s]*(.*)/gim;
  while ((m = boldPattern.exec(text)) !== null) {
    const line = m[1]?.trim();
    if (line) results.push(extract(line));
  }
  if (results.length > 0) return results;

  // Strategy 4: Raw fallback — non-empty lines, strip markdown markers
  const rawLines = text.split("\n")
    .map((l) => l.replace(/^[#*\->\s]+/, "").trim())
    .filter((l) => l.length > 5);
  for (const line of rawLines.slice(0, 8)) {
    results.push(extract(line));
  }
  return results;
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

export default function deepInvestigationExtension(api: ExtensionAPI): void {
  // --- Mode state ---
  let checklist: DpChecklist | null = null;

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
      enabled: checklist !== null,
      checklist,
    });
  }

  // --- Toggle ---

  function enableDpMode(ctx: ExtensionContext): void {
    if (checklist) return;
    checklist = createChecklist("");
    updateStatus(ctx);
    persistState();
    if (ctx.hasUI) ctx.ui.notify("\uD83D\uDD0D Deep Investigation ON \u2014 Ctrl+I or /dp to exit");
  }

  function disableDpMode(ctx: ExtensionContext): void {
    if (!checklist) return;
    checklist = null;
    updateStatus(ctx);
    persistState();
    if (ctx.hasUI) ctx.ui.notify("Deep Investigation OFF");
  }

  function toggleDpMode(ctx: ExtensionContext): void {
    if (checklist) {
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
      if (!checklist) {
        enableDpMode(ctx);
      }
      checklist!.question = prompt;
      persistState();
      api.sendUserMessage(buildActivationMessage(prompt));
    },
  });

  // --- manage_checklist tool: model manages its own progress (batch add/update/remove) ---

  function executeManageChecklist(
    params: {
      updates?: Array<{ id: string; status?: string; summary?: string }>;
    },
    ctx: ExtensionContext,
  ): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
    if (!checklist) {
      checklist = createChecklist("");
    }

    const results: string[] = [];

    if (params.updates && params.updates.length > 0) {
      for (const upd of params.updates) {
        const found = checklist.items.find((i) => i.id === upd.id);
        if (!found) {
          results.push(`update ${upd.id}: not found`);
          continue;
        }
        if (upd.status) found.status = upd.status as ChecklistItemStatus;
        if (upd.summary) found.summary = upd.summary;
        results.push(`update ${upd.id}: ${upd.status ?? "ok"}`);
      }
    }

    persistState();
    if (ctx.hasUI) updateStatus(ctx);

    // Auto-exit DP mode when conclusion is marked done (workflow complete)
    const conclusionItem = checklist.items.find((i) => i.id === "conclusion");
    if (conclusionItem?.status === "done") {
      disableDpMode(ctx);
    }

    return {
      content: [{ type: "text" as const, text: results.length > 0 ? results.join("; ") : "No operations specified." }],
      details: {},
    };
  }

  api.registerTool({
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeManageChecklist(params as any, ctx);
    },
  });


  // --- end_investigation tool: early termination ---

  api.registerTool({
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checklist) {
        return { content: [{ type: "text" as const, text: "No investigation in progress." }], details: {} };
      }
      const { reason } = params as { reason: string };
      for (const item of checklist.items) {
        if (item.status === "pending" || item.status === "in_progress") {
          item.status = "skipped";
          item.summary = reason;
        }
      }
      persistState();
      if (ctx.hasUI) updateStatus(ctx);
      disableDpMode(ctx);
      return {
        content: [{ type: "text" as const, text: `Investigation ended: ${reason}` }],
        details: {},
      };
    },
  });

  // --- propose_hypotheses tool: user interaction (simplified, no handshake) ---

  api.registerTool({
    name: "propose_hypotheses",
    label: "Propose Hypotheses",
    description:
      "Present hypotheses to the user during deep investigation (non-blocking). " +
      "Call this after triage to propose 3-5 ranked hypotheses. " +
      "The tool will show the hypotheses to the user and immediately return — " +
      "proceed to call deep_search right away without waiting for confirmation. " +
      "Only available in deep investigation mode.",
    parameters: Type.Object({
      hypotheses: Type.String({
        description:
          "Formatted hypothesis list in markdown. Each hypothesis should include: " +
          "description, validation method (skill script paths), and confidence percentage.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checklist) {
        checklist = createChecklist("");
      }

      const { hypotheses: hypothesesText } = params as { hypotheses: string };

      const hasTUI = ctx.hasUI && isThemeUsable(ctx);

      if (hasTUI) {
        // TUI mode: render formatted hypotheses as a persistent widget above editor
        const widgetLines = formatHypothesesWidget(hypothesesText, ctx.ui.theme);
        ctx.ui.setWidget("dp-hypotheses", widgetLines);

        // Auto-dismiss widget after a short delay (non-blocking)
        setTimeout(() => ctx.ui.setWidget("dp-hypotheses", undefined), 5000);
      }

      // Non-blocking: immediately return and let the model proceed to deep_search
      return {
        content: [{ type: "text" as const, text: "Hypotheses recorded. Proceed to call deep_search to validate them." }],
        details: { hypotheses: hypothesesText, autoConfirmed: true },
      };
    },
  });

  // --- input: detect [Deep Investigation] marker from web UI toggle ---

  api.on("input", async (event, ctx) => {
    const marker = "[Deep Investigation]\n";
    if (!event.text.startsWith(marker)) return { action: "continue" as const };

    // Strip the marker and extract the actual question
    const question = event.text.slice(marker.length).trim();
    if (!question) return { action: "continue" as const };

    // Enable DP mode if not already active
    if (!checklist) {
      enableDpMode(ctx);
    }
    checklist!.question = question;
    persistState();

    // Transform into the format the agent expects (includes workflow from SKILL.md)
    return {
      action: "transform" as const,
      text: buildActivationMessage(question),
    };
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
    // Reset state — each session starts clean (prevents bleed from previous session)
    checklist = null;

    // From CLI flag
    if (api.getFlag("dp") === true) {
      checklist = createChecklist("");
    }

    // From persisted entries
    const entries = ctx.sessionManager.getEntries();
    const entry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "dp-mode")
      .pop() as { data?: { enabled: boolean; checklist?: DpChecklist; phase?: string; question?: string } } | undefined;

    if (entry?.data) {
      if (entry.data.checklist) {
        // New format
        checklist = entry.data.checklist;
      } else if (entry.data.phase && entry.data.phase !== "idle") {
        // Old format migration
        checklist = createChecklist(entry.data.question ?? "");
        const doneMap: Record<string, string[]> = {
          A: [],
          B: ["triage"],
          C: ["triage", "hypotheses"],
          D: ["triage", "hypotheses", "deep_search", "conclusion"],
        };
        for (const id of doneMap[entry.data.phase] ?? []) {
          markItem(checklist, id, "done", "(migrated from phase state)");
        }
      }
    }

    updateStatus(ctx);
  });

  // --- agent_end: no backend safety-net ---
  // The model owns checklist state via manage_checklist. If it forgets to mark
  // items done, that's accurately reflected. Tool guards (gate, dpActive) protect
  // against harmful actions. Frontend handles visual cleanup on prompt_done.

  // --- tool_call: progress rendering setup (no auto-mark) ---

  api.on("tool_call", (event, ctx) => {
    // Set up progress rendering for deep_search regardless of DP mode
    if (event.toolName === "deep_search") {
      activeUI = ctx.ui;
      resetProgressState();
    }
  });

  // --- tool_result: progress cleanup (no auto-mark) ---

  api.on("tool_result", (event) => {
    if (event.toolName === "deep_search") {
      // Progress rendering cleanup
      if (activeUI) {
        activeUI.setWorkingMessage();
        activeUI.setWidget(WIDGET_ID, undefined);
      }
      activeUI = null;
      resetProgressState();
    }
  });

  // --- context: filter UI-only custom messages ---

  // Custom types that are UI-only metadata — must never be sent to the LLM.
  const DP_FILTER_TYPES = new Set(["dp-checklist-sync"]);

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
