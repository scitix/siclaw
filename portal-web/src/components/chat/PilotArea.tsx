import { useRef, useEffect, useState, useCallback, useMemo } from "react"
import {
  Terminal,
  User,
  Bot,
  Loader2,
  ChevronRight,
  FileCode,
  SearchCode,
  CheckCircle2,
  XCircle,
  Ban,
  MessageSquare,
  Copy,
  Check,
  Users,
  Clock,
} from "lucide-react"
import { cn } from "./cn"
import { Markdown } from "./Markdown"
import { InputArea } from "./InputArea"
import { SkillCard } from "./SkillCard"
import { ScheduleCard } from "./ScheduleCard"
import type { PilotMessage, ContextUsage, ActionChip, PrefixActionChip } from "./types"

const DIG_DEEPER_CHIP: PrefixActionChip = {
  kind: "prefix",
  id: "dig-deeper",
  label: "Dig deeper",
  fullPrompt:
    "Your conclusion may not be the root cause. Please dig deeper — trace where the problematic values, configurations, or states come from. Check the upstream resources, dependencies, and configuration sources until you find the original cause.",
  placeholder: "Add detail for deeper investigation (optional)",
}

/**
 * Legacy DP prefix chips. These are no longer rendered for every DP turn; they
 * stay in the parser so existing messages created by the previous UI can still
 * round-trip as compact pills instead of exposing the injected fullPrompt.
 */
const LEGACY_DP_PREFIX_CHIPS: PrefixActionChip[] = [
  {
    kind: "prefix",
    id: "dp-proceed",
    label: "Proceed",
    fullPrompt: "Proceed with your current investigation direction.",
    placeholder: "Add context (optional)",
  },
  {
    kind: "prefix",
    id: "dp-adjust",
    label: "Adjust",
    fullPrompt: "Adjust your investigation direction based on my input below.",
    placeholder: "Describe the adjustment you want...",
  },
  {
    kind: "prefix",
    id: "dp-skip",
    label: "Skip",
    fullPrompt:
      "Stop invoking tools. Give me your best conclusion from the information you already have.",
    placeholder: "Add context (optional)",
  },
]

/**
 * Hypothesis checkpoint controls are shown only when the model emits the
 * hidden checkpoint marker. They look like simple user-facing actions, but
 * expand into a hidden instruction prompt when sent so the user never has to
 * type protocol letters like A/B/C.
 */
const DP_CHECKPOINT_PREFIX_CHIPS: Record<string, PrefixActionChip> = {
  A: {
    kind: "prefix",
    id: "dp-checkpoint-proceed",
    label: "Proceed",
    fullPrompt:
      "Proceed with the current leading hypothesis or most promising lead. Do not ask for confirmation again; take the next validation step and report evidence.",
    placeholder: "Add optional direction for this step",
  },
  B: {
    kind: "prefix",
    id: "dp-checkpoint-refine",
    label: "Refine",
    fullPrompt:
      "Refine or add hypotheses based on my additional direction below. Preserve useful evidence, update confidence, and explain what changed.",
    placeholder: "Describe what to adjust or add",
  },
  C: {
    kind: "prefix",
    id: "dp-checkpoint-summarize",
    label: "Summarize",
    fullPrompt:
      "Stop deeper validation for now. Give the current best conclusion from existing evidence, including confidence and caveats.",
    placeholder: "Add optional summary preference",
  },
}

const THINKING_TIPS = [
  "Thinking...",
  "Tip: Enable Deep Investigation for hypothesis-driven root cause analysis",
  "Analyzing the situation...",
  "Tip: Use Skills to run reusable diagnostic scripts",
  "Working on it...",
]

export interface PilotAreaProps {
  messages: PilotMessage[]
  isLoading: boolean
  isLoadingHistory?: boolean
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  sendMessage: (text: string) => void
  abortResponse?: () => void
  contextUsage?: ContextUsage | null
  pendingMessages?: string[]
  onRemovePending?: (index: number) => void
  dpActive?: boolean
  onSetDpActive?: (active: boolean) => void
  sessionKey?: string | null
  onOpenSkillPanel?: (msg: PilotMessage) => void
  onOpenSchedulePanel?: (msg: PilotMessage) => void
  agentId?: string
}

