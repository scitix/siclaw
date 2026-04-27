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
    <div className="flex gap-2 flex-row items-start">
      <AlertTriangle className="w-3.5 h-3.5 mt-1.5 shrink-0 text-red-500/80 dark:text-red-400/80" />
      <div
        className={cn(
          "rounded-lg border border-red-300/40 bg-red-50/40 dark:bg-red-950/20 dark:border-red-900/40",
          "px-3 py-1.5 max-w-3xl",
        )}
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm text-red-700 dark:text-red-300/90 break-words">
            {detail.message}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-red-600/60 dark:text-red-400/50 shrink-0">
            {detail.code}
          </span>
          {detail.requestId && (
            <span className="font-mono text-[10px] text-red-600/40 dark:text-red-400/30 shrink-0">
              {detail.requestId.slice(0, 8)}
            </span>
          )}
          {detail.retriable && onRetry && (
            <button
              onClick={onRetry}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          )}
          {hasDetails && (
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="inline-flex items-center text-[10px] text-red-600/60 dark:text-red-400/50 hover:text-red-800 dark:hover:text-red-200"
            >
              {showDetails ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </button>
          )}
        </div>
        {showDetails && hasDetails && (
          <pre className="mt-1 overflow-auto rounded bg-red-100/30 dark:bg-red-950/40 p-1.5 text-[10px] text-red-900/80 dark:text-red-200/70 font-mono whitespace-pre-wrap break-all">
            {typeof detail.details === "string"
              ? detail.details
              : JSON.stringify(detail.details, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}
