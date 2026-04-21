import { ArrowUp, ArrowDown, Square, X, Loader2, SearchCode, Plus, Check } from "lucide-react"
import type { ContextUsage } from "./types"
import { useState, useCallback, useRef, useEffect } from "react"
import type { KeyboardEvent } from "react"
import { cn } from "./cn"

/** Format token count: 0 -> "0", 1234 -> "1.2k" */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100000) return (n / 1000).toFixed(1) + "k"
  return Math.round(n / 1000) + "k"
}

/** Format cost: $0.0012 -> "$0.001", $1.23 -> "$1.23" */
function formatCost(cost: number): string {
  if (cost < 0.01) return "$" + cost.toFixed(3)
  return "$" + cost.toFixed(2)
}

/**
 * A canned prompt presented as an atomic pill in the input area.
 * The user cannot edit label text; they type follow-up detail after it and
 * fullPrompt is expanded on send.
 */
export interface PrefixChip {
  id: string
  label: string
  fullPrompt: string
  placeholder?: string
}

interface InputAreaProps {
  onSend: (message: string) => void
  onAbort?: () => void
  disabled?: boolean
  isLoading?: boolean
  contextUsage?: ContextUsage | null
  pendingMessages?: string[]
  onRemovePending?: (index: number) => void
  dpFocus?: string | null
  dpActive?: boolean
  onSetDpActive?: (active: boolean) => void
  hasMessages?: boolean
  draft?: string | null
  draftSeq?: number
  activePrefix?: PrefixChip | null
  onClearPrefix?: () => void
}

