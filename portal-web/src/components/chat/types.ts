/** Shared types for the Pilot-style chat UI. */

export type MessageRole = "user" | "assistant" | "tool" | "error"

export type ToolStatus = "running" | "success" | "error" | "aborted"

/**
 * Per-message timing data shown as small badges in the chat bubble.
 *
 * Assistant messages carry ONE model call's partition, measured by the runtime at
 * the provider boundary (`metadata.llm_call.ms`, live: `event.llmCall.ms`):
 *   - netTtftMs:  request sent → first token (network + queue + hidden reasoning)
 *   - thinkingMs: streamed reasoning blocks
 *   - outputMs:   text + tool-call argument streaming
 *   - totalMs:    request sent → response end (= the three above)
 *
 * Tool messages:
 *   - durationMs: tool wall-clock execution time (agentbox clock).
 */
export interface MessageTiming {
  netTtftMs?: number
  thinkingMs?: number
  outputMs?: number
  totalMs?: number
  durationMs?: number
}

export interface ModelRouteMetadata {
  candidate_key?: string
  provider?: string
  model_id?: string
  is_fallback?: boolean
  primary_candidate_key?: string
  switched_from_candidate_key?: string
  switched_from_provider?: string
  switched_from_model_id?: string
  recovered_from_candidate_key?: string
  recovered_from_provider?: string
  recovered_from_model_id?: string
  failure_kind?: string
  error_message?: string
  cooldown_until?: number
  attempt?: number
}

/** Wire-compatible with siclaw's ErrorDetail (src/lib/error-envelope.ts) and
 *  the management server's ErrorDetail. See docs/design/error-envelope.md. */
export interface ErrorDetail {
  code: string
  message: string
  retriable: boolean
  retryAfterMs?: number
  requestId?: string
  details?: unknown
}

export interface PilotMessage {
  id: string
  role: MessageRole
  content: string
  attachments?: ChatAttachment[]
  toolName?: string
  toolInput?: string
  /** Raw parsed tool input, when available, for structured cards. */
  toolArgs?: Record<string, unknown>
  toolStatus?: ToolStatus
  /** pi tool-call id — correlates live tool_execution_update events to the right (parallel) tool message. */
  toolCallId?: string
  /** Structured details from tool result metadata */
  toolDetails?: Record<string, unknown>
  metadata?: Record<string, unknown>
  /** Timing badges (⏳ TTFT / 💭 thinking / ⚙️ tool-exec) */
  timing?: MessageTiming
  fromAgentId?: string | null
  parentSessionId?: string | null
  delegationId?: string | null
  targetAgentId?: string | null
  timestamp: string
  isStreaming?: boolean
  /** Hidden from chat bubbles (e.g. update_plan tool messages) */
  hidden?: boolean
  /** Populated when role === "error". */
  errorDetail?: ErrorDetail
}

export interface ContextUsage {
  tokens: number
  contextWindow: number
  percent: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export interface ChatAttachment {
  kind: "image" | "pdf"
  filename: string
  mimeType: string
  data: string
}

/**
 * A clickable chip shown near the chat input. Two variants share one type:
 *
 * - `fill`: inserts visible text into the input box. User can send as-is or
 *   add context after it. Used by model-emitted suggested replies (A./B./C.).
 *
 * - `prefix`: renders as an atomic pill in the input; `fullPrompt` is the
 *   template that gets expanded on send, with any user-typed text appended
 *   as "Additional direction". Used by Dig deeper and DP checkpoint chips.
 */
export type ActionChip =
  | {
      kind: "fill"
      id: string
      label: string
      /** Optional muted prefix rendered before the label (e.g. "A.") */
      labelPrefix?: string
      /** Text inserted verbatim into the input on click */
      insertText: string
    }
  | {
      kind: "prefix"
      id: string
      label: string
      /** Template expanded on send */
      fullPrompt: string
      /** Placeholder shown in the input while the pill is active */
      placeholder?: string
    }

/** Narrowed shape for ActionChips that live as atomic pills in the input. */
export type PrefixActionChip = Extract<ActionChip, { kind: "prefix" }>