export function PilotArea({
  messages,
  isLoading,
  isLoadingHistory,
  hasMore,
  loadingMore,
  onLoadMore,
  sendMessage,
  abortResponse,
  contextUsage,
  pendingMessages,
  onRemovePending,
  dpActive,
  onSetDpActive,
  sessionKey,
  onOpenSkillPanel,
  onOpenSchedulePanel,
  agentId,
}: PilotAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const prevMsgCountRef = useRef(0)
  const userScrolledAwayRef = useRef(false)
  const needsScrollOnLoadRef = useRef(false)
  const prevSessionKeyRef = useRef(sessionKey)

  useEffect(() => {
    if (prevSessionKeyRef.current !== sessionKey) {
      prevSessionKeyRef.current = sessionKey
      userScrolledAwayRef.current = false
      prevMsgCountRef.current = 0
      needsScrollOnLoadRef.current = true
    }
  }, [sessionKey])

  // Suggested reply draft
  const [chipSeq, setChipSeq] = useState(0)
  const [chipDraft, setChipDraft] = useState<string | null>(null)

  // Active prefix chip (e.g. "Dig deeper") shown as atomic pill in the input
  const [activePrefix, setActivePrefix] = useState<PrefixActionChip | null>(null)
  useEffect(() => {
    setActivePrefix(null)
  }, [sessionKey])

  const lastSentRef = useRef<string | null>(null)
  const wrappedSendMessage = useCallback(
    (text: string) => {
      if (!isLoading) lastSentRef.current = text
      sendMessage(text)
    },
    [sendMessage, isLoading],
  )
  const wrappedAbort = useCallback(() => {
    abortResponse?.()
    if (lastSentRef.current) {
      // Strip the injected markers + fullPrompt so only what the user actually
      // typed returns to the input. Same parsers used to render past user
      // bubbles cleanly, so round-trip is consistent.
      const { text: afterDp } = parseDeepInvestigation(lastSentRef.current)
      const { text: userTyped } = parseActionChipMarker(afterDp)
      setChipSeq((s) => s + 1)
      setChipDraft(userTyped)
      lastSentRef.current = null
    }
  }, [abortResponse])

  const scrollToBottom = useCallback((smooth = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollIntoView(smooth ? { behavior: "smooth" } : undefined)
    })
  }, [])

  // Find last assistant message id
  const lastAssistantMsgId = useMemo(() => {
    const visible = messages.filter((m) => !m.hidden)
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].role === "assistant") return visible[i].id
      if (visible[i].role === "user") return null
    }
    return null
  }, [messages])

  // Dig deeper button visibility — intentionally permissive.
  // Show whenever a non-streaming assistant reply exists in the current turn
  // outside Deep Investigation. Agency is with the user; no click-count cap.
  const showTraceButton = useMemo(() => {
    if (isLoading) return false
    if (dpActive) return false
    let turnStart = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        turnStart = i
        break
      }
    }
    if (turnStart < 0) return false
    return messages
      .slice(turnStart + 1)
      .some((m) => m.role === "assistant" && !m.isStreaming && (m.content?.trim().length ?? 0) > 0)
  }, [messages, isLoading, dpActive])
  const renderMessages = useMemo(() => withDelegationStatusNotices(messages), [messages])

  // Auto-scroll logic
  useEffect(() => {
    if (needsScrollOnLoadRef.current && messages.length > 0) {
      needsScrollOnLoadRef.current = false
      userScrolledAwayRef.current = false
      scrollToBottom(false)
    } else if (prevMsgCountRef.current === 0 && messages.length > 0) {
      userScrolledAwayRef.current = false
      scrollToBottom(false)
    } else if (messages.length > prevMsgCountRef.current) {
      const latest = messages[messages.length - 1]
      if (latest?.role === "user") {
        userScrolledAwayRef.current = false
        scrollToBottom(false)
      } else if (!userScrolledAwayRef.current) {
        scrollToBottom(true)
      }
    } else if (!userScrolledAwayRef.current) {
      scrollToBottom(true)
    }
    prevMsgCountRef.current = messages.length
  }, [messages, scrollToBottom])

  // Detect user scrolling away
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    userScrolledAwayRef.current = distanceFromBottom > 300
  }, [])

  return (
    <div className="flex-1 flex flex-col h-full bg-card">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 lg:px-8 py-8" onScroll={handleScroll}>
        <div className="max-w-5xl mx-auto space-y-8">
          {isLoadingHistory ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/70">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground/50 mb-4" />
              <p className="text-sm">Loading messages...</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/70">
              <MessageSquare className="w-12 h-12 text-gray-200 mb-4" />
              <p className="text-sm text-muted-foreground">Send a message to start the conversation</p>
            </div>
          ) : (
            <>
              {/* Load more button */}
              {hasMore && (
                <div className="flex justify-center pb-4">
                  <button
                    type="button"
                    onClick={onLoadMore}
                    disabled={loadingMore}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium text-muted-foreground bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      "Load earlier messages"
                    )}
                  </button>
                </div>
              )}

              {renderMessages
                .filter((m) => !m.hidden)
                .map((msg) => (
                  <MessageItem
                    key={msg.id}
                    message={msg}
                    sendMessage={wrappedSendMessage}
                    showSuggestedReplies={msg.id === lastAssistantMsgId && !isLoading}
                    dpActive={dpActive}
                    onChipClick={(chip, meta) => {
                      if (meta.isDpCheckpoint) {
                        const prefixChip = DP_CHECKPOINT_PREFIX_CHIPS[chip.insertText.toUpperCase()]
                        if (prefixChip) {
                          setActivePrefix(prefixChip)
                          setChipDraft(null)
                          return
                        }
                      }
                      setChipSeq((s) => s + 1)
                      setChipDraft(chip.insertText + " ")
                    }}
                    onOpenSkillPanel={onOpenSkillPanel}
                    onOpenSchedulePanel={onOpenSchedulePanel}
                    agentId={agentId}
                  />
                ))}

              {/* Dig deeper — shown when agent produced a conclusion and user may want
                  to trace the root cause upstream. Hidden while a prefix chip is active. */}
              {showTraceButton && !activePrefix && (
                <div className="flex justify-start pl-12 my-2">
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() => setActivePrefix(DIG_DEEPER_CHIP)}
                    className="flex items-center gap-2 px-5 py-2 rounded-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white text-sm font-medium shadow-sm hover:shadow-md transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <SearchCode className="w-4 h-4" />
                    Dig deeper
                  </button>
                </div>
              )}

              {isLoading && <ThinkingIndicator />}
            </>
          )}
          <div ref={scrollRef} />
        </div>
      </div>
      <InputArea
        onSend={wrappedSendMessage}
        onAbort={wrappedAbort}
        disabled={false}
        isLoading={isLoading}
        contextUsage={contextUsage}
        pendingMessages={pendingMessages}
        onRemovePending={onRemovePending}
        dpActive={dpActive}
        onSetDpActive={onSetDpActive}
        hasMessages={messages.length > 0}
        draft={chipDraft}
        draftSeq={chipSeq}
        activePrefix={activePrefix}
        onClearPrefix={() => setActivePrefix(null)}
      />
    </div>
  )
}

