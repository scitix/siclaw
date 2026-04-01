/**
 * Tool result context guard — preemptive context budget enforcement.
 *
 * Wraps the agent's `transformContext` to:
 * 1. Truncate individual oversized tool results
 * 2. Compact oldest tool results when total context exceeds budget
 * 3. Throw preemptive overflow error when context is still too large
 *
 * Ported from OpenClaw's src/agents/pi-embedded-runner/tool-result-context-guard.ts
 * with inlined char estimation (no separate module).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextGuard } from "./guard-pipeline.js";

// ── Constants ────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;

const TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const TRUNCATION_SUFFIX = `\n${TRUNCATION_NOTICE}`;
const COMPACTION_PLACEHOLDER = "[compacted: tool output removed to free context]";

export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Preemptive context overflow: estimated context size exceeds safe threshold during tool loop";

// ── Internal types ───────────────────────────────────────────────────────

type TransformContextFn = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: TransformContextFn;
};

type MessageCharEstimateCache = WeakMap<AgentMessage, number>;

// ── Char estimation (inlined from tool-result-char-estimator) ────────────

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined) return 0;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

function isToolResultMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: unknown }).role;
  const type = (msg as { type?: unknown }).type;
  return role === "toolResult" || role === "tool" || type === "toolResult";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if (!isToolResultMessage(msg)) return [];
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) {
      chars += block.text.length;
    } else if (isImageBlock(block)) {
      chars += IMAGE_CHAR_ESTIMATE;
    } else {
      chars += estimateUnknownChars(block);
    }
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

export function estimateMessageChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") return 0;

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.length;
    if (Array.isArray(content)) return estimateContentBlockChars(content);
    return 0;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const typed = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (typed.type === "text" && typeof typed.text === "string") {
          chars += typed.text.length;
        } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
          chars += typed.thinking.length;
        } else if (typed.type === "toolCall") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        } else {
          chars += estimateUnknownChars(block);
        }
      }
    }
    return chars;
  }

  if (isToolResultMessage(msg)) {
    const content = getToolResultContent(msg);
    let chars = estimateContentBlockChars(content);
    const details = (msg as { details?: unknown }).details;
    chars += estimateUnknownChars(details);
    const weightedChars = Math.ceil(chars * (CHARS_PER_TOKEN / TOOL_RESULT_CHARS_PER_TOKEN));
    return Math.max(chars, weightedChars);
  }

  return 256;
}

function createMessageCharEstimateCache(): MessageCharEstimateCache {
  return new WeakMap<AgentMessage, number>();
}

function estimateMessageCharsCached(msg: AgentMessage, cache: MessageCharEstimateCache): number {
  const hit = cache.get(msg);
  if (hit !== undefined) return hit;
  const estimated = estimateMessageChars(msg);
  cache.set(msg, estimated);
  return estimated;
}

function estimateContextChars(messages: AgentMessage[], cache: MessageCharEstimateCache): number {
  return messages.reduce((sum, msg) => sum + estimateMessageCharsCached(msg, cache), 0);
}

function invalidateMessageCharsCacheEntry(cache: MessageCharEstimateCache, msg: AgentMessage): void {
  cache.delete(msg);
}

// ── Truncation / compaction helpers ──────────────────────────────────────

export function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return TRUNCATION_NOTICE;

  const bodyBudget = Math.max(0, maxChars - TRUNCATION_SUFFIX.length);
  if (bodyBudget <= 0) return TRUNCATION_NOTICE;

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  return text.slice(0, cutPoint) + TRUNCATION_SUFFIX;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) return msg;

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) return msg;

  const rawText = getToolResultText(msg);
  if (!rawText) return replaceToolResultText(msg, TRUNCATION_NOTICE);

  const truncatedText = truncateTextToBudget(rawText, maxChars);
  return replaceToolResultText(msg, truncatedText);
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) return;

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function compactExistingToolResultsInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
}): number {
  const { messages, charsNeeded, cache } = params;
  if (charsNeeded <= 0) return 0;

  let reduced = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) continue;

    const before = estimateMessageCharsCached(msg, cache);
    if (before <= COMPACTION_PLACEHOLDER.length) continue;

    const compacted = replaceToolResultText(msg, COMPACTION_PLACEHOLDER);
    applyMessageMutationInPlace(msg, compacted, cache);
    const after = estimateMessageCharsCached(msg, cache);
    if (after >= before) continue;

    reduced += before - after;
    if (reduced >= charsNeeded) break;
  }

  return reduced;
}

// ── Main enforcement function ────────────────────────────────────────────

export function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): void {
  const { messages, contextBudgetChars, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();

  // Ensure each tool result has an upper bound before considering total context usage.
  for (const message of messages) {
    if (!isToolResultMessage(message)) continue;
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }

  let currentChars = estimateContextChars(messages, estimateCache);
  if (currentChars <= contextBudgetChars) return;

  // Compact oldest tool outputs first until the context is back under budget.
  compactExistingToolResultsInPlace({
    messages,
    charsNeeded: currentChars - contextBudgetChars,
    cache: estimateCache,
  });
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Install a context guard that enforces tool result size budgets.
 *
 * Wraps `agent.transformContext` (private in pi-coding-agent, accessed via
 * runtime cast) to truncate/compact tool results and trigger preemptive
 * overflow when context is still too large.
 */
export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
}): void {
  const guard = createContextBudgetGuard(params.contextWindowTokens);

  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const contextMessages = Array.isArray(transformed) ? transformed : messages;
    guard(contextMessages);

    return contextMessages;
  }) as TransformContextFn;
}

/**
 * Create a ContextGuard that enforces tool result size budgets.
 *
 * Truncates individual oversized results, compacts oldest results when
 * total context exceeds budget, and throws on preemptive overflow.
 */
export function createContextBudgetGuard(contextWindowTokens: number): ContextGuard {
  const tokens = Math.max(1, Math.floor(contextWindowTokens));
  const contextBudgetChars = Math.max(
    1_024,
    Math.floor(tokens * CHARS_PER_TOKEN * CONTEXT_INPUT_HEADROOM_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(tokens * TOOL_RESULT_CHARS_PER_TOKEN * SINGLE_TOOL_RESULT_CONTEXT_SHARE),
  );
  const preemptiveOverflowChars = Math.max(
    contextBudgetChars,
    Math.floor(tokens * CHARS_PER_TOKEN * PREEMPTIVE_OVERFLOW_RATIO),
  );

  return (messages: AgentMessage[]): void => {
    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars,
      maxSingleToolResultChars,
    });

    const postEnforcementChars = estimateContextChars(
      messages,
      createMessageCharEstimateCache(),
    );
    if (postEnforcementChars > preemptiveOverflowChars) {
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }
  };
}
