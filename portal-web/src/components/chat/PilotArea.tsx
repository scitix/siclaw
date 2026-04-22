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
} from "lucide-react"
import { cn } from "./cn"
import { Markdown } from "./Markdown"
import { InputArea, type PrefixChip } from "./InputArea"
import { SkillCard } from "./SkillCard"
import { ScheduleCard } from "./ScheduleCard"
import { InvestigationCard } from "./InvestigationCard"
import { HypothesesCard } from "./HypothesesCard"
import { DpChecklistCard } from "./DpChecklistCard"
import type { PilotMessage, ContextUsage, InvestigationProgress, DpChecklistItem } from "./types"

const DIG_DEEPER_CHIP: PrefixChip = {
  id: "dig-deeper",
  label: "Dig deeper",
  fullPrompt:
    "Your conclusion may not be the root cause. Please dig deeper — trace where the problematic values, configurations, or states come from. Check the upstream resources, dependencies, and configuration sources until you find the original cause.",
  placeholder: "Add detail for deeper investigation (optional)",
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
  investigationProgress?: InvestigationProgress | null
  dpActive?: boolean
  onSetDpActive?: (active: boolean) => void
  dpFocus?: string | null
  dpChecklist?: DpChecklistItem[] | null
  onHypothesesConfirmed?: (hypotheses: Array<{ id: string; text: string; confidence: number }>) => void
  onExitDp?: () => void
  sessionKey?: string | null
  onOpenSkillPanel?: (msg: PilotMessage) => void
  onOpenSchedulePanel?: (msg: PilotMessage) => void
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
  investigationProgress,
  dpActive,
  onSetDpActive,
  dpFocus,
  dpChecklist,
  onHypothesesConfirmed,
  onExitDp,
  sessionKey,
  onOpenSkillPanel,
  onOpenSchedulePanel,
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
  const [activePrefix, setActivePrefix] = useState<PrefixChip | null>(null)
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
      setChipSeq((s) => s + 1)
      setChipDraft(lastSentRef.current)
      lastSentRef.current = null
    }
  }, [abortResponse])

  const scrollToBottom = useCallback((smooth = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollIntoView(smooth ? { behavior: "smooth" } : undefined)
    })
  }, [])

  // Find the latest propose_hypotheses message
  const latestHypothesesId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].toolName === "propose_hypotheses" && !messages[i].isStreaming) {
        return messages[i].id
      }
    }
    return null
  }, [messages])

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
    if (dpActive || (dpChecklist && dpChecklist.length > 0)) return false
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
  }, [messages, isLoading, dpActive, dpChecklist])

  // Check if latest hypotheses were already confirmed
  const latestHypothesesConfirmed = useMemo(() => {
    if (!latestHypothesesId) return false
    const hypoIdx = messages.findIndex((m) => m.id === latestHypothesesId)
    if (hypoIdx < 0) return false
    const afterHypo = messages.slice(hypoIdx + 1)
    if (afterHypo.some((m) => m.toolName === "deep_search")) return true
    if (afterHypo.some((m) => m.role === "user" && m.content.includes("confirmed hypotheses"))) return true
    if (dpChecklist?.some((i) => i.id === "deep_search" && (i.status === "in_progress" || i.status === "done")))
      return true
    return false
  }, [messages, latestHypothesesId, dpChecklist])

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

              {messages
                .filter((m) => !m.hidden)
                .map((msg) => (
                  <MessageItem
                    key={msg.id}
                    message={msg}
                    investigationProgress={investigationProgress}
                    sendMessage={wrappedSendMessage}
                    dpFocus={dpFocus}
                    dpChecklistActive={dpChecklist != null && dpChecklist.length > 0}
                    onHypothesesConfirmed={onHypothesesConfirmed}
                    hypothesesSuperseded={
                      latestHypothesesId != null && msg.toolName === "propose_hypotheses" && msg.id !== latestHypothesesId
                    }
                    hypothesesAlreadyConfirmed={msg.id === latestHypothesesId && latestHypothesesConfirmed}
                    showSuggestedReplies={msg.id === lastAssistantMsgId && !isLoading}
                    onChipClick={(key) => {
                      setChipSeq((s) => s + 1)
                      setChipDraft(key + " ")
                    }}
                    onOpenSkillPanel={onOpenSkillPanel}
                    onOpenSchedulePanel={onOpenSchedulePanel}
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

              {/* DP Checklist Card */}
              {dpChecklist && dpChecklist.length > 0 && (
                <DpChecklistCard items={dpChecklist} investigationProgress={investigationProgress} onDismiss={onExitDp} />
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
        dpFocus={dpFocus}
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

interface SuggestedReply {
  key: string
  label: string
}

function detectOptionReplies(content: string): SuggestedReply[] {
  const primary: SuggestedReply[] = []
  const regex = /[-*]\s+\*\*([A-Za-z\d]+)\.\*\*\s+(.+?)(?:\s+[—\-–]\s+.*)?$/gm
  for (const match of content.matchAll(regex)) {
    primary.push({ key: match[1], label: match[2].trim() })
  }
  if (primary.length >= 2 && primary.length <= 8) return primary

  const fallback: SuggestedReply[] = []
  const fallbackRegex = /^([A-Z])\.\s+(.+?)(?:\s+[—\-–]\s+.*)?$/gm
  for (const match of content.matchAll(fallbackRegex)) {
    fallback.push({ key: match[1], label: match[2].trim() })
  }
  return fallback.length >= 2 && fallback.length <= 8 ? fallback : []
}

function parseSuggestedReplies(content: string): { replies: SuggestedReply[]; text: string } {
  const commentMatch = content.match(/<!--\s*suggested-replies:\s*(.*?)\s*-->/)
  if (commentMatch) {
    const replies: SuggestedReply[] = []
    for (const part of commentMatch[1].split(",")) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const pipeIdx = trimmed.indexOf("|")
      if (pipeIdx > 0) {
        replies.push({ key: trimmed.slice(0, pipeIdx).trim(), label: trimmed.slice(pipeIdx + 1).trim() })
      } else {
        replies.push({ key: trimmed, label: trimmed })
      }
    }
    const text = content.replace(/<!--\s*suggested-replies:\s*.*?\s*-->/, "").trimEnd()
    return { replies, text }
  }

  const detected = detectOptionReplies(content)
  if (detected.length > 0) {
    return { replies: detected, text: content }
  }

  return { replies: [], text: content }
}

// --- Message rendering ---

function MessageItem({
  message,
  investigationProgress,
  sendMessage,
  dpFocus,
  dpChecklistActive,
  onHypothesesConfirmed,
  hypothesesSuperseded,
  hypothesesAlreadyConfirmed,
  showSuggestedReplies,
  onChipClick,
  onOpenSkillPanel,
  onOpenSchedulePanel,
}: {
  message: PilotMessage
  investigationProgress?: InvestigationProgress | null
  sendMessage?: (text: string) => void
  dpFocus?: string | null
  dpChecklistActive?: boolean
  onHypothesesConfirmed?: (hypotheses: Array<{ id: string; text: string; confidence: number }>) => void
  hypothesesSuperseded?: boolean
  hypothesesAlreadyConfirmed?: boolean
  showSuggestedReplies?: boolean
  onChipClick?: (key: string) => void
  onOpenSkillPanel?: (msg: PilotMessage) => void
  onOpenSchedulePanel?: (msg: PilotMessage) => void
}) {
  const isUser = message.role === "user"
  const isTool = message.role === "tool"

  if (isTool) {
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
    if (message.toolName === "schedule_preview" && !message.isStreaming) {
      return <ScheduleCard message={message} onOpenPanel={onOpenSchedulePanel} />
    }
    if (message.toolName === "deep_search") {
      if (message.isStreaming && (dpFocus || dpChecklistActive)) {
        return null
      }
      return (
        <InvestigationCard
          message={message}
          progress={message.isStreaming ? investigationProgress : undefined}
          sendMessage={sendMessage}
        />
      )
    }
    if (message.toolName === "propose_hypotheses" && !message.isStreaming) {
      return (
        <HypothesesCard
          message={message}
          sendMessage={sendMessage}
          onHypothesesConfirmed={onHypothesesConfirmed}
          superseded={hypothesesSuperseded}
          alreadyConfirmed={hypothesesAlreadyConfirmed}
        />
      )
    }
    return <ToolItem message={message} />
  }

  // Parse references from user messages
  const { isDeepInvestigation, text: afterDeepInv } = isUser
    ? parseDeepInvestigation(message.content)
    : { isDeepInvestigation: false, text: message.content }
  const { scripts, text: afterScripts } = isUser
    ? parseScriptRefs(afterDeepInv)
    : { scripts: [] as ScriptRef[], text: afterDeepInv }
  const { skillName, text: afterSkillRef } = isUser
    ? parseSkillRef(afterScripts)
    : { skillName: null, text: afterScripts }

  // Strip suggested-replies comments
  const strippedContent =
    !isUser && !isTool ? afterSkillRef.replace(/<!--\s*suggested-replies:\s*.*?\s*-->/g, "").trimEnd() : afterSkillRef
  const { replies: suggestedReplies, text: textContent } =
    !isUser && !isTool && showSuggestedReplies && !message.isStreaming
      ? parseSuggestedReplies(afterSkillRef)
      : { replies: [] as SuggestedReply[], text: strippedContent }

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
        {(isDeepInvestigation || skillName || scripts.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {isDeepInvestigation && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs font-medium text-blue-400">
                <SearchCode className="w-3.5 h-3.5 text-blue-500" />
                <span>Deep Investigation</span>
                {dpFocus && (
                  <span className="ml-1 px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 text-[10px] font-semibold uppercase">
                    {dpFocus}
                  </span>
                )}
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

        {suggestedReplies.length > 0 && onChipClick && (
          <div className="flex flex-wrap gap-2 mt-2">
            {suggestedReplies.map((reply) => (
              <button
                key={reply.key}
                type="button"
                onClick={() => onChipClick(reply.key)}
                className="rounded-full px-3 py-1.5 text-sm border border-border bg-card hover:bg-secondary text-foreground transition-colors cursor-pointer"
              >
                <span className="font-medium text-muted-foreground">{reply.key}.</span> {reply.label}
              </button>
            ))}
          </div>
        )}
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