function ThinkingIndicator() {
  const [tipIndex, setTipIndex] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setTipIndex((i) => (i + 1) % THINKING_TIPS.length)
        setVisible(true)
      }, 300)
    }, 8000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex gap-4">
      <div className="w-8 h-8 rounded-full bg-card border border-border flex items-center justify-center text-blue-400 shadow-sm shadow-black/10">
        <Bot className="w-5 h-5" />
      </div>
      <div className="flex items-center gap-2 text-muted-foreground/70">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className={cn("text-sm transition-opacity duration-300", visible ? "opacity-100" : "opacity-0")}>
          {THINKING_TIPS[tipIndex]}
        </span>
      </div>
    </div>
  )
}

// --- Parse helpers ---

interface ScriptRef {
  name: string
  lang: string
}

function parseScriptRefs(content: string): { scripts: ScriptRef[]; text: string } {
  const scripts: ScriptRef[] = []
  const regex = /\[User Script: ([^\s]+) \((\w+)\)\]\n*/g
  const text = content
    .replace(regex, (_, name, lang) => {
      scripts.push({ name, lang })
      return ""
    })
    .trim()
  return { scripts, text }
}

function parseSkillRef(content: string): { skillName: string | null; text: string } {
  const compactMatch = content.match(/\[Skill: ([^\]]+)\]\n*/)
  if (compactMatch) {
    return { skillName: compactMatch[1], text: content.replace(compactMatch[0], "").trim() }
  }
  const legacyMatch = content.match(/\[Editing Skill: ([^\]]+)\]\n(?:.*\n)*?---\n*/)
  if (legacyMatch) {
    return { skillName: legacyMatch[1], text: content.replace(legacyMatch[0], "").trim() }
  }
  return { skillName: null, text: content }
}

function parseDeepInvestigation(content: string): { isDeepInvestigation: boolean; text: string } {
  const dpMatch = content.match(/\[Deep Investigation\]\n*/)
  if (dpMatch) {
    return { isDeepInvestigation: true, text: content.replace(dpMatch[0], "").trim() }
  }
  const controlMatch = content.match(/\[DP_(?:CONFIRM|ADJUST|REINVESTIGATE|SKIP|EXIT)\]\n*/)
  if (controlMatch) {
    return { isDeepInvestigation: true, text: content.replace(controlMatch[0], "").trim() }
  }
  return { isDeepInvestigation: false, text: content }
}

/**
 * All prefix-variant chips that can appear as `[<label>]` markers in user
 * messages (Dig deeper + DP three chips). Used to re-derive which chip
 * produced a past message so we can hide the long fullPrompt body.
 */
const ALL_PREFIX_CHIPS: PrefixActionChip[] = [
  DIG_DEEPER_CHIP,
  ...Object.values(DP_CHECKPOINT_PREFIX_CHIPS),
  ...LEGACY_DP_PREFIX_CHIPS,
]

/**
 * Parse a prefix-chip marker at the start of a user message. If present,
 * strip the marker + its fullPrompt + the "Additional direction from user: "
 * prefix, so the bubble only shows what the user actually typed.
 */
function parseActionChipMarker(content: string): { chip: PrefixActionChip | null; text: string } {
  const match = content.match(/^\[([^\]]+)\]\n/)
  if (!match) return { chip: null, text: content }
  const candidates = ALL_PREFIX_CHIPS.filter((c) => c.label === match[1])
  const chip =
    candidates.find((c) => content.slice(match[0].length).startsWith(c.fullPrompt)) ??
    candidates[0]
  if (!chip) return { chip: null, text: content }

  let rest = content.slice(match[0].length)
  if (rest.startsWith(chip.fullPrompt)) rest = rest.slice(chip.fullPrompt.length)
  const addPrefix = "\n\nAdditional direction from user: "
  if (rest.startsWith(addPrefix)) rest = rest.slice(addPrefix.length)
  return { chip, text: rest.trim() }
}

type FillActionChip = Extract<ActionChip, { kind: "fill" }>

function toFillChip(key: string, label: string): FillActionChip {
  return { kind: "fill", id: `suggested-${key}`, label, labelPrefix: `${key}.`, insertText: key }
}

function toDpCheckpointFillChip(chip: FillActionChip): FillActionChip {
  const prefixChip = DP_CHECKPOINT_PREFIX_CHIPS[chip.insertText.toUpperCase()]
  if (!prefixChip) return chip
  return {
    kind: "fill",
    id: prefixChip.id,
    label: prefixChip.label,
    insertText: chip.insertText,
  }
}

function FillChipButton({ chip, onClick }: { chip: FillActionChip; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-1.5 text-sm border border-border bg-card hover:bg-secondary text-foreground transition-colors cursor-pointer"
    >
      {chip.labelPrefix && (
        <span className="font-medium text-muted-foreground">{chip.labelPrefix}</span>
      )}
      {chip.labelPrefix ? " " : ""}
      {chip.label}
    </button>
  )
}

function detectOptionReplies(content: string): FillActionChip[] {
  const primary: FillActionChip[] = []
  const regex = /[-*]\s+\*\*([A-Za-z\d]+)\.\*\*\s+(.+?)(?:\s+[—\-–]\s+.*)?$/gm
  for (const match of content.matchAll(regex)) {
    primary.push(toFillChip(match[1], match[2].trim()))
  }
  if (primary.length >= 2 && primary.length <= 8) return primary

  const fallback: FillActionChip[] = []
  const fallbackRegex = /^([A-Z])\.\s+(.+?)(?:\s+[—\-–]\s+.*)?$/gm
  for (const match of content.matchAll(fallbackRegex)) {
    fallback.push(toFillChip(match[1], match[2].trim()))
  }
  return fallback.length >= 2 && fallback.length <= 8 ? fallback : []
}


function stripSuggestedReplyComments(content: string): string {
  return content.replace(/<!--\s*suggested-replies:\s*.*?\s*-->/g, "").trimEnd()
}

function parseHypothesisCheckpoint(content: string): { isCheckpoint: boolean; text: string } {
  const marker = /<!--\s*hypothesis-checkpoint\s*-->/i
  return {
    isCheckpoint: marker.test(content),
    text: content.replace(marker, "").trimEnd(),
  }
}