export function InputArea({
  onSend,
  onAbort,
  disabled,
  isLoading,
  contextUsage,
  pendingMessages,
  onRemovePending,
  dpFocus,
  dpActive,
  onSetDpActive,
  hasMessages,
  draft,
  draftSeq,
  activePrefix,
  onClearPrefix,
}: InputAreaProps) {
  const [value, setValue] = useState("")
  const [isFocused, setIsFocused] = useState(false)
  const [isAborting, setIsAborting] = useState(false)
  const isComposingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // When external draft changes, populate input and focus
  useEffect(() => {
    if (draft) {
      setValue(draft)
      setTimeout(() => {
        const el = textareaRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(draft.length, draft.length)
        }
      }, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, draftSeq])

  // Reset aborting state when loading finishes
  useEffect(() => {
    if (!isLoading) setIsAborting(false)
  }, [isLoading])

  const deepInvestigation = dpActive ?? false
  const setDeepInvestigation = onSetDpActive ?? (() => {})

  const [showActionMenu, setShowActionMenu] = useState(false)

  const handleSend = useCallback(async () => {
    const text = value.trim()
    if (disabled) return
    if (!text && !activePrefix) return

    let fullMessage = ""
    if (deepInvestigation) {
      fullMessage += "[Deep Investigation]\n"
    }
    if (activePrefix) {
      fullMessage += activePrefix.fullPrompt
      if (text) fullMessage += `\n\nAdditional direction from user: ${text}`
    } else {
      fullMessage += text
    }

    onSend(fullMessage.trim())
    setValue("")
    onClearPrefix?.()
  }, [value, disabled, onSend, deepInvestigation, activePrefix, onClearPrefix])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Backspace at cursor=0 with active prefix → atomic delete of the pill
      if (e.key === "Backspace" && activePrefix && !isComposingRef.current) {
        const el = textareaRef.current
        if (el && el.selectionStart === 0 && el.selectionEnd === 0) {
          e.preventDefault()
          onClearPrefix?.()
          return
        }
      }
      if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current && !e.nativeEvent.isComposing) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, activePrefix, onClearPrefix],
  )

  const hasContent = value.trim() || !!activePrefix

  return (
    <>
      <div className="w-full px-4 pb-2 z-20 bg-gradient-to-t from-background via-background to-transparent pt-10">
        <div className="max-w-5xl mx-auto">
          <div
            className={cn(
              "relative bg-card rounded-[24px] shadow-lg shadow-black/20 border transition-all duration-200",
              isFocused ? "border-border shadow-xl shadow-black/20" : "border-border",
              disabled && "opacity-60",
            )}
          >
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-4 pt-3 pb-1 min-w-0">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowActionMenu(!showActionMenu)}
                  disabled={disabled}
                  className={cn(
                    "p-1.5 rounded-lg transition-colors disabled:opacity-50",
                    showActionMenu
                      ? "text-muted-foreground bg-secondary"
                      : "text-muted-foreground/70 hover:text-muted-foreground hover:bg-secondary",
                  )}
                  title="Actions"
                >
                  <Plus className="w-4 h-4" />
                </button>

                {showActionMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowActionMenu(false)} />
                    <div className="absolute bottom-full left-0 mb-1 bg-card rounded-xl shadow-xl shadow-black/20 border border-border z-20 w-[220px]">
                      <div className="py-1">
                        {/* Deep Investigation */}
                        <button
                          type="button"
                          onClick={() => setDeepInvestigation(!deepInvestigation)}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-secondary transition-colors"
                        >
                          <SearchCode className="w-4 h-4 text-blue-500 shrink-0" />
                          <span className="flex-1 text-sm text-foreground">Deep Investigation</span>
                          {deepInvestigation && <Check className="w-4 h-4 text-blue-500 shrink-0" />}
                        </button>

                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="ml-auto flex items-center gap-3 shrink-0" />
            </div>

            {/* Mode chips */}
            {deepInvestigation && (
              <div className="flex flex-wrap gap-2 px-4 pb-1">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium bg-blue-500/10 border-blue-500/30 text-blue-400">
                  <SearchCode className="w-3.5 h-3.5 text-blue-500" />
                  <span>Deep Investigation</span>
                  {dpFocus && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 text-[10px] font-semibold uppercase">
                      {dpFocus.replace(/_/g, " ")}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ml-0.5 p-0.5 rounded hover:bg-blue-500/20 transition-colors"
                    onClick={() => setDeepInvestigation(false)}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}

            {/* Prefix chip — canned prompt presented as atomic pill */}
            {activePrefix && (
              <div className="flex flex-wrap gap-2 px-4 pb-1">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium bg-purple-500/10 border-purple-500/30 text-purple-400">
                  <SearchCode className="w-3.5 h-3.5 text-purple-500" />
                  <span>{activePrefix.label}</span>
                  <button
                    type="button"
                    className="ml-0.5 p-0.5 rounded hover:bg-purple-500/20 transition-colors"
                    onClick={() => onClearPrefix?.()}
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}

            {/* Pending steer messages */}
            {pendingMessages && pendingMessages.length > 0 && (
              <div className="flex flex-col gap-1 px-4 pb-1">
                {pendingMessages.map((msg, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-200 text-xs text-amber-400"
                  >
                    <span className="flex-1 truncate">{msg}</span>
                    <button
                      type="button"
                      className="p-0.5 rounded hover:bg-amber-500/100/20 transition-colors shrink-0"
                      onClick={() => onRemovePending?.(i)}
                      title="Remove this instruction"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="relative w-full">
              <textarea
                ref={textareaRef}
                value={value}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false
                }}
                placeholder={
                  disabled
                    ? "Connecting..."
                    : activePrefix?.placeholder ?? "Reply..."
                }
                disabled={disabled}
                className="w-full bg-transparent border-none outline-none px-6 py-3 pr-14 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:ring-0 focus:outline-none resize-none min-h-[48px] max-h-[200px] disabled:cursor-not-allowed"
                rows={1}
                style={{ height: "auto" }}
              />
            </div>

            {isLoading && value.trim() ? (
              <button
                onClick={handleSend}
                className="absolute right-3 bottom-3 p-2 rounded-lg bg-blue-600 text-white shadow-md hover:bg-blue-700 transition-all"
                title="Send steer instruction"
              >
                <ArrowUp className="w-5 h-5" />
              </button>
            ) : isLoading ? (
              <button
                onClick={() => {
                  setIsAborting(true)
                  onAbort?.()
                }}
                className={cn(
                  "absolute right-3 bottom-3 p-2 rounded-lg text-white shadow-md transition-all",
                  isAborting ? "bg-red-400 hover:bg-red-500/100" : "bg-red-500/100 hover:bg-red-600",
                )}
                title={isAborting ? "Stopping..." : "Stop generating"}
              >
                {isAborting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Square className="w-5 h-5" />}
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!hasContent || disabled}
                className={cn(
                  "absolute right-3 bottom-3 p-2 rounded-lg transition-all",
                  hasContent && !disabled
                    ? "bg-blue-600 text-white shadow-md hover:bg-blue-700"
                    : "bg-secondary text-muted-foreground/50 cursor-not-allowed",
                )}
              >
                <ArrowUp className="w-5 h-5" />
              </button>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between px-1">
            <p className="text-xs text-muted-foreground/70">AI may make mistakes. Please verify important information.</p>
            {contextUsage && contextUsage.percent > 0 ? (
              <div className="flex items-center gap-3 text-xs text-muted-foreground/70 font-mono cursor-default">
                <span className="flex items-center gap-0.5" title={`Input: ${contextUsage.inputTokens.toLocaleString()} tokens`}>
                  <ArrowUp className="h-3 w-3" />{formatTokens(contextUsage.inputTokens)}
                </span>
                <span className="flex items-center gap-0.5" title={`Output: ${contextUsage.outputTokens.toLocaleString()} tokens`}>
                  <ArrowDown className="h-3 w-3" />{formatTokens(contextUsage.outputTokens)}
                </span>
                {contextUsage.cost > 0 && <span title="API cost this session">{formatCost(contextUsage.cost)}</span>}
                <span
                  className="flex items-center gap-1"
                  title={`Context: ${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} tokens`}
                >
                  {Math.round(contextUsage.percent)}%
                  <span
                    className={cn(
                      "inline-block w-1.5 h-1.5 rounded-full",
                      contextUsage.percent > 75 ? "bg-red-400" : contextUsage.percent > 50 ? "bg-yellow-400" : "bg-green-400",
                    )}
                  />
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}
