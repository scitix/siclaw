import { useRef, useEffect, useState, useCallback, useMemo, useLayoutEffect } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { formatToolInput } from "../../hooks/usePilotChat"
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
  ArrowRight,
  PencilLine,
  FileText,
  ListChecks,
  Square,
  X,
  Download,
  CircleAlert,
} from "lucide-react"
import { cn } from "./cn"
import { Markdown } from "./Markdown"
import { useCopyFeedback, copyTextToClipboard } from "./clipboard"
import { copyElementsAsRichText, buildCopyHtml } from "./rich-copy"
import { downloadBlob } from "./svg-export"
import { serializeMessagesToText, serializeMessagesToMarkdown, stripVisualizationFences, stripImageData } from "./transcript"
import {
  EMPTY_SELECTION,
  toggleFollowing,
  toggleMessage,
  selectedIds as computeSelectedIds,
  type SelectionState,
} from "./selection-model"
import { InputArea } from "./InputArea"
import { ImageAttachmentPreview } from "./ImageAttachmentPreview"
import { SkillCard } from "./SkillCard"
import { ScheduleCard } from "./ScheduleCard"
import { ErrorBubble } from "./ErrorBubble"
import { stripAttachmentOcrEvidence } from "./user-message-text"
import type {
  ChatAttachment,
  PilotMessage,
  ContextUsage,
  ActionChip,
  PrefixActionChip,
  MessageTiming,
  ModelRouteMetadata,
} from "./types"

