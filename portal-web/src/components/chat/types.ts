/** Shared types for the Pilot-style chat UI. */

export type MessageRole = "user" | "assistant" | "tool" | "error"

export type ToolStatus = "running" | "success" | "error" | "aborted"

/**
 * Per-message timing data shown as small badges in the chat bubble.
 *
 * Designed so a naive sum of all visible badges equals the turn's wall clock
 * (within event-dispatch noise) — no double-counting, no missing intervals.
 *
 * Assistant messages:
 *   - ⏳ ttftMs:     first message of a turn ONLY. Time to first token.
 *   - 💭 thinkingMs: boundary (turn-start or last tool_end) → first text token.
 *   - ✍️ outputMs:  first text token → message_end (text streaming time).
 *
 * Tool messages:
 *   - 💭 thinkingMs: model reasoning before this tool fired (boundary-based).
 *   - ⚙️ durationMs: tool wall-clock execution time.
 *
 * turnTotalMs is carried for cross-checking but not rendered as a badge.
 */
export interface MessageTiming {
  ttftMs?: number
  thinkingMs?: number
  outputMs?: number
  durationMs?: number
  turnTotalMs?: number
}

/** Wire-compatible with siclaw's ErrorDetail (src/lib/error-envelope.ts) and
 *  sicore's pkg/model ErrorDetail. See docs/design/error-envelope.md. */
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
  toolName?: string
  toolInput?: string
  /** Raw parsed tool input, when available, for structured cards. */
  toolArgs?: Record<string, unknown>
  toolStatus?: ToolStatus
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
