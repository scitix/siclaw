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
 * The current DP baseline is single-agent plus optional same-agent
 * `delegate_to_agent(agent_id="self")` sub-investigation. Cross-agent expert
 * collaboration and permission gates are intentionally separate follow-up
 * phases.
 */

const DP_ACTIVATION_PROMPT = `You are now in Deep Investigation mode. Approach the user's question with the rigor of a senior SRE running an incident post-mortem.

Run this loop until you have a justified answer:

1. Collect baseline evidence first. Inspect the current state, recent events, configuration, logs, and cheap high-signal data before forming hypotheses. If tool access is unavailable, say what evidence is missing and reason from the available context.
2. The user describes symptoms; you design the investigation. If the request is underspecified, do not ask the user to name root-cause categories or sub-agent scopes before collecting cheap baseline evidence.
3. Form hypotheses only when evidence makes them useful. Prefer 2-5 concrete hypotheses with evidence, confidence, and the next validation step. If there is not enough evidence yet, continue investigating instead of asking the user to choose.
4. Work autonomously by default. Do not ask the user to choose A/B/C after every message. Do not narrate DP mechanics unless it helps the investigation.
5. Use same-agent delegation when it reduces hallucination or latency. You may call delegate_to_agent with agent_id="self" for one focused check. When the user explicitly asks for multiple sub-agents, or when you identify 2-3 independent checks that should run in parallel, prefer delegate_to_agents with 1-3 tasks in a single tool call. Each delegated scope must be narrow and evidence-oriented, with only the context_summary needed for that sub-task. Do not call one sub-agent, wait for it, then decide whether to start the next unless the tasks truly depend on each other. Do not target another agent unless the runtime explicitly exposes that capability.
6. Treat a delegate_to_agents result with status="running" as a launch acknowledgement only. It does not contain delegated findings. Do not report delegated results, do not produce a final delegated synthesis, and do not attribute parent-collected evidence to sub-agents until you receive a [Delegation Batch Complete] / delegation.batch_complete notification. While waiting, you may collect clearly labeled parent-side baseline evidence or tell the user the delegated checks are still running.
7. After delegated evidence is actually available, synthesize it in the parent answer. Update the hypotheses, confidence, and next step from the delegated evidence instead of leaving the user to inspect sub-agent cards.
8. Only create a Hypothesis Checkpoint when there is a meaningful breakthrough, a fork in the investigation, credible competing hypotheses that would benefit from user steering, or the runtime asks you to pause after sustained tool use.
9. At a Hypothesis Checkpoint, write the hypotheses in plain markdown. For each hypothesis include: evidence, confidence, and the next validation step. Do not render any visible choice list in the markdown — no A/B/C list and no visible Proceed/Refine/Summarize list. The UI will render those controls from the hidden hints. Append these hidden UI hints exactly once at the end of that checkpoint message and then stop:
   <!-- hypothesis-checkpoint -->
   <!-- suggested-replies: A|Proceed, B|Refine, C|Summarize -->
10. When the user replies:
   - "Proceed" / "A" — proceed with validating the strongest current hypothesis
   - "Refine" / "B <text>" — revise or add hypotheses based on what they wrote
   - "Summarize" / "C" — wrap up with your current best answer
   - anything else — interpret naturally
11. Document evidence as you collect it. Structure your final answer with clear sections: Findings, Root Cause, Recommendation, Caveats.

Stay in this mindset across turns until the user exits with [DP_EXIT].`;

/**
 * UI-only chip marker labels. When the frontend sends a message triggered by
 * one of these chips, the content is prefixed with `[<label>]\n` so past
 * messages can be re-rendered with a compact pill instead of the full prompt.
 * The marker is stripped here before forwarding to the agent — it is not
 * meaningful to the LLM.
 */
const CHIP_MARKER_ALLOWLIST = new Set(["Dig deeper", "Proceed", "Refine", "Summarize", "Adjust", "Skip"]);
const DELEGATION_BATCH_COMPLETE_MARKER = "[Delegation Batch Complete]";
const DP_TOOL_CALLS_BEFORE_CHECKPOINT = 20;
const DELEGATION_SYNTHESIS_BLOCK_REASON =
  "Delegated investigation results are ready. Before calling more tools, synthesize the delegated evidence for the user in a visible assistant message. Include findings, updated hypotheses, confidence, and the next step.";
