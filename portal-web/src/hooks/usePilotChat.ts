/**
 * usePilotChat — manages Pilot-style chat state over HTTP/SSE.
 *
 * Replaces the original usePilot hook which used WebSocket RPC.
 * Uses chatSSE (from api.ts) for streaming, chatSteer for mid-stream injection,
 * and chatAbort for cancellation.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import { api, chatSteer, chatAbort } from "../api"
import type {
  PilotMessage,
  ContextUsage,
  ErrorDetail,
  ChatAttachment,
} from "../components/chat/types"
import { stripAttachmentOcrEvidence } from "../components/chat/user-message-text"
import { findPendingSteerIndex, removePendingAt, extractUserMessageText, pendingSteerMatchText } from "./steer-pending"

/** Parse an unknown payload into an ErrorDetail with backward-compat fallbacks.
 *  See docs/design/error-envelope.md §4. */
function parseErrorDetail(raw: unknown): ErrorDetail {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    if (
      typeof obj.code === "string" &&
      typeof obj.message === "string" &&
      typeof obj.retriable === "boolean"
    ) {
      return obj as unknown as ErrorDetail
    }
    if ("error" in obj) {
      const e = obj.error
      if (typeof e === "object" && e !== null) return parseErrorDetail(e)
      if (typeof e === "string") {
        return { code: "INTERNAL_ERROR", message: e, retriable: true }
      }
    }
  }
  if (typeof raw === "string") {
    return { code: "INTERNAL_ERROR", message: raw, retriable: true }
  }
  return { code: "INTERNAL_ERROR", message: "Unknown error", retriable: true }
}

function makeErrorMessage(detail: ErrorDetail): PilotMessage {
  return {
    id: `error-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`,
    role: "error",
    content: detail.message,
    timestamp: new Date().toISOString(),
    errorDetail: detail,
  }
}

// Re-export types for convenience
export type { PilotMessage, ContextUsage }

interface ChatSession {
  id: string
  title?: string
  created_at: string
  updated_at?: string
}

interface ChatMessage {
  id: string
  role: "user" | "assistant" | "tool"
  content: string
  tool_name?: string
  tool_input?: string
  outcome?: string
  duration_ms?: number
  metadata?: Record<string, unknown>
  hidden?: boolean
  from_agent_id?: string | null
  parent_session_id?: string | null
  delegation_id?: string | null
  target_agent_id?: string | null
  created_at: string
}

interface UsePilotChatOptions {
  agentId: string
  sessionId: string | null
}

interface UsePilotChatReturn {
  messages: PilotMessage[]
  streaming: boolean
  streamText: string
  dpActive: boolean
  contextUsage: ContextUsage | null
  isCompacting: boolean
  pendingMessages: string[]
  hasMore: boolean
  loadingMore: boolean
  send: (text: string, attachments?: ChatAttachment[]) => void
  steer: (text: string, attachments?: ChatAttachment[]) => void
  abort: () => void
  loadMore: () => void
  setDpActive: (active: boolean) => void
  removePending: (index: number) => void
  exitDp: () => void
}

interface PendingSteer {
  text: string
  matchText: string
  attachments?: ChatAttachment[]
}

const DELEGATED_TOOL_STALE_MS = 4 * 60 * 1000
// Generic stale window for non-delegation tools (kubectl, skill, etc.).
// `tool_execution_start` now persists a "running" row eagerly; if the
// gateway/agentbox restarts or the SSE stream drops before
// `tool_execution_end` lands, the row stays outcome=null forever and the
// frontend shows a permanently-spinning card on reload. 30 min is far
// above any realistic non-delegation tool runtime — kubectl reads finish
// in seconds, skill scripts have their own timeouts well under 30 min.
const NON_DELEGATION_TOOL_STALE_MS = 30 * 60 * 1000
const DELEGATED_TOOL_NAMES = new Set(["delegate_to_agent", "delegate_to_agents"])
const ASYNC_DELEGATED_TOOL_NAMES = new Set(["delegate_to_agents"])

/** Format tool args into a readable one-liner for display */
export function formatToolInput(toolName: string, args?: Record<string, unknown>): string {
  if (!args) return ""
  const name = toolName.toLowerCase()
  if (name === "bash" || name === "shell" || name === "command") {
    return (args.command as string) || (args.cmd as string) || ""
  }
  if (name === "node_exec") {
    const node = (args.node as string) || ""
    const cmd = (args.command as string) || ""
    return node && cmd ? `${node} $ ${cmd}` : node || cmd
  }
  if (name === "node_script") {
    const node = (args.node as string) || ""
    const skill = (args.skill as string) || ""
    const script = (args.script as string) || ""
    const sArgs = (args.args as string) || ""
    const scriptPart = [skill, script].filter(Boolean).join("/")
    const cmdPart = sArgs ? `${scriptPart} ${sArgs}` : scriptPart
    return node && cmdPart ? `${node} $ ${cmdPart}` : node || cmdPart
  }
  if (name === "pod_exec") {
    const pod = (args.pod as string) || ""
    const ns = (args.namespace as string) || ""
    const cmd = (args.command as string) || ""
    const target = ns ? `${pod} -n ${ns}` : pod
    return target && cmd ? `${target} $ ${cmd}` : target || cmd
  }
  if (name === "pod_script") {
    const pod = (args.pod as string) || ""
    const ns = (args.namespace as string) || ""
    const skill = (args.skill as string) || ""
    const script = (args.script as string) || ""
    const sArgs = (args.args as string) || ""
    const target = ns ? `${pod} -n ${ns}` : pod
    const scriptPart = [skill, script].filter(Boolean).join("/")
    const cmdPart = sArgs ? `${scriptPart} ${sArgs}` : scriptPart
    return target && cmdPart ? `${target} $ ${cmdPart}` : target || cmdPart
  }
  if (name === "read" || name === "readfile") {
    return (args.file_path as string) || (args.path as string) || ""
  }
  if (name === "write" || name === "writefile") {
    return (args.file_path as string) || (args.path as string) || ""
  }
  if (name === "edit") {
    return (args.file_path as string) || (args.path as string) || ""
  }
  if (name === "grep" || name === "search") {
    const pattern = (args.pattern as string) || ""
    const path = (args.path as string) || ""
    return path ? `${pattern} in ${path}` : pattern
  }
  if (name === "glob") {
    return (args.pattern as string) || ""
  }
  if (name === "skill_preview") {
    return (args.dir as string)?.split("/").pop() || ""
  }
  if (name === "delegate_to_agents") {
    const tasks = Array.isArray(args.tasks) ? args.tasks : []
    const count = tasks.length
    const firstScope = tasks
      .map((task) => typeof task === "object" && task ? (task as Record<string, unknown>).scope : undefined)
      .find((scope) => typeof scope === "string" && scope.length > 0) as string | undefined
    return firstScope ? `${count} sub-agent tasks · ${firstScope}` : `${count} sub-agent tasks`
  }
  if (name === "local_script") {
    const skill = (args.skill as string) || ""
    const script = (args.script as string) || ""
    const skillArgs = (args.args as string) || ""
    const parts = [skill, script].filter(Boolean).join("/")
    return skillArgs ? `${parts} ${skillArgs}` : parts
  }
  if (name === "update_plan") {
    const step = args.step as number | undefined
    const status = (args.status as string) || ""
    return step != null ? `Step ${step}: ${status}` : status
  }
  // Fallback
  const vals = Object.values(args).filter((v) => typeof v === "string" && (v as string).length > 0) as string[]
  return vals[0] || JSON.stringify(args)
}

