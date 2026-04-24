/**
 * usePilotChat — manages Pilot-style chat state over HTTP/SSE.
 *
 * Replaces the original usePilot hook which used WebSocket RPC.
 * Uses chatSSE (from api.ts) for streaming, chatSteer for mid-stream injection,
 * and chatAbort for cancellation.
 */

import { useState, useCallback, useEffect, useRef } from "react"
import { api, chatSteer, chatAbort } from "../api"
import type {
  PilotMessage,
  ContextUsage,
} from "../components/chat/types"
import { findPendingSteerIndex, removePendingAt, extractUserMessageText } from "./steer-pending"

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
  send: (text: string) => void
  steer: (text: string) => void
  abort: () => void
  loadMore: () => void
  setDpActive: (active: boolean) => void
  removePending: (index: number) => void
  exitDp: () => void
}

const DELEGATED_TOOL_STALE_MS = 4 * 60 * 1000
const DELEGATED_TOOL_NAMES = new Set(["delegate_to_agent", "delegate_to_agents"])

/** Format tool args into a readable one-liner for display */
function formatToolInput(toolName: string, args?: Record<string, unknown>): string {
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

function isStaleDelegationTool(m: ChatMessage): boolean {
  if (m.role !== "tool") return false
  if (m.outcome) return false
  if (!m.tool_name || !DELEGATED_TOOL_NAMES.has(m.tool_name)) return false
  const createdAt = parsePortalTimestamp(m.created_at)
  if (!Number.isFinite(createdAt)) return false
  return Date.now() - createdAt > DELEGATED_TOOL_STALE_MS
}

function toolStatusFromMessage(m: ChatMessage): PilotMessage["toolStatus"] | undefined {
  if (m.role !== "tool") return undefined;
  if (isStaleDelegationTool(m)) return "error";
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

function toPilotMessage(m: ChatMessage): PilotMessage {
  const toolArgs = m.tool_input ? tryParseJson(m.tool_input) : undefined
  const metadata = normalizeMetadata(m.metadata)
  const isDelegationEvent = metadata?.kind === "delegation_event"
  const staleDelegation = isStaleDelegationTool(m)
  const toolStatus = toolStatusFromMessage(m)
  const recoveredMetadata = staleDelegation
    ? {
        ...(metadata ?? {}),
        status: "timed_out",
        recovery_reason: "stale_delegation_tool",
      }
    : metadata
  return {
    id: m.id,
    role: m.role,
    content: staleDelegation && !m.content?.trim()
      ? "Delegated investigation did not finish before the recovery window. It may have timed out or been interrupted."
      : m.content,
    toolName: m.tool_name,
    toolArgs,
    toolInput: toolArgs ? formatToolInput(m.tool_name ?? "", toolArgs) : undefined,
    toolStatus,
    metadata: recoveredMetadata,
    hidden: m.hidden || isDelegationEvent,
    fromAgentId: m.from_agent_id ?? null,
    parentSessionId: m.parent_session_id ?? null,
    delegationId: m.delegation_id ?? null,
    targetAgentId: m.target_agent_id ?? null,
    timestamp: formatPortalTimestamp(m.created_at),
    isStreaming: toolStatus === "running",
  }
}

function hasRunningPersistedMessages(messages: PilotMessage[]): boolean {
  return messages.some((m) => m.role === "tool" && (m.toolStatus === "running" || m.isStreaming))
}

export function usePilotChat({ agentId, sessionId }: UsePilotChatOptions): UsePilotChatReturn {
  const [messages, setMessages] = useState<PilotMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState("")
  const [dpActive, setDpActive] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const [pendingMessages, setPendingMessages] = useState<string[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const pageRef = useRef(1)

  const abortControllerRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  const recoveredStreamingRef = useRef(false)
  const isAbortingRef = useRef(false)
  const activeSessionIdRef = useRef<string | undefined>(sessionId ?? undefined)
  const [isCompacting, setIsCompacting] = useState(false)

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

  const PAGE_SIZE = 20

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
        const res = await api<{ data: ChatMessage[] }>(
          `/siclaw/agents/${agentId}/chat/sessions/${sessionId}/messages?page=1&page_size=${PAGE_SIZE}`,
        )
        const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as unknown as ChatMessage[]) : []
        if (cancelled) return
        const pilotMsgs: PilotMessage[] = items.map(toPilotMessage)
        const recoveredActive = hasRunningPersistedMessages(pilotMsgs)
        setMessages(pilotMsgs)
        setStreaming(recoveredActive)
        streamingRef.current = recoveredActive
        recoveredStreamingRef.current = recoveredActive
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
        const res = await api<{ data: ChatMessage[] }>(
          `/siclaw/agents/${agentId}/chat/sessions/${sessionId}/messages?page=1&page_size=${PAGE_SIZE}`,
        )
        if (cancelled) return
        const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as unknown as ChatMessage[]) : []
        const pilotMsgs = items.map(toPilotMessage)
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
          setPendingMessages([])
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

  // Process a chat.event from the SSE stream
  const handleChatEvent = useCallback(
    (evt: Record<string, unknown>) => {
      const eventType = evt.type as string

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
              const last = prev[prev.length - 1]
              if (last?.isStreaming && last.role === "assistant") {
                return [...prev.slice(0, -1), { ...last, content: last.content + ame.delta }]
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
          const hidden = toolName === "update_plan"
          const dbMessageId = evt.dbMessageId as string | undefined

          setMessages((prev) => [
            ...prev,
            {
              id: dbMessageId ?? `tool-${Date.now()}`,
              role: "tool" as const,
              content: "",
              toolName: toolName ?? "tool",
              toolArgs: args,
              toolInput,
              toolStatus: "running" as const,
              timestamp: timeNow(),
              isStreaming: true,
              hidden,
            },
          ])
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

          setMessages((prev) => {
            const index = dbMessageId
              ? prev.findIndex((m) => m.id === dbMessageId && m.role === "tool")
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
          // so only create a PilotMessage if the text is in pendingMessages (= steer).
          if (msg?.role === "user") {
            const text = extractUserMessageText(msg.content)
            if (text) {
              setPendingMessages((prev) => {
                const idx = findPendingSteerIndex(prev, text)
                if (idx < 0) return prev // not a steer — already displayed
                // Steer message: add to chat and remove from pending
                setMessages((msgs) => [
                  ...msgs,
                  {
                    id: `msg-${Date.now()}`,
                    role: "user" as const,
                    content: text,
                    timestamp: timeNow(),
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
          setPendingMessages([])
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
          setPendingMessages([])
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
      const olderMsgs: PilotMessage[] = items.map(toPilotMessage)
      setMessages((prev) => [...olderMsgs, ...prev])
      setHasMore(items.length >= PAGE_SIZE)
      pageRef.current = nextPage
    } catch (err) {
      console.error("[usePilotChat] Failed to load more messages:", err)
    } finally {
      setLoadingMore(false)
    }
  }, [agentId, sessionId, hasMore, loadingMore])

  // --- Send a message ---
  const send = useCallback(
    (text: string) => {
      if (streamingRef.current && sessionId) {
        // While streaming, send as steer
        chatSteer(agentId, sessionId, text).catch((err) => console.error("[usePilotChat] steer error:", err))
        setPendingMessages((prev) => [...prev, text])
        return
      }

      // Add user message optimistically
      const userMsg: PilotMessage = {
        id: `msg-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: timeNow(),
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
            body: JSON.stringify({ text, session_id: sessionId }),
            signal: controller.signal,
          })

          if (!res.ok) throw new Error(`HTTP ${res.status}`)

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
                    setPendingMessages([])
                  }
                  // Update cache: mark stream as finished so switching back shows final state
                  if (streamSessionId) { const cached = messagesCacheRef.current.get(streamSessionId); if (cached) cached.streaming = false }
                } else if (event === "error") {
                  console.error("[usePilotChat] SSE error:", parsed)
                  if (isActive) {
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
          if ((err as Error).name !== "AbortError") {
            console.error("[usePilotChat] SSE error:", err)
          }
          if (activeSessionIdRef.current === streamSessionId) {
            setMessages((prev) => prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)))
            setStreaming(false)
            streamingRef.current = false
            recoveredStreamingRef.current = false
          }
        } finally {
          if (abortControllerRef.current === controller) abortControllerRef.current = null
        }
      })()
    },
    [agentId, sessionId, handleChatEvent],
  )

  // --- Steer ---
  const steer = useCallback(
    (text: string) => {
      if (!sessionId) return
      chatSteer(agentId, sessionId, text).catch((err) => console.error("[usePilotChat] steer error:", err))
      setPendingMessages((prev) => [...prev, text])
    },
    [agentId, sessionId],
  )

  // --- Abort ---
  const abort = useCallback(async () => {
    if (!sessionId) return
    isAbortingRef.current = true
    setPendingMessages([])
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
    setPendingMessages((prev) => [...prev.slice(0, index), ...prev.slice(index + 1)])
  }, [])

  // --- Exit DP ---
  const exitDp = useCallback(() => {
    if (sessionId) {
      chatSteer(agentId, sessionId, "[DP_EXIT]\nUser requested to exit Deep Investigation.").catch(console.error)
    }
    resetDpState()
  }, [agentId, sessionId, resetDpState])

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
