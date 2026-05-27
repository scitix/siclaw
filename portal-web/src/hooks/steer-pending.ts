/**
 * Pure functions for steer pending-message state management.
 *
 * Extracted so the logic can be unit-tested without React/jsdom.
 */

import { stripAttachmentOcrEvidence } from "../components/chat/user-message-text"
import { ATTACHMENT_ONLY_PROMPT } from "../components/chat/attachment-prompt"

export function pendingSteerMatchText(text: string, hasAttachments: boolean): string {
  const trimmed = text.trim()
  if (trimmed) return trimmed
  return hasAttachments ? ATTACHMENT_ONLY_PROMPT : text
}

/**
 * Match an incoming steer message (from SSE message_start) against the pending queue.
 * Returns the index of the matched pending message, or -1 if not found.
 *
 * Uses trimmed comparison to tolerate minor whitespace differences between
 * what the frontend sent and what pi-agent echoes back.
 */
export function findPendingSteerIndex(pending: readonly string[], incomingText: string): number {
  const trimmed = stripAttachmentOcrEvidence(incomingText).trim()
  if (!trimmed) return -1
  return pending.findIndex((p) => stripAttachmentOcrEvidence(p).trim() === trimmed)
}

/**
 * Remove a pending message by index, returning the new array.
 * Returns the original array unchanged if index is out of bounds.
 */
export function removePendingAt<T>(pending: readonly T[], index: number): T[] {
  if (index < 0 || index >= pending.length) return [...pending]
  return [...pending.slice(0, index), ...pending.slice(index + 1)]
}

/**
 * Extract text from a pi-ai UserMessage content field.
 * content can be a plain string or an array of TextContent/ImageContent blocks.
 */
export function extractUserMessageText(content: unknown): string {
  if (typeof content === "string") return stripAttachmentOcrEvidence(content)
  if (!Array.isArray(content)) return ""
  const text = (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
  return stripAttachmentOcrEvidence(text)
}
