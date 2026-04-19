/**
 * Compaction safeguard extension.
 *
 * Takes over the `session_before_compact` hook to generate a structured summary
 * directly via LLM call, instead of injecting flush messages that can trigger
 * infinite agent loops (the OOM crash root cause).
 *
 * Ported from OpenClaw's src/agents/pi-extensions/compaction-safeguard.ts,
 * simplified for Siclaw (no runtime registry, no agent context injection,
 * no language-preservation instructions).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import {
  EXACT_IDENTIFIERS_HEADING,
  SUMMARIZATION_OVERHEAD_TOKENS,
  SAFETY_MARGIN,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  extractToolCallsFromAssistant,
  extractToolResultId,
  pruneHistoryForContextShare,
  repairToolUseResultPairing,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";

// ── Constants ────────────────────────────────────────────────────────────

const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const MAX_EXTRACTED_IDENTIFIERS = 12;

const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  EXACT_IDENTIFIERS_HEADING,
] as const;

const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";

const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request," +
  " early progress, and any details needed to understand the retained suffix.";

const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";

const MAX_INSTRUCTION_LENGTH = 800;

// ── Types ────────────────────────────────────────────────────────────────

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

// ── Small helpers ────────────────────────────────────────────────────────

function clampNonNegativeInt(value: unknown, fallback: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(normalized));
}

function truncateUnicodeSafe(s: string, maxCodePoints: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxCodePoints) return s;
  return chars.slice(0, maxCodePoints).join("");
}

function resolveCompactionInstructions(eventInstructions?: string): string {
  const trimmed = eventInstructions?.trim();
  const resolved = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_COMPACTION_INSTRUCTIONS;
  return truncateUnicodeSafe(resolved, MAX_INSTRUCTION_LENGTH);
}

// ── Message inspection ───────────────────────────────────────────────────

function isRealConversationMessage(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }
  return parts.join("\n").trim();
}

function collectTextContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  return parts;
}

// ── Tool failure collection ──────────────────────────────────────────────

function normalizeFailureText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateFailureText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? record.exitCode
      : undefined;
  const parts: string[] = [];
  if (status) parts.push(`status=${status}`);
  if (exitCode !== undefined) parts.push(`exitCode=${exitCode}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role !== "toolResult") continue;
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (toolResult.isError !== true) continue;
    const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) continue;
    seen.add(toolCallId);

    const toolName =
      typeof toolResult.toolName === "string" && toolResult.toolName.trim()
        ? toolResult.toolName
        : "tool";
    const rawText = collectTextContentBlocks(toolResult.content).join("\n");
    const meta = formatToolFailureMeta(toolResult.details);
    const normalized = normalizeFailureText(rawText);
    const summary = truncateFailureText(
      normalized || (meta ? "failed" : "failed (no output)"),
      MAX_TOOL_FAILURE_CHARS,
    );
    failures.push({ toolCallId, toolName, summary, meta });
  }
  return failures;
}

function formatToolFailuresSection(failures: ToolFailure[]): string {
  if (failures.length === 0) return "";
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}

// ── File operations formatting ───────────────────────────────────────────

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

// ── Recent turns preservation ────────────────────────────────────────────

function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    clampNonNegativeInt(params.recentTurnsPreserve, 0),
  );
  if (preserveTurns <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  const conversationIndexes: number[] = [];
  const userIndexes: number[] = [];
  for (let i = 0; i < params.messages.length; i += 1) {
    const role = (params.messages[i] as { role?: unknown }).role;
    if (role === "user" || role === "assistant") {
      conversationIndexes.push(i);
      if (role === "user") userIndexes.push(i);
    }
  }
  if (conversationIndexes.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  const preservedIndexSet = new Set<number>();
  if (userIndexes.length >= preserveTurns) {
    const boundaryStartIndex = userIndexes[userIndexes.length - preserveTurns] ?? -1;
    if (boundaryStartIndex >= 0) {
      for (const index of conversationIndexes) {
        if (index >= boundaryStartIndex) preservedIndexSet.add(index);
      }
    }
  } else {
    const fallbackMessageCount = preserveTurns * 2;
    for (const userIndex of userIndexes) preservedIndexSet.add(userIndex);
    for (let i = conversationIndexes.length - 1; i >= 0; i -= 1) {
      const index = conversationIndexes[i];
      if (index === undefined) continue;
      preservedIndexSet.add(index);
      if (preservedIndexSet.size >= fallbackMessageCount) break;
    }
  }
  if (preservedIndexSet.size === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  // Collect tool call IDs from preserved assistant messages
  const preservedToolCallIds = new Set<string>();
  for (let i = 0; i < params.messages.length; i += 1) {
    if (!preservedIndexSet.has(i)) continue;
    const message = params.messages[i];
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const toolCalls = extractToolCallsFromAssistant(
      message as Extract<AgentMessage, { role: "assistant" }>,
    );
    for (const toolCall of toolCalls) preservedToolCallIds.add(toolCall.id);
  }

  // Include matching toolResult messages in the preserved set
  if (preservedToolCallIds.size > 0) {
    let preservedStartIndex = -1;
    for (let i = 0; i < params.messages.length; i += 1) {
      if (preservedIndexSet.has(i)) {
        preservedStartIndex = i;
        break;
      }
    }
    if (preservedStartIndex >= 0) {
      for (let i = preservedStartIndex; i < params.messages.length; i += 1) {
        const message = params.messages[i];
        if ((message as { role?: unknown }).role !== "toolResult") continue;
        const toolResultId = extractToolResultId(
          message as Extract<AgentMessage, { role: "toolResult" }>,
        );
        if (toolResultId && preservedToolCallIds.has(toolResultId)) {
          preservedIndexSet.add(i);
        }
      }
    }
  }

  const summarizableMessages = params.messages.filter((_, idx) => !preservedIndexSet.has(idx));
  const repairedSummarizableMessages = repairToolUseResultPairing(summarizableMessages).messages;
  const preservedMessages = params.messages
    .filter((_, idx) => preservedIndexSet.has(idx))
    .filter((msg) => {
      const role = (msg as { role?: unknown }).role;
      return role === "user" || role === "assistant" || role === "toolResult";
    });
  return { summarizableMessages: repairedSummarizableMessages, preservedMessages };
}

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return null;
  if (!Array.isArray(content)) return "[non-text content]";
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typeRaw = (block as { type?: unknown }).type;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") continue;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  if (typeCounts.size === 0) return null;
  const parts = [...typeCounts.entries()].map(([type, count]) =>
    count > 1 ? `${type} x${count}` : type,
  );
  return `[non-text content: ${parts.join(", ")}]`;
}

function formatPreservedTurnsSection(messages: AgentMessage[]): string {
  if (messages.length === 0) return "";
  const lines = messages
    .map((message) => {
      let roleLabel: string;
      if (message.role === "assistant") {
        roleLabel = "Assistant";
      } else if (message.role === "user") {
        roleLabel = "User";
      } else if (message.role === "toolResult") {
        const toolName = (message as { toolName?: unknown }).toolName;
        const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
        roleLabel = `Tool result (${safeToolName})`;
      } else {
        return null;
      }
      const text = extractMessageText(message);
      const nonTextPlaceholder = formatNonTextPlaceholder(
        (message as { content?: unknown }).content,
      );
      const rendered =
        text && nonTextPlaceholder ? `${text}\n${nonTextPlaceholder}` : text || nonTextPlaceholder;
      if (!rendered) return null;
      const trimmed =
        rendered.length > MAX_RECENT_TURN_TEXT_CHARS
          ? `${rendered.slice(0, MAX_RECENT_TURN_TEXT_CHARS)}...`
          : rendered;
      return `- ${roleLabel}: ${trimmed}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return "";
  return `\n\n## Recent turns preserved verbatim\n${lines.join("\n")}`;
}

// ── Structured summary instructions ──────────────────────────────────────

function buildCompactionStructureInstructions(customInstructions?: string): string {
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    STRICT_EXACT_IDENTIFIERS_INSTRUCTION,
    "Do not omit unresolved asks from the user.",
  ].join("\n");
  const custom = customInstructions?.trim();
  if (!custom) return sectionsTemplate;
  return `${sectionsTemplate}\n\nAdditional context:\n${custom}`;
}

// ── Fallback summary ─────────────────────────────────────────────────────

function buildStructuredFallbackSummary(previousSummary: string | undefined): string {
  const trimmed = previousSummary?.trim() ?? "";
  if (trimmed && hasRequiredSummarySections(trimmed)) return trimmed;
  return [
    "## Decisions",
    trimmed || "No prior history.",
    "",
    "## Open TODOs",
    "None.",
    "",
    "## Constraints/Rules",
    "None.",
    "",
    "## Pending user asks",
    "None.",
    "",
    "## Exact identifiers",
    "None captured.",
  ].join("\n");
}

// ── Quality auditing ─────────────────────────────────────────────────────

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

function extractOpaqueIdentifiers(text: string): string[] {
  const matches =
    text.match(
      /([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g,
    ) ?? [];

  const sanitize = (value: string): string =>
    value.trim().replace(/^[("'`[{<]+/, "").replace(/[)\]"'`,;:.!?<>]+$/, "");

  const normalize = (value: string): string =>
    /^[A-Fa-f0-9]{8,}$/.test(value) ? value.toUpperCase() : value;

  return Array.from(
    new Set(
      matches
        .map((v) => sanitize(v))
        .map((v) => normalize(v))
        .filter((v) => v.length >= 4),
    ),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== "user") continue;
    const text = extractMessageText(messages[i]);
    if (text) return text;
  }
  return null;
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (/^[A-Fa-f0-9]{8,}$/.test(identifier)) {
    return summary.toUpperCase().includes(identifier.toUpperCase());
  }
  return summary.includes(identifier);
}

// Common stopwords that inflate overlap counts without carrying meaning.
// Covers English + high-frequency Chinese function words.
const OVERLAP_STOP_WORDS = new Set([
  // English
  "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can",
  "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "into", "through", "during",
  "it", "its", "this", "that", "these", "those", "what", "which",
  "who", "whom", "how", "when", "where", "why",
  "not", "no", "nor", "so", "if", "then", "than", "too", "very",
  "just", "about", "up", "out", "all", "also", "get", "got",
  "help", "need", "want", "thing", "stuff", "some", "any",
  // Chinese function words
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
  "都", "一", "个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "这", "那", "吗", "呢",
]);

function tokenizeOverlapText(text: string): string[] {
  const normalized = text.toLocaleLowerCase().normalize("NFKC").trim();
  if (!normalized) return [];
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Check if a token is a CJK character (single-char tokens from CJK splitting). */
function isCjkChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.codePointAt(0)!;
  // CJK Unified Ideographs + Extension A
  return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF);
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  if (!latestAsk) return true;
  const askTokens = Array.from(new Set(tokenizeOverlapText(latestAsk))).slice(0, 12);
  if (askTokens.length === 0) return true;
  // Filter out stopwords so only meaningful terms drive the overlap check
  const meaningfulTokens = askTokens.filter(
    (t) => t.length > 1 && !OVERLAP_STOP_WORDS.has(t),
  );
  const tokensToCheck = meaningfulTokens.length > 0 ? meaningfulTokens : askTokens;
  if (tokensToCheck.length === 0) return true;
  const summaryLower = summary.toLocaleLowerCase().normalize("NFKC");
  const summaryTokens = new Set(tokenizeOverlapText(summary));
  let overlapCount = 0;
  for (const token of tokensToCheck) {
    // For single CJK characters, use substring matching instead of exact token match
    // since Unicode word-boundary splitting yields individual characters that rarely
    // match as standalone tokens in the summary.
    if (isCjkChar(token)) {
      if (summaryLower.includes(token)) overlapCount += 1;
    } else {
      if (summaryTokens.has(token)) overlapCount += 1;
    }
  }
  const requiredMatches = tokensToCheck.length >= 3 ? 2 : 1;
  return overlapCount >= requiredMatches;
}

