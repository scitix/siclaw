import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, Text } from "@mariozechner/pi-tui";
import type { MutableDpStateRef } from "../types.js";

/**
 * Deep Investigation extension — lightweight mode flag.
 *
 * DP is a USER-OWNED MODE: it turns ON when the user sends a message with
 * the `[Deep Investigation]` prefix (from the web-UI magnifier chip, the
 * `/dp` command, or Ctrl+I) and OFF only when the user sends `[DP_EXIT]`.
 *
 * While ON, the first marker-bearing message is rewritten to prepend a
 * prompt addendum that nudges the model toward divergent / rigorous
 * reasoning. Subsequent turns rely on conversation history to keep the
 * model in that mindset — no state machine, no per-turn prompt injection,
 * no dedicated tools, no specialized UI cards.
 *
 * All heavy mechanics (propose_hypotheses / deep_search / end_investigation
 * tools, dpStatus state machine, checklist, custom cards, dp_status SSE
 * event, DP_CONFIRM / DP_ADJUST / DP_SKIP / DP_REINVESTIGATE markers) were
 * removed in the Apr 2026 refactor — see
 * docs/design/2026-04-24-dp-mode-refactor-design.md. The new
 * `delegate_to_agent` tool plus the permission-gate primitive are Phase 2
 * work that lands on top of this clean baseline.
 */

const DP_ACTIVATION_PROMPT = `You are now in Deep Investigation mode. Approach the user's question with the rigor of a senior SRE running an incident post-mortem:

1. Don't rush to conclusions. Gather evidence with tools before forming hypotheses.
2. When you have enough context, write 2-5 candidate hypotheses in plain markdown, each with your estimated confidence.
3. After listing hypotheses, present three options on new lines so the user can steer you:
   A. Proceed with current direction
   B. Adjust — the user will elaborate
   C. Skip validation and give me the best answer now
4. When the user replies:
   - "A" alone — proceed as they have agreed
   - "B <text>" — redirect based on what they wrote
   - "C" alone — wrap up with your current best answer
   - anything else — interpret naturally
5. Document evidence as you collect it. Structure your final answer with clear sections: Findings, Root Cause, Recommendation, Caveats.

Stay in this mindset across turns until the user exits with [DP_EXIT].`;

export default function deepInvestigationExtension(
  api: ExtensionAPI,
  _memoryRef?: unknown,
  dpStateRef?: MutableDpStateRef,
): void {
  let dpActive = false;

  function setActive(next: boolean): void {
    dpActive = next;
    if (dpStateRef) dpStateRef.active = next;
  }

  function persistState(): void {
    api.appendEntry("dp-mode", { active: dpActive });
  }

  function enableDpMode(ctx: ExtensionContext): void {
    if (dpActive) return;
    setActive(true);
    persistState();
    if (ctx.hasUI) ctx.ui.notify("🔍 Deep Investigation ON — Ctrl+I or /dp to exit");
  }

  function disableDpMode(ctx: ExtensionContext): void {
    if (!dpActive) return;
    setActive(false);
    persistState();
    if (ctx.hasUI) ctx.ui.notify("Deep Investigation OFF");
  }

  function toggleDpMode(ctx: ExtensionContext): void {
    if (dpActive) disableDpMode(ctx);
    else enableDpMode(ctx);
  }

  // --- CLI / TUI entry points ---

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
    description: "Toggle deep investigation mode",
    handler: async (_args, ctx) => toggleDpMode(ctx),
  });

  // --- Message renderer for UI-only custom message type ---

  api.registerMessageRenderer("dp-mode-toggle", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    if (!theme?.fg) return new Text(content, 0, 0);
    const lines = content.split("\n");
    const styled = lines.map((line) => theme.fg("muted", line));
    return new Text("\n" + styled.join("\n"), 0, 0);
  });

  // --- [Deep Investigation] marker: activate + inject prompt preamble ---
  //
  // First occurrence (dpActive=false): turn on the mode and transform the
  // message to include the activation preamble. Subsequent occurrences
  // while already active: just strip the marker — the model stays in DP
  // via conversation history.

  api.on("input", async (event, ctx) => {
    const marker = "[Deep Investigation]\n";
    if (!event.text.startsWith(marker)) return { action: "continue" as const };

    const userText = event.text.slice(marker.length).trim();
    if (!userText) return { action: "continue" as const };

    if (!dpActive) {
      enableDpMode(ctx);
      return {
        action: "transform" as const,
        text: `${DP_ACTIVATION_PROMPT}\n\n---\n\n${userText}`,
      };
    }

    return { action: "transform" as const, text: userText };
  });

  // --- [DP_EXIT] marker: deactivate ---

  api.on("input", async (event, ctx) => {
    const hasPrefix = event.text.startsWith("[DP_EXIT]\n");
    const bareMarker = event.text.trim() === "[DP_EXIT]";
    if (!hasPrefix && !bareMarker) return { action: "continue" as const };

    const userText = hasPrefix ? event.text.slice("[DP_EXIT]\n".length).trim() : "";
    disableDpMode(ctx);
    return {
      action: "transform" as const,
      text: userText
        ? `The user has exited Deep Investigation mode. ${userText}`
        : "The user has exited Deep Investigation mode.",
    };
  });

  // --- session_start: restore dpActive from persisted entries ---

  api.on("session_start", async (_event, ctx) => {
    setActive(false);

    if (api.getFlag("dp") === true) {
      setActive(true);
      if (ctx.hasUI) ctx.ui.notify("🔍 Deep Investigation (from --dp flag)");
      return;
    }

    // Restore from the latest dp-mode entry. Accepts the new `{active}` shape
    // plus the two legacy shapes (`{enabled}` and `{dpStatus}`) so sessions
    // persisted under the pre-refactor architecture restore correctly.
    const entries = ctx.sessionManager.getEntries();
    const entry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "dp-mode")
      .pop() as { data?: { active?: boolean; enabled?: boolean; dpStatus?: string } } | undefined;

    if (!entry?.data) return;
    if (entry.data.active === true) setActive(true);
    else if (entry.data.enabled === true) setActive(true);
    else if (entry.data.dpStatus && entry.data.dpStatus !== "idle") setActive(true);
  });

  // --- context filter: strip UI-only custom messages ---

  const DP_FILTER_TYPES = new Set(["dp-mode"]);
  api.on("context", async (event) => {
    return {
      messages: event.messages.filter((m: any) => !DP_FILTER_TYPES.has(m.customType)),
    };
  });
}
