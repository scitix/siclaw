import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Rough character-to-token ratio for estimating context usage */
const CHARS_PER_TOKEN = 4;

/** Start soft-trimming old tool results when context exceeds this ratio */
const SOFT_TRIM_RATIO = 0.3;

/** Replace old tool results entirely when context exceeds this ratio */
const HARD_CLEAR_RATIO = 0.5;

/** Number of most-recent assistant messages whose adjacent tool results are protected */
const KEEP_LAST_ASSISTANTS = 3;

/** Only soft-trim tool results longer than this */
const SOFT_TRIM_MAX_CHARS = 4000;

/** Characters to keep at the head when soft-trimming */
const SOFT_TRIM_HEAD = 1500;

/** Characters to keep at the tail when soft-trimming */
const SOFT_TRIM_TAIL = 1500;

/** Placeholder text for hard-cleared tool results */
const HARD_CLEAR_PLACEHOLDER = "[Tool result cleared]";

export {
  CHARS_PER_TOKEN,
  SOFT_TRIM_RATIO,
  HARD_CLEAR_RATIO,
  KEEP_LAST_ASSISTANTS,
  SOFT_TRIM_MAX_CHARS,
  SOFT_TRIM_HEAD,
  SOFT_TRIM_TAIL,
  HARD_CLEAR_PLACEHOLDER,
};

/**
 * Sum total characters across all messages.
 */
export function sumChars(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          total += block.text.length;
        }
      }
    }
  }
  return total;
}

/**
 * Get the total character length of a tool result message's text content.
 */
function getToolResultLength(msg: any): number {
  if (!Array.isArray(msg.content)) return 0;
  let len = 0;
  for (const block of msg.content) {
    if (block.type === "text" && typeof block.text === "string") {
      len += block.text.length;
    }
  }
  return len;
}

/**
 * Find indexes of tool result messages that are eligible for pruning.
 * Protects tool results adjacent to the last N assistant messages.
 */
export function findPrunableToolResults(messages: any[]): number[] {
  // Find the index of the Nth-from-last assistant message
  let assistantCount = 0;
  let cutoffIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantCount++;
      if (assistantCount >= KEEP_LAST_ASSISTANTS) {
        cutoffIndex = i;
        break;
      }
    }
  }

  const prunable: number[] = [];
  for (let i = 0; i < cutoffIndex; i++) {
    if (messages[i].role === "toolResult") {
      prunable.push(i);
    }
  }
  return prunable;
}

/**
 * Soft-trim a tool result message: keep head + tail of text content.
 */
function softTrimMessage(msg: any): any {
  if (!Array.isArray(msg.content)) return msg;
  const newContent = msg.content.map((block: any) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    if (block.text.length <= SOFT_TRIM_MAX_CHARS) return block;
    const head = block.text.slice(0, SOFT_TRIM_HEAD);
    const tail = block.text.slice(-SOFT_TRIM_TAIL);
    const totalLines = block.text.split("\n").length;
    return {
      ...block,
      text: `${head}\n\n... [${totalLines} lines total, old output trimmed to save context.]\n\n${tail}`,
    };
  });
  return { ...msg, content: newContent };
}

/**
 * Hard-clear a tool result message: replace all text content with a placeholder.
 */
function hardClearMessage(msg: any): any {
  return {
    ...msg,
    content: [{ type: "text", text: HARD_CLEAR_PLACEHOLDER }],
  };
}

/**
 * Context pruning extension.
 *
 * Hooks into the "context" event (fired before each LLM call) to trim or
 * clear old tool result messages, preventing multi-turn context overflow.
 *
 * - Soft trim (context > 30%): old tool results > 4000 chars → head 1500 + tail 1500
 * - Hard clear (context > 50%): old tool results → "[Tool result cleared]"
 * - Protects the last 3 assistant messages and their tool results
 */
export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event, ctx) => {
    const contextUsage = ctx.getContextUsage();
    const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
    if (!contextWindow) return undefined;

    const charWindow = contextWindow * CHARS_PER_TOKEN;
    const messages = event.messages;
    let totalChars = sumChars(messages);
    let ratio = totalChars / charWindow;

    if (ratio < SOFT_TRIM_RATIO) return undefined;

    const prunableIndexes = findPrunableToolResults(messages);
    if (!prunableIndexes.length) return undefined;

    const next = messages.slice();

    // Soft trim: trim large tool results to head+tail
    for (const i of prunableIndexes) {
      if (ratio < SOFT_TRIM_RATIO) break;
      const len = getToolResultLength(next[i]);
      if (len <= SOFT_TRIM_MAX_CHARS) continue;
      const trimmed = softTrimMessage(next[i]);
      const saved = len - getToolResultLength(trimmed);
      next[i] = trimmed;
      totalChars -= saved;
      ratio = totalChars / charWindow;
    }

    // Hard clear: if still over threshold, replace old tool results entirely
    if (ratio >= HARD_CLEAR_RATIO) {
      for (const i of prunableIndexes) {
        if (ratio < HARD_CLEAR_RATIO) break;
        const len = getToolResultLength(next[i]);
        if (len <= HARD_CLEAR_PLACEHOLDER.length) continue;
        next[i] = hardClearMessage(next[i]);
        const saved = len - HARD_CLEAR_PLACEHOLDER.length;
        totalChars -= saved;
        ratio = totalChars / charWindow;
      }
    }

    return { messages: next };
  });
}
