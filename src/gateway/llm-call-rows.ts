/**
 * Row shapes for one model call, shared by every persistence path (web/api/a2a
 * `sse-consumer.ts`, Lark `collectChannelResponse`). Pure: no I/O.
 *
 * One model call ⇒ one assistant "model-call row" carrying `metadata.llm_call`,
 * preceded by one `kind: "thinking"` row when the provider streamed reasoning
 * text. See sicore `docs/design/siclaw-llm-call-timeline-DESIGN.md` §4.
 */

import { thinkingBlocksFromMessage, type LlmCallEnvelope } from "../core/llm-call-recorder.js";
import type { ChatMessageMetadata } from "../shared/message-kinds.js";

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
