import { useState } from "react"
import { FileText, X, ZoomIn, ZoomOut } from "lucide-react"
import { cn } from "./cn"
import type { ChatAttachment } from "./types"

interface ImageAttachmentPreviewProps {
  attachments: ChatAttachment[]
  className?: string
  tileClassName?: string
  imageClassName?: string
  onRemove?: (index: number) => void
}

export function ImageAttachmentPreview({
  attachments,
  className,
  tileClassName,
  imageClassName,
  onRemove,
}: ImageAttachmentPreviewProps) {
  const items = attachments.map((attachment, index) => ({ attachment, index }))
  const [preview, setPreview] = useState<ChatAttachment | null>(null)
  const [zoomed, setZoomed] = useState(false)

  if (items.length === 0) return null

  const previewSrc = preview ? imageSrc(preview) : ""

  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {items.map(({ attachment, index }) => (
          <div key={`${attachment.filename}-${index}`} className="relative">
            {attachment.kind === "image" ? (
              <div
                className={cn(
                  "relative overflow-hidden rounded-md border border-blue-500/30 bg-blue-500/10 shadow-sm shadow-black/10",
                  tileClassName,
                )}
              >
                <button
                  type="button"
                  className="block h-full w-full bg-background/70"
                  onClick={() => {
                    setPreview(attachment)
                    setZoomed(false)
                  }}
                  title="Preview image"
                >
                  <img
                    src={imageSrc(attachment)}
                    alt="Pasted image preview"
                    className={cn("h-full w-full object-contain", imageClassName)}
                  />
                </button>
              </div>
            ) : (
              <div className="flex h-[64px] w-[min(360px,calc(100vw-64px))] items-center gap-3 rounded-2xl border border-border bg-background/90 px-3 pr-9 text-left shadow-sm shadow-black/5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground" title={attachment.filename}>
                    {attachment.filename}
                  </div>
                  <div className="mt-0.5 text-xs font-medium uppercase text-muted-foreground">
                    PDF
                  </div>
                </div>
              </div>
            )}
            {onRemove && (
              <button
                type="button"
                className="absolute right-1 top-1 rounded bg-black/55 p-0.5 text-white shadow-sm transition-colors hover:bg-black/75"
                onClick={() => onRemove(index)}
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/78 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <div className="absolute right-5 top-5 flex items-center gap-2">
            <button
              type="button"
              className="rounded-full bg-white/12 p-2 text-white shadow-sm transition-colors hover:bg-white/20"
              onClick={(e) => {
                e.stopPropagation()
                setZoomed((value) => !value)
              }}
              title={zoomed ? "Fit to screen" : "View actual size"}
            >
              {zoomed ? <ZoomOut className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />}
            </button>
            <button
              type="button"
              className="rounded-full bg-white/12 p-2 text-white shadow-sm transition-colors hover:bg-white/20"
              onClick={(e) => {
                e.stopPropagation()
                setPreview(null)
              }}
              title="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div
            className="max-h-[88vh] max-w-[94vw] overflow-auto rounded-md bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewSrc}
              alt="Pasted image preview"
              className={cn(
                "block bg-white",
                zoomed
                  ? "h-auto max-h-none max-w-none cursor-zoom-out"
                  : "max-h-[88vh] max-w-[94vw] cursor-zoom-in object-contain",
              )}
              onClick={() => setZoomed((value) => !value)}
            />
          </div>
        </div>
      )}
    </>
  )
}

function imageSrc(attachment: ChatAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`
}
