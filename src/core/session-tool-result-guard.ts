/**
 * Session tool result guard — write-time validation for session history.
 *
 * Monkey-patches sessionManager.appendMessage to:
 * 1. Drop malformed tool call blocks from assistant messages before persistence
 * 2. Track pending tool calls and insert synthetic error results for orphans
 * 3. Truncate oversized tool results to prevent context window bloat
 *
 * Ported from OpenClaw's session-tool-result-guard.ts (simplified —
 * no plugin hooks, no transcript events).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { extractToolCallsFromAssistant, extractToolResultId } from "./message-utils.js";
import { sanitizeToolCallInputs } from "./tool-call-repair.js";
import type { PersistGuard } from "./guard-pipeline.js";
import { guardLog } from "./guard-log.js";

// ── Tool result truncation ──────────────────────────────────────────────

const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
const MIN_KEEP_CHARS = 2_000;
const TRUNCATION_SUFFIX =
  "\n\n[Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";
const MIDDLE_OMISSION_MARKER =
  "\n\n[... middle content omitted — showing head and tail ...]\n\n";

function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

function truncateToolResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(MIN_KEEP_CHARS, maxChars - TRUNCATION_SUFFIX.length);

  if (hasImportantTail(text) && budget > MIN_KEEP_CHARS * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;
    if (headBudget > MIN_KEEP_CHARS) {
      let headCut = headBudget;
      const headNewline = text.lastIndexOf("\n", headBudget);
      if (headNewline > headBudget * 0.8) headCut = headNewline;

      let tailStart = text.length - tailBudget;
      const tailNewline = text.indexOf("\n", tailStart);
      if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) tailStart = tailNewline + 1;

      return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart) + TRUNCATION_SUFFIX;
    }
  }

  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) cutPoint = lastNewline;
  return text.slice(0, cutPoint) + TRUNCATION_SUFFIX;
}

function capToolResultSize(msg: AgentMessage): AgentMessage {
  if ((msg as { role?: string }).role !== "toolResult") return msg;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return msg;

  let totalChars = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
      totalChars += (block as any).text.length;
    }
  }
  if (totalChars <= HARD_MAX_TOOL_RESULT_CHARS) return msg;

  const newContent = content.map((block: any) => {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return block;
    const blockShare = block.text.length / totalChars;
    const blockBudget = Math.max(MIN_KEEP_CHARS + TRUNCATION_SUFFIX.length, Math.floor(HARD_MAX_TOOL_RESULT_CHARS * blockShare));
    return { ...block, text: truncateToolResultText(block.text, blockBudget) };
  });
  return { ...msg, content: newContent } as unknown as AgentMessage;
}

function makeSyntheticToolResult(toolCallId: string, toolName?: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[siclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

export function installSessionToolResultGuard(sessionManager: SessionManager): void {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const guard = createSessionToolResultGuard();

  sessionManager.appendMessage = ((message: AgentMessage) => {
    const results = guard(message);
    for (const msg of results) {
      originalAppend(msg as never);
    }
  }) as SessionManager["appendMessage"];
}

/**
 * Create a PersistGuard for session tool result validation.
 *
 * Returns a function that takes a message and returns an array of messages
 * to actually persist:
 * - Empty array: message is dropped (e.g. orphaned toolResult)
 * - Single element: message passes through (possibly sanitized/truncated)
 * - Multiple elements: synthetic results flushed before the message
 */
export function createSessionToolResultGuard(): PersistGuard {
  const pending = new Map<string, string | undefined>(); // tool call id → tool name
  const droppedToolCallIds = new Set<string>();

  const flushPending = (): AgentMessage[] => {
    if (pending.size === 0) return [];
    const results: AgentMessage[] = [];
    for (const [id, name] of pending) {
      results.push(makeSyntheticToolResult(id, name));
    }
    pending.clear();
    return results;
  };

  return (message: AgentMessage): AgentMessage[] => {
    const role = (message as { role?: unknown }).role;

    if (role === "assistant") {
      // Track IDs of tool calls that will be dropped by sanitization
      const contentBefore = Array.isArray((message as any).content) ? (message as any).content : [];
      const idsBefore = new Set<string>();
      for (const block of contentBefore) {
        if (block && typeof block === "object" && typeof block.id === "string" && block.id) {
          const type = block.type;
          if (type === "toolCall" || type === "toolUse" || type === "functionCall") {
            idsBefore.add(block.id);
          }
        }
      }

      const sanitized = sanitizeToolCallInputs([message]);
      if (sanitized.length === 0) {
        guardLog("session-tool-result-guard", "dropped-assistant", { reason: "all tool call blocks malformed" });
        for (const id of idsBefore) droppedToolCallIds.add(id);
        return flushPending();
      }
      const nextMessage = sanitized[0] as Extract<AgentMessage, { role: "assistant" }>;

      // Find which IDs were dropped by sanitization
      const idsAfter = new Set<string>();
      for (const block of (nextMessage as any).content ?? []) {
        if (block && typeof block === "object" && typeof block.id === "string" && block.id) {
          idsAfter.add(block.id);
        }
      }
      for (const id of idsBefore) {
        if (!idsAfter.has(id)) droppedToolCallIds.add(id);
      }

      // Skip tool call extraction for errored/aborted messages — their blocks may be incomplete
      const stopReason = (nextMessage as { stopReason?: string }).stopReason;
      const toolCalls =
        stopReason !== "error" && stopReason !== "aborted"
          ? extractToolCallsFromAssistant(nextMessage)
          : [];

      // Flush pending orphans before a new assistant turn
      const flushed = flushPending();

      for (const tc of toolCalls) {
        pending.set(tc.id, tc.name);
      }

      return [...flushed, nextMessage];
    }

    if (role === "toolResult") {
      const id = extractToolResultId(message as Extract<AgentMessage, { role: "toolResult" }>);
      if (id && droppedToolCallIds.has(id)) {
        guardLog("session-tool-result-guard", "dropped-tool-result", { toolCallId: id });
        droppedToolCallIds.delete(id);
        return [];
      }
      if (id) pending.delete(id);
      return [capToolResultSize(message)];
    }

    // User or other messages: flush pending orphans first
    return [...flushPending(), message];
  };
}
