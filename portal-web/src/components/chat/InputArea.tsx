import { ArrowUp, ArrowDown, Square, X, Loader2, SearchCode, Plus, Check, ArrowRight, PencilLine, FileText, Paperclip } from "lucide-react"
import type { ChatAttachment, ContextUsage, PrefixActionChip } from "./types"
import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react"
import type { ClipboardEvent, KeyboardEvent } from "react"
import { cn } from "./cn"
import { ImageAttachmentPreview } from "./ImageAttachmentPreview"
import { useToast } from "../toast"

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

interface InputAreaProps {
  onSend: (message: string, attachments?: ChatAttachment[]) => void
  onAbort?: () => void
  disabled?: boolean
  isLoading?: boolean
  contextUsage?: ContextUsage | null
  pendingMessages?: string[]
  onRemovePending?: (index: number) => void
  dpActive?: boolean
  onSetDpActive?: (active: boolean) => void
  hasMessages?: boolean
  draft?: string | null
  draftSeq?: number
  historyMessages?: string[]
  activePrefix?: PrefixActionChip | null
  onClearPrefix?: () => void
}

const MAX_PASTED_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_PASTED_PDF_BYTES = 6 * 1024 * 1024
const MAX_ATTACHMENTS = 4
const ACCEPTED_ATTACHMENT_TYPES = ".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? "")
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value)
    }
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment"))
    reader.readAsDataURL(file)
  })
}

function pastedImageName(file: File, index: number): string {
  if (file.name) return file.name
  const ext = file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png"
  return `pasted-image-${index + 1}.${ext}`
}

function pastedPdfName(file: File, index: number): string {
  return file.name || `pasted-document-${index + 1}.pdf`
}

function normalizedAttachmentMimeType(file: File): string {
  const mimeType = file.type.toLowerCase()
  if (mimeType === "application/pdf" || SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return mimeType

  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith(".pdf")) return "application/pdf"
  if (lowerName.endsWith(".png")) return "image/png"
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg"
  if (lowerName.endsWith(".webp")) return "image/webp"
  return mimeType
}

function isSupportedPastedFile(file: File): boolean {
  const mimeType = normalizedAttachmentMimeType(file)
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || mimeType === "application/pdf"
}

