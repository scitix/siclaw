// Type-only import (erased at runtime; src/shared already type-imports from src/core elsewhere,
// and tool-registry does not import shared → no cycle). Keeps the group item-status snapshot
// precisely typed on the wire.
import type { GroupItemStatus } from "../core/tool-registry.js";
import type { PersistedTierOutcome } from "../core/subagent-models.js";

export interface DelegationLineagePayload {
  parentSessionId?: string | null;
  parentAgentId?: string | null;
  delegationId?: string | null;
  targetAgentId?: string | null;
}

export interface DelegationAppendMessagePayload {
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
  toolset?: string | null;
  toolInput?: string | null;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
  fromAgentId?: string | null;
  parentSessionId?: string | null;
  delegationId?: string | null;
  targetAgentId?: string | null;
  /** per-prompt root trace id inherited from the parent, for DB trace filtering. */
  traceId?: string | null;
}

export interface DelegationUpdateMessagePayload {
  messageId: string;
  sessionId: string;
  content: string;
  toolName?: string | null;
  toolset?: string | null;
  toolInput?: string | null;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
  delegationId?: string | null;
}

export interface DelegationToolUpdatePayload {
  sessionId: string;
  toolName: string;
  delegationId: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
}

export interface DelegationEventPayload {
  parentSessionId: string;
  parentAgentId: string | null;
  userId: string;
  delegationId: string;
  childSessionId: string;
  targetAgentId: string | null;
  status: "done" | "partial" | "failed" | "timed_out" | "cancelled";
  capsule: string;
  fullSummary?: string;
  summaryTruncated?: boolean;
  scope?: string;
  taskIndex?: number;
  totalTasks?: number;
  toolCalls?: number;
  durationMs?: number;
  partialSource?: "steered" | "runtime_fallback";
  interruptedTool?: string;
  /**
   * Which model a SINGLE child ran on and why — identifiers and reasons only.
   * The group equivalent lives per-item inside `itemStatuses`.
   */
  tier?: PersistedTierOutcome;
  /**
   * Per-item status snapshot for a spawn_subagent GROUP terminal event (index → status). Lets the
   * frontend render items that were never persisted as their own child event — chiefly `skipped`
   * ones (circuit-break / group-timeout / pre-launch stop) — instead of stranding them on the
   * live-only "running" fallback after a reload. Absent for single-subagent events. Additive.
   */
  /**
   * Per-item terminal snapshot. `tier` records which model ran an item and why,
   * carrying identifiers and reasons only — never a `modelConfig`.
   *
   * It is here rather than only in the tool result because a BACKGROUND group's
   * tool call returns `launched` before any of it is known: this event is the only
   * record that survives, so without it a detached run can never be asked which
   * model it actually used.
   */
  itemStatuses?: Array<{
    index: number;
    status: GroupItemStatus;
    tier?: PersistedTierOutcome;
  }>;
  /** per-prompt root trace id inherited from the parent, for DB trace filtering. */
  traceId?: string | null;
}

export interface ChannelDeliverMessagePayload {
  sessionId: string;
  kind: "milestone" | "final" | "artifact";
  text: string;
  fromAgentId?: string | null;
}

export type DelegationPersistenceEvent =
  | {
      type: "delegation.ensure_session";
      sessionId: string;
      agentId: string;
      userId: string;
      title?: string;
      preview?: string;
      origin?: string;
      lineage?: DelegationLineagePayload;
    }
  | { type: "delegation.append_message"; message: DelegationAppendMessagePayload }
  | { type: "delegation.update_message"; message: DelegationUpdateMessagePayload }
  | { type: "delegation.update_tool_message"; message: DelegationToolUpdatePayload }
  | { type: "delegation.append_event"; event: DelegationEventPayload }
  | { type: "delegation.emit_chat_event"; sessionId: string; event: Record<string, unknown> }
  | { type: "channel.deliver_message"; message: ChannelDeliverMessagePayload };

export interface DelegationPersistenceResponse {
  ok: boolean;
  id?: string;
}