/** Reduce individual progress events into accumulated investigation state */
function timeNow(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function tryParseJson(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s) } catch { return undefined }
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return tryParseJson(value);
  if (typeof value === "object") return value as Record<string, unknown>;
  return undefined;
}

export function parsePortalTimestamp(value: string): number {
  // SQLite CURRENT_TIMESTAMP returns UTC as "YYYY-MM-DD HH:mm:ss" without a
  // timezone. Browsers parse that shape as local time, which makes fresh
  // running tool rows look hours old in non-UTC timezones.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`)
  }
  return Date.parse(value)
}

function formatPortalTimestamp(value: string): string {
  const parsed = parsePortalTimestamp(value)
  if (!Number.isFinite(parsed)) return ""
  return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function isStaleRunningTool(m: ChatMessage): boolean {
  if (m.role !== "tool") return false
  if (m.outcome) return false
  const createdAt = parsePortalTimestamp(m.created_at)
  if (!Number.isFinite(createdAt)) return false
  let staleMs: number
  if (m.tool_name && ASYNC_DELEGATED_TOOL_NAMES.has(m.tool_name)) {
    staleMs = 15 * 60 * 1000
  } else if (m.tool_name && DELEGATED_TOOL_NAMES.has(m.tool_name)) {
    staleMs = DELEGATED_TOOL_STALE_MS
  } else {
    staleMs = NON_DELEGATION_TOOL_STALE_MS
  }
  return Date.now() - createdAt > staleMs
}

function isDelegationTool(toolName?: string | null): boolean {
  return Boolean(toolName && DELEGATED_TOOL_NAMES.has(toolName))
}

// Task-ledger tools are plumbing for the Plan panel — their tool cards are noise
// in the conversation (the panel already shows the resulting plan), so hide them.
const TASK_TOOL_NAMES = new Set(["task_create", "task_update", "task_list", "task_get"])
function isTaskTool(toolName?: string | null): boolean {
  return Boolean(toolName && TASK_TOOL_NAMES.has(toolName))
}

function toolStatusFromMessage(m: ChatMessage): PilotMessage["toolStatus"] | undefined {
  if (m.role !== "tool") return undefined;
  if (isStaleRunningTool(m)) return "error";
  if (m.outcome === "error" || m.outcome === "blocked") return "error";
  if (m.outcome === "success") return "success";
  return "running";
}

function findLastMessageIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

function extractTiming(metadata: Record<string, unknown> | undefined, durationMs: number | null | undefined): import("../components/chat/types").MessageTiming | undefined {
  // Tool rows: duration_ms (⚙️ exec) is its own column; pre_thinking_ms
  // (💭 model-thinking-before-this-tool) lives at metadata.pre_thinking_ms.
  // Assistant rows: timing sub-object inside metadata holds ⏳ ttft, 💭
  // thinking-before-text, and turn-total.
  const t: import("../components/chat/types").MessageTiming = {}
  const rawTiming = metadata?.timing as Record<string, unknown> | undefined
  if (rawTiming) {
    if (typeof rawTiming.ttft_ms === "number") t.ttftMs = rawTiming.ttft_ms
    if (typeof rawTiming.thinking_ms === "number") t.thinkingMs = rawTiming.thinking_ms
    if (typeof rawTiming.output_ms === "number") t.outputMs = rawTiming.output_ms
    if (typeof rawTiming.turn_total_ms === "number") t.turnTotalMs = rawTiming.turn_total_ms
  }
  // Pre-tool thinking gets surfaced as the same `thinkingMs` field — it's
  // semantically the same emoji (💭 model reasoning) just attached to a
  // tool row instead of a text row. UI uses one badge code path either way.
  // No threshold: a 0/small 💭 on the 2nd-Nth tool of a batch is the visible
  // proof that they came from one thinking burst (not N independent ones).
  const preThinking = metadata?.pre_thinking_ms
  if (typeof preThinking === "number") t.thinkingMs = preThinking
  if (typeof durationMs === "number" && durationMs >= 0) t.durationMs = durationMs
  return Object.keys(t).length > 0 ? t : undefined
}

const PAGE_SIZE = 20

/**
 * Fetch page 1 (the most recent PAGE_SIZE messages) of a session and map to PilotMessages.
 * Shared by the initial load and the recovered-run / async-delegation / background-turn
 * pollers, which each previously inlined the identical fetch + envelope-unwrap + map.
 */
async function fetchSessionPage1(
  agentId: string,
  sessionId: string,
): Promise<{ items: ChatMessage[]; pilotMsgs: PilotMessage[] }> {
  const res = await api<{ data: ChatMessage[] }>(
    `/siclaw/agents/${agentId}/chat/sessions/${sessionId}/messages?page=1&page_size=${PAGE_SIZE}`,
  )
  const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as unknown as ChatMessage[]) : []
  return { items, pilotMsgs: annotateSubagentCompletions(annotateExecJobCompletions(annotateDelegationSynthesis(items.map(toPilotMessage)))) }
}

function toPilotMessage(m: ChatMessage): PilotMessage {
  const toolArgs = m.tool_input ? tryParseJson(m.tool_input) : undefined
  const metadata = normalizeMetadata(m.metadata)
  const isDelegationEvent = metadata?.kind === "delegation_event"
  // task_event rows are folded into the Plan panel (foldPlan); never show them as chat bubbles.
  const isTaskEvent = metadata?.kind === "task_event"
  // The <task_notification> user message is the internal prompt injected to wake the model
  // when a background job finishes — plumbing, not user-facing. The model's human reply to it
  // ("✅ 后台任务已完成…") stays; this raw XML bubble is hidden. (Tagged in src/agentbox/session.ts.)
  const isTaskNotification = metadata?.kind === "task_notification"
  // A background exec job's completion marker — folded into the launching tool's box
  // (annotateExecJobCompletions), never shown as its own row.
  const isExecJobEvent = metadata?.kind === "exec_job_event"
  const staleRunning = isStaleRunningTool(m)
  const toolIsDelegation = isDelegationTool(m.tool_name)
  const toolStatus = toolStatusFromMessage(m)
  const recoveredMetadata = staleRunning
    ? {
        ...(metadata ?? {}),
        status: "timed_out",
        recovery_reason: toolIsDelegation ? "stale_delegation_tool" : "stale_running_tool",
      }
    : metadata
  const timing = extractTiming(metadata, m.duration_ms)
  return {
    id: m.id,
    role: m.role,
    content: staleRunning && !m.content?.trim()
      ? (toolIsDelegation
          ? "Delegated investigation did not finish before the recovery window. It may have timed out or been interrupted."
          : "Tool execution did not finish before the recovery window. It may have timed out or been interrupted.")
      : m.role === "user" ? stripAttachmentOcrEvidence(m.content) : m.content,
    toolName: m.tool_name,
    toolArgs,
    toolInput: toolArgs ? formatToolInput(m.tool_name ?? "", toolArgs) : undefined,
    toolStatus,
    // Persisted tool result details (e.g. sub-agent steps, child_session_id) live in
    // metadata; surface them as toolDetails so cards recover their content on refresh.
    toolDetails: m.role === "tool" ? (recoveredMetadata ?? undefined) : undefined,
    metadata: recoveredMetadata,
    timing,
    hidden: m.hidden || isDelegationEvent || isTaskEvent || isTaskNotification || isExecJobEvent || isTaskTool(m.tool_name),
    fromAgentId: m.from_agent_id ?? null,
    parentSessionId: m.parent_session_id ?? null,
    delegationId: m.delegation_id ?? null,
    targetAgentId: m.target_agent_id ?? null,
    timestamp: formatPortalTimestamp(m.created_at),
    isStreaming: toolStatus === "running",
  }
}