function parseSuggestedReplies(content: string): { chips: FillActionChip[]; text: string } {
  const commentMatch = content.match(/<!--\s*suggested-replies:\s*(.*?)\s*-->/)
  if (commentMatch) {
    const chips: FillActionChip[] = []
    for (const part of commentMatch[1].split(",")) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const pipeIdx = trimmed.indexOf("|")
      if (pipeIdx > 0) {
        chips.push(toFillChip(trimmed.slice(0, pipeIdx).trim(), trimmed.slice(pipeIdx + 1).trim()))
      } else {
        chips.push(toFillChip(trimmed, trimmed))
      }
    }
    const text = stripTrailingVisibleOptionBlock(
      content.replace(/<!--\s*suggested-replies:\s*.*?\s*-->/, "").trimEnd(),
      chips.flatMap((chip) => [chip.insertText, chip.label]),
    )
    return { chips, text }
  }

  const detected = detectOptionReplies(content)
  if (detected.length > 0) {
    return { chips: detected, text: content }
  }

  return { chips: [], text: content }
}

function stripTrailingVisibleOptionBlock(content: string, optionKeys: string[]): string {
  const keySet = new Set(optionKeys.map((k) => k.toUpperCase()))
  if (keySet.size === 0) return content

  const lines = content.trimEnd().split("\n")
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === "") end--

  let start = end
  let optionCount = 0
  const optionLine = /^\s*(?:[-*]\s*)?(?:\*\*)?([A-Za-z\d]+)(?:\*\*)?\s*[.)、:：]\s*/
  while (start > 0) {
    const match = lines[start - 1].match(optionLine)
    if (!match || !keySet.has(match[1].toUpperCase())) break
    start--
    optionCount++
  }

  // Only strip when this is clearly a trailing UI choice block. We preserve
  // ordinary hypothesis text and tables; hidden suggested-replies comments are
  // the source of truth for the rendered chips.
  if (optionCount < 2) return content

  while (start > 0 && lines[start - 1].trim() === "") start--
  const lead = lines[start - 1]?.trim() ?? ""
  if (/(请选择|请指示|选择方向|下一步|选项|回复|请回复|方向|如何继续|怎么继续|continue|choose|option|reply)/i.test(lead)) {
    start--
    while (start > 0 && lines[start - 1].trim() === "") start--
  }

  return lines.slice(0, start).join("\n").trimEnd()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

interface AgentToolTrace {
  toolName: string
  toolInput?: string | null
  outcome?: string
  duration?: string
  contentPreview?: string
}