// Wrap copy-ready message HTML in a minimal self-contained document for the
// Markdown-export's companion .html file. Charts are inline PNG <img>, which
// browsers always render (unlike data: images in many Markdown viewers).
function wrapChatHtml(inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Siclaw chat export</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 880px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; }
  img { max-width: 100%; height: auto; }
  pre { background: #f4f4f5; padding: .75rem 1rem; border-radius: 8px; overflow-x: auto; }
  code { background: #f0f0f1; padding: .1rem .3rem; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: .5rem 0; }
  th, td { border: 1px solid #ddd; padding: .4rem .7rem; }
  blockquote { border-left: 3px solid #ddd; margin: .5rem 0; padding-left: 1rem; color: #555; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 1.5rem 0; }
</style>
</head>
<body>${inner}</body>
</html>
`
}

/**
 * Format a millisecond duration into a compact human-readable string.
 * <1s → "850ms"; <60s → "3.2s"; ≥60s → "1m 12s".
 */
function formatTimingMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

/**
 * Inline "model time" shown next to the assistant's header. Combines the
 * three model-side phases (ttft + thinking + output) into one user-facing
 * figure so chat doesn't surface dashboard-level timing breakdowns.
 * Dashboard latency stats keep their per-phase split.
 */
function combinedModelMs(timing: MessageTiming | undefined): number | undefined {
  if (!timing) return undefined
  // ttftMs already covers user-message → first-token (and contains the
  // thinking portion). Add outputMs (first-delta → message_end) to get
  // total model wall-clock. thinkingMs is a subset of ttftMs and is
  // intentionally not summed to avoid double-counting.
  const ttft = typeof timing.ttftMs === "number" ? timing.ttftMs : 0
  const out = typeof timing.outputMs === "number" ? timing.outputMs : 0
  const total = ttft + out
  if (total <= 0) return undefined
  return total
}

function ModelTimeLabel({ timing }: { timing: MessageTiming | undefined }) {
  const total = combinedModelMs(timing)
  if (total == null) return null
  return (
    <span data-copy-ignore className="text-xs text-muted-foreground/70 tabular-nums select-text cursor-text">
      thinking {formatTimingMs(total)}
    </span>
  )
}

function modelRouteMetadata(message: PilotMessage): ModelRouteMetadata | null {
  const route = message.metadata?.model_route
  if (!route || typeof route !== "object" || Array.isArray(route)) return null
  return route as ModelRouteMetadata
}

function isModelRouteNoticeMessage(message: PilotMessage): boolean {
  return message.metadata?.kind === "model_route_notice"
}

function isVisibleChatMessage(message: PilotMessage): boolean {
  return !message.hidden && !isModelRouteNoticeMessage(message)
}

function routeModelDisplayName(modelId?: string, provider?: string): string {
  if (!modelId) return provider || "unknown"
  const parts = modelId.split("/").filter(Boolean)
  return parts[parts.length - 1] || modelId
}

function ModelRouteIndicator({ route }: { route: ModelRouteMetadata | null }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const isFallback = Boolean(route?.is_fallback)

  useEffect(() => {
    if (!open || !isFallback) return
    const closeOnOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", closeOnOutside)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("mousedown", closeOnOutside)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [open, isFallback])

  if (!route?.model_id && !route?.provider) return null

  const displayName = routeModelDisplayName(route.model_id, route.provider)
  const title = `Model: ${displayName}`

  return (
    <span
      ref={rootRef}
      data-copy-ignore
      title={title}
      className="relative inline-flex h-5 max-w-[12rem] items-center gap-1 rounded-md px-1 text-xs leading-none text-muted-foreground/70"
    >
      {isFallback && (
        <button
          type="button"
          aria-label="Fallback model explanation"
          aria-expanded={open}
          title="Fallback model"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors",
            "text-muted-foreground/55 hover:bg-secondary hover:text-muted-foreground",
            open && "bg-secondary text-muted-foreground",
          )}
        >
          <CircleAlert className="h-3 w-3" />
        </button>
      )}
      <span className="truncate">{displayName}</span>
      {open && isFallback && (
        <span
          role="status"
          className="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-md border border-border bg-card px-3 py-2 text-left text-[11px] leading-snug text-muted-foreground shadow-md shadow-black/10"
        >
          This reply used a fallback model after the primary model was unavailable.
        </span>
      )}
    </span>
  )
}

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
      "Proceed with the current leading hypothesis or most promising lead. Do not ask for confirmation again. If there are two or more independent hypotheses, validation paths, objects, or evidence sources to check, fan out: emit one spawn_subagent per check in the same turn so they run concurrently, each with a narrow, evidence-oriented scope and only the context it needs — do not check them one-by-one yourself. When the sub-agent reports come back, synthesize them into your hypotheses, confidence, and next step. If there is only one small direct validation, run it yourself. Report evidence after the validation step.",
    placeholder: "Add optional direction for this step",
  },
  B: {
    kind: "prefix",
    id: "dp-checkpoint-refine",
    label: "Refine",
    fullPrompt:
      "Refine or add hypotheses based on my additional direction below. Preserve useful evidence, update confidence, and explain what changed. If the refined direction names multiple independent hypotheses, validation paths, objects, or evidence sources, fan out: emit one spawn_subagent per check in the same turn so they run concurrently instead of checking them one-by-one yourself. Synthesize the sub-agent reports when they return.",
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
  /** Detached background work still running after the turn ended — keeps the Stop button shown. */
  hasBackgroundWork?: boolean
  isLoadingHistory?: boolean
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  sendMessage: (text: string, attachments?: ChatAttachment[]) => void
  abortResponse?: () => void
  contextUsage?: ContextUsage | null
  pendingMessages?: string[]
  onRemovePending?: (index: number) => void
  dpActive?: boolean
  onSetDpActive?: (active: boolean) => void
  sessionKey?: string | null
  onOpenSkillPanel?: (msg: PilotMessage) => void
  onOpenSchedulePanel?: (msg: PilotMessage) => void
  onOpenSubagent?: (childSessionId: string, status?: string, label?: string) => void
  agentId?: string
  /** Read-only transcript: hides the composer and edit/steer/dig-deeper affordances.
   *  Used by the admin session-snapshot view. Message rendering is unchanged. */
  readOnly?: boolean
}

export function PilotArea({
  messages,
  isLoading,
  hasBackgroundWork,
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
  onOpenSubagent,
  agentId,
  readOnly = false,
}: PilotAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const selectBoundaryRef = useRef<HTMLDivElement>(null)
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState("")
  const userMessageHistory = useMemo(
    () =>
      messages
        .filter((m) => m.role === "user")
        .map((m) => getEditableUserText(m.content))
        .filter(Boolean),
    [messages],
  )
  useEffect(() => {
    setActivePrefix(null)
    setEditingMessageId(null)
    setEditingDraft("")
  }, [sessionKey])

  const wrappedSendMessage = useCallback(
    (text: string, attachments?: ChatAttachment[]) => {
      sendMessage(text, attachments)
    },
    [sendMessage],
  )
  // Stop just stops: abort the running turn and leave the input alone. We intentionally do NOT
  // restore the sent message back into the input box — the turn has usually already been
  // partly processed (tools ran), so re-filling the input reads as the message "bouncing back".
  const wrappedAbort = useCallback(() => {
    abortResponse?.()
  }, [abortResponse])

  const scrollToBottom = useCallback((smooth = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollIntoView(smooth ? { behavior: "smooth" } : undefined)
    })
  }, [])

  // Find last assistant message id
  const lastAssistantMsgId = useMemo(() => {
    const visible = messages.filter(isVisibleChatMessage)
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
      .some((m) =>
        m.role === "assistant" &&
        !m.isStreaming &&
        !isModelRouteNoticeMessage(m) &&
        (m.content?.trim().length ?? 0) > 0
      )
  }, [messages, isLoading, dpActive])
  const renderMessages = useMemo(
    () => withDelegationStatusNotices(messages).filter(isVisibleChatMessage),
    [messages],
  )
  const hasVisibleMessages = renderMessages.length > 0
  // The exact list rendered as rows, in order. Range selection indexes into
  // this same list, so a row's data-msg-idx always maps back to the right message.
  const selectableMessages = renderMessages
  const latestEditableUserMessageId = useMemo(() => {
    for (let i = renderMessages.length - 1; i >= 0; i--) {
      const message = renderMessages[i]
      if (message.hidden || message.role !== "user" || message.isStreaming) continue
      if (getEditableUserText(message.content)) return message.id
    }
    return null
  }, [renderMessages])

  const startEditingMessage = useCallback((id: string, content: string) => {
    setActivePrefix(null)
    setEditingMessageId(id)
    setEditingDraft(content)
  }, [])

  const cancelEditingMessage = useCallback(() => {
    setEditingMessageId(null)
    setEditingDraft("")
  }, [])

  const submitEditedMessage = useCallback(() => {
    const text = editingDraft.trim()
    if (!text || isLoading) return
    wrappedSendMessage(text)
    setEditingMessageId(null)
    setEditingDraft("")
  }, [editingDraft, isLoading, wrappedSendMessage])

  // --- Range selection copy ---
  // Click the sticky "Select following" boundary to select a loaded message range,
  // fine-tune with checkboxes, then copy/download the lot (images and all).
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const selectModeRef = useRef(false)
  const [selectionCopied, , flashSelectionCopied] = useCopyFeedback()
  useEffect(() => {
    selectModeRef.current = selectMode
  }, [selectMode])
  // Drop any in-progress selection when the session changes.
  useEffect(() => {
    setSelectMode(false)
    setSelection(EMPTY_SELECTION)
  }, [sessionKey])

  const enterSelectMode = useCallback(() => {
    setSelection(EMPTY_SELECTION)
    setSelectMode(true)
  }, [])
  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelection(EMPTY_SELECTION)
  }, [])
  const handleToggleMessage = useCallback((id: string) => {
    setSelection((s) => toggleMessage(s, id))
  }, [])

  const getBoundaryStartIndex = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return 0

    const boundaryBottom = selectBoundaryRef.current?.getBoundingClientRect().bottom
      ?? container.getBoundingClientRect().top
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-msg-id]"))
    const firstBelowBoundary = rows.find((row) => row.getBoundingClientRect().bottom > boundaryBottom + 4)
    const id = firstBelowBoundary?.getAttribute("data-msg-id")
    const index = id ? selectableMessages.findIndex((m) => m.id === id) : selectableMessages.length
    return index >= 0 ? index : 0
  }, [selectableMessages])

  const handleToggleFollowingBoundary = useCallback(() => {
    const startIndex = getBoundaryStartIndex()
    const ids = selectableMessages.map((m) => m.id)
    setSelection((s) => toggleFollowing(ids, startIndex, s))
  }, [getBoundaryStartIndex, selectableMessages])

  const selectedIdSet = useMemo(() => computeSelectedIds(selection), [selection])
  const selectedCount = selectedIdSet.size

  const copySelection = useCallback(async () => {
    if (selectedIdSet.size === 0) return
    const selected = selectableMessages.filter((m) => selectedIdSet.has(m.id))
    const plain = serializeMessagesToText(selected)
    const container = scrollContainerRef.current
    let ok = false
    if (container) {
      const els = Array.from(container.querySelectorAll<HTMLElement>("[data-msg-id]")).filter((el) => {
        const id = el.getAttribute("data-msg-id")
        return id != null && selectedIdSet.has(id)
      })
      ok = await copyElementsAsRichText(els, plain)
    }
    if (!ok) ok = await copyTextToClipboard(plain)
    if (ok) flashSelectionCopied()
  }, [selectedIdSet, selectableMessages, flashSelectionCopied])

  const downloadSelection = useCallback(async () => {
    if (selectedIdSet.size === 0) return
    const selected = selectableMessages.filter((m) => selectedIdSet.has(m.id))
    const base = `siclaw-chat-${selected.length}-messages`

    // Prefer one file per click: HTML when the rendered selection contains
    // visuals, Markdown for plain text/tool transcripts.
    const container = scrollContainerRef.current
    if (container) {
      try {
        const rowById = new Map(
          Array.from(container.querySelectorAll<HTMLElement>("[data-msg-id]")).map(
            (r) => [r.getAttribute("data-msg-id"), r] as const,
          ),
        )
        const els = selected.map((m) => rowById.get(m.id)).filter((r): r is HTMLElement => !!r)
        const { html, hasVisual } = await buildCopyHtml(els)
        if (hasVisual) {
          downloadBlob(new Blob([wrapChatHtml(html)], { type: "text/html;charset=utf-8" }), `${base}.html`)
          return
        }
      } catch (err) {
        console.warn("[download] rich HTML export failed, falling back to Markdown:", err)
      }
    }

    const md = serializeMessagesToMarkdown(selected)
    downloadBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), `${base}.md`)
  }, [selectedIdSet, selectableMessages])

  // Auto-scroll logic
  useEffect(() => {
    // While selecting, the user is scrolling on purpose — never yank them.
    if (selectModeRef.current) {
      prevMsgCountRef.current = messages.length
      return
    }
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

  // Detect user scrolling away.
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    userScrolledAwayRef.current = distanceFromBottom > 300
  }, [])

  const visibleForCopy = useMemo(() => messages.filter(isVisibleChatMessage), [messages])

  return (
    <div className="flex-1 flex flex-col h-full bg-card relative">
      {visibleForCopy.length > 0 && (
        <div className="absolute top-2 left-3 z-10">
          <button
            type="button"
            onClick={selectMode ? exitSelectMode : enterSelectMode}
            title={selectMode ? "Exit selection" : "Select messages to copy"}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              selectMode
                ? "bg-blue-500/15 text-blue-400"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
            )}
          >
            <ListChecks className="h-4 w-4" />
          </button>
        </div>
      )}
      {selectMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 shadow-md shadow-black/10 backdrop-blur">
          <span className="text-xs font-medium text-foreground whitespace-nowrap">
            {selectedCount > 0 ? `${selectedCount} selected` : "Use top boundary"}
          </span>
          <div className="h-3.5 w-px bg-border" />
          <button
            type="button"
            onClick={downloadSelection}
            disabled={selectedCount === 0}
            title="Download selected (HTML for visuals, Markdown otherwise)"
            className="flex items-center rounded-md border border-border bg-secondary/40 p-1 text-foreground hover:bg-secondary transition-colors disabled:opacity-40 disabled:hover:bg-secondary/40"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={copySelection}
            disabled={selectedCount === 0}
            className="flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:hover:bg-blue-600"
          >
            {selectionCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {selectionCopied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={exitSelectMode}
            title="Exit selection"
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 lg:px-8 py-8" onScroll={handleScroll}>
        <div className="max-w-5xl mx-auto space-y-8">
          {isLoadingHistory ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/70">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground/50 mb-4" />
              <p className="text-sm">Loading messages...</p>
            </div>
          ) : !hasVisibleMessages ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/70">
              <MessageSquare className="w-12 h-12 text-gray-200 mb-4" />
              <p className="text-sm text-muted-foreground">{readOnly ? "No messages in this session" : "Send a message to start the conversation"}</p>
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

              {selectMode && selectableMessages.length > 0 && (
                <div
                  ref={selectBoundaryRef}
                  data-copy-ignore
                  className="pointer-events-none sticky top-14 z-20 ml-8 flex items-center gap-2 bg-card/90 py-2 pr-2 backdrop-blur"
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleToggleFollowingBoundary()
                    }}
                    className="pointer-events-auto shrink-0 rounded-full border border-border bg-card/95 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm transition-colors hover:bg-secondary hover:text-foreground"
                    title="Toggle this boundary and following messages"
                  >
                    Select following
                  </button>
                  <div className="h-px flex-1 bg-border/70" />
                </div>
              )}

              {selectableMessages.map((msg) => {
                const childSessionId = msg.metadata?.kind === "delegation_event"
                  ? (msg.metadata as Record<string, unknown>).child_session_id
                  : undefined
                const subStatus = (msg.metadata as Record<string, unknown> | undefined)?.status
                const selected = selectMode && selectedIdSet.has(msg.id)
                return (
                  <div key={msg.id}>
                    <div
                      data-msg-id={msg.id}
                      data-msg-role={msg.role}
                      onClick={selectMode ? () => handleToggleMessage(msg.id) : undefined}
                      className={cn(
                        "relative rounded-xl transition-colors",
                        // No row-level highlight — the checkbox alone signals selection.
                        selectMode && "cursor-pointer px-2 -mx-2 py-1 hover:bg-secondary/30",
                      )}
                    >
                      {selectMode && (
                        <button
                          type="button"
                          data-copy-ignore
                          title={selected ? "Deselect" : "Select"}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleToggleMessage(msg.id)
                          }}
                          className="absolute left-1.5 top-1.5 z-10 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {selected ? (
                            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[4px] bg-blue-500 text-white">
                              <Check className="h-2.5 w-2.5" strokeWidth={3} />
                            </span>
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                      <div className={cn(selectMode && "pl-8 pointer-events-none select-none")}>
                        <MessageItem
                          message={msg}
                          sendMessage={wrappedSendMessage}
                          showSuggestedReplies={!readOnly && msg.id === lastAssistantMsgId && !isLoading}
                          dpActive={dpActive}
                          canEditMessage={!readOnly && msg.id === latestEditableUserMessageId && !isLoading}
                          editingContent={editingMessageId === msg.id ? editingDraft : null}
                          onStartEditMessage={startEditingMessage}
                          onEditMessageChange={setEditingDraft}
                          onCancelEditMessage={cancelEditingMessage}
                          onSubmitEditMessage={submitEditedMessage}
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
                        {typeof childSessionId === "string" && onOpenSubagent && (
                          <div className="pl-12 -mt-1 mb-2">
                            <button
                              type="button"
                              onClick={() => onOpenSubagent(childSessionId as string, typeof subStatus === "string" ? subStatus : undefined, "Sub-agent")}
                              className="text-[11px] text-blue-400 hover:text-blue-300 hover:underline underline-offset-2"
                            >
                              View sub-agent transcript →
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}

              {/* Dig deeper — shown when agent produced a conclusion and user may want
                  to trace the root cause upstream. Hidden while a prefix chip is active. */}
              {!readOnly && showTraceButton && !activePrefix && (
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
      {!readOnly && (
        <InputArea
          onSend={wrappedSendMessage}
          onAbort={wrappedAbort}
          disabled={false}
          isLoading={isLoading}
          hasBackgroundWork={hasBackgroundWork}
          contextUsage={contextUsage}
          pendingMessages={pendingMessages}
          onRemovePending={onRemovePending}
          dpActive={dpActive}
          onSetDpActive={onSetDpActive}
          hasMessages={hasVisibleMessages}
          draft={chipDraft}
          draftSeq={chipSeq}
          historyMessages={userMessageHistory}
          activePrefix={activePrefix}
          onClearPrefix={() => setActivePrefix(null)}
        />
      )}
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

function getVisibleUserText(content: string): string {
  const { text: afterDeepInvestigation } = parseDeepInvestigation(stripAttachmentOcrEvidence(content))
  const { text: afterActionChip } = parseActionChipMarker(afterDeepInvestigation)
  const { text: afterScripts } = parseScriptRefs(afterActionChip)
  const { text } = parseSkillRef(afterScripts)
  return text.trim()
}

function getEditableUserText(content: string): string {
  return stripCopiedTranscriptHeader(getVisibleUserText(content))
}

function stripCopiedTranscriptHeader(content: string): string {
  return content
    .replace(
      /^\s*(?:Siclaw|Assistant)\s*\n\s*\d{1,2}:\d{2}\s*\n\s*(?:response|thinking)\s+[\d.]+s\s*\n+/i,
      "",
    )
    .replace(/^\s*(?:Siclaw|Assistant)\s+\d{1,2}:\d{2}\s+(?:response|thinking)\s+[\d.]+s\s+/i, "")
    .replace(/^\s*You\s*\n\s*\d{1,2}:\d{2}\s*\n+/i, "")
    .replace(/^\s*You\s+\d{1,2}:\d{2}\s+/i, "")
    .trim()
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

function SuggestedReplyIcon({ chip }: { chip: FillActionChip }) {
  const label = chip.label.toLowerCase()
  if (label.includes("refine") || label.includes("adjust")) {
    return <PencilLine className="w-3.5 h-3.5" />
  }
  if (label.includes("summarize") || label.includes("summary")) {
    return <FileText className="w-3.5 h-3.5" />
  }
  return <ArrowRight className="w-3.5 h-3.5" />
}

function PrefixChipIcon({ chip }: { chip: PrefixActionChip }) {
  const label = chip.label.toLowerCase()
  if (label.includes("refine") || label.includes("adjust")) {
    return <PencilLine className="w-3.5 h-3.5 text-purple-500" />
  }
  if (label.includes("summarize") || label.includes("summary")) {
    return <FileText className="w-3.5 h-3.5 text-purple-500" />
  }
  if (label.includes("proceed")) {
    return <ArrowRight className="w-3.5 h-3.5 text-purple-500" />
  }
  return <SearchCode className="w-3.5 h-3.5 text-purple-500" />
}

function FillChipButton({ chip, onClick }: { chip: FillActionChip; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${chip.labelPrefix ?? chip.insertText} | ${chip.label}`}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm border border-border bg-card hover:bg-secondary text-foreground transition-colors cursor-pointer"
    >
      <SuggestedReplyIcon chip={chip} />
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
    case "queued":
      return { label: "Queued", className: "bg-muted text-muted-foreground border-border" }
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

function delegationStatusNoticeContent(message: PilotMessage): string {
  const completed = numberValue(message.metadata?.completed_tasks)
  const total = numberValue(message.metadata?.total_tasks)
  return completed != null && total != null && total > 0
    ? `${completed}/${total} results ready · Siclaw is synthesizing`
    : "Results ready · Siclaw is synthesizing"
}

function withDelegationStatusNotices(messages: PilotMessage[]): PilotMessage[] {
  const next: PilotMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    next.push(message)
    if (!isBatchCompleteDelegationEvent(message)) continue

    const hasSyntheticReply = messages
      .slice(i + 1)
      .some((candidate) => candidate.role === "assistant" && isVisibleChatMessage(candidate))
    if (hasSyntheticReply) continue

    next.push({
      id: `delegation-status-${messageDelegationId(message) ?? message.id}`,
      role: "assistant",
      content: delegationStatusNoticeContent(message),
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

// A spawn_subagent launched in the background — detectable from the launch itself (run_in_background
// arg or the "launched" result), so the card shows the indicator/running state during the LIVE turn,
// not only after annotateSubagentCompletions runs on a refetch.
function isBackgroundSpawn(message: PilotMessage): boolean {
  if (message.toolName !== "spawn_subagent") return false
  if ((message.toolArgs as Record<string, unknown> | undefined)?.run_in_background === true) return true
  const parsed = message.content ? parseJsonRecord(message.content) : null
  return stringValue(parsed?.status) === "launched"
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
    scope: stringValue(args.description) ?? stringValue(args.scope) ?? stringValue(args.prompt) ?? stringValue(metadata.scope) ?? message.toolInput,
    summary: normalizeAgentWorkSummary(
      // Background spawn: the folded sub-agent report (subBgSummary), not the launch JSON.
      stringValue(metadata.subBgSummary) ??
      stringValue(result.summary) ??
      (isBackgroundSpawn(message) ? undefined : stringValue(message.content)),
    ),
    fullSummary: normalizeAgentWorkSummary(
      stringValue(details.full_summary) ??
      stringValue(metadata.full_summary) ??
      stringValue(result.full_summary),
    ),
    summaryTruncated: booleanValue(details.summary_truncated) ?? booleanValue(metadata.summary_truncated),
    childSessionId:
      stringValue(result.session_id) ??
      stringValue(result.sessionId) ??
      stringValue(result.child_session_id) ??
      stringValue(details.child_session_id) ??
      stringValue(metadata.child_session_id),
    toolCalls: numberValue(result.tool_calls) ?? numberValue(result.toolCalls),
    duration: compactDuration(durationMs ?? message.metadata?.durationMs as number | undefined),
    toolTrace: toolTraceValue(result.tool_trace ?? result.toolTrace ?? details.tool_trace ?? details.toolTrace),
    status:
      // Background spawn: folded completion status, else "running" until it folds — never the
      // launch result's "launched" (which would show as the default "Ready").
      stringValue(metadata.subBgStatus) ??
      (isBackgroundSpawn(message) ? "running" : undefined) ??
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
  canEditMessage,
  editingContent,
  onStartEditMessage,
  onEditMessageChange,
  onCancelEditMessage,
  onSubmitEditMessage,
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
  canEditMessage?: boolean
  editingContent?: string | null
  onStartEditMessage?: (id: string, content: string) => void
  onEditMessageChange?: (content: string) => void
  onCancelEditMessage?: () => void
  onSubmitEditMessage?: () => void
}) {
  const isUser = message.role === "user"
  const isTool = message.role === "tool"
  const isError = message.role === "error"

  if (isError && message.errorDetail) {
    return <ErrorBubble detail={message.errorDetail} />
  }

  if (message.metadata?.kind === "delegation_status_notice") {
    return <DelegationStatusNotice content={message.content} />
  }

  if (isTool) {
    if (message.toolName === "delegate_to_agents") {
      return <AgentWorkBatchCard message={message} />
    }
    if (message.toolName === "delegate_to_agent" || message.toolName === "spawn_subagent" || message.metadata?.kind === "agent_work") {
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
    ? parseDeepInvestigation(stripAttachmentOcrEvidence(message.content))
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
  const editableText = isUser ? getEditableUserText(message.content) : ""
  const canRenderEditor = !!onEditMessageChange && !!onCancelEditMessage && !!onSubmitEditMessage
  const route = !isUser && !isTool ? modelRouteMetadata(message) : null

  return (
    <div className={cn("flex gap-4 group", isUser ? "flex-row-reverse" : "flex-row")}>
      {/* Avatar */}
      <div
        data-copy-ignore
        className={cn(
          "w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm shadow-black/10 border",
          isUser ? "bg-blue-600 border-blue-600 text-white" : "bg-card border-border text-blue-400",
        )}
      >
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-5 h-5" />}
      </div>

      <div className={cn("flex flex-col min-w-0", isUser ? "items-end" : "items-start")}>
        <div className="flex flex-wrap items-center gap-2 mb-1 min-w-0">
          <span className="text-sm font-semibold text-foreground">{isUser ? "You" : "Siclaw"}</span>
          <span className="text-xs text-muted-foreground/70">{message.timestamp}</span>
          {!isUser && <ModelRouteIndicator route={route} />}
          {!isUser && <ModelTimeLabel timing={message.timing} />}
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
                <PrefixChipIcon chip={actionChip} />
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

        {isUser && message.attachments && message.attachments.length > 0 && (
          // data-copy-ignore: pasted/uploaded attachments are transient OCR
          // inputs, so the scroll-select copy/export skips them (the copy helper
          // strips [data-copy-ignore]).
          <div data-copy-ignore>
            <ImageAttachmentPreview
              attachments={message.attachments}
              className="mb-2 max-w-[560px] justify-end"
              tileClassName="h-32 w-56"
            />
          </div>
        )}

        {isUser && editingContent != null && canRenderEditor ? (
          <EditableUserMessage
            content={editingContent}
            onChange={onEditMessageChange}
            onCancel={onCancelEditMessage}
            onSubmit={onSubmitEditMessage}
          />
        ) : textContent ? (
          <CopyableMessage
            isUser={isUser}
            content={textContent}
            isStreaming={message.isStreaming}
            onEdit={
              canEditMessage && editableText
                ? () => onStartEditMessage?.(message.id, editableText)
                : undefined
            }
          />
        ) : isUser && message.attachments && message.attachments.length > 0 ? (
          <div className="rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
            (No content)
          </div>
        ) : null}

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

function CopyIconButton({
  text,
  title,
  className,
}: {
  text: string
  title?: string
  className?: string
}) {
  const [copied, copy] = useCopyFeedback()
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void copy(text)
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title ?? "Copy"}
      className={cn(
        "transition-opacity p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-secondary",
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

function CopyableMessage({
  isUser,
  content,
  isStreaming = false,
  onEdit,
}: {
  isUser: boolean
  content: string
  isStreaming?: boolean
  onEdit?: (content: string) => void
}) {
  const [copied, copy, flashCopied] = useCopyFeedback()
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const handleCopy = async () => {
    const bubble = bubbleRef.current
    const plain = stripImageData(stripVisualizationFences(content))
    if (bubble && (await copyElementsAsRichText([bubble], plain))) {
      flashCopied()
      return
    }
    void copy(content)
  }

  // Copy button sits OUTSIDE the bubble (below it, aligned right for user /
  // left for assistant), matching ChatGPT/Claude convention. Avoids any chance
  // of overlapping message text — even for one-line bubbles.
  return (
    <div className={cn("group/msg flex flex-col gap-1 max-w-3xl min-w-0", isUser ? "items-end" : "items-start")}>
      <div
        ref={bubbleRef}
        className={cn(
          "px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm shadow-black/10 min-w-0 overflow-hidden",
          isUser
            ? "bg-blue-600 text-white rounded-tr-sm [&_pre]:bg-black/20 [&_pre]:text-white [&_code]:bg-card/15 [&_code]:text-white [&_a]:text-blue-200"
            : "bg-card border border-border text-foreground rounded-tl-sm",
        )}
      >
        <Markdown isStreaming={isStreaming}>{content}</Markdown>
      </div>
      <div className={cn("flex items-center gap-1", isUser ? "justify-end" : "justify-start")}>
        <button
          onClick={handleCopy}
          className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-secondary transition-colors"
          title={isUser ? "Copy" : "Copy markdown"}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        {onEdit && (
          <button
            onClick={() => onEdit(content)}
            className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-secondary transition-colors"
            title="Edit and resend"
          >
            <PencilLine className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function EditableUserMessage({
  content,
  onChange = () => {},
  onCancel = () => {},
  onSubmit = () => {},
}: {
  content: string
  onChange?: (content: string) => void
  onCancel?: () => void
  onSubmit?: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const isComposingRef = useRef(false)

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const maxHeight = Math.min(420, Math.max(220, Math.floor(window.innerHeight * 0.46)))
    el.style.height = "auto"
    const nextHeight = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${nextHeight}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [content])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(content.length, content.length)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !isComposingRef.current && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key === "Enter" && !event.shiftKey && !isComposingRef.current && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="w-[48rem] max-w-full rounded-2xl rounded-tr-sm bg-card border border-border shadow-sm shadow-black/10 p-3">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false
        }}
        className="w-full min-h-[96px] resize-none bg-transparent border-none outline-none p-2 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:ring-0"
        style={{ height: "auto", overflowY: "hidden" }}
      />
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-secondary text-sm text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!content.trim()}
          className="px-3 py-1.5 rounded-lg bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  )
}

interface SubagentStepView {
  kind: "assistant" | "tool"
  text?: string
  toolName?: string
  toolInput?: string
  content?: string
  outcome?: string
  durationMs?: number | null
}

/**
 * Renders a sub-agent's execution like a mini main-agent run: reasoning text as
 * Markdown, and each tool call via the SAME ToolItem component the main timeline
 * uses (collapsible, formatted input/output, status + timing) — so it matches the
 * main agent's execution view.
 */
function SubagentSteps({ steps }: { steps: SubagentStepView[] }) {
  if (!steps?.length) return null
  return (
    <div className="space-y-3">
      {steps.map((s, i) =>
        s.kind === "assistant" ? (
          <div key={i} className="text-sm text-foreground">
            <Markdown>{s.text ?? ""}</Markdown>
          </div>
        ) : (
          (() => {
            // Format the command header exactly like the main agent (formatToolInput),
            // parsing the (redacted) args JSON we forwarded.
            const args = parseJsonRecord(s.toolInput ?? "") ?? undefined
            const header = formatToolInput(s.toolName ?? "", args) || s.toolInput
            return (
              <ToolItem
                key={i}
                nested
                message={{
                  id: `substep-${i}`,
                  role: "tool",
                  content: s.content ?? "",
                  toolName: s.toolName ?? "tool",
                  toolArgs: args,
                  toolInput: header,
                  toolStatus: s.outcome === "error" ? "error" : "success",
                  timestamp: "",
                  ...(s.durationMs != null ? { timing: { durationMs: s.durationMs } } : {}),
                }}
              />
            )
          })()
        ),
      )}
    </div>
  )
}

function AgentWorkCard({ message }: { message: PilotMessage }) {
  const work = agentWorkSummary(message)
  const steps = (message.toolDetails?.steps as SubagentStepView[] | undefined) ?? []
  // Queued = waiting for a concurrency slot. pi paints the whole fan-out batch as
  // "running" at once (one tool_execution_start each), so without this the queued
  // children would falsely show a spinner; the backend flips status to "queued".
  const isQueued = work.status === "queued"
  // Background spawn_subagent: the launch tool returns immediately (toolStatus "success"), so it
  // is "running in the background" until its completion folds in (subBgStatus). Treat that as
  // running so the card shows a spinner + the background marker instead of a bare "Ready".
  const isBgSubagent = isBackgroundSpawn(message)
  const bgSubDone = Boolean(message.metadata?.subBgStatus)
  const isRunning = !isQueued && (message.toolStatus === "running" || message.isStreaming || (isBgSubagent && !bgSubDone))
  const isSpawn = message.toolName === "spawn_subagent"
  // Collapsed by default — the user expands the card when they want to see the
  // execution. (Legacy delegate cards keep auto-opening while streaming.)
  const [expanded, setExpanded] = useState(false)
  const isOpen = isSpawn ? expanded : message.isStreaming || expanded
  const tone = statusTone(work.status)
  const title = isSpawn ? "Sub-agent" : work.isSelfDelegation ? "Delegated investigation" : "Expert collaboration"

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
              <span className={cn("text-sm font-semibold text-foreground", isSpawn ? "truncate" : "shrink-0")}>
                {isSpawn ? (work.scope || "Sub-agent") : title}
              </span>
              {isSpawn && (
                <span className="shrink-0 px-1.5 py-0.5 rounded-full border border-purple-500/30 bg-purple-500/10 text-purple-400 text-[10px] font-medium">
                  sub-agent
                </span>
              )}
              {isBgSubagent && (
                <span
                  className="shrink-0 inline-flex text-muted-foreground/70"
                  title="Runs in the background — returns immediately, notifies on completion"
                  aria-label="Background execution"
                >
                  <Clock className="w-3.5 h-3.5" />
                </span>
              )}
              <span className={cn("shrink-0 px-2 py-0.5 rounded-full border text-[11px] font-medium", tone.className)}>
                {tone.label}
              </span>
            </div>
            {!isSpawn && (
              <div className="text-xs text-muted-foreground truncate">
                {`${work.targetLabel}${work.scope ? ` · ${work.scope}` : ""}`}
              </div>
            )}
          </div>
          {isQueued ? (
            <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          ) : isRunning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
          ) : null}
        </button>

        {isOpen && (
          <div className="p-4 space-y-3 bg-secondary/20 border-t border-border">
            {isSpawn ? (
              // The card is just the sub-agent's execution process; the conclusion is
              // surfaced by the parent in the main conversation, so no report here.
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  {isBgSubagent && bgSubDone ? "Result" : "Execution"}
                </div>
                {steps.length > 0 ? (
                  <SubagentSteps steps={steps} />
                ) : isQueued ? (
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <Clock className="w-3 h-3" />
                    {stringValue(message.toolDetails?.activity) ?? "Waiting for a free slot…"}
                  </div>
                ) : isRunning ? (
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {isBgSubagent ? "Running in the background… (updates here when done)" : "Sub-agent working…"}
                  </div>
                ) : isBgSubagent && work.summary ? (
                  // Background sub-agent has no inline steps (it ran in its own session); show the
                  // folded result report so the user sees the outcome on the card.
                  <div className="text-sm text-foreground"><Markdown>{work.summary}</Markdown></div>
                ) : (
                  <div className="text-xs text-muted-foreground/60">(no execution recorded)</div>
                )}
              </div>
            ) : (
              <>
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
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Capsule sent to parent</div>
                    <div className="text-sm text-foreground"><Markdown>{work.summary}</Markdown></div>
                  </div>
                )}
                {work.fullSummary && work.fullSummary !== work.summary && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Full sub-agent report</div>
                    <div className="text-sm text-foreground max-h-96 overflow-y-auto pr-2"><Markdown>{work.fullSummary}</Markdown></div>
                  </div>
                )}
                <AgentToolTraceList trace={work.toolTrace} defaultOpen={isRunning} />
              </>
            )}
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

function AgentToolTraceList({ trace, defaultOpen }: { trace: AgentToolTrace[]; defaultOpen?: boolean }) {
  if (trace.length === 0) return null
  return (
    <details open={defaultOpen} className="rounded-lg border border-border/70 bg-card/40">
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
  const isOpen = message.isStreaming || expanded
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
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight
            className={cn("w-3.5 h-3.5 text-muted-foreground/70 transition-transform shrink-0", isOpen && "rotate-90")}
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

        {isOpen && (
          <div className="px-4 py-3 bg-secondary/20 border-t border-border">
            {batch.tasks.length > 0 ? (
              <div className="ml-5 pl-4 border-l-2 border-border/60">
                {batch.tasks.map((task, index) => (
                  <AgentWorkBatchRow key={`${task.targetLabel}-${task.index ?? index}`} task={task} />
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

function ToolItem({ message, nested }: { message: PilotMessage; nested?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const isOpen = message.isStreaming || expanded
  // node_exec / pod_exec / bash launched with run_in_background return immediately and
  // notify on completion. The job's completion is folded back onto this box as bgStatus
  // (see annotateExecJobCompletions), so the box shows its lifecycle: running → done/failed.
  const isBackground = (message.toolArgs as Record<string, unknown> | undefined)?.run_in_background === true
  const bgStatus = isBackground ? ((message.metadata as Record<string, unknown> | undefined)?.bgStatus as string | undefined) : undefined
  const bgExitCode = (message.metadata as Record<string, unknown> | undefined)?.bgExitCode
  const bgRunning = isBackground && !bgStatus
  const bgFailed = bgStatus === "failed"
  const bgStopped = bgStatus === "stopped" || bgStatus === "killed"
  // Synthesized when a launch's completion was never persisted (crash) and the row aged out —
  // the job is gone, so render it as a non-success terminal state, not a green "done".
  const bgTimedOut = bgStatus === "timed_out"
  const bgDone = isBackground && !!bgStatus && !bgFailed && !bgStopped && !bgTimedOut
  const bgExitLabel = typeof bgExitCode === "number" ? ` (exit ${bgExitCode})` : ""
  // The expanded body re-prints toolInput only when the single-line header can't
  // already show it in full: multi-line input (a heredoc / multi-statement command)
  // or a very long one-liner the header truncates. For short single-line inputs
  // (a `read`/`grep`/`glob` path), the header already shows the whole thing, so the
  // body echo is pure duplication — skip it. The header copy button grabs full text
  // either way.
  const showInputBody =
    !!message.toolInput && (message.toolInput.includes("\n") || message.toolInput.length > 100)

  return (
    <div className={nested ? "min-w-0" : "pl-12 min-w-0"}>
      <div className="group/tool bg-card border border-border rounded-lg shadow-sm shadow-black/10 overflow-hidden">
        {/* Whole row toggles expand. The toolInput span + timing badges
            stopPropagation on mousedown so drag-select doesn't get hijacked
            as a click, restoring the original "click anywhere to expand"
            ergonomics for SREs scanning many tool rows. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => setExpanded(!expanded)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              setExpanded(!expanded)
            }
          }}
          className="flex items-center gap-2 w-full px-4 py-2 bg-secondary border-b border-border hover:bg-secondary/80 transition-colors cursor-pointer min-w-0"
          title={isOpen ? "Collapse" : "Expand"}
        >
          <ChevronRight
            className={cn("w-3.5 h-3.5 text-muted-foreground/70 transition-transform shrink-0", isOpen && "rotate-90")}
          />
          <Terminal className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="font-mono text-xs font-semibold text-foreground shrink-0">{message.toolName}</span>
          {isBackground && (
            <span
              className="shrink-0 inline-flex text-muted-foreground/70"
              title="Runs in the background — returns immediately, notifies on completion"
              aria-label="Background execution"
            >
              <Clock className="w-3.5 h-3.5" />
            </span>
          )}
          {message.toolInput && (
            <span
              className="font-mono text-xs text-muted-foreground truncate min-w-0 select-text cursor-text"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {message.toolInput}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {(() => {
              const t = message.timing
              const showThink = typeof t?.thinkingMs === "number"
              const showDur = typeof t?.durationMs === "number"
              const durationLabel = message.toolStatus === "running" ? "running" : "ran"
              return (
                <>
                  {(showThink || showDur) && (
                    <span className="text-[11px] text-muted-foreground tabular-nums select-text">
                      {showThink && <>thinking {formatTimingMs(t!.thinkingMs!)}</>}
                      {showThink && showDur && ", "}
                      {showDur && <>{durationLabel} {formatTimingMs(t!.durationMs!)}</>}
                    </span>
                  )}
                </>
              )
            })()}
            {message.toolInput && (
              <CopyIconButton
                text={message.toolInput}
                title="Copy command"
                className=""
              />
            )}
            {isBackground ? (
              // Background launch: show the JOB's lifecycle (folded from its completion),
              // not the launch call's own status (which is always "success" at launch).
              <>
                {bgRunning && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                {bgDone && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                {bgFailed && <XCircle className="w-3.5 h-3.5 text-red-500" />}
                {(bgStopped || bgTimedOut) && <Ban className="w-3.5 h-3.5 text-amber-500" />}
              </>
            ) : (
              <>
                {message.toolStatus === "running" && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                {message.toolStatus === "success" && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                {message.toolStatus === "error" && <XCircle className="w-3.5 h-3.5 text-red-500" />}
                {message.toolStatus === "aborted" && <Ban className="w-3.5 h-3.5 text-amber-500" />}
              </>
            )}
          </div>
        </div>
        {isOpen && (
          <div className="overflow-x-auto bg-secondary/30 max-h-80 overflow-y-auto">
            {showInputBody && (
              <div className="relative group/input px-4 pt-3 pb-2 border-b border-border/50">
                {/* No copy button here — the header already copies the command. */}
                <pre className="text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all pr-8">
                  {message.toolInput}
                </pre>
              </div>
            )}
            <div className="relative group/output p-4">
              <pre className="text-xs font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap pr-8">
                {isBackground
                  ? (bgRunning
                      ? "Running in the background… (updates here when done)"
                      : bgFailed
                        ? `Background task failed${bgExitLabel}`
                        : bgStopped
                          ? "Background task stopped"
                          : bgTimedOut
                            ? "Background task did not report completion (timed out)"
                            : `Background task completed${bgExitLabel}`)
                  : (message.content || (message.toolStatus === "aborted" ? "Aborted." : "Running..."))}
              </pre>
              {/* Output copy only for a real captured output — a background box's body is a
                  status line, not output (the real output is read via the read tool). */}
              {!isBackground && message.content && (
                <CopyIconButton
                  text={message.content}
                  title="Copy output"
                  className="absolute top-2 right-2"
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