function auditSummaryQuality(params: {
  summary: string;
  identifiers: string[];
  latestAsk: string | null;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.summary));
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) reasons.push(`missing_section:${section}`);
  }
  const missingIdentifiers = params.identifiers.filter(
    (id) => !summaryIncludesIdentifier(params.summary, id),
  );
  if (missingIdentifiers.length > 0) {
    reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
  }
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Summary assembly helpers ─────────────────────────────────────────────

function appendSummarySection(summary: string, section: string): string {
  if (!section) return summary;
  if (!summary.trim()) return section.trimStart();
  return `${summary}${section}`;
}

// ── Extension entry point ────────────────────────────────────────────────

export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions: eventInstructions, signal } = event;

    // ── Empty conversation guard ──
    //
    // If prepareCompaction surfaced a request with zero summarizable content,
    // writing the empty-skeleton fallback is actively harmful: the skeleton
    // passes `hasRequiredSummarySections()`, so future compactions read it
    // back as `previousSummary` and preserve it verbatim — the agent then
    // sees a "Decisions: None / Pending asks: None / ..." system block that
    // overrides whatever it should have remembered. User-visible symptom:
    // "agent forgets everything after a few turns."
    //
    // Paths:
    //   - No prior summary either → cancel; there is genuinely nothing to
    //     summarize and pi-agent won't re-trigger immediately (context still
    //     fits or the reserve-tokens threshold hasn't moved).
    //   - Prior summary exists → keep it verbatim. It was already a real
    //     summary from an earlier compaction; overwriting it with "None."
    //     placeholders would erase live memory.
    const hasRealSummarizable = preparation.messagesToSummarize.some(isRealConversationMessage);
    const hasRealTurnPrefix = preparation.turnPrefixMessages.some(isRealConversationMessage);
    if (!hasRealSummarizable && !hasRealTurnPrefix) {
      const prevTrimmed = preparation.previousSummary?.trim() ?? "";
      const hasPriorSummary = prevTrimmed.length > 0 && hasRequiredSummarySections(prevTrimmed);
      console.log(
        `[compaction-safeguard] No real conversation messages to summarize ` +
          `(messagesToSummarize=${preparation.messagesToSummarize.length}, ` +
          `turnPrefixMessages=${preparation.turnPrefixMessages.length}, ` +
          `hasPriorSummary=${hasPriorSummary}).`,
      );
      if (!hasPriorSummary) {
        // No prior summary — cancel instead of inventing an empty one.
        return { cancel: true };
      }
      return {
        compaction: {
          summary: prevTrimmed,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    }

    // ── Extract file ops & tool failures ──
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailures = collectToolFailures([
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]);
    const toolFailureSection = formatToolFailuresSection(toolFailures);

    // ── Resolve model + API key ──
    const customInstructions = resolveCompactionInstructions(eventInstructions);
    const model = ctx.model;
    if (!model) {
      console.warn(
        "[compaction-safeguard] ctx.model is undefined; cancelling compaction to preserve history.",
      );
      return { cancel: true };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      console.warn(
        "[compaction-safeguard] No API key available; cancelling compaction to preserve history.",
      );
      return { cancel: true };
    }

    try {
      const contextWindowTokens = resolveContextWindowTokens(model);
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      let messagesToSummarize = preparation.messagesToSummarize;
      const recentTurnsPreserve = DEFAULT_RECENT_TURNS_PRESERVE;
      const qualityGuardMaxRetries = DEFAULT_QUALITY_GUARD_MAX_RETRIES;
      const structuredInstructions = buildCompactionStructureInstructions(customInstructions);

      const maxHistoryShare = 0.5;
      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      // ── Token budget check ──
      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        const maxHistoryTokens = Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN);

        if (newContentTokens > maxHistoryTokens) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToSummarize,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
          if (pruned.droppedChunks > 0) {
            const newContentRatio = (newContentTokens / contextWindowTokens) * 100;
            console.warn(
              `[compaction-safeguard] New content uses ${newContentRatio.toFixed(
                1,
              )}% of context; dropped ${pruned.droppedChunks} older chunk(s) ` +
                `(${pruned.droppedMessages} messages) to fit history budget.`,
            );
            messagesToSummarize = pruned.messages;

            if (pruned.droppedMessagesList.length > 0) {
              try {
                const droppedChunkRatio = computeAdaptiveChunkRatio(
                  pruned.droppedMessagesList,
                  contextWindowTokens,
                );
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio) -
                    SUMMARIZATION_OVERHEAD_TOKENS,
                );
                droppedSummary = await summarizeInStages({
                  messages: pruned.droppedMessagesList,
                  model,
                  apiKey,
                  signal,
                  reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
                  maxChunkTokens: droppedMaxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions: structuredInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                console.warn(
                  `[compaction-safeguard] Failed to summarize dropped messages: ${
                    droppedError instanceof Error ? droppedError.message : String(droppedError)
                  }`,
                );
              }
            }
          }
        }
      }

      // ── Recent turns preservation ──
      // Extract latestUserAsk BEFORE splitting so it reflects the actual most recent ask,
      // not an older one left after preserved turns are removed.
      const latestUserAsk = extractLatestUserAsk([...messagesToSummarize, ...turnPrefixMessages]);
      const {
        summarizableMessages: summaryTargetMessages,
        preservedMessages: preservedRecentMessages,
      } = splitPreservedRecentTurns({
        messages: messagesToSummarize,
        recentTurnsPreserve,
      });
      messagesToSummarize = summaryTargetMessages;
      const preservedTurnsSection = formatPreservedTurnsSection(preservedRecentMessages);
      const identifierSeedText = [...messagesToSummarize, ...turnPrefixMessages]
        .slice(-10)
        .map((message) => extractMessageText(message))
        .filter(Boolean)
        .join("\n");
      const identifiers = extractOpaqueIdentifiers(identifierSeedText);

      // ── Summarize with adaptive chunk ratio ──
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const adaptiveRatio = computeAdaptiveChunkRatio(allMessages, contextWindowTokens);
      const maxChunkTokens = Math.max(
        1,
        Math.floor(contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
      );
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      let summary = "";
      let currentInstructions = structuredInstructions;
      const totalAttempts = qualityGuardMaxRetries + 1;
      let lastSuccessfulSummary: string | null = null;

      // ── Quality guard retry loop ──
      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        let summaryWithoutPreservedTurns = "";
        let summaryWithPreservedTurns = "";
        try {
          const historySummary =
            messagesToSummarize.length > 0
              ? await summarizeInStages({
                  messages: messagesToSummarize,
                  model,
                  apiKey,
                  signal,
                  reserveTokens,
                  maxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions: currentInstructions,
                  previousSummary: effectivePreviousSummary,
                })
              : buildStructuredFallbackSummary(effectivePreviousSummary);

          summaryWithoutPreservedTurns = historySummary;

          // Handle split turn prefix
          if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
            const composedTurnInstructions = [
              TURN_PREFIX_INSTRUCTIONS,
              "Additional requirements:",
              currentInstructions,
            ].join("\n\n");
            const prefixSummary = await summarizeInStages({
              messages: turnPrefixMessages,
              model,
              apiKey,
              signal,
              reserveTokens,
              maxChunkTokens,
              contextWindow: contextWindowTokens,
              customInstructions: composedTurnInstructions,
              previousSummary: undefined,
            });
            const splitTurnSection = `**Turn Context (split turn):**\n\n${prefixSummary}`;
            summaryWithoutPreservedTurns = historySummary.trim()
              ? `${historySummary}\n\n---\n\n${splitTurnSection}`
              : splitTurnSection;
          }

          summaryWithPreservedTurns = appendSummarySection(
            summaryWithoutPreservedTurns,
            preservedTurnsSection,
          );
        } catch (attemptError) {
          if (lastSuccessfulSummary && attempt > 0) {
            console.warn(
              `[compaction-safeguard] Quality retry failed on attempt ${attempt + 1}; ` +
                `keeping last successful summary: ${
                  attemptError instanceof Error ? attemptError.message : String(attemptError)
                }`,
            );
            summary = lastSuccessfulSummary;
            break;
          }
          throw attemptError;
        }
        lastSuccessfulSummary = summaryWithPreservedTurns;

        const canRegenerate =
          messagesToSummarize.length > 0 ||
          (preparation.isSplitTurn && turnPrefixMessages.length > 0);
        if (!canRegenerate) {
          summary = summaryWithPreservedTurns;
          break;
        }

        const quality = auditSummaryQuality({
          summary: summaryWithoutPreservedTurns,
          identifiers,
          latestAsk: latestUserAsk,
        });
        summary = summaryWithPreservedTurns;
        if (quality.ok || attempt >= totalAttempts - 1) break;

        const reasons = quality.reasons.join(", ");
        console.log(
          `[compaction-safeguard] Quality audit failed (attempt ${attempt + 1}): ${reasons}`,
        );
        currentInstructions =
          `${structuredInstructions}\n\n` +
          `Fix all issues and include every required section with exact identifiers preserved.\n\n` +
          `Previous summary failed quality checks (${reasons}).`;
      }

      // ── Assemble final summary ──
      summary = appendSummarySection(summary, toolFailureSection);
      summary = appendSummarySection(summary, fileOpsSummary);

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch (error) {
      console.warn(
        `[compaction-safeguard] Summarization failed; cancelling compaction to preserve history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { cancel: true };
    }
  });
}