function toolTraceValue(value: unknown): AgentToolTrace[] {
  const rows = arrayValue(value) ?? []
  return rows.flatMap((row) => {
    const record = asRecord(row)
    if (!record) return []
    const toolName = stringValue(record.toolName) ?? stringValue(record.tool_name)
    if (!toolName) return []
    const durationMs = numberValue(record.durationMs) ?? numberValue(record.duration_ms)
    return [{
      toolName,
      toolInput: stringValue(record.toolInput) ?? stringValue(record.tool_input) ?? null,
      outcome: stringValue(record.outcome),
      duration: compactDuration(durationMs),
      contentPreview: stringValue(record.contentPreview) ?? stringValue(record.content_preview),
    }]
  })
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function compactDuration(ms?: number): string | undefined {
  if (ms == null) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.round(ms / 60_000)}m`
}

function statusTone(status?: string): { label: string; className: string } {
  switch (status) {
    case "running":
    case "pending":
      return { label: status === "pending" ? "Pending" : "Running", className: "bg-blue-500/10 text-blue-400 border-blue-500/30" }
    case "success":
    case "done":
    case "allowed":
      return { label: status === "allowed" ? "Allowed" : "Done", className: "bg-green-500/10 text-green-400 border-green-500/30" }
    case "error":
    case "failed":
    case "denied":
      return { label: status === "denied" ? "Denied" : "Failed", className: "bg-red-500/10 text-red-400 border-red-500/30" }
    case "timed_out":
      return { label: "Timed out", className: "bg-amber-500/10 text-amber-400 border-amber-500/30" }
    case "partial":
      return { label: "Partial", className: "bg-amber-500/10 text-amber-300 border-amber-500/30" }
    case "aborted":
    case "cancelled":
      return { label: "Cancelled", className: "bg-amber-500/10 text-amber-400 border-amber-500/30" }
    default:
      return { label: "Ready", className: "bg-secondary text-muted-foreground border-border" }
  }
}

function messageDelegationId(message: PilotMessage): string | undefined {
  return message.delegationId ?? stringValue(message.metadata?.delegation_id)
}

function isBatchCompleteDelegationEvent(message: PilotMessage): boolean {
  return (
    message.metadata?.kind === "delegation_event" &&
    message.metadata?.event_type === "delegation.batch_complete" &&
    Boolean(messageDelegationId(message))
  )
}

function withDelegationStatusNotices(messages: PilotMessage[]): PilotMessage[] {
  const next: PilotMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    next.push(message)
    if (!isBatchCompleteDelegationEvent(message)) continue

    const hasSyntheticReply = messages
      .slice(i + 1)
      .some((candidate) => candidate.role === "assistant" && !candidate.hidden)
    if (hasSyntheticReply) continue

    next.push({
      id: `delegation-status-${messageDelegationId(message) ?? message.id}`,
      role: "assistant",
      content: "Results ready · Siclaw is synthesizing",
      timestamp: message.timestamp,
      metadata: { kind: "delegation_status_notice" },
    })
  }

  return next
}

function agentWorkBatchSummary(message: PilotMessage): {
  taskCount: number
  tasks: Array<{
    index: number
    status?: string
    targetLabel: string
    scope?: string
    summary?: string
    fullSummary?: string
    summaryTruncated?: boolean
    toolCalls?: number
    duration?: string
    toolTrace: AgentToolTrace[]
  }>
  totalToolCalls?: number
  duration?: string
  status: string
  notice?: string
} {
  const args = message.toolArgs ?? {}
  const details = message.toolDetails ?? {}
  const metadata = message.metadata ?? {}
  const parsedContent = message.content ? parseJsonRecord(message.content) : null
  const result = parsedContent ?? details
  const argTasks = arrayValue(args.tasks) ?? []
  const resultTasks = arrayValue(result.tasks) ?? []
  const detailTasks = arrayValue(details.tasks) ?? arrayValue(metadata.tasks) ?? []
  const maxTasks = Math.max(argTasks.length, resultTasks.length, detailTasks.length)
  const status =
    stringValue(metadata.status) ??
    stringValue(details.status) ??
    stringValue(result.status) ??
    message.toolStatus ??
    "ready"
  const tasks = Array.from({ length: maxTasks }).map((_, i) => {
    const argTask = asRecord(argTasks[i]) ?? {}
    const resultTask = asRecord(resultTasks[i]) ?? {}
    const detailTask = asRecord(detailTasks[i]) ?? {}
    const rawTarget =
      stringValue(detailTask.agent_id) ??
      stringValue(resultTask.agent_id) ??
      stringValue(argTask.agent_id) ??
      "self"
    const isSelfDelegation = rawTarget === "self" || rawTarget === message.fromAgentId
    const durationMs =
      numberValue(detailTask.duration_ms) ??
      numberValue(resultTask.duration_ms) ??
      numberValue(detailTask.durationMs) ??
      numberValue(resultTask.durationMs)
    const taskStatus =
      stringValue(detailTask.status) ??
      stringValue(resultTask.status)
    const resolvedTaskStatus =
      status === "timed_out" && taskStatus === "running"
        ? "timed_out"
        : taskStatus
    return {
      index: numberValue(detailTask.index) ?? numberValue(resultTask.index) ?? i + 1,
      status:
        resolvedTaskStatus ??
        (status === "running" || status === "timed_out" ? status : undefined),
      targetLabel: isSelfDelegation ? "self sub-agent" : rawTarget,
      scope:
        stringValue(detailTask.scope) ??
        stringValue(resultTask.scope) ??
        stringValue(argTask.scope),
      summary: normalizeAgentWorkSummary(
        stringValue(detailTask.summary) ??
        stringValue(resultTask.summary),
      ),
      fullSummary: normalizeAgentWorkSummary(
        stringValue(detailTask.full_summary) ??
        stringValue(detailTask.fullSummary),
      ),
      summaryTruncated:
        booleanValue(detailTask.summary_truncated) ??
        booleanValue(detailTask.summaryTruncated),
      toolCalls:
        numberValue(detailTask.tool_calls) ??
        numberValue(resultTask.tool_calls) ??
        numberValue(detailTask.toolCalls) ??
        numberValue(resultTask.toolCalls),
      duration: compactDuration(durationMs),
      toolTrace: toolTraceValue(detailTask.tool_trace ?? detailTask.toolTrace),
    }
  })
  const durationMs =
    numberValue(result.duration_ms) ??
    numberValue(details.duration_ms) ??
    numberValue(metadata.duration_ms) ??
    numberValue(message.metadata?.durationMs)
  return {
    taskCount: tasks.length,
    tasks,
    totalToolCalls:
      numberValue(result.total_tool_calls) ??
      numberValue(details.total_tool_calls) ??
      numberValue(metadata.total_tool_calls),
    duration: compactDuration(durationMs),
    status,
    notice: stringValue(metadata.ui_status),
  }
}

function agentWorkSummary(message: PilotMessage): {
  target: string
  targetLabel: string
  isSelfDelegation: boolean
  scope?: string
  summary?: string
  fullSummary?: string
  summaryTruncated?: boolean
  childSessionId?: string
  toolCalls?: number
  duration?: string
  toolTrace: AgentToolTrace[]
  status: string
} {
  const args = message.toolArgs ?? {}
  const details = message.toolDetails ?? {}
  const metadata = message.metadata ?? {}
  const parsedContent = message.content ? parseJsonRecord(message.content) : null
  const result = parsedContent ?? details
  const rawTarget =
    stringValue(args.agent_id) ??
    stringValue(metadata.target_agent_id) ??
    message.targetAgentId ??
    "self"
  const isSelfDelegation = rawTarget === "self" || rawTarget === message.fromAgentId
  const targetName =
    stringValue(args.agent_name) ??
    stringValue(args.target_agent_name) ??
    stringValue(metadata.target_agent_name) ??
    stringValue(metadata.targetAgentName) ??
    stringValue(metadata.target_agent_label) ??
    stringValue(metadata.targetAgentLabel)
  const durationMs =
    numberValue(result.duration_ms) ??
    numberValue(result.durationMs) ??
    numberValue(metadata.duration_ms) ??
    numberValue(metadata.durationMs)
  return {
    target: rawTarget,
    targetLabel: isSelfDelegation ? "self sub-agent" : (targetName ? `${targetName} · ${rawTarget}` : rawTarget),
    isSelfDelegation,
    scope: stringValue(args.scope) ?? stringValue(metadata.scope) ?? message.toolInput,
    summary: normalizeAgentWorkSummary(stringValue(result.summary) ?? stringValue(message.content)),
    fullSummary: normalizeAgentWorkSummary(
      stringValue(details.full_summary) ??
      stringValue(metadata.full_summary) ??
      stringValue(result.full_summary),
    ),
    summaryTruncated: booleanValue(details.summary_truncated) ?? booleanValue(metadata.summary_truncated),
    childSessionId:
      stringValue(result.session_id) ??
      stringValue(result.sessionId) ??
      stringValue(metadata.child_session_id),
    toolCalls: numberValue(result.tool_calls) ?? numberValue(result.toolCalls),
    duration: compactDuration(durationMs ?? message.metadata?.durationMs as number | undefined),
    toolTrace: toolTraceValue(result.tool_trace ?? result.toolTrace ?? details.tool_trace ?? details.toolTrace),
    status:
      stringValue(result.status) ??
      stringValue(metadata.status) ??
      message.toolStatus ??
      "ready",
  }
}

function normalizeAgentWorkSummary(summary?: string): string | undefined {
  if (!summary) return undefined
  if (summary === "Delegated agent completed without a final text summary.") {
    return "Completed. No concise summary was returned."
  }
  return summary
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

// --- Message rendering ---

function MessageItem({
  message,
  sendMessage,
  showSuggestedReplies,
  dpActive,
  onChipClick,
  onOpenSkillPanel,
  onOpenSchedulePanel,
  agentId,
}: {
  message: PilotMessage
  sendMessage?: (text: string) => void
  showSuggestedReplies?: boolean
  /** Whether the session is in Deep Investigation; DP only renders suggestions at explicit hypothesis checkpoints. */
  dpActive?: boolean
  onChipClick?: (chip: FillActionChip, meta: { isDpCheckpoint: boolean }) => void
  onOpenSkillPanel?: (msg: PilotMessage) => void
  onOpenSchedulePanel?: (msg: PilotMessage) => void
  agentId?: string
}) {
  const isUser = message.role === "user"
  const isTool = message.role === "tool"

  if (message.metadata?.kind === "delegation_status_notice") {
    return <DelegationStatusNotice content={message.content} />
  }

  if (isTool) {
    if (message.toolName === "delegate_to_agents") {
      return <AgentWorkBatchCard message={message} />
    }
    if (message.toolName === "delegate_to_agent" || message.metadata?.kind === "agent_work") {
      return <AgentWorkCard message={message} />
    }
    if (message.toolName === "skill_preview" && !message.isStreaming) {
      return (
        <div
          className={onOpenSkillPanel ? "cursor-pointer" : undefined}
          onClick={() => onOpenSkillPanel?.(message)}
        >
          <SkillCard message={message} />
        </div>
      )
    }
    if (message.toolName === "manage_schedule" && !message.isStreaming) {
      return <ScheduleCard message={message} onOpenPanel={onOpenSchedulePanel} agentId={agentId} />
    }
    return <ToolItem message={message} />
  }

  // Parse references from user messages
  const { isDeepInvestigation, text: afterDeepInv } = isUser
    ? parseDeepInvestigation(message.content)
    : { isDeepInvestigation: false, text: message.content }
  const { chip: actionChip, text: afterChip } = isUser
    ? parseActionChipMarker(afterDeepInv)
    : { chip: null as PrefixActionChip | null, text: afterDeepInv }
  const { scripts, text: afterScripts } = isUser
    ? parseScriptRefs(afterChip)
    : { scripts: [] as ScriptRef[], text: afterChip }
  const { skillName, text: afterSkillRef } = isUser
    ? parseSkillRef(afterScripts)
    : { skillName: null, text: afterScripts }

  const checkpoint = !isUser && !isTool ? parseHypothesisCheckpoint(afterSkillRef) : { isCheckpoint: false, text: afterSkillRef }
  const canShowSuggestedReplies =
    !isUser &&
    !isTool &&
    showSuggestedReplies &&
    !message.isStreaming &&
    (!dpActive || checkpoint.isCheckpoint)
  const { chips: suggestedChips, text: textContent } = canShowSuggestedReplies
    ? parseSuggestedReplies(checkpoint.text)
    : { chips: [] as FillActionChip[], text: stripSuggestedReplyComments(checkpoint.text) }
  const renderedSuggestedChips = checkpoint.isCheckpoint
    ? suggestedChips.map(toDpCheckpointFillChip)
    : suggestedChips

  return (
    <div className={cn("flex gap-4 group", isUser ? "flex-row-reverse" : "flex-row")}>
      {/* Avatar */}
      <div
        className={cn(
          "w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm shadow-black/10 border",
          isUser ? "bg-blue-600 border-blue-600 text-white" : "bg-card border-border text-blue-400",
        )}
      >
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-5 h-5" />}
      </div>

      <div className={cn("flex flex-col min-w-0", isUser ? "items-end" : "items-start")}>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-sm font-semibold text-foreground">{isUser ? "You" : "Siclaw"}</span>
          <span className="text-xs text-muted-foreground/70">{message.timestamp}</span>
          {message.isStreaming && !isUser && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/70" />}
        </div>

        {/* Reference chips (user messages only) */}
        {(isDeepInvestigation || actionChip || skillName || scripts.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {isDeepInvestigation && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs font-medium text-blue-400">
                <SearchCode className="w-3.5 h-3.5 text-blue-500" />
                <span>Deep Investigation</span>
              </div>
            )}
            {actionChip && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/10 border border-purple-500/30 text-xs font-medium text-purple-400">
                <SearchCode className="w-3.5 h-3.5 text-purple-500" />
                <span>{actionChip.label}</span>
              </div>
            )}
            {skillName && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-500/30 text-xs font-medium text-indigo-700">
                <FileCode className="w-3.5 h-3.5 text-indigo-500" />
                <span>{skillName}</span>
              </div>
            )}
            {scripts.map((s, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs font-medium text-blue-800"
              >
                {s.lang === "python" ? (
                  <FileCode className="w-3.5 h-3.5 text-blue-400" />
                ) : (
                  <Terminal className="w-3.5 h-3.5 text-green-600" />
                )}
                <span>{s.name}</span>
              </div>
            ))}
          </div>
        )}

        {textContent && (
          <CopyableMessage isUser={isUser} content={textContent} />
        )}

        {renderedSuggestedChips.length > 0 && onChipClick && (
          <div className="flex flex-wrap gap-2 mt-2">
            {renderedSuggestedChips.map((chip) => (
              <FillChipButton
                key={chip.id}
                chip={chip}
                onClick={() => onChipClick(chip, { isDpCheckpoint: checkpoint.isCheckpoint })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DelegationStatusNotice({ content }: { content: string }) {
  const [headline, detail] = content.split(" · ")
  return (
    <div className="pl-12 min-w-0">
      <div className="inline-flex max-w-3xl items-center gap-2 rounded-full border border-blue-500/25 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-300 shadow-sm shadow-black/10">
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        <span className="font-medium">{headline}</span>
        {detail && <span className="text-blue-300/70">·</span>}
        {detail && <span className="truncate">{detail}</span>}
      </div>
    </div>
  )
}

function CopyableMessage({ isUser, content }: { isUser: boolean; content: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div
      className={cn(
        "group relative px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm shadow-black/10 max-w-3xl min-w-0 overflow-hidden",
        isUser
          ? "bg-blue-600 text-white rounded-tr-sm [&_pre]:bg-black/20 [&_pre]:text-white [&_code]:bg-card/15 [&_code]:text-white [&_a]:text-blue-200"
          : "bg-card border border-border text-foreground rounded-tl-sm",
      )}
    >
      <Markdown>{content}</Markdown>
      {!isUser && (
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-secondary"
          title="Copy markdown"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}

function AgentWorkCard({ message }: { message: PilotMessage }) {
  const work = agentWorkSummary(message)
  const [expanded, setExpanded] = useState(message.isStreaming ?? false)
  const isOpen = message.isStreaming || expanded
  const tone = statusTone(work.status)
  const title = work.isSelfDelegation ? "Delegated investigation" : "Expert collaboration"

  return (
    <div className="pl-12 min-w-0">
      <div className="bg-card border border-border rounded-xl shadow-sm shadow-black/10 overflow-hidden max-w-3xl">
        <button
          type="button"
          className="flex items-center gap-3 w-full px-4 py-3 bg-secondary/70 hover:bg-secondary transition-colors text-left min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight
            className={cn("w-3.5 h-3.5 text-muted-foreground/70 transition-transform shrink-0", isOpen && "rotate-90")}
          />
          <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-purple-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-foreground shrink-0">{title}</span>
              <span className={cn("px-2 py-0.5 rounded-full border text-[11px] font-medium", tone.className)}>
                {tone.label}
              </span>
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {work.targetLabel}{work.scope ? ` · ${work.scope}` : ""}
            </div>
          </div>
          {message.toolStatus === "running" && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
          )}
        </button>

        {isOpen && (
          <div className="p-4 space-y-3 bg-secondary/20 border-t border-border">
            <div className="grid gap-2">
              <div className="rounded-lg border border-border bg-card/70 p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  {work.isSelfDelegation ? "Target" : "Target agent"}
                </div>
                <div className="text-sm text-foreground truncate">{work.targetLabel}</div>
              </div>
            </div>
            {work.scope && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Scope</div>
                <p className="text-sm text-foreground whitespace-pre-wrap">{work.scope}</p>
              </div>
            )}
            {work.summary && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Capsule sent to parent
                </div>
                <div className="text-sm text-foreground">
                  <Markdown>{work.summary}</Markdown>
                </div>
              </div>
            )}
            {work.fullSummary && work.fullSummary !== work.summary && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Full sub-agent report
                </div>
                <div className="text-sm text-foreground max-h-96 overflow-y-auto pr-2">
                  <Markdown>{work.fullSummary}</Markdown>
                </div>
              </div>
            )}
            <AgentToolTraceList trace={work.toolTrace} />
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {work.toolCalls != null && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border">
                  <Terminal className="w-3 h-3" />
                  {work.toolCalls} tool calls
                </span>
              )}
              {work.duration && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border">
                  <Clock className="w-3 h-3" />
                  {work.duration}
                </span>
              )}
              {work.summaryTruncated && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border">
                  capsule capped
                </span>
              )}
              {message.fromAgentId && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border">
                  from {message.fromAgentId}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type AgentWorkBatchTask = ReturnType<typeof agentWorkBatchSummary>["tasks"][number]

function AgentToolTraceList({ trace }: { trace: AgentToolTrace[] }) {
  if (trace.length === 0) return null
  return (
    <details className="rounded-lg border border-border/70 bg-card/40">
      <summary className="cursor-pointer select-none px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
        Tool trace
      </summary>
      <div className="divide-y divide-border/60">
        {trace.map((tool, index) => {
          const tone = statusTone(tool.outcome)
          const preview = tool.contentPreview?.trim()
          return (
            <div key={`${tool.toolName}-${index}`} className="px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-mono text-[11px] font-semibold text-foreground truncate">
                  {tool.toolName}
                </span>
                {tool.outcome && (
                  <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", tone.className)}>
                    {tone.label}
                  </span>
                )}
                {tool.duration && (
                  <span className="text-[11px] text-muted-foreground/70 shrink-0">{tool.duration}</span>
                )}
              </div>
              {tool.toolInput && (
                <pre className="mt-1 max-h-24 overflow-auto rounded-md bg-background/50 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
                  {tool.toolInput}
                </pre>
              )}
              {preview && (
                <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                  {preview}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </details>
  )
}

function TaskStatusPill({ status, compact = false }: { status?: string; compact?: boolean }) {
  if (!status) return null
  const tone = statusTone(status)
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border font-medium",
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
        tone.className,
      )}
    >
      {tone.label}
    </span>
  )
}

function computeBatchTone(
  batch: ReturnType<typeof agentWorkBatchSummary>,
): { label: string; className: string } {
  const done = new Set(["done", "success", "allowed"])
  const tasks = batch.tasks
  if (tasks.length > 0) {
    const doneCount = tasks.filter((t) => t.status && done.has(t.status)).length
    if (doneCount > 0 && doneCount < tasks.length) {
      return {
        label: `${doneCount}/${tasks.length} done`,
        className: statusTone("partial").className,
      }
    }
  }
  return statusTone(batch.status)
}

function AgentWorkBatchCard({ message }: { message: PilotMessage }) {
  const batch = agentWorkBatchSummary(message)
  const [expanded, setExpanded] = useState(message.isStreaming ?? false)
  const tone = computeBatchTone(batch)
  const isSynthesizing = batch.notice != null
  const taskLabel = `${batch.taskCount || 0} sub-agent${batch.taskCount === 1 ? "" : "s"}`
  const aggregateBits = [
    taskLabel,
    batch.totalToolCalls != null ? `${batch.totalToolCalls} tool calls` : null,
    batch.duration || null,
  ].filter(Boolean) as string[]

  return (
    <div className="pl-12 min-w-0">
      <div className="bg-card border border-border rounded-xl shadow-sm shadow-black/10 overflow-hidden max-w-3xl">
        <button
          type="button"
          className="flex items-center gap-3 w-full px-4 py-3 bg-secondary/70 hover:bg-secondary transition-colors text-left min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight
            className={cn("w-3.5 h-3.5 text-muted-foreground/70 transition-transform shrink-0", expanded && "rotate-90")}
          />
          <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-purple-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-foreground shrink-0">Delegated investigation batch</span>
              <span className={cn("px-2 py-0.5 rounded-full border text-[11px] font-medium", tone.className)}>
                {tone.label}
              </span>
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {aggregateBits.join(" · ")}
            </div>
            {batch.notice && (
              <div className="mt-0.5 text-xs text-blue-300 truncate">
                {batch.notice}
              </div>
            )}
          </div>
          {(batch.status === "running" || isSynthesizing) && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
          )}
        </button>

        {expanded && (
          <div className="px-4 py-3 bg-secondary/20 border-t border-border">
            {batch.tasks.length > 0 ? (
              <div className="ml-5 pl-4 border-l-2 border-border/60">
                {batch.tasks.map((task) => (
                  <AgentWorkBatchRow key={task.index} task={task} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Preparing delegated tasks...</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function AgentWorkBatchRow({ task }: { task: AgentWorkBatchTask }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetails = Boolean(task.scope || task.summary || task.fullSummary || task.toolTrace.length > 0)
  const metricBits = [
    task.toolCalls != null ? `${task.toolCalls} calls` : null,
    task.duration || null,
  ].filter(Boolean) as string[]

  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left min-w-0"
        onClick={() => hasDetails && setExpanded(!expanded)}
        disabled={!hasDetails}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 mt-1 text-muted-foreground/50 transition-transform shrink-0",
            expanded && "rotate-90",
            !hasDetails && "invisible",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold text-foreground shrink-0">Agent {task.index}</span>
            <TaskStatusPill status={task.status} compact />
          </div>
          {task.scope && !expanded && (
            <div className="text-[11px] leading-snug text-muted-foreground truncate mt-0.5">
              {task.scope}
            </div>
          )}
          {metricBits.length > 0 && (
            <div className="text-[11px] text-muted-foreground/70 mt-1">
              {metricBits.join(" · ")}
            </div>
          )}
        </div>
      </button>

      {expanded && hasDetails && (
        <div className="mt-2 ml-5 rounded-lg border border-border/70 bg-card/45 p-3 space-y-3">
          {task.scope && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Scope</div>
              <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">{task.scope}</p>
            </div>
          )}
          {task.summary && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Capsule sent to parent
              </div>
              <div className="text-sm text-foreground">
                <Markdown>{task.summary}</Markdown>
              </div>
            </div>
          )}
          {task.fullSummary && task.fullSummary !== task.summary && (
            <details className="rounded-lg border border-border/70 bg-card/40">
              <summary className="cursor-pointer select-none px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
                Full sub-agent report
              </summary>
              <div className="px-3 pb-3 text-sm text-foreground max-h-80 overflow-y-auto pr-2">
                <Markdown>{task.fullSummary}</Markdown>
              </div>
            </details>
          )}
          <AgentToolTraceList trace={task.toolTrace} />
          {task.summaryTruncated && (
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              capsule capped
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolItem({ message }: { message: PilotMessage }) {
  const [expanded, setExpanded] = useState(false)
  const isOpen = message.isStreaming || expanded

  return (
    <div className="pl-12 min-w-0">
      <div className="bg-card border border-border rounded-lg shadow-sm shadow-black/10 overflow-hidden">
        <button
          type="button"
          className="flex items-center gap-2 w-full px-4 py-2 bg-secondary border-b border-border hover:bg-secondary transition-colors cursor-pointer text-left min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight
            className={cn("w-3.5 h-3.5 text-muted-foreground/70 transition-transform shrink-0", isOpen && "rotate-90")}
          />
          <Terminal className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="font-mono text-xs font-semibold text-foreground shrink-0">{message.toolName}</span>
          {message.toolInput && (
            <span className="font-mono text-xs text-muted-foreground truncate min-w-0">{message.toolInput}</span>
          )}
          {message.toolStatus === "running" && (
            <Loader2 className="w-3 h-3 animate-spin text-blue-400 ml-auto shrink-0" />
          )}
          {message.toolStatus === "success" && (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500 ml-auto shrink-0" />
          )}
          {message.toolStatus === "error" && <XCircle className="w-3.5 h-3.5 text-red-500 ml-auto shrink-0" />}
          {message.toolStatus === "aborted" && <Ban className="w-3.5 h-3.5 text-amber-500 ml-auto shrink-0" />}
        </button>
        {isOpen && (
          <div className="overflow-x-auto bg-secondary/30 max-h-80 overflow-y-auto">
            {message.toolInput && (
              <div className="px-4 pt-3 pb-2 border-b border-border/50">
                <pre className="text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all">
                  {message.toolInput}
                </pre>
              </div>
            )}
            <div className="p-4">
              <pre className="text-xs font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap">
                {message.content || (message.toolStatus === "aborted" ? "Aborted." : "Running...")}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