function hasRunningPersistedMessages(messages: PilotMessage[]): boolean {
  return messages.some((m) =>
    m.role === "tool" &&
    !ASYNC_DELEGATED_TOOL_NAMES.has(m.toolName ?? "") &&
    (m.toolStatus === "running" || m.isStreaming),
  )
}

function isRunningAsyncDelegationMessage(m: PilotMessage): boolean {
  if (m.role !== "tool" || !ASYNC_DELEGATED_TOOL_NAMES.has(m.toolName ?? "")) return false
  if (m.toolStatus === "error") return false
  const parsedContent = m.content ? tryParseJson(m.content) : undefined
  const status = (m.metadata?.status as string | undefined) ?? (parsedContent?.status as string | undefined)
  return status === "running" || m.toolStatus === "running" || !!m.isStreaming
}

function hasRunningAsyncDelegationMessages(messages: PilotMessage[]): boolean {
  return messages.some(isRunningAsyncDelegationMessage)
}

function messageString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function messageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function messageDelegationId(message: PilotMessage): string | undefined {
  if (message.delegationId) return message.delegationId
  const metadataId = messageString(message.metadata?.delegation_id)
  if (metadataId) return metadataId
  const parsedContent = message.content ? tryParseJson(message.content) : undefined
  return messageString(parsedContent?.delegation_id)
}

function delegationResultsReadyLabel(toolMessage: PilotMessage, eventMessage?: PilotMessage): string {
  const parsedContent = toolMessage.content ? tryParseJson(toolMessage.content) : undefined
  const tasks = Array.isArray(parsedContent?.tasks) ? parsedContent.tasks : []
  const total =
    messageNumber(eventMessage?.metadata?.total_tasks) ??
    messageNumber(toolMessage.metadata?.total_tasks) ??
    tasks.length
  const completed =
    messageNumber(eventMessage?.metadata?.completed_tasks) ??
    messageNumber(toolMessage.metadata?.completed_tasks) ??
    total
  return total > 0
    ? `${completed}/${total} results ready · Siclaw is synthesizing`
    : "Results ready · Siclaw is synthesizing"
}

function isBatchCompleteDelegationEvent(message: PilotMessage, delegationId: string): boolean {
  return (
    message.metadata?.kind === "delegation_event" &&
    message.metadata?.event_type === "delegation.batch_complete" &&
    messageDelegationId(message) === delegationId
  )
}

function annotateDelegationSynthesis(messages: PilotMessage[]): PilotMessage[] {
  let next: PilotMessage[] | null = null
  const updateAt = (index: number, message: PilotMessage) => {
    if (!next) next = [...messages]
    next[index] = message
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== "tool" || message.toolName !== "delegate_to_agents") continue

    const delegationId = messageDelegationId(message)
    const existingMetadata = message.metadata ?? {}
    if (!delegationId) {
      if (existingMetadata.ui_state === "synthesizing" || existingMetadata.ui_status) {
        const { ui_state: _state, ui_status: _status, ...metadata } = existingMetadata
        updateAt(i, { ...message, metadata })
      }
      continue
    }

    const eventIndex = messages.findIndex((candidate, index) =>
      index > i && isBatchCompleteDelegationEvent(candidate, delegationId),
    )
    const hasSyntheticReply =
      eventIndex >= 0 &&
      messages.slice(eventIndex + 1).some((candidate) => candidate.role === "assistant" && !candidate.hidden)
    const shouldShowSynthesizing = eventIndex >= 0 && !hasSyntheticReply
    const uiStatus = shouldShowSynthesizing
      ? delegationResultsReadyLabel(message, messages[eventIndex])
      : undefined

    if (shouldShowSynthesizing) {
      if (
        existingMetadata.ui_state !== "synthesizing" ||
        existingMetadata.ui_status !== uiStatus
      ) {
        updateAt(i, {
          ...message,
          metadata: {
            ...existingMetadata,
            ui_state: "synthesizing",
            ui_status: uiStatus,
          },
        })
      }
    } else if (existingMetadata.ui_state === "synthesizing" || existingMetadata.ui_status) {
      const { ui_state: _state, ui_status: _status, ...metadata } = existingMetadata
      updateAt(i, { ...message, metadata })
    }
  }

  return next ?? messages
}

/**
 * Fold a background exec job's completion (hidden exec_job_event row) into the launching
 * tool's box: attach bgStatus / bgExitCode so the box renders running → done/failed.
 * Correlated by jobId (the launch tool message's metadata.backgroundTaskId === the
 * completion's job_id). Refresh-safe — it's all chat history.
 */
function annotateExecJobCompletions(messages: PilotMessage[]): PilotMessage[] {
  const done = new Map<string, { status: string; exitCode: number | null }>()
  for (const m of messages) {
    const meta = m.metadata as Record<string, unknown> | undefined
    if (meta?.kind === "exec_job_event" && typeof meta.job_id === "string") {
      done.set(meta.job_id, {
        status: typeof meta.status === "string" ? meta.status : "completed",
        exitCode: typeof meta.exit_code === "number" ? meta.exit_code : null,
      })
    }
  }
  if (done.size === 0) return messages
  return messages.map((m) => {
    const jobId = (m.metadata as Record<string, unknown> | undefined)?.backgroundTaskId
    if (m.role === "tool" && typeof jobId === "string" && done.has(jobId)) {
      const c = done.get(jobId)!
      return { ...m, metadata: { ...(m.metadata ?? {}), bgStatus: c.status, bgExitCode: c.exitCode } }
    }
    return m
  })
}

/**
 * Fold a BACKGROUND spawn_subagent's completion into its launch card. The launch tool row
 * returns {status:"launched", job_id} immediately; the sub-agent's result lands later as a
 * hidden delegation_event whose delegation_id === the launch job_id (spawnId). Mark the launch
 * background (so the card shows the clock indicator + a running state) and, once the completion
 * is present, attach subBgStatus/subBgSummary so the card folds running → done/failed with the
 * report. Refresh-safe — it's all chat history. (Sync spawn cards already fold via streaming.)
 */
