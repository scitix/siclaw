/**
 * Shared spawn_subagent group-form predicates — consumed by BOTH the chat hook (usePilotChat)
 * and the renderer (PilotArea) so the "is this a batch?" and "what terminal status is this?"
 * decisions can't drift between the two. Zero external deps on purpose (only the PilotMessage
 * type) — a heavier helper like the launch-id ladder stays local to usePilotChat, which owns the
 * `messageDelegationId`/`tryParseJson` primitives it needs (importing those here would cycle).
 */
import type { PilotMessage } from "../components/chat/types"

/**
 * The unified spawn_subagent renders as one of two forms (v3 single-tool merge): a BATCH form
 * (map→reduce group card) when its items list has >1 entry OR it carries a reduce_prompt; otherwise
 * the single-item COLLAPSE form (legacy sub-agent card). The now-deleted `spawn_subagent_group` tool
 * name is still recognised so historical sessions keep rendering as a group.
 */
export function isGroupForm(m: PilotMessage): boolean {
  if (m.toolName === "spawn_subagent_group") return true // legacy history
  if (m.toolName !== "spawn_subagent") return false
  const args = m.toolArgs as Record<string, unknown> | undefined
  const items = args?.items
  const reduce = args?.reduce_prompt
  const hasReduce = typeof reduce === "string" && reduce.trim() !== ""
  return Array.isArray(items) && (items.length > 1 || hasReduce)
}

/**
 * Map a delegation status / event-type string to a terminal item/group status, or `null` for a
 * NON-terminal (running/queued/synthesizing) event. Single source of truth for the status regex
 * family that was duplicated between annotateSubagentCompletions (inline) and the group fold.
 * Callers decide what the non-terminal `null` means for them: the single-subagent fold skips it
 * (`if (status === null) continue`), the group fold renders it as "running" (`?? "running"`).
 */
export function normalizeCompletionStatus(raw?: string): string | null {
  const s = (raw ?? "done").toLowerCase()
  if (/run|start|queue|pend|progress|synthes/.test(s)) return null // non-terminal
  if (/fail|error/.test(s)) return "failed"
  if (/cancel|abort|stop/.test(s)) return "cancelled"
  if (/timed?[-_ ]?out/.test(s)) return "timed_out"
  if (/partial|truncat/.test(s)) return "partial"
  if (/skip/.test(s)) return "skipped"
  return "done"
}
