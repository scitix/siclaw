import type { UsageBatch, UsageBatchResponse } from "./model-usage.js";
// Type-only import (erased at runtime; src/shared already type-imports from src/core elsewhere,
// and tool-registry does not import shared → no cycle). Keeps the group item-status snapshot
// precisely typed on the wire.
import type { GroupItemStatus, SubagentTargetCoverage } from "../core/tool-registry.js";
import type { PersistedTierOutcome } from "../core/subagent-models.js";
import type { ChatMessageMetadata } from "./message-kinds.js";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Allow-list inventory coverage before it crosses either persistence boundary. */
export function sanitizeWireTargetCoverage(value: unknown): SubagentTargetCoverage | undefined {
  if (!record(value)) return undefined;
  const { artifact_id: artifactId, total, offset, selected, next_offset: nextOffset } = value;
  if (typeof artifactId !== "string" || !artifactId || !nonNegativeInteger(total) || total < 1 ||
      !nonNegativeInteger(offset) || !nonNegativeInteger(selected) || selected < 1 || selected > total ||
      offset > total || offset + selected > total ||
      !(nextOffset === null || nonNegativeInteger(nextOffset)) ||
      nextOffset !== (offset + selected < total ? offset + selected : null) ||
      !Array.isArray(value.target_ids) || value.target_ids.length !== selected ||
      !value.target_ids.every(id => typeof id === "string" && id.length > 0)) return undefined;

  const targetIds = [...new Set(value.target_ids as string[])];
  if (targetIds.length !== selected) return undefined;
  const coverage: SubagentTargetCoverage = {
    artifact_id: artifactId,
    total,
    offset,
    selected,
    next_offset: nextOffset,
    target_ids: targetIds,
  };
  if (value.outcomes !== undefined) {
    if (!record(value.outcomes)) return undefined;
    const outcomes: Record<string, string> = {};
    for (const id of targetIds) {
      const outcome = value.outcomes[id];
      if (typeof outcome !== "string" || !outcome) return undefined;
      outcomes[id] = outcome;
    }
    coverage.outcomes = outcomes;
  }
  if (typeof value.snapshot_complete === "boolean") {
    if (value.snapshot_complete && (
      offset !== 0 || selected !== total || nextOffset !== null ||
      !coverage.outcomes || Object.values(coverage.outcomes).some(status => status !== "done")
    )) return undefined;
    coverage.snapshot_complete = value.snapshot_complete;
  }
  return coverage;
}

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
  metadata?: ChatMessageMetadata | null;
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
  metadata?: ChatMessageMetadata | null;
  outcome?: "success" | "error" | "blocked" | null;
  durationMs?: number | null;
  delegationId?: string | null;
}

export interface DelegationToolUpdatePayload {
  sessionId: string;
  toolName: string;
  delegationId: string;
  content: string;
  metadata?: ChatMessageMetadata | null;
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
  /** Final inventory coverage for a group terminal event. */
  targetCoverage?: SubagentTargetCoverage;
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
  | { type: "usage.record_calls"; batch: UsageBatch }
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
  usage?: UsageBatchResponse;
  ok: boolean;
  id?: string;
}
