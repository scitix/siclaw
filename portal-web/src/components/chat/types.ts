/** Shared types for the Pilot-style chat UI. */

export type MessageRole = "user" | "assistant" | "tool"

export type ToolStatus = "running" | "success" | "error" | "aborted"

export interface PilotMessage {
  id: string
  role: MessageRole
  content: string
  toolName?: string
  toolInput?: string
  toolStatus?: ToolStatus
  /** Structured details from tool result metadata */
  toolDetails?: Record<string, unknown>
  metadata?: Record<string, unknown>
  timestamp: string
  isStreaming?: boolean
  /** Hidden from chat bubbles (e.g. update_plan tool messages) */
  hidden?: boolean
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
