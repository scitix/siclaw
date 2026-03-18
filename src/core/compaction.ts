/**
 * Compaction utilities for context window management.
 *
 * Ported from OpenClaw's src/agents/compaction.ts — wraps pi-coding-agent SDK
 * functions with security filtering and multi-stage summarization.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateTokens, generateSummary } from "@mariozechner/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────────

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;

/**
 * Default context window size when model metadata is unavailable.
 * Conservative fallback matching Anthropic's standard context windows.
 */
const DEFAULT_CONTEXT_TOKENS = 200_000;

// Overhead reserved for summarization prompt, system prompt, previous summary,
// and serialization wrappers (<conversation> tags, instructions, etc.).
// generateSummary uses reasoning: "high" which also consumes context budget.
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

const MERGE_SUMMARIES_INSTRUCTIONS = [
  "Merge these partial summaries into a single cohesive summary.",
  "",
  "MUST PRESERVE:",
  "- Active tasks and their current status (in-progress, blocked, pending)",
  "- Batch operation progress (e.g., '5/17 items completed')",
  "- The last thing the user requested and what was being done about it",
  "- Decisions made and their rationale",
  "- TODOs, open questions, and constraints",
  "- Any commitments or follow-ups promised",
  "",
  "PRIORITIZE recent context over older history. The agent needs to know",
  "what it was doing, not just what was discussed.",
].join("\n");

/** Sentinel heading used to detect structured compaction instructions. */
export const EXACT_IDENTIFIERS_HEADING = "## Exact identifiers";

export const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, tokens, API keys, hostnames, IPs, ports, URLs, and file names.";

// ── Security helpers (local, not from SDK) ───────────────────────────────

/**
 * Remove `.details` from toolResult messages.
 * SECURITY: toolResult.details can contain untrusted/verbose payloads;
 * never include in LLM-facing compaction.
 */
export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "toolResult") {
      out.push(msg);
      continue;
    }
    if (!("details" in msg)) {
      out.push(msg);
      continue;
    }
    const sanitized = { ...(msg as object) } as { details?: unknown };
    delete sanitized.details;
    touched = true;
    out.push(sanitized as unknown as AgentMessage);
  }
  return touched ? out : messages;
}

export type ToolCallLike = { id: string; name?: string };

export function extractToolCallsFromAssistant(
  msg: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
      toolCalls.push({ id: rec.id, name: typeof rec.name === "string" ? rec.name : undefined });
    }
  }
  return toolCalls;
}

export function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) return toolCallId;
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) return toolUseId;
  return null;
}

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[siclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

/**
 * Fix orphaned tool_results after dropping messages.
 *
 * Anthropic rejects transcripts where tool_results appear without a matching
 * tool_use in an assistant message. This repairs pairings by:
 * - Moving matching toolResult messages directly after their assistant toolCall turn
 * - Inserting synthetic error toolResults for missing IDs
 * - Dropping duplicate or orphaned toolResults
 */
export function repairToolUseResultPairing(messages: AgentMessage[]): {
  messages: AgentMessage[];
  droppedOrphanCount: number;
} {
  const out: AgentMessage[] = [];
  const seenToolResultIds = new Set<string>();
  let droppedOrphanCount = 0;
  let changed = false;

  const pushToolResult = (msg: Extract<AgentMessage, { role: "toolResult" }>) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      changed = true;
      return;
    }
    if (id) seenToolResultIds.add(id);
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    const stopReason = (assistant as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      out.push(msg);
      continue;
    }

    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));
    const toolCallNamesById = new Map(toolCalls.map((t) => [t.id, t.name] as const));
    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }
      const nextRole = (next as { role?: unknown }).role;
      if (nextRole === "assistant") break;

      if (nextRole === "toolResult") {
        const toolResult = next as Extract<AgentMessage, { role: "toolResult" }>;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            changed = true;
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, toolResult);
          }
          continue;
        }
      }

      if (nextRole !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    out.push(msg);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      changed = true;
    }

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name ?? toolCallNamesById.get(call.id),
        });
        changed = true;
        pushToolResult(missing);
      }
    }

    for (const rem of remainder) {
      out.push(rem);
    }
    i = j - 1;
  }

  return { messages: changed ? out : messages, droppedOrphanCount };
}

// ── Token estimation ─────────────────────────────────────────────────────

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  const safe = stripToolResultDetails(messages);
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function estimateCompactionMessageTokens(message: AgentMessage): number {
  return estimateMessagesTokens([message]);
}