const INVESTIGATION_CHECKPOINT_BLOCK_REASON =
  "Pause tool use now and write a visible Hypothesis Checkpoint before continuing. Include observed evidence, 2-5 current hypotheses, confidence, uncertainty, and the next validation step for each hypothesis. Append the hidden checkpoint UI hints exactly once: <!-- hypothesis-checkpoint --> and <!-- suggested-replies: A|Proceed, B|Refine, C|Summarize -->. Stop after this checkpoint; do not call another tool in this turn.";

function stripChipMarker(text: string): string {
  const match = text.match(/^\[([^\]]+)\]\n/);
  if (!match || !CHIP_MARKER_ALLOWLIST.has(match[1])) return text;
  return text.slice(match[0].length);
}

function extractTextContent(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

function isDelegationBatchCompleteNotification(text: string): boolean {
  return (
    text.startsWith(`${DELEGATION_BATCH_COMPLETE_MARKER}\n`) &&
    text.includes("\nDelegation ID: ") &&
    text.includes("\nEvidence capsules:") &&
    text.includes("\nSynthesize these capsules into the current investigation.")
  );
}

function hasPendingDelegationSynthesis(messages: any[]): boolean {
  let pending = false;
  for (const message of messages) {
    const text = extractTextContent(message);
    if (message?.role === "user") {
      pending = isDelegationBatchCompleteNotification(text);
      continue;
    }
    if (pending && message?.role === "assistant" && text.trim()) {
      pending = false;
    }
  }
  return pending;
}

function countToolCallsSinceVisibleAssistant(messages: any[]): number {
  let count = 0;
  for (const message of messages) {
    const text = extractTextContent(message);
    if (message?.role === "assistant" && text.trim()) {
      count = 0;
      continue;
    }
    if (message?.role === "tool" || message?.role === "toolResult") count += 1;
  }
  return count;
}

export default function deepInvestigationExtension(
  api: ExtensionAPI,
  _memoryRef?: unknown,
  dpStateRef?: MutableDpStateRef,
): void {
  let dpActive = false;
  let delegationSynthesisPending = false;
  let toolCallsSinceVisibleAssistant = 0;

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

    // Also strip any chip marker (Adjust / Skip / Proceed / Dig deeper) that
    // the frontend may have prefixed after the DP marker — those are
    // UI-only hints and must not leak into the prompt.
    const userText = stripChipMarker(event.text.slice(marker.length).trim());
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

  // --- Prefix-chip marker: strip UI-only hint ---
  //
  // Handles non-DP cases like `[Dig deeper]\n...`. (In DP mode the marker is
  // already stripped inside the `[Deep Investigation]` handler above before
  // the activation preamble is prepended — the handler-chain transform would
  // otherwise not see the marker, since it gets buried in the middle.)

  api.on("input", async (event) => {
    const stripped = stripChipMarker(event.text);
    if (stripped === event.text) return { action: "continue" as const };
    return { action: "transform" as const, text: stripped };
  });

  // --- session_start: restore dpActive from persisted entries ---

  api.on("session_start", async (_event, ctx) => {
    setActive(false);
    delegationSynthesisPending = false;
    toolCallsSinceVisibleAssistant = 0;

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
    delegationSynthesisPending = dpActive && hasPendingDelegationSynthesis(event.messages);
    toolCallsSinceVisibleAssistant = dpActive ? countToolCallsSinceVisibleAssistant(event.messages) : 0;
    return {
      messages: event.messages.filter((m: any) => !DP_FILTER_TYPES.has(m.customType)),
    };
  });

  // --- delegation synthesis barrier ---
  //
  // This is intentionally one-shot and history-derived, not a DP state
  // machine. When async delegated evidence arrives, the next model turn must
  // first produce visible synthesis before spending more tools. Once an
  // assistant text message exists after the delegation event, the context hook
  // above clears the barrier automatically.

  api.on("tool_call", async () => {
    if (!dpActive) return {};
    if (delegationSynthesisPending) {
      return {
        block: true,
        reason: DELEGATION_SYNTHESIS_BLOCK_REASON,
      };
    }
    if (toolCallsSinceVisibleAssistant >= DP_TOOL_CALLS_BEFORE_CHECKPOINT) {
      return {
        block: true,
        reason: INVESTIGATION_CHECKPOINT_BLOCK_REASON,
      };
    }
    return {};
  });
}