export function InputArea({
  onSend,
  onAbort,
  disabled,
  isLoading,
  contextUsage,
  pendingMessages,
  onRemovePending,
  dpActive,
  onSetDpActive,
  hasMessages,
  draft,
  draftSeq,
  historyMessages = [],
  activePrefix,
  onClearPrefix,
}: InputAreaProps) {
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [isFocused, setIsFocused] = useState(false)
  const [isAborting, setIsAborting] = useState(false)
  const toast = useToast()
  const isComposingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const historyCursorRef = useRef<number | null>(null)
  const draftBeforeHistoryRef = useRef("")

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const maxHeight = Math.min(320, Math.max(180, Math.floor(window.innerHeight * 0.36)))
    el.style.height = "auto"
    const nextHeight = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${nextHeight}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [value, activePrefix, pendingMessages])

  // When external draft changes, populate input and focus
  useEffect(() => {
    if (draft) {
      historyCursorRef.current = null
      draftBeforeHistoryRef.current = draft
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

  const addFiles = useCallback((files: File[]) => {
    const supportedFiles = files.filter(isSupportedPastedFile)
    if (supportedFiles.length === 0) {
      if (files.length > 0) toast.error("Only PNG, JPEG, WebP, and PDF attachments are supported.")
      return
    }
    const unsupportedCount = files.length - supportedFiles.length
    if (unsupportedCount > 0) {
      toast.error(`${unsupportedCount} unsupported attachment${unsupportedCount === 1 ? "" : "s"} skipped.`)
    }

    void Promise.allSettled(supportedFiles.map(async (file, index) => {
      const mimeType = normalizedAttachmentMimeType(file)
      const isPdf = mimeType === "application/pdf"
      const filename = isPdf ? pastedPdfName(file, index) : pastedImageName(file, index)
      const maxBytes = isPdf ? MAX_PASTED_PDF_BYTES : MAX_PASTED_IMAGE_BYTES
      if (file.size > maxBytes) {
        throw new Error(`${filename} is too large`)
      }
      return {
        kind: isPdf ? "pdf" as const : "image" as const,
        filename,
        mimeType,
        data: await readFileBase64(file),
      }
    }))
      .then((results) => {
        const next: ChatAttachment[] = []
        const errors: string[] = []
        for (const result of results) {
          if (result.status === "fulfilled") {
            next.push(result.value)
          } else {
            errors.push(result.reason instanceof Error ? result.reason.message : "Failed to read attachment")
          }
        }
        if (next.length > 0) {
          const availableSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length)
          const accepted = next.slice(0, availableSlots)
          const skipped = next.length - accepted.length
          if (skipped > 0) {
            toast.error(`Attachment limit is ${MAX_ATTACHMENTS}; ${skipped} file${skipped === 1 ? "" : "s"} skipped.`)
          }
          if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS))
        }
        for (const error of errors) toast.error(error)
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Failed to read attachment")
      })
  }, [attachments.length, toast])

  const handleSend = useCallback(async () => {
    const text = value.trim()
    if (disabled) return
    if (!text && !activePrefix && attachments.length === 0) return

    let fullMessage = ""
    if (deepInvestigation) {
      fullMessage += "[Deep Investigation]\n"
    }
    if (activePrefix) {
      // Prepend a chip marker so the frontend can re-derive which chip was
      // used when rendering past messages (hiding the long fullPrompt), and
      // the backend can strip it before forwarding to the agent.
      fullMessage += `[${activePrefix.label}]\n`
      fullMessage += activePrefix.fullPrompt
      if (text) fullMessage += `\n\nAdditional direction from user: ${text}`
    } else {
      fullMessage += text
    }

    onSend(fullMessage.trim(), attachments.length > 0 ? attachments : undefined)
    setValue("")
    setAttachments([])
    historyCursorRef.current = null
    draftBeforeHistoryRef.current = ""
    onClearPrefix?.()
  }, [value, disabled, onSend, deepInvestigation, activePrefix, onClearPrefix, attachments])

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file)
      .filter(isSupportedPastedFile)

    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }, [addFiles])

  const navigateHistory = useCallback(
    (direction: "previous" | "next") => {
      if (activePrefix || historyMessages.length === 0) return false

      const current = historyCursorRef.current
      if (direction === "previous") {
        const next = current == null ? historyMessages.length - 1 : Math.max(0, current - 1)
        if (current == null) draftBeforeHistoryRef.current = value
        historyCursorRef.current = next
        setValue(historyMessages[next] ?? "")
      } else {
        if (current == null) return false
        if (current >= historyMessages.length - 1) {
          historyCursorRef.current = null
          setValue(draftBeforeHistoryRef.current)
        } else {
          const next = current + 1
          historyCursorRef.current = next
          setValue(historyMessages[next] ?? "")
        }
      }

      setTimeout(() => {
        const el = textareaRef.current
        if (!el) return
        const end = el.value.length
        el.focus()
        el.setSelectionRange(end, end)
      }, 0)
      return true
    },
    [activePrefix, historyMessages, value],
  )

  const resetHistoryNavigation = useCallback((nextValue: string) => {
    historyCursorRef.current = null
    draftBeforeHistoryRef.current = nextValue
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const isPlainArrow =
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isComposingRef.current &&
        !e.nativeEvent.isComposing

      if (isPlainArrow) {
        const el = textareaRef.current
        if (el && el.selectionStart === el.selectionEnd) {
          const beforeCursor = el.value.slice(0, el.selectionStart)
          const afterCursor = el.value.slice(el.selectionEnd)
          const atFirstLine = !beforeCursor.includes("\n")
          const atLastLine = !afterCursor.includes("\n")
          const didNavigate =
            e.key === "ArrowUp"
              ? atFirstLine && navigateHistory("previous")
              : atLastLine && navigateHistory("next")
          if (didNavigate) {
            e.preventDefault()
            return
          }
        }
      }

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
    [handleSend, activePrefix, onClearPrefix, navigateHistory],
  )

  const hasContent = !!value.trim() || !!activePrefix || attachments.length > 0

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
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_ATTACHMENT_TYPES}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? [])
                    if (files.length > 0) addFiles(files)
                    e.currentTarget.value = ""
                  }}
                />
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
                        <button
                          type="button"
                          onClick={() => {
                            setShowActionMenu(false)
                            fileInputRef.current?.click()
                          }}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-secondary transition-colors"
                        >
                          <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="flex-1 text-sm text-foreground">Add photos & files</span>
                        </button>

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

              {/* Deep Investigation active indicator — only rendered when DP is on.
                  Activation stays in the `+` menu to prevent accidental enable;
                  clicking this icon turns DP off. */}
              {deepInvestigation && (
                <button
                  type="button"
                  onClick={() => setDeepInvestigation(false)}
                  disabled={disabled}
                  className="p-1.5 rounded-lg transition-colors disabled:opacity-50 text-blue-500 bg-blue-500/15 hover:bg-blue-500/25"
                  title="Deep Investigation on (click to turn off)"
                >
                  <SearchCode className="w-4 h-4" />
                </button>
              )}

              <div className="ml-auto flex items-center gap-3 shrink-0" />
            </div>


            {/* Prefix chip — canned prompt presented as atomic pill */}
            {activePrefix && (
              <div className="flex flex-wrap gap-2 px-4 pb-1">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium bg-purple-500/10 border-purple-500/30 text-purple-400">
                  <PrefixChipIcon chip={activePrefix} />
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

            {attachments.length > 0 && (
              <ImageAttachmentPreview
                attachments={attachments}
                className="px-4 pb-2"
                tileClassName="h-28 w-44"
                onRemove={(idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
              />
            )}

            <div className="relative w-full">
              <textarea
                ref={textareaRef}
                value={value}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onChange={(e) => {
                  setValue(e.target.value)
                  resetHistoryNavigation(e.target.value)
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
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
                className="w-full bg-transparent border-none outline-none px-6 py-3 pr-14 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:ring-0 focus:outline-none resize-none min-h-[48px] disabled:cursor-not-allowed"
                rows={1}
                style={{ height: "auto", overflowY: "hidden" }}
              />
            </div>

            {isLoading && (value.trim() || attachments.length > 0 || activePrefix) ? (
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
