/**
 * Shared message inspection utilities.
 *
 * Extracted from compaction.ts to serve multiple consumers
 * (compaction, compaction-safeguard, session-tool-result-guard)
 * without coupling unrelated concerns.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type ToolCallLike = { id: string; name?: string };

const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

export function extractToolCallsFromAssistant(
  msg: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
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