function annotateSubagentCompletions(messages: PilotMessage[]): PilotMessage[] {
  const done = new Map<string, { status: string; summary?: string }>()
  for (const m of messages) {
    if (m.metadata?.kind !== "delegation_event") continue
    const id = messageDelegationId(m)
    if (!id) continue
    const raw = (messageString(m.metadata?.event_type) ?? messageString(m.metadata?.status) ?? "done").toLowerCase()
    if (/run|start|queue|pend|progress|synthes/.test(raw)) continue // not a terminal event
    // Preserve timed_out / partial as their own (amber) statuses — collapsing them into "done"
    // showed a truncated/timed-out background investigation as a clean green success. statusTone
    // renders both amber, matching the foreground delegation path.
    const status = /fail|error/.test(raw) ? "failed"
      : /cancel|abort|stop/.test(raw) ? "cancelled"
      : /timed?[-_ ]?out/.test(raw) ? "timed_out"
      : /partial|truncat/.test(raw) ? "partial"
      : "done"
    done.set(id, { status, summary: typeof m.content === "string" ? m.content : undefined })
  }
  let changed = false
  const next = messages.map((m) => {
    if (!isBackgroundSpawnLaunch(m)) return m // foreground spawn already carries its final status
    const parsed = m.content ? tryParseJson(m.content) : undefined
    changed = true
    const jobId = messageString(parsed?.job_id) ?? messageDelegationId(m) ?? m.id
    const c = jobId ? done.get(jobId) : undefined
    return {
      ...m,
      metadata: {
        ...(m.metadata ?? {}),
        subBackground: true,
        ...(c ? { subBgStatus: c.status, subBgSummary: c.summary } : {}),
      },
    }
  })
  return changed ? next : messages
}

/** A spawn_subagent launched in the background — detectable from the launch itself (args /
 * "launched" result), so it works during the LIVE turn too, not only after annotate runs on a
 * refetch. */
function isBackgroundSpawnLaunch(m: PilotMessage): boolean {
  if (m.role !== "tool" || m.toolName !== "spawn_subagent") return false
  if ((m.toolArgs as Record<string, unknown> | undefined)?.run_in_background === true) return true
  const parsed = m.content ? tryParseJson(m.content) : undefined
  return parsed?.status === "launched"
}

/** A background spawn_subagent that launched but whose completion hasn't folded in yet. */
function hasActiveBackgroundSubagent(messages: PilotMessage[]): boolean {
  return messages.some((m) => isBackgroundSpawnLaunch(m) && !m.metadata?.subBgStatus)
}

function hasPendingDelegationSynthesis(messages: PilotMessage[]): boolean {
  return messages.some((message) => message.metadata?.ui_state === "synthesizing")
}

function hasActiveAsyncDelegationSurface(messages: PilotMessage[]): boolean {
  return hasRunningAsyncDelegationMessages(messages) || hasPendingDelegationSynthesis(messages)
}

