import { useState } from "react"
import { Search, CheckCircle2, X, MessageSquare, ChevronRight, Play, RefreshCw, PenLine } from "lucide-react"
import { cn } from "./cn"
import { Markdown } from "./Markdown"
import type { PilotMessage } from "./types"

// --- Types ---

interface ParsedHypothesis {
  index: number
  title: string
  confidence?: number
  description?: string
  detailLines: string[]
}

// --- Parser ---

/**
 * Parse hypotheses from LLM-generated markdown.
 */
export function parseHypotheses(input: string): ParsedHypothesis[] {
  if (!input) return []

  // Strategy 1: Split by --- separators
  const blocks = input.split(/\n---\s*\n/).filter((b) => b.trim())
  if (blocks.length >= 2) {
    return blocks.map((block, i) => parseBlock(block.trim(), i + 1))
  }

  // Strategy 2: Try structured headers
  const headerSplit = input.split(/\n(?=#{2,3}\s*(?:Hypothesis|H)\s*\d)/i).filter((b) => b.trim())
  if (headerSplit.length >= 2) {
    return headerSplit.map((block, i) => parseBlock(block.trim(), i + 1))
  }

  // Strategy 2.5: Generic numbered headings
  const numberedHeadingSplit = input.split(/\n(?=#{2,3}\s*\d+[.)]\s)/).filter((b) => b.trim())
  if (numberedHeadingSplit.length >= 2) {
    const hasNumbered = (b: string) => /^#{2,3}\s*\d+[.)]\s/m.test(b)
    const hypoBlocks = numberedHeadingSplit.filter(hasNumbered)
    if (hypoBlocks.length >= 2) {
      return hypoBlocks.map((block, i) => parseBlock(block.trim(), i + 1))
    }
  }

  // Strategy 3: Bold-prefixed
  const boldSplit = input.split(/\n(?=\*{2}(?:Hypothesis|H)\s*\d)/i).filter((b) => b.trim())
  if (boldSplit.length >= 2) {
    const hasHypothesis = (b: string) => /\*{2}(?:Hypothesis|H)\s*\d/i.test(b)
    const hypoBlocks = boldSplit.filter(hasHypothesis)
    if (hypoBlocks.length >= 2) {
      return hypoBlocks.map((block, i) => parseBlock(block.trim(), i + 1))
    }
  }

  // Strategy 4: Numbered list fallback
  return parseNumberedList(input)
}

function parseBlock(block: string, fallbackIndex: number): ParsedHypothesis {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

  let confidence: number | undefined
  let title = ""
  let description = ""
  const detailLines: string[] = []

  for (const line of lines) {
    // Bold-prefixed hypothesis title
    const boldHypoMatch = line.match(/^\*{2}(?:Hypothesis|H)\s*\d+[:\s]*(.*?)\*{2}\s*$/i)
    if (boldHypoMatch) {
      const inner = boldHypoMatch[1]
      const inlineConf = inner.match(/[(\uff08](?:confidence|置信度)[:\s：]*(\d+)\s*%[)\uff09]/i)
      if (inlineConf) confidence = parseInt(inlineConf[1], 10)
      title = cleanMarkdown(inner.replace(/[(\uff08](?:confidence|置信度)[:\s：]*\d+\s*%[)\uff09]/i, "").trim())
      continue
    }

    // Heading line
    const headingMatch = line.match(/^#{2,3}\s*(?:Hypothesis|H)\s*\d+[:\s]*(.*)/i)
    if (headingMatch) {
      const inner = headingMatch[1]
      const inlineConf = inner.match(/[(\uff08](?:confidence|置信度)[:\s：]*(\d+)\s*%[)\uff09]/i)
      if (inlineConf) confidence = parseInt(inlineConf[1], 10)
      title = cleanMarkdown(inner.replace(/[(\uff08](?:confidence|置信度)[:\s：]*\d+\s*%[)\uff09]/i, "").trim())
      continue
    }

    // Generic numbered heading
    const genericHeadingMatch = line.match(/^#{2,3}\s*\d+[.)]\s*(.*)/)
    if (genericHeadingMatch) {
      const inner = genericHeadingMatch[1]
      const inlineConf = inner.match(/[(\uff08](?:confidence|置信度)[:\s：]*(\d+)\s*%[)\uff09]/i)
      if (inlineConf) confidence = parseInt(inlineConf[1], 10)
      title = cleanMarkdown(inner.replace(/[(\uff08](?:confidence|置信度)[:\s：]*\d+\s*%[)\uff09]/i, "").trim())
      continue
    }

    // Extract confidence
    const confMatch = line.match(/^\*{0,2}(?:confidence|置信度)\*{0,2}[:\s：]*(\d+)\s*%/i)
    if (confMatch) {
      confidence = parseInt(confMatch[1], 10)
      continue
    }

    // Skip raw tool references
    if (line.match(/^\*{0,2}(?:validation tools?|verification tools?)\*{0,2}[:\s]/i)) continue
    if (line.match(/`(node_exec|pod_exec|bash|local_script|node_script)[:\s]/)) {
      detailLines.push(cleanMarkdown(line))
      continue
    }

    const stripped = line.replace(/^[-*]\s+/, "")

    // Description header
    const descMatch = stripped.match(/^\*{0,2}(?:description|描述)\*{0,2}[:\s：]*(.*)/i)
    if (descMatch && descMatch[1]) {
      const cleaned = cleanMarkdown(descMatch[1])
      if (!title) title = cleaned
      else if (!description) description = cleaned
      else detailLines.push(cleaned)
      continue
    }

    // Validation method lines
    if (stripped.match(/^(?:\*{0,2})(?:validation method|validation|expected result|验证方法|验证|预期结果)(?:\*{0,2})[:\s：]/i)) {
      detailLines.push(cleanMarkdown(stripped))
      continue
    }

    // First substantial non-metadata line becomes title
    if (!title && stripped.length > 10) {
      title = cleanMarkdown(stripped)
      continue
    }

    // Remaining lines are details
    if (title) {
      const cleaned = cleanMarkdown(stripped)
      if (cleaned.length > 5) {
        if (!description) {
          description = cleaned
        } else {
          detailLines.push(cleaned)
        }
      }
    }
  }

  if (confidence == null) {
    const blockConfMatch = block.match(/(\d+)\s*%/)
    if (blockConfMatch) confidence = parseInt(blockConfMatch[1], 10)
  }

  return {
    index: fallbackIndex,
    title: title || `Hypothesis ${fallbackIndex}`,
    confidence,
    description: description || undefined,
    detailLines,
  }
}

function parseNumberedList(input: string): ParsedHypothesis[] {
  const hypotheses: ParsedHypothesis[] = []
  const lines = input.split("\n")
  let current: ParsedHypothesis | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const numberedMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/)
    if (numberedMatch) {
      if (current) hypotheses.push(current)
      const text = cleanMarkdown(numberedMatch[2])
      const confMatch = text.match(/(\d+)\s*%/)
      current = {
        index: parseInt(numberedMatch[1], 10),
        title: text.replace(/\(\d+%\)/, "").trim(),
        confidence: confMatch ? parseInt(confMatch[1], 10) : undefined,
        detailLines: [],
      }
    } else if (current && (trimmed.startsWith("-") || trimmed.startsWith("*") || /^\s/.test(line))) {
      const detail = cleanMarkdown(trimmed.replace(/^[-*]\s+/, ""))
      if (detail.length > 5) current.detailLines.push(detail)
    }
  }
  if (current) hypotheses.push(current)
  return hypotheses
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[#\s]+/, "")
    .trim()
}

// --- Component ---

export interface ConfirmedHypothesis {
  id: string
  text: string
  confidence: number
}

export interface HypothesesCardProps {
  message: PilotMessage
  sendMessage?: (text: string) => void
  onHypothesesConfirmed?: (hypotheses: ConfirmedHypothesis[]) => void
  superseded?: boolean
  alreadyConfirmed?: boolean
}

export function HypothesesCard({
  message,
  sendMessage,
  onHypothesesConfirmed,
  superseded,
  alreadyConfirmed,
}: HypothesesCardProps) {
  const [feedbackMode, setFeedbackMode] = useState(false)
  const [feedbackText, setFeedbackText] = useState("")
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const isRunning = message.toolStatus === "running"
  const isDone = message.toolStatus === "success" || (!message.toolStatus && !message.isStreaming)

  // Parse hypotheses: prefer toolDetails.hypotheses, fallback to toolInput
  const raw = message.toolDetails?.hypotheses
  let hypotheses: ParsedHypothesis[]
  if (Array.isArray(raw)) {
    hypotheses = (raw as Array<{ text?: string; confidence?: number; description?: string }>).map((h, i) => ({
      index: i + 1,
      title: h.text ?? `Hypothesis ${i + 1}`,
      confidence: h.confidence,
      description: h.description,
      detailLines: [],
    }))
  } else {
    const hypothesesSource = (raw as string | undefined) || message.toolInput || ""
    hypotheses = parseHypotheses(hypothesesSource)
  }
  const hypothesesSource = Array.isArray(raw) ? "" : (raw as string | undefined) || message.toolInput || ""

  const effectiveConfirmed = confirmed || alreadyConfirmed

  // Superseded: render collapsed
  if (superseded) {
    return (
      <div className="pl-12">
        <div className="rounded-lg border border-border bg-secondary/30 px-4 py-2 max-w-2xl opacity-50">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground/70 shrink-0" />
            <span className="text-sm text-muted-foreground">Hypotheses</span>
            <span className="text-xs text-muted-foreground/70">{hypotheses.length} items</span>
            <span className="ml-auto text-xs text-muted-foreground/70">Superseded</span>
          </div>
        </div>
      </div>
    )
  }

  const isAutoConfirmed = isDone && message.toolDetails?.autoConfirmed === true
  const showActions = isDone && !isRunning && !feedbackMode && !isAutoConfirmed && !effectiveConfirmed

  const emitConfirmed = () => {
    if (onHypothesesConfirmed && hypotheses.length > 0) {
      onHypothesesConfirmed(
        hypotheses.map((h) => ({
          id: `H${h.index}`,
          text: h.title,
          confidence: h.confidence ?? 0,
        })),
      )
    }
  }

  const handleConfirm = () => {
    if (sendMessage) {
      sendMessage("[DP_CONFIRM]\nThe user has confirmed hypotheses.")
      setConfirmed(true)
      emitConfirmed()
    }
  }

  const handleModify = () => {
    if (feedbackText.trim() && sendMessage) {
      sendMessage(`[DP_ADJUST]\n${feedbackText.trim()}`)
      setFeedbackMode(false)
      setFeedbackText("")
      setConfirmed(true)
    }
  }

  const handleReinvestigate = () => {
    if (sendMessage) {
      const hint = feedbackText.trim()
      sendMessage(`[DP_REINVESTIGATE]\n${hint || "Re-investigate from a different angle."}`)
      setFeedbackMode(false)
      setFeedbackText("")
      setConfirmed(true)
    }
  }

  const handleSkip = () => {
    if (sendMessage) {
      sendMessage("[DP_SKIP]\nSkip validation and present conclusion.")
      setConfirmed(true)
    }
  }

  const toggleExpand = (idx: number) => {
    setExpandedIdx(expandedIdx === idx ? null : idx)
  }

  return (
    <div className="pl-12" data-hypotheses-card data-hypotheses-card-id={message.id}>
      <div
        className={cn(
          "rounded-lg border px-4 py-3 max-w-2xl transition-colors",
          isDone ? "border-indigo-500/30 bg-indigo-500/10" : "border-blue-500/30 bg-blue-500/10/50",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <Search className="w-4 h-4 text-indigo-500 shrink-0" />
          <span className="text-sm font-semibold text-foreground">Deep Investigation</span>
          <span className="text-xs text-muted-foreground">Hypothesis Review</span>
          {isDone && (isAutoConfirmed || effectiveConfirmed) && (
            <span className="ml-auto text-xs font-medium px-1.5 py-0.5 rounded flex items-center gap-1 bg-indigo-500/15 text-indigo-400">
              <CheckCircle2 className="w-3 h-3" />
              Confirmed
            </span>
          )}
          {isDone && !isAutoConfirmed && !effectiveConfirmed && !feedbackMode && (
            <span className="ml-auto text-xs text-amber-400 font-medium px-1.5 py-0.5 rounded bg-amber-500/10">
              Awaiting review
            </span>
          )}
        </div>

        {/* Hypotheses list */}
        {hypotheses.length > 0 ? (
          <div className="space-y-1 mb-3">
            {hypotheses.map((h) => {
              const isExpanded = expandedIdx === h.index
              const hasDetails = h.detailLines.length > 0 || !!h.description
              return (
                <div key={h.index}>
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md transition-colors",
                      hasDetails ? "hover:bg-indigo-500/10 cursor-pointer" : "cursor-default",
                      isExpanded && "bg-indigo-500/10",
                    )}
                    onClick={() => hasDetails && toggleExpand(h.index)}
                  >
                    {hasDetails ? (
                      <ChevronRight
                        className={cn("w-3 h-3 text-muted-foreground/70 shrink-0 transition-transform", isExpanded && "rotate-90")}
                      />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-indigo-500 bg-indigo-100 rounded-full w-5 h-5 flex items-center justify-center shrink-0">
                      {h.index}
                    </span>
                    <span className="flex-1 text-sm text-foreground min-w-0 truncate">{h.title}</span>
                    {h.confidence != null && (
                      <span
                        className={cn(
                          "text-xs font-semibold px-1.5 py-0.5 rounded shrink-0",
                          h.confidence >= 70
                            ? "bg-indigo-500/15 text-indigo-400"
                            : h.confidence >= 40
                              ? "bg-blue-500/15 text-blue-400"
                              : "bg-secondary text-muted-foreground",
                        )}
                      >
                        {h.confidence}%
                      </span>
                    )}
                  </button>
                  {isExpanded && hasDetails && (
                    <div className="ml-10 pl-2 border-l-2 border-indigo-500/30 mt-1 mb-2 space-y-1">
                      {h.description && <p className="text-xs text-muted-foreground leading-relaxed">{h.description}</p>}
                      {h.detailLines.map((line, i) => (
                        <p key={i} className="text-xs text-muted-foreground leading-relaxed">
                          {line}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="mb-3 text-sm text-muted-foreground">
            <Markdown>{hypothesesSource}</Markdown>
          </div>
        )}

        {/* Adjust panel */}
        {feedbackMode && (
          <div className="mb-3 space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleModify()}
                placeholder="Feedback or guidance..."
                className="flex-1 text-sm border border-indigo-500/30 rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  setFeedbackMode(false)
                  setFeedbackText("")
                }}
                className="text-xs font-medium px-2 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleModify}
                disabled={!feedbackText.trim()}
                className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <PenLine className="w-3 h-3" />
                Modify
              </button>
              <button
                type="button"
                onClick={handleReinvestigate}
                className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md text-indigo-600 border border-indigo-500/30 hover:bg-indigo-50 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                Re-investigate
              </button>
            </div>
          </div>
        )}

        {/* Action buttons */}
        {showActions && (
          <div className="flex items-center gap-2 pt-2 border-t border-indigo-100">
            <button
              type="button"
              onClick={handleConfirm}
              className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              <Play className="w-3 h-3" />
              Confirm & Run
            </button>
            <button
              type="button"
              onClick={() => setFeedbackMode(true)}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-md text-indigo-600 hover:bg-indigo-100 transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3 h-3" />
              Adjust
            </button>
            <button
              type="button"
              onClick={handleSkip}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md text-muted-foreground/70 hover:text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
            >
              Skip
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
