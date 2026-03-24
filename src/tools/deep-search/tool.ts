import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { investigate } from "./engine.js";
import { formatSummary } from "./format.js";
import { NORMAL_BUDGET, QUICK_BUDGET } from "./types.js";
import { Text } from "@mariozechner/pi-tui";
import { deepSearchEvents } from "./events.js";
import type { KubeconfigRef, LlmConfigRef } from "../../core/agent-factory.js";
import type { MemoryIndexer } from "../../memory/indexer.js";
import type { DpStateRef } from "../dp-tools.js";

/** Mutable ref to the shared memory indexer (set after session creation). */
export interface MemoryRef {
  indexer?: MemoryIndexer;
  dir?: string;
}

interface DeepSearchHypothesis {
  text: string;
  confidence: number;
  suggestedTools: string[];
}

interface DeepSearchParams {
  question: string;
  budget?: "normal" | "quick";
  triageContext?: string;
  hypotheses?: DeepSearchHypothesis[] | string;
}

/** Colorize status emoji keywords in already-formatted text. */
function colorizeStatus(text: string, theme: any): string {
  return text
    .replace(/✅ VALIDATED/g, theme.fg("success", "✅ VALIDATED"))
    .replace(/❌ INVALIDATED/g, theme.fg("warning", "❌ INVALIDATED"))
    .replace(/⚠️ INCONCLUSIVE/g, theme.fg("warning", "⚠️ INCONCLUSIVE"));
}