export function usePilotChat({ agentId, sessionId }: UsePilotChatOptions): UsePilotChatReturn {
  const [messages, setMessages] = useState<PilotMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState("")
  const [dpActive, setDpActive] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const pageRef = useRef(1)

  const abortControllerRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  const recoveredStreamingRef = useRef(false)
  const isAbortingRef = useRef(false)
  const activeSessionIdRef = useRef<string | undefined>(sessionId ?? undefined)
  const [isCompacting, setIsCompacting] = useState(false)
  const hasActiveAsyncDelegation = hasActiveAsyncDelegationSurface(messages)
  const hasActiveBgSubagent = hasActiveBackgroundSubagent(messages)

  // Per-session state cache: preserves ALL state across session switches so each
  // agent's conversation feels independent — like browser tabs.
  interface SessionCache {
    messages: PilotMessage[]
    streaming: boolean
    dpActive: boolean
    contextUsage: ContextUsage | null
  }
  const messagesCacheRef = useRef<Map<string, SessionCache>>(new Map())
  const prevSessionIdRef = useRef<string | undefined>(undefined)

  // Reset DP mode flag. Kept as its own callback for the useEffect deps below.
  const resetDpState = useCallback(() => {
    setDpActive(false)
  }, [])

  // Load message history when session changes
  useEffect(() => {
    // Save outgoing session's full state to cache
    const prev = prevSessionIdRef.current
    if (prev) {
      messagesCacheRef.current.set(prev, {
        messages, streaming, dpActive, contextUsage,
      })
    }
    prevSessionIdRef.current = sessionId ?? undefined
    activeSessionIdRef.current = sessionId ?? undefined

    if (!sessionId) {
      setMessages([])
      setStreaming(false)
      streamingRef.current = false
      recoveredStreamingRef.current = false
      setContextUsage(null)
      setHasMore(true)
      pageRef.current = 1
      resetDpState()
      return
    }

    // Restore from cache ONLY if stream is still in progress (DB doesn't have
    // all messages yet). Otherwise load from DB — it's the authoritative source
    // and includes messages produced while the user was on another session.
    const cached = messagesCacheRef.current.get(sessionId)
    if (cached?.streaming) {
      setMessages(cached.messages)
      setStreaming(true)
      streamingRef.current = true
      recoveredStreamingRef.current = false
      setDpActive(cached.dpActive)
      setContextUsage(cached.contextUsage)
      setHasMore(true)
      return
    }
    if (cached) {
      setDpActive(cached.dpActive)
      setContextUsage(cached.contextUsage)
    } else {
      // No cache (first visit / page reload) — fetch persisted dp-state below.
      // Pre-set false as neutral default in case the fetch fails.
      resetDpState()
    }

    // No cache — load from DB (first visit to this session)
    let cancelled = false
    async function loadHistory() {
      try {
        pageRef.current = 1
        const { items, pilotMsgs } = await fetchSessionPage1(agentId, sessionId!)
        if (cancelled) return
        const hasRunning = hasRunningPersistedMessages(pilotMsgs)
        const recoveredActive = hasRunning || hasPendingDelegationSynthesis(pilotMsgs)
        setMessages(pilotMsgs)
        setStreaming(recoveredActive)
        streamingRef.current = recoveredActive
        recoveredStreamingRef.current = hasRunning
        setHasMore(items.length >= PAGE_SIZE)
      } catch (err) {
        console.error("[usePilotChat] Failed to load messages:", err)
        if (!cancelled) {
          setMessages([])
          setStreaming(false)
          streamingRef.current = false
          recoveredStreamingRef.current = false
          setHasMore(false)
        }
      }
    }
    // Restore persisted DP mode from the backend marker history. Only runs
    // on cache miss (first visit / page reload); a cache hit above already
    // reflected the last known state. Failures fall back to the reset-default.
    async function loadDpState() {
      try {
        const { active } = await api<{ active: boolean }>(
          `/siclaw/agents/${agentId}/chat/sessions/${sessionId}/dp-state`,
        )
        if (!cancelled) setDpActive(!!active)
      } catch (err) {
        console.warn("[usePilotChat] Failed to load dp-state:", err)
      }
    }
    loadHistory()
    if (!cached) loadDpState()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, sessionId, resetDpState])

  // Keep cache in sync with current state so switching back restores latest
  useEffect(() => {
    if (sessionId) {
      messagesCacheRef.current.set(sessionId, {
        messages, streaming, dpActive, contextUsage,
      })
    }
  }, [sessionId, messages, streaming, dpActive, contextUsage])

  // A page reload drops the browser's live SSE reader, but the runtime can
  // keep the prompt running and continue persisting tool rows. When history
  // contains a running persisted tool, keep the input in steer/abort mode and
  // poll the DB until the recovered run has visibly settled.
  useEffect(() => {
    if (!sessionId || !streaming || !recoveredStreamingRef.current) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let settledPolls = 0

    async function refreshRecoveredRun() {
      try {
        const { items, pilotMsgs } = await fetchSessionPage1(agentId, sessionId!)
        if (cancelled) return
        const hasRunning = hasRunningPersistedMessages(pilotMsgs)
        const latest = pilotMsgs[pilotMsgs.length - 1]

        setMessages(pilotMsgs)
        setHasMore(items.length >= PAGE_SIZE)

        if (hasRunning) {
          settledPolls = 0
        } else if (latest?.role === "assistant") {
          settledPolls += 1
        } else {
          settledPolls = 0
        }

        if (!hasRunning && settledPolls >= 2) {
          recoveredStreamingRef.current = false
          setStreaming(false)
          streamingRef.current = false
          setPendingSteers([])
          return
        }
      } catch (err) {
        console.warn("[usePilotChat] Failed to refresh recovered run:", err)
      }

      if (!cancelled) timer = setTimeout(refreshRecoveredRun, 2000)
    }

    timer = setTimeout(refreshRecoveredRun, 1000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [agentId, sessionId, streaming])

  // Async delegation is intentionally detached from the parent prompt, so the
  // normal SSE request may be closed while sub-agents continue in the
  // background. Poll persisted history while an async batch card is running or
  // while a completed batch is waiting for parent synthesis.
  useEffect(() => {
    if (!sessionId || !hasActiveAsyncDelegation) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function refreshAsyncDelegation() {
      try {
        const { items, pilotMsgs } = await fetchSessionPage1(agentId, sessionId!)
        if (cancelled) return
        const pendingSynthesis = hasPendingDelegationSynthesis(pilotMsgs)
        setMessages(pilotMsgs)
        setHasMore(items.length >= PAGE_SIZE)
        if (pendingSynthesis) {
          setStreaming(true)
          streamingRef.current = true
        }
        if (!hasActiveAsyncDelegationSurface(pilotMsgs)) {
          if (!recoveredStreamingRef.current && !abortControllerRef.current) {
            setStreaming(false)
            streamingRef.current = false
          }
          return
        }
      } catch (err) {
        console.warn("[usePilotChat] Failed to refresh async delegation:", err)
      }

      if (!cancelled) timer = setTimeout(refreshAsyncDelegation, 2000)
    }

    timer = setTimeout(refreshAsyncDelegation, 1000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [agentId, sessionId, hasActiveAsyncDelegation])

  // A background spawn_subagent isn't an async-delegation batch, so the poller above doesn't
  // cover it, and its completion is a pure-ack synthetic turn (no background_turn_done). Poll
  // history while one is running so its card folds running → done live (annotateSubagentCompletions
  // does the fold); stop once folded. Never clobbers a live /send stream or paged-back scrollback.
  useEffect(() => {
    if (!sessionId || !hasActiveBgSubagent) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    async function poll() {
      try {
        const { items, pilotMsgs } = await fetchSessionPage1(agentId, sessionId!)
        if (cancelled) return
        if (pageRef.current === 1 && !streamingRef.current) {
          setMessages(pilotMsgs)
          setHasMore(items.length >= PAGE_SIZE)
        }
        if (!hasActiveBackgroundSubagent(pilotMsgs)) return // folded → stop polling
      } catch (err) {
        console.warn("[usePilotChat] background-subagent refresh failed:", err)
      }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [agentId, sessionId, hasActiveBgSubagent])

  // Persistent per-session SSE: receives server-pushed turns that land while the user is
  // idle — e.g. a background job's completion turn, generated AFTER the /send stream closed.
  // We do NOT render events live off this channel (the synthetic turn's body isn't streamed
  // here — message_update text deltas are intentionally not emitted). Instead, a
  // `background_turn_done` signal triggers a silent history refetch, so the completed turn
  // appears without a manual reload. EventSource can't set headers → JWT via ?token=.
  useEffect(() => {
    if (!sessionId) return
    const token = localStorage.getItem("token")
    if (!token) return

    let closed = false
    let refetchTimer: ReturnType<typeof setTimeout> | null = null

    async function refetchHistory() {
      // Only safe to wholesale-replace with page 1 when page 1 is all that's loaded.
      // If the user has paged back (loaded older history), replacing would discard that
      // scrollback — skip the live refresh; the completed turn still appears on their next
      // message or on reload.
      if (pageRef.current !== 1) return
      try {
        const { items, pilotMsgs } = await fetchSessionPage1(agentId, sessionId!)
        if (closed) return
        setMessages(pilotMsgs)
        setHasMore(items.length >= PAGE_SIZE)
      } catch (err) {
        console.warn("[usePilotChat] background-turn refetch failed:", err)
      }
    }

    // Debounced refetch that DEFERS while a live /send is streaming (don't clobber the
    // active stream); re-checks at fire time and reschedules if still streaming.
    function scheduleRefetch() {
      if (refetchTimer) clearTimeout(refetchTimer)
      refetchTimer = setTimeout(() => {
        if (closed) return
        if (streamingRef.current) { scheduleRefetch(); return }
        void refetchHistory()
      }, 400)
    }

    const url = `/api/v1/siclaw/agents/${agentId}/chat/sessions/${sessionId}/events?token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    es.addEventListener("chat.event", (ev: MessageEvent) => {
      try {
        const evt = JSON.parse(ev.data) as Record<string, unknown>
        if (evt?.type === "background_turn_done") {
          scheduleRefetch()
        } else if (evt?.type === "exec_job_done" && typeof evt.job_id === "string") {
          // Flip the launching tool's box in place (running → done/failed) live, no refetch.
          const jobId = evt.job_id
          const status = typeof evt.status === "string" ? evt.status : "completed"
          const exitCode = typeof evt.exit_code === "number" ? evt.exit_code : null
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "tool" && (m.metadata as Record<string, unknown> | undefined)?.backgroundTaskId === jobId
                ? { ...m, metadata: { ...(m.metadata ?? {}), bgStatus: status, bgExitCode: exitCode } }
                : m,
            ),
          )
        } else if (evt?.type === "subagent_done" && typeof evt.job_id === "string") {
          // Fold the background spawn_subagent card in place (running → done/failed/…), regardless
          // of page/stream state — so a completion the model stays silent about doesn't leave the
          // card stuck on "Running…". The refetch reconciles the full summary later.
          const jobId = evt.job_id
          const raw = (typeof evt.status === "string" ? evt.status : "completed").toLowerCase()
          const status = raw === "completed" ? "done" : raw === "stopped" ? "cancelled" : raw // failed/timed_out/partial pass through
          setMessages((prev) =>
            prev.map((m) => {
              if (!isBackgroundSpawnLaunch(m) || m.metadata?.subBgStatus) return m
              const parsedJobId = (m.content ? tryParseJson(m.content) : undefined)?.job_id
              const launchJobId = (typeof parsedJobId === "string" ? parsedJobId : undefined) ?? messageDelegationId(m) ?? m.id
              return launchJobId === jobId
                ? { ...m, metadata: { ...(m.metadata ?? {}), subBackground: true, subBgStatus: status } }
                : m
            }),
          )
        }
      } catch { /* ignore malformed frame */ }
    })
    // EventSource auto-reconnects on transient errors; nothing to do here.

    return () => {
      closed = true
      if (refetchTimer) clearTimeout(refetchTimer)
      es.close()
    }
  }, [agentId, sessionId])

  // Process a chat.event from the SSE stream
  const handleChatEvent = useCallback(
    (evt: Record<string, unknown>) => {
      const eventType = evt.type as string

      // Live task-ledger event — it carries `kind` (not `type`), so it never matches the
      // switch below. Append it as a hidden message whose metadata foldPlan replays, so the
      // Plan panel updates during the turn (not only after a reload picks up the persisted row).
      if (evt.kind === "task_event") {
        setMessages((prev) => [
          ...prev,
          {
            id: `taskev-live-${prev.length}`,
            role: "user" as const,
            content: "",
            hidden: true,
            metadata: evt,
            timestamp: timeNow(),
          },
        ])
        return
      }

      switch (eventType) {
        // --- Text streaming (simplified brain: agent_message is the portal gateway's text event) ---
        case "agent_message": {
          const text = evt.text as string | undefined
          if (text) {
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last?.isStreaming && last.role === "assistant") {
                return [...prev.slice(0, -1), { ...last, content: last.content + text }]
              }
              return [
                ...prev,
                {
                  id: `msg-${Date.now()}`,
                  role: "assistant" as const,
                  content: text,
                  timestamp: timeNow(),
                  isStreaming: true,
                },
              ]
            })
          }
          break
        }

        // --- Claude SDK / pi-agent text delta ---
        case "message_update": {
          const ame = evt.assistantMessageEvent as { type: string; delta?: string } | undefined
          if (ame?.type === "text_delta" && ame.delta) {
            setMessages((prev) => {
              // Append to the assistant bubble that is still streaming, even if tool
              // rows were pushed after it: one assistant turn can be text → tool call
              // → more text, and that text must stay in ONE bubble (otherwise a
              // markdown table spanning the tool call splits across two bubbles and
              // renders broken until reload). message_end clears isStreaming, so this
              // only ever finds the CURRENT turn's bubble — separate turns still get
              // their own bubble.
              for (let i = prev.length - 1; i >= 0; i--) {
                const m = prev[i]
                if (m.isStreaming && m.role === "assistant") {
                  const updated = [...prev]
                  updated[i] = { ...m, content: m.content + ame.delta }
                  return updated
                }
              }
              return [
                ...prev,
                {
                  id: `msg-${Date.now()}`,
                  role: "assistant" as const,
                  content: ame.delta!,
                  timestamp: timeNow(),
                  isStreaming: true,
                },
              ]
            })
          }
          break
        }

        // --- Tool execution start ---
        case "tool_execution_start": {
          const toolName = evt.toolName as string | undefined
          const args = evt.args as Record<string, unknown> | undefined
          const toolInput = formatToolInput(toolName ?? "", args)
          const hidden = toolName === "update_plan" || isTaskTool(toolName)
          const dbMessageId = evt.dbMessageId as string | undefined
          // 💭 Pre-tool thinking time (gap from previous tool_end / turn-start
          // to now). Server-stamped; matches the value persisted in the row's
          // metadata.pre_thinking_ms, so live and reload render identically.
          const preThinkingMs = typeof evt.preThinkingMs === "number" ? evt.preThinkingMs : undefined
          const showThinking = preThinkingMs != null

          setMessages((prev) => [
            ...prev,
            {
              id: dbMessageId ?? `tool-${Date.now()}`,
              role: "tool" as const,
              content: "",
              toolName: toolName ?? "tool",
              toolArgs: args,
              toolInput,
              toolCallId: evt.toolCallId as string | undefined,
              toolStatus: "running" as const,
              timestamp: timeNow(),
              isStreaming: true,
              hidden,
              ...(showThinking ? { timing: { thinkingMs: preThinkingMs } } : {}),
            },
          ])
          break
        }

        // --- Tool execution update (live partial result, e.g. spawn_subagent streaming its progress) ---
        case "tool_execution_update": {
          const toolCallId = evt.toolCallId as string | undefined
          const partial = evt.partialResult as
            | { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }
            | undefined
          if (!toolCallId || !partial?.details) break
          setMessages((prev) => {
            const i = prev.findIndex((m) => m.role === "tool" && m.toolCallId === toolCallId)
            if (i < 0) return prev
            const updated = [...prev]
            const merged = { ...(updated[i].toolDetails ?? {}), ...partial.details }
            updated[i] = { ...updated[i], toolDetails: merged, metadata: { ...(updated[i].metadata ?? {}), ...partial.details } }
            return updated
          })
          break
        }

        // --- Tool execution end ---
        case "tool_execution_end": {
          const result = evt.result as
            | { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }
            | undefined
          const resultText =
            result?.content
              ?.filter((c: { type: string }) => c.type === "text")
              .map((c: { text?: string }) => c.text ?? "")
              .join("") ?? ""
          const toolDetails = result?.details
          const isError = evt.isError as boolean | undefined
          // Use real DB message ID if available (enables metadata persistence)
          const dbMessageId = evt.dbMessageId as string | undefined
          // ⚙️ Server-stamped tool execution duration (matches duration_ms
          // column written at the same moment).
          const durationMs = typeof evt.durationMs === "number" ? evt.durationMs : undefined

          const endToolCallId = evt.toolCallId as string | undefined
          setMessages((prev) => {
            // Correlate the result to its OWN tool box: prefer the DB id, then the toolCallId
            // (so parallel/sequential tool calls never cross-attach), and only then fall back
            // to the last still-running tool box.
            const index = dbMessageId
              ? prev.findIndex((m) => m.id === dbMessageId && m.role === "tool")
              : endToolCallId
                ? prev.findIndex((m) => m.role === "tool" && m.toolCallId === endToolCallId && Boolean(m.isStreaming))
                : -1
            const fallbackIndex = index >= 0
              ? index
              : findLastMessageIndex(prev, (m) => m.role === "tool" && Boolean(m.isStreaming))
            if (fallbackIndex >= 0) {
              const current = prev[fallbackIndex]
              const next = {
                ...current,
                content: resultText,
                toolStatus: isError ? ("error" as const) : ("success" as const),
                isStreaming: false,
                ...(toolDetails ? { toolDetails, metadata: toolDetails } : {}),
                ...(durationMs != null ? { timing: { ...(current.timing ?? {}), durationMs } } : {}),
                ...(dbMessageId ? { id: dbMessageId } : {}),
              }
              return [
                ...prev.slice(0, fallbackIndex),
                next,
                ...prev.slice(fallbackIndex + 1),
              ]
            }
            return prev
          })
          break
        }

        // --- Background exec job finished: flip the launching tool's box in place ---
        // (running → done/failed) without a refetch, so it updates immediately even while a
        // turn is streaming. Correlated by jobId === the launch's backgroundTaskId.
        case "exec_job_done": {
          const jobId = evt.job_id as string | undefined
          if (!jobId) break
          const status = typeof evt.status === "string" ? evt.status : "completed"
          const exitCode = typeof evt.exit_code === "number" ? evt.exit_code : null
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "tool" && (m.metadata as Record<string, unknown> | undefined)?.backgroundTaskId === jobId
                ? { ...m, metadata: { ...(m.metadata ?? {}), bgStatus: status, bgExitCode: exitCode } }
                : m,
            ),
          )
          break
        }

        // --- Message start (steer messages injected mid-conversation) ---
        case "message_start": {
          const msg = evt.message as
            | {
                role?: string
                customType?: string
                details?: Record<string, unknown>
                content?: string | Array<{ type: string; text?: string }>
              }
            | undefined

          // Show steer (user) messages injected mid-conversation.
          // The initial prompt's user message is already displayed by send(),
          // so only create a PilotMessage if the text is in pendingSteers (= steer).
          if (msg?.role === "user") {
            const text = extractUserMessageText(msg.content)
            if (text) {
              setPendingSteers((prev) => {
                const idx = findPendingSteerIndex(prev.map((pending) => pending.matchText), text)
                if (idx < 0) return prev // not a steer — already displayed
                const pending = prev[idx]
                // Steer message: add to chat and remove from pending
                setMessages((msgs) => [
                  ...msgs,
                  {
                    id: `msg-${Date.now()}`,
                    role: "user" as const,
                    content: pending.text.trim() ? text : pending.text,
                    timestamp: timeNow(),
                    ...(pending.attachments?.length ? { attachments: pending.attachments } : {}),
                  },
                ])
                return removePendingAt(prev, idx)
              })
            }
          }
          break
        }

        // --- Message end (tool details backfill + mark assistant done) ---
        case "message_end": {
          const endMsg = evt.message as
            | { role?: string; toolName?: string; details?: Record<string, unknown> }
            | undefined
          // ⏳/💭/✍️ Server-stamped per-message timing block, attached to
          // the event by sse-consumer right before persistence.
          const evtTiming = evt.timing as
            | { ttft_ms?: number; thinking_ms?: number; output_ms?: number; turn_total_ms?: number }
            | undefined
          if (endMsg?.role === "assistant" && evtTiming) {
            setMessages((prev) => {
              const idx = findLastMessageIndex(prev, (m) => m.role === "assistant")
              if (idx < 0) return prev
              const current = prev[idx]
              const timing = {
                ...(current.timing ?? {}),
                ...(typeof evtTiming.ttft_ms === "number" ? { ttftMs: evtTiming.ttft_ms } : {}),
                ...(typeof evtTiming.thinking_ms === "number" ? { thinkingMs: evtTiming.thinking_ms } : {}),
                ...(typeof evtTiming.output_ms === "number" ? { outputMs: evtTiming.output_ms } : {}),
                ...(typeof evtTiming.turn_total_ms === "number" ? { turnTotalMs: evtTiming.turn_total_ms } : {}),
              }
              return [...prev.slice(0, idx), { ...current, timing }, ...prev.slice(idx + 1)]
            })
          }
          if (endMsg?.role === "toolResult" && endMsg.details && Object.keys(endMsg.details).length > 0) {
            // Pi-agent brain: tool result details arrive via message_end (not tool_execution_end).
            // Backfill toolDetails onto the matching tool message.
            const tName = endMsg.toolName
            setMessages((prev) => {
              // Walk backwards to find the most recent tool message with this name
              for (let i = prev.length - 1; i >= 0; i--) {
                const m = prev[i]
                if (m.role === "tool" && (!tName || m.toolName === tName) && !m.toolDetails) {
                  const updated = [...prev]
                  updated[i] = { ...m, toolDetails: endMsg.details }
                  return updated
                }
              }
              return prev
            })
          }
          // Mark current streaming assistant message as complete
          setMessages((prev) =>
            prev.map((m) => (m.isStreaming && m.role === "assistant" ? { ...m, isStreaming: false } : m)),
          )
          break
        }

        // --- Auto compaction ---
        case "auto_compaction_start":
          setIsCompacting(true)
          break

        case "auto_compaction_end":
          setIsCompacting(false)
          break

        // --- Turn end (mark streaming messages done, but keep loading — agent may have more turns) ---
        case "turn_end":
          setMessages((prev) => prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)))
          break

        // --- Prompt done (agent prompt truly finished) ---
        case "prompt_done":
          setMessages((prev) => prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)))
          // During abort, don't unlock here — abort handler will do it after RPC completes
          if (!isAbortingRef.current) {
            setStreaming(false)
            streamingRef.current = false
            recoveredStreamingRef.current = false
          }
          setPendingSteers([])
          break

        // --- Agent start (agent started processing) ---
        case "agent_start":
          setStreaming(true)
          streamingRef.current = true
          break

        // --- Agent end / turn complete / done ---
        case "agent_end":
        case "turn_complete":
        case "done": {
          setMessages((prev) => prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)))
          setStreaming(false)
          streamingRef.current = false
          recoveredStreamingRef.current = false
          setPendingSteers([])
          // Update context usage from agent_end event
          const cu = evt.contextUsage as ContextUsage | undefined
          if (cu) {
            setContextUsage(cu)
          }
          break
        }

        // --- Auto retry (model retries) ---
        case "auto_retry_start":
          // Agent is retrying — keep streaming state active
          break

        case "auto_retry_end":
          // Retry finished — agent continues normally
          break
      }
    },
    [resetDpState],
  )

  // --- Load more (older) messages ---
  const loadMore = useCallback(async () => {
    if (!sessionId || !hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const nextPage = pageRef.current + 1
      const res = await api<{ data: ChatMessage[] }>(
        `/siclaw/agents/${agentId}/chat/sessions/${sessionId}/messages?page=${nextPage}&page_size=${PAGE_SIZE}`,
      )
      const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as unknown as ChatMessage[]) : []
      const olderMsgs = items.map(toPilotMessage)
      setMessages((prev) => annotateDelegationSynthesis([...olderMsgs, ...prev]))
      setHasMore(items.length >= PAGE_SIZE)
      pageRef.current = nextPage
    } catch (err) {
      console.error("[usePilotChat] Failed to load more messages:", err)
    } finally {
      setLoadingMore(false)
    }
  }, [agentId, sessionId, hasMore, loadingMore])

  const handleSteerFailure = useCallback((err: unknown, pending: PendingSteer) => {
    console.error("[usePilotChat] steer error:", err)
    setPendingSteers((prev) => prev.filter((item) => item !== pending))
    const body = (err as { body?: unknown }).body
    const detail = body !== undefined
      ? parseErrorDetail(body)
      : {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Failed to steer",
          retriable: true,
        }
    setMessages((prev) => [...prev, makeErrorMessage(detail)])
  }, [])

  // --- Send a message ---
  const send = useCallback(
    (text: string, attachments?: ChatAttachment[]) => {
      if ((streamingRef.current || hasPendingDelegationSynthesis(messages)) && sessionId) {
        // While streaming, send as steer
        const pending: PendingSteer = {
          text,
          matchText: pendingSteerMatchText(text, !!attachments?.length),
          ...(attachments?.length ? { attachments } : {}),
        }
        chatSteer(agentId, sessionId, text, attachments).catch((err) => handleSteerFailure(err, pending))
        setPendingSteers((prev) => [...prev, pending])
        return
      }

      // Add user message optimistically
      const userMsg: PilotMessage = {
        id: `msg-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: timeNow(),
        ...(attachments?.length ? { attachments } : {}),
      }
      setMessages((prev) => [...prev, userMsg])
      setStreaming(true)
      streamingRef.current = true
      recoveredStreamingRef.current = false
      setStreamText("")

      // Start SSE
      const controller = new AbortController()
      abortControllerRef.current = controller
      const streamSessionId = sessionId // capture at call time
      const token = localStorage.getItem("token")

      ;(async () => {
        try {
          const res = await fetch(`/api/v1/siclaw/agents/${agentId}/chat/send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ text, session_id: sessionId, attachments }),
            signal: controller.signal,
          })

          if (!res.ok) {
            // Try to read error envelope from body before failing.
            let bodyDetail: ErrorDetail | null = null
            try {
              const bodyText = await res.text()
              if (bodyText) bodyDetail = parseErrorDetail(JSON.parse(bodyText))
            } catch {
              // body wasn't JSON — fall through to generic
            }
            const detail: ErrorDetail = bodyDetail ?? {
              code: "INTERNAL_ERROR",
              message: `Request failed (HTTP ${res.status})`,
              retriable: res.status >= 500,
            }
            throw Object.assign(new Error(detail.message), { __errorDetail: detail })
          }

          const reader = res.body?.getReader()
          if (!reader) throw new Error("No body")

          const decoder = new TextDecoder()
          let buffer = ""

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const frames = buffer.split("\n\n")
            buffer = frames.pop() || ""

            for (const frame of frames) {
              if (!frame.trim()) continue
              const isActive = activeSessionIdRef.current === streamSessionId
              let event = "message"
              let data = ""
              for (const line of frame.split("\n")) {
                if (line.startsWith("event: ")) event = line.slice(7)
                else if (line.startsWith("data: ")) data = line.slice(6)
              }
              if (!data) continue
              try {
                const parsed = JSON.parse(data)
                if (event === "session") {
                  // Session ID from backend — we already have it from the prop
                } else if (event === "chat.event") {
                  if (isActive) handleChatEvent(parsed)
                } else if (event === "chat.text") {
                  const chunk = parsed.text || ""
                  if (chunk && isActive) {
                    setMessages((prev) => {
                      const last = prev[prev.length - 1]
                      if (last?.isStreaming && last.role === "assistant") {
                        return [...prev.slice(0, -1), { ...last, content: last.content + chunk }]
                      }
                      return [
                        ...prev,
                        {
                          id: `msg-${Date.now()}`,
                          role: "assistant" as const,
                          content: chunk,
                          timestamp: timeNow(),
                          isStreaming: true,
                        },
                      ]
                    })
                  }
                } else if (event === "done") {
                  if (isActive) {
                    setMessages((prev) => prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)))
                    setStreaming(false)
                    streamingRef.current = false
                    recoveredStreamingRef.current = false
                    setPendingSteers([])
                  }
                  // Update cache: mark stream as finished so switching back shows final state
                  if (streamSessionId) { const cached = messagesCacheRef.current.get(streamSessionId); if (cached) cached.streaming = false }
                } else if (event === "error") {
                  console.error("[usePilotChat] SSE error:", parsed)
                  const detail = parseErrorDetail(parsed)
                  if (isActive) {
                    setMessages((prev) => [...prev, makeErrorMessage(detail)])
                    setStreaming(false)
                    streamingRef.current = false
                    recoveredStreamingRef.current = false
                  }
                  if (streamSessionId) { const cached = messagesCacheRef.current.get(streamSessionId); if (cached) cached.streaming = false }
                }
              } catch {
                // Ignore parse errors
              }
            }
          }

          // Stream ended — finalize (only if still on this session)
          if (activeSessionIdRef.current === streamSessionId) {
            setMessages((prev) => prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)))
            if (streamingRef.current) {
              setStreaming(false)
              streamingRef.current = false
              recoveredStreamingRef.current = false
            }
          }
        } catch (err) {
          const isAbort = (err as Error).name === "AbortError"
          if (!isAbort) {
            console.error("[usePilotChat] SSE error:", err)
          }
          if (activeSessionIdRef.current === streamSessionId) {
            setMessages((prev) => {
              const cleared = prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
              if (isAbort) return cleared
              const attached = (err as { __errorDetail?: ErrorDetail }).__errorDetail
              const detail = attached ?? {
                code: "STREAM_INTERRUPTED",
                message: err instanceof Error ? err.message : "Connection lost",
                retriable: true,
              }
              return [...cleared, makeErrorMessage(detail)]
            })
            setStreaming(false)
            streamingRef.current = false
            recoveredStreamingRef.current = false
          }
        } finally {
          if (abortControllerRef.current === controller) abortControllerRef.current = null
          // Unconditionally mark this session as no longer streaming in the cache.
          // If the user navigated away while the stream was running, the isActive
          // checks above skip setStreaming(false) — but the cache entry must still
          // be cleared so that switching back to this session triggers a DB load
          // (which has the complete, persisted messages) instead of restoring a
          // stale cache snapshot that shows "streaming" forever.
          if (streamSessionId) {
            const cached = messagesCacheRef.current.get(streamSessionId)
            if (cached) cached.streaming = false
          }
        }
      })()
    },
    [agentId, sessionId, messages, handleChatEvent, handleSteerFailure],
  )

  // --- Steer ---
  const steer = useCallback(
    (text: string, attachments?: ChatAttachment[]) => {
      if (!sessionId) return
      const pending: PendingSteer = {
        text,
        matchText: pendingSteerMatchText(text, !!attachments?.length),
        ...(attachments?.length ? { attachments } : {}),
      }
      chatSteer(agentId, sessionId, text, attachments).catch((err) => handleSteerFailure(err, pending))
      setPendingSteers((prev) => [...prev, pending])
    },
    [agentId, sessionId, handleSteerFailure],
  )

  // --- Abort ---
  const abort = useCallback(async () => {
    if (!sessionId) return
    isAbortingRef.current = true
    setPendingSteers([])
    // Mark all streaming messages as complete visually
    setMessages((prev) =>
      prev.map((m) =>
        m.isStreaming
          ? { ...m, isStreaming: false, ...(m.role === "tool" ? { toolStatus: "aborted" as const } : {}) }
          : m,
      ),
    )
    try {
      abortControllerRef.current?.abort()
      await chatAbort(agentId, sessionId)
    } catch (err) {
      console.error("[usePilotChat] abort error:", err)
    }
    // Only allow new input after backend confirms abort
    isAbortingRef.current = false
    setStreaming(false)
    streamingRef.current = false
    recoveredStreamingRef.current = false
  }, [agentId, sessionId])

  // --- Remove pending ---
  const removePending = useCallback((index: number) => {
    setPendingSteers((prev) => removePendingAt(prev, index))
  }, [])

  // --- Exit DP ---
  const exitDp = useCallback(() => {
    if (sessionId) {
      chatSteer(agentId, sessionId, "[DP_EXIT]\nUser requested to exit Deep Investigation.").catch(console.error)
    }
    resetDpState()
  }, [agentId, sessionId, resetDpState])

  const pendingMessages = useMemo(
    () => pendingSteers.map((pending) => pending.text || "(No content)"),
    [pendingSteers],
  )

  return {
    messages,
    streaming,
    streamText,
    dpActive,
    contextUsage,
    isCompacting,
    pendingMessages,
    hasMore,
    loadingMore,
    send,
    steer,
    abort,
    loadMore,
    setDpActive,
    removePending,
    exitDp,
  }
}
