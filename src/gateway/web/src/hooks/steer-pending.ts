/**
 * Pure functions for steer pending-message state management.
 *
 * Extracted from usePilot.ts so the logic can be unit-tested without React/jsdom.
 * usePilot.ts delegates to these functions inside its setState callbacks.
 */

/**
 * Match an incoming steer message (from SSE message_start) against the pending queue.
 * Returns the index of the matched pending message, or -1 if not found.
 *
 * Uses trimmed comparison to tolerate minor whitespace differences between
 * what the frontend sent and what pi-agent echoes back.
 */
export function findPendingSteerIndex(pending: readonly string[], incomingText: string): number {
  const trimmed = incomingText.trim();
  if (!trimmed) return -1;
  return pending.findIndex(p => p.trim() === trimmed);
}

/**
 * Remove a pending message by index, returning the new array.
 * Returns the original array unchanged if index is out of bounds.
 */
export function removePendingAt(pending: readonly string[], index: number): string[] {
  if (index < 0 || index >= pending.length) return [...pending];
  return [...pending.slice(0, index), ...pending.slice(index + 1)];
}

/**
 * Extract text from a pi-ai UserMessage content field.
 * content can be a plain string or an array of TextContent/ImageContent blocks.
 */
export function extractUserMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter(c => c.type === "text")
    .map(c => c.text ?? "")
    .join("");
}