/** Convert a single line of markdown to TUI-styled text. */
function styleMarkdownLine(line: string, theme: any): string {
  // Headings: ## or ###
  const headingMatch = line.match(/^(#{2,3})\s+(.*)/);
  if (headingMatch) {
    return theme.bold(theme.fg("accent", headingMatch[2]));
  }

  // Bullet list: - item
  if (/^- /.test(line)) {
    let content = line.slice(2);
    // Inline bold: **text**
    content = content.replace(/\*\*(.+?)\*\*/g, (_: string, t: string) => theme.bold(t));
    // Inline code: `text`
    content = content.replace(/`(.+?)`/g, (_: string, t: string) => theme.fg("warning", t));
    // Inline italic: *text* (strip markers only)
    content = content.replace(/\*(.+?)\*/g, "$1");
    return colorizeStatus("  • " + content, theme);
  }

  // Indented continuation (e.g., reasoning under hypothesis)
  if (/^  \S/.test(line)) {
    let content = line.slice(2);
    content = content.replace(/\*\*(.+?)\*\*/g, (_: string, t: string) => theme.bold(t));
    content = content.replace(/`(.+?)`/g, (_: string, t: string) => theme.fg("warning", t));
    return "    " + theme.fg("muted", content);
  }

  // Plain line with possible inline formatting
  let styled = line;
  const hasBold = /\*\*(.+?)\*\*/.test(styled);
  const hasCode = /`(.+?)`/.test(styled);
  const hasItalic = /\*(.+?)\*/.test(styled);

  if (hasBold || hasCode || hasItalic) {
    styled = styled.replace(/\*\*(.+?)\*\*/g, (_: string, t: string) => theme.bold(t));
    styled = styled.replace(/`(.+?)`/g, (_: string, t: string) => theme.fg("warning", t));
    styled = styled.replace(/\*(.+?)\*/g, "$1");
    return colorizeStatus(styled, theme);
  }

  return theme.fg("toolOutput", line);
}

/** Default collapsed: show Statistics section only. Expand with ctrl+o to see full report. */
function renderDeepSearchResult(result: any, options: any, theme: any) {
  const textBlocks = (result.content || []).filter((c: any) => c.type === "text");
  const output: string = textBlocks.map((c: any) => c.text || "").join("\n").trim();
  if (!output) return new Text("", 0, 0);

  // Web mode: theme is not initialized, return plain text
  if (!theme?.bold || !theme?.fg) {
    return new Text(output, 0, 0);
  }

  const lines = output.split("\n");

  if (options.expanded) {
    const styled = lines.map((l: string) => styleMarkdownLine(l, theme));
    return new Text("\n" + styled.join("\n"), 0, 0);
  }

  // Collapsed: show Hypothesis Verdicts + Statistics (skip Conclusion which can be long)
  const verdictsIdx = lines.findIndex((l: string) => l.startsWith("### Hypothesis Verdicts"));
  const previewLines = verdictsIdx >= 0 ? lines.slice(verdictsIdx) : lines.slice(-8);
  const styled = previewLines.map((l: string) => styleMarkdownLine(l, theme));
  const skipped = lines.length - previewLines.length;
  const hint = skipped > 0
    ? theme.fg("muted", `... (${skipped} lines hidden, ctrl+o to expand)`)
    : "";
  return new Text("\n" + (hint ? hint + "\n" : "") + styled.join("\n"), 0, 0);
}

export function createDeepSearchTool(kubeconfigRef?: KubeconfigRef, llmConfigRef?: LlmConfigRef, memoryRef?: MemoryRef, dpStateRef?: DpStateRef): ToolDefinition {
  return {
    name: "deep_search",
    label: "Deep Search",
    description: `Perform parallel hypothesis validation for a Kubernetes infrastructure issue.

IMPORTANT: This tool is only available in Deep Investigation mode (activated via /dp, Ctrl+I, or the magnifying glass toggle).

This tool launches independent sub-agents to validate hypotheses with targeted tool calls.
You must complete the investigation-and-confirm cycle before calling this tool:
1. Triage: run commands to gather context
2. Propose: call propose_hypotheses with your findings and hypotheses
3. Wait: the user must confirm your hypotheses
4. Execute: call deep_search — hypotheses and triageContext are automatically provided from the confirmed data

Do NOT call this tool without user confirmation of hypotheses.
Do NOT use for simple queries that can be answered with 1-2 kubectl commands.`,
    parameters: Type.Object({
      question: Type.String({
        description:
          "The investigation question, e.g. 'Why is pod X in CrashLoopBackOff in namespace Y?'",
      }),
      budget: Type.Optional(
        Type.Union([Type.Literal("normal"), Type.Literal("quick")], {
          description:
            'Budget preset: "normal" (60 tool calls max, 5 hypotheses) or "quick" (30 tool calls, 3 hypotheses). Default: normal.',
        }),
      ),
      triageContext: Type.Optional(
        Type.String({
          description:
            "Pre-gathered context from triage. When provided, Phase 1 (context gathering) is skipped " +
            "and its budget is redistributed to Phase 3 validation. " +
            "Should include: cluster mode, relevant pods/namespaces, node info, key observations.",
        }),
      ),
      hypotheses: Type.Optional(
        Type.Union([
          Type.Array(
            Type.Object({
              text: Type.String({ description: "Specific hypothesis description" }),
              confidence: Type.Number({ description: "Prior belief 0-100" }),
              suggestedTools: Type.Array(Type.String(), {
                description: 'Validation commands, e.g. "bash: skills/core/roce-pcie-link/scripts/pcie-link.sh --node X"',
              }),
            }),
          ),
          Type.String({ description: "JSON-encoded array of hypotheses (fallback for models that serialize arrays as strings)" }),
        ], {
          description:
            "Pre-confirmed hypotheses from user. When provided, Phase 2 (hypothesis generation) is skipped. " +
            "Use skill script paths in suggestedTools for best results.",
        }),
      ),
    }),
    renderResult: renderDeepSearchResult,
    async execute(_toolCallId, rawParams) {
      // --- DP mode runtime gate ---
      if (!dpStateRef || dpStateRef.status === "idle") {
        return {
          content: [{ type: "text", text:
            "deep_search is only available in Deep Investigation mode.\n" +
            "In normal mode, use standard tools (bash, run_skill) for lightweight diagnostics.\n" +
            "To activate: use /dp command, Ctrl+I shortcut, or the magnifying glass toggle in web UI." }],
          details: { error: true, reason: "not_in_dp_mode" },
        };
      }
      if (dpStateRef.status === "awaiting_confirmation") {
        return {
          content: [{ type: "text", text:
            "Cannot execute deep_search: hypotheses have not been confirmed yet.\n" +
            "Wait for the user to review and confirm the proposed hypotheses before proceeding." }],
          details: { error: true, reason: "awaiting_confirmation" },
        };
      }
      if (dpStateRef.status !== "validating") {
        return {
          content: [{ type: "text", text:
            `Cannot execute deep_search: current DP status is "${dpStateRef.status}".\n` +
            "deep_search can only run when status is 'validating' (after user confirms hypotheses)." }],
          details: { error: true, reason: "invalid_status" },
        };
      }

      const params = rawParams as DeepSearchParams;
      const budget = params.budget === "quick" ? QUICK_BUDGET : NORMAL_BUDGET;

      // --- Resolve hypotheses: prefer confirmed state, fallback to tool params ---
      let hypotheses: DeepSearchHypothesis[] | undefined;
      if (dpStateRef.confirmedHypotheses && dpStateRef.confirmedHypotheses.length > 0) {
        // Use confirmed data from state machine (source of truth)
        hypotheses = dpStateRef.confirmedHypotheses.map(h => ({
          text: h.text,
          confidence: h.confidence,
          suggestedTools: [], // suggestedTools not tracked in DpHypothesis — engine will infer
        }));
      } else if (typeof params.hypotheses === "string") {
        try {
          const parsed = JSON.parse(params.hypotheses);
          hypotheses = Array.isArray(parsed) ? parsed : parsed?.hypotheses;
        } catch {
          hypotheses = undefined;
        }
      } else if (Array.isArray(params.hypotheses)) {
        hypotheses = params.hypotheses;
      }

      // --- Hard reject if no confirmed hypotheses available ---
      if (!hypotheses || hypotheses.length === 0) {
        return {
          content: [{ type: "text", text:
            "Cannot execute deep_search: no confirmed hypotheses available.\n" +
            "The investigation loop must complete before deep_search can run:\n" +
            "1. Call propose_hypotheses with triageContext and hypotheses\n" +
            "2. Wait for user to confirm\n" +
            "3. Then call deep_search — confirmed hypotheses are provided automatically." }],
          details: { error: true, reason: "no_hypotheses" },
        };
      }

      // --- Resolve triageContext: prefer state, fallback to tool params ---
      const triageContext = dpStateRef.triageContextDraft || params.triageContext;
      if (!triageContext) {
        return {
          content: [{ type: "text", text:
            "Cannot execute deep_search: no triage context available.\n" +
            "The main agent must provide triageContext when calling propose_hypotheses.\n" +
            "This context is automatically passed to deep_search after user confirms." }],
          details: { error: true, reason: "no_triage_context" },
        };
      }

      try {
        const result = await investigate(params.question, {
          budget,
          triageContext,
          hypotheses,
          kubeconfigRef,
          // Pass current main model's LLM config to sub-agents
          apiKey: llmConfigRef?.apiKey,
          baseUrl: llmConfigRef?.baseUrl,
          model: llmConfigRef?.model,
          api: llmConfigRef?.api,
          onProgress: (event) => deepSearchEvents.emit("progress", event),
          // Pass memory refs for investigation history retrieval and persistence
          memoryIndexer: memoryRef?.indexer,
          memoryDir: memoryRef?.dir,
        });
        const summary = formatSummary(result);
        return {
          content: [{ type: "text", text: summary }],
          details: {
            dpStatus: "concluding" as const,
            investigationId: result.investigationId,
            totalToolCalls: result.totalToolCalls,
            durationMs: result.totalDurationMs,
            hypothesesValidated: result.hypotheses.filter((h) => h.status === "validated").length,
            hypothesesTotal: result.hypotheses.length,
            hypotheses: result.hypotheses.map((h) => ({
              id: h.id,
              text: h.text,
              status: h.status,
              confidence: h.confidence,
              reasoning: h.reasoning,
              toolCallsUsed: h.toolCallsUsed,
              evidence: h.evidence.map((e) => ({
                tool: e.tool,
                command: e.command.length > 100 ? e.command.slice(0, 97) + "..." : e.command,
                outputPreview: e.output?.trim()
                  ? (e.output.trim().length > 200 ? e.output.trim().slice(0, 197) + "..." : e.output.trim())
                  : "",
                interpretation: e.interpretation,
              })),
            })),
          },
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Deep search failed: ${errMsg}` }],
          details: { error: true },
        };
      }
    },
  };
}
