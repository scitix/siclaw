/**
 * Row shapes for one model call, shared by every persistence path (web/api/a2a
 * `sse-consumer.ts`, Lark `collectChannelResponse`). Pure: no I/O.
 *
 * One model call ⇒ one assistant "model-call row" carrying `metadata.llm_call`,
 * preceded by one `kind: "thinking"` row when the provider streamed reasoning
 * text.
 */

import {
  llmCallFromMessage,
  thinkingBlocksFromMessage,
  type LlmCallEnvelope,
} from "../core/llm-call-recorder.js";
import type { ChatMessageMetadata } from "../shared/message-kinds.js";

export interface ToolCallClock {
  /** AgentBox-clock start, present when the runtime stamps the event. */
  startedAt?: number;
  /** Consumer-local fallback start. */
  localStartMs: number;
}

/** Read one finite AgentBox-clock timestamp from an SSE event. */
export function eventClock(
  event: Record<string, unknown>,
  key: "startedAt" | "endedAt",
): number | undefined {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Measure a tool call without ever subtracting timestamps from different
 * processes. Use AgentBox stamps only when both are present; otherwise use the
 * consumer's local clock for both ends.
 */
export function toolDurationMs(
  start: ToolCallClock,
  endedAt: number | undefined,
  localEndMs = Date.now(),
): number {
  if (start.startedAt !== undefined && endedAt !== undefined) {
    return Math.max(0, endedAt - start.startedAt);
  }
  return Math.max(0, localEndMs - start.localStartMs);
}

/**
 * Value identity for an envelope crossing an SSE/JSON boundary. `message_end`
 * and `turn_end` are parsed independently by AgentBoxClient, so object identity
 * cannot deduplicate them.
 */
export function llmCallEnvelopeKey(envelope: LlmCallEnvelope): string {
  return JSON.stringify([
    envelope.v,
    envelope.kind,
    envelope.attempt,
    envelope.round,
    envelope.request_at,
    envelope.response_end_at,
  ]);
}

/** Shared round/dedup state for every gateway persistence path. */
export class LlmCallTimeline {
  private readonly seenEnvelopeKeys = new Set<string>();
  private round = 0;

  take(message: unknown): LlmCallEnvelope | undefined {
    const envelope = llmCallFromMessage(message);
    if (!envelope) return undefined;
    const key = llmCallEnvelopeKey(envelope);
    if (this.seenEnvelopeKeys.has(key)) return undefined;
    this.seenEnvelopeKeys.add(key);
    if (envelope.kind === "agent" && envelope.round > 0) this.round = envelope.round;
    return envelope;
  }

  nextRound(): number {
    return this.round + 1;
  }

  toolMetadata(event: Record<string, unknown>): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    if (this.round > 0) metadata.llm_round = this.round;
    if (typeof event.toolCallId === "string" && event.toolCallId) {
      metadata.tool_call_id = event.toolCallId;
    }
    return metadata;
  }
}

/**
 * Clone an envelope for persistence and redact provider error text, including
 * errors on folded auxiliary calls. Live events retain the original envelope.
 */
export function redactLlmCallEnvelope(
  envelope: LlmCallEnvelope,
  redact: (text: string) => string,
): LlmCallEnvelope {
  return {
    ...envelope,
    model: { ...envelope.model },
    ms: { ...envelope.ms },
    blocks: envelope.blocks.map((block) => ({ ...block })),
    ...(envelope.usage ? { usage: { ...envelope.usage } } : {}),
    tool_call_ids: [...envelope.tool_call_ids],
    ...(envelope.error_message ? { error_message: redact(envelope.error_message) } : {}),
    ...(envelope.aux_calls
      ? { aux_calls: envelope.aux_calls.map((call) => redactLlmCallEnvelope(call, redact)) }
      : {}),
  };
}

export interface ThinkingRowSpec {
  content: string;
  metadata: ChatMessageMetadata;
}

/**
 * Build the thinking row for a model call, or null when there is nothing to
 * store (no thinking blocks, or only empty non-redacted ones). `redact` is the
 * caller's content redactor — reasoning text leaks secrets like any other text.
 */
export function buildThinkingRow(
  message: unknown,
  envelope: LlmCallEnvelope,
  redact: (text: string) => string,
): ThinkingRowSpec | null {
  const blocks = thinkingBlocksFromMessage(message).filter((b) => b.text.length > 0 || b.redacted);
  if (blocks.length === 0) return null;
  return {
    content: redact(blocks.map((b) => b.text).join("\n\n")),
    metadata: {
      kind: "thinking",
      llm_round: envelope.round,
      redacted: blocks.some((b) => b.redacted),
      signature_present: blocks.some((b) => b.signature_present),
    },
  };
}

/**
 * Whether this envelope should get a model-call row of its own. Aux
 * (compaction) calls ride the next agent call's `aux_calls`; a failed call's
 * envelope rides the error row instead.
 */
export function isModelCallRowEnvelope(envelope: LlmCallEnvelope | undefined, stopReason: unknown): envelope is LlmCallEnvelope {
  return envelope !== undefined && envelope.kind === "agent" && envelope.round > 0 && stopReason !== "error";
}
