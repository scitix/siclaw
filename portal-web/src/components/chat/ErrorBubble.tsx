import { useState } from "react"
import { AlertTriangle, RefreshCw, ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "./cn"
import type { ErrorDetail } from "./types"

/** Inline chat bubble for an error envelope. See docs/design/error-envelope.md. */
export function ErrorBubble({
  detail,
  onRetry,
}: {
  detail: ErrorDetail
  onRetry?: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const hasDetails = detail.details !== undefined && detail.details !== null

  return (
    <div className="flex gap-4 flex-row">
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm shadow-black/10 border bg-red-50 border-red-200 text-red-500">
        <AlertTriangle className="w-4 h-4" />
      </div>
      <div
        className={cn(
          "flex-1 min-w-0 rounded-2xl border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900",
          "px-4 py-3 shadow-sm shadow-black/10 max-w-3xl",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] leading-relaxed text-red-900 dark:text-red-200 break-words">
              {detail.message}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-red-700/80 dark:text-red-300/70">
              <span className="font-mono">{detail.code}</span>
              {detail.requestId && (
                <span className="font-mono opacity-70" title="Copy request id for support">
                  · {detail.requestId.slice(0, 8)}
                </span>
              )}
            </div>
          </div>
          {detail.retriable && onRetry && (
            <button
              onClick={onRetry}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 rounded-lg",
                "px-2.5 py-1.5 text-xs font-medium",
                "bg-red-600 text-white hover:bg-red-700",
                "dark:bg-red-700 dark:hover:bg-red-600",
                "transition-colors",
              )}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          )}
        </div>
        {hasDetails && (
          <div className="mt-2 border-t border-red-200/70 dark:border-red-900/70 pt-2">
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-red-700/80 dark:text-red-300/70 hover:text-red-900 dark:hover:text-red-200"
            >
              {showDetails ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              Details
            </button>
            {showDetails && (
              <pre className="mt-1.5 overflow-auto rounded-md bg-red-100/60 dark:bg-red-950/60 p-2 text-[11px] text-red-900/90 dark:text-red-200/80 font-mono whitespace-pre-wrap break-all">
                {typeof detail.details === "string"
                  ? detail.details
                  : JSON.stringify(detail.details, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