// ── Message splitting ────────────────────────────────────────────────────

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) return 1;
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) return [];
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) return [messages];

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function chunkMessagesByMaxTokens(
  messages: AgentMessage[],
  maxTokens: number,
): AgentMessage[][] {
  if (messages.length === 0) return [];

  const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message);
    if (currentChunk.length > 0 && currentTokens + messageTokens > effectiveMax) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(message);
    currentTokens += messageTokens;

    if (messageTokens > effectiveMax) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

// ── Adaptive chunking ────────────────────────────────────────────────────

export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}

export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateCompactionMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

// ── Summarization with retry ─────────────────────────────────────────────

async function summarizeChunks(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const safeMessages = stripToolResultDetails(params.messages);
  const chunks = chunkMessagesByMaxTokens(safeMessages, params.maxChunkTokens);
  let summary = params.previousSummary;
  const effectiveInstructions = buildSummarizationInstructions(params.customInstructions);

  for (const chunk of chunks) {
    // Simple retry: 1 retry on failure (replaces OpenClaw's retryAsync wrapper)
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        summary = await generateSummary(
          chunk,
          params.model,
          params.reserveTokens,
          params.apiKey,
          params.signal,
          effectiveInstructions,
          summary,
        );
        lastError = undefined;
        break;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        lastError = err;
        if (attempt < 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    if (lastError) {
      // Return best-effort partial summary if earlier chunks succeeded
      if (summary) return summary;
      throw lastError;
    }
  }

  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

function buildSummarizationInstructions(customInstructions?: string): string | undefined {
  const custom = customInstructions?.trim();
  if (!custom) return IDENTIFIER_PRESERVATION_INSTRUCTIONS;
  // When custom instructions already contain structured section headings
  // (from buildCompactionStructureInstructions), pass them through directly
  // to avoid double-wrapping with identifier preservation instructions.
  if (custom.includes(EXACT_IDENTIFIERS_HEADING)) return custom;
  return `${IDENTIFIER_PRESERVATION_INSTRUCTIONS}\n\nAdditional focus:\n${custom}`;
}

// ── Summarize with fallback ──────────────────────────────────────────────

export async function summarizeWithFallback(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  const { messages, contextWindow } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Try full summarization first
  try {
    return await summarizeChunks(params);
  } catch (fullError) {
    console.warn(
      `[compaction] Full summarization failed, trying partial: ${
        fullError instanceof Error ? fullError.message : String(fullError)
      }`,
    );
  }

  // Fallback: summarize only small messages
  const smallMessages: AgentMessage[] = [];
  const oversizedNotes: string[] = [];

  for (const msg of messages) {
    if (isOversizedForSummary(msg, contextWindow)) {
      const role = (msg as { role?: string }).role ?? "message";
      const tokens = estimateCompactionMessageTokens(msg);
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
      );
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partialSummary = await summarizeChunks({ ...params, messages: smallMessages });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partialSummary + notes;
    } catch (partialError) {
      console.warn(
        `[compaction] Partial summarization also failed: ${
          partialError instanceof Error ? partialError.message : String(partialError)
        }`,
      );
    }
  }

  return (
    `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). ` +
    `Summary unavailable due to size limits.`
  );
}

// ── Multi-stage summarization ────────────────────────────────────────────

export async function summarizeInStages(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({ ...params, messages: chunk, previousSummary: undefined }),
    );
  }

  if (partialSummaries.length === 1) return partialSummaries[0];

  const summaryMessages: AgentMessage[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const custom = params.customInstructions?.trim();
  const mergeInstructions = custom
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\n${custom}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

// ── History pruning ──────────────────────────────────────────────────────

export function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const maxHistoryShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = params.messages;
  const allDroppedMessages: AgentMessage[] = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;

  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);
  let iterations = 0;

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    if (++iterations > 50) break; // defensive cap against infinite loops
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) break;

    const [dropped, ...rest] = chunks;
    const flatRest = rest.flat();
    const repairReport = repairToolUseResultPairing(flatRest);
    const repairedKept = repairReport.messages;
    const orphanedCount = repairReport.droppedOrphanCount;

    droppedChunks += 1;
    droppedMessages += dropped.length + orphanedCount;
    droppedTokens += estimateMessagesTokens(dropped);
    allDroppedMessages.push(...dropped);
    keptMessages = repairedKept;
  }

  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}

// ── Context window resolution ────────────────────────────────────────────

export function resolveContextWindowTokens(model?: ExtensionContext["model"]): number {
  return Math.max(1, Math.floor(model?.contextWindow ?? DEFAULT_CONTEXT_TOKENS));
}
