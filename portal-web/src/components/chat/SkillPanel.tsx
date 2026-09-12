import { useSkillPreview } from "../../lib/useSkillPreview"
import { useState } from "react"
import { X, BookOpen, Tag, ChevronRight, FileText, Terminal, FileCode, Copy, Check } from "lucide-react"
import { cn } from "./cn"
import type { PilotMessage } from "./types"
import { type SkillPreviewData } from "../../lib/skillPreview"

function CopyButton({ text, name }: { text: string; name: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      aria-label={`Copy ${name}`}
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground/70 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 text-green-500" />
          <span className="text-green-600">Copied</span>
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" />
          Copy
        </>
      )}
    </button>
  )
}

function getFileIcon(name: string) {
  if (name === "SKILL.md") return <FileText className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
  if (name.endsWith(".py")) return <FileCode className="w-3.5 h-3.5 text-blue-500 shrink-0" />
  if (name.endsWith(".sh")) return <Terminal className="w-3.5 h-3.5 text-green-500 shrink-0" />
  return <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
}

function FileEntry({
  name,
  content,
  meta,
  defaultExpanded,
  binary = false,
}: {
  name: string
  content: string
  meta?: string
  defaultExpanded?: boolean
  binary?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false)

  return (
    <div className="border-t border-border/50">
      <div className="flex items-center gap-2 px-4 hover:bg-secondary transition-colors">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex items-center gap-2 flex-1 min-w-0 py-2 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight
            className={cn(
              "w-3 h-3 text-muted-foreground/70 transition-transform shrink-0",
              expanded && "rotate-90",
            )}
          />
          {getFileIcon(name)}
          <span className="text-xs font-mono text-foreground truncate">{name}</span>
          {meta && <span className="text-[10px] text-muted-foreground shrink-0">{meta}</span>}
        </button>
        {!binary && <CopyButton text={content} name={name} />}
      </div>
      {expanded && (
        <div className="px-4 pb-3">
          <pre className="text-xs font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap bg-secondary rounded p-3 max-h-[40vh] overflow-y-auto">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}

function decodeSkillPanelFile(file: NonNullable<SkillPreviewData["files"]>[number]): { content: string; meta?: string } {
  if (file.encoding === "base64") {
    return {
      content: `Binary file${file.size ? ` (${file.size} bytes)` : ""}: text preview and copy are unavailable.`,
      meta: "binary",
    }
  }
  return { content: file.content, meta: file.size ? `${file.size}B` : undefined }
}

export interface SkillPanelProps {
  message: PilotMessage
  onClose: () => void
  detailUrl?: string
}

export function SkillPanel({ message, onClose, detailUrl }: SkillPanelProps) {
  const { skill, notice, loading, error, retry } = useSkillPreview(message, detailUrl)

  if (!skill) {
    return (
      <div className="w-[480px] border-l border-border bg-card flex flex-col shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm text-muted-foreground">Skill preview unavailable</span>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-secondary">
            <X className="w-4 h-4 text-muted-foreground/70" />
          </button>
        </div>
        <p className="px-4 py-3 text-sm text-muted-foreground">{loading ? "Loading preview…" : notice?.status === "omitted" ? "The full preview could not be saved within the storage or redaction limits. Generate a smaller preview." : error ? "Could not load the preview. Try again." : "Ask the agent to generate the preview again."}</p>
        {error && <button type="button" onClick={retry}>Retry</button>}
      </div>
    )
  }

  const files: Array<{ name: string; content: string; meta?: string; binary?: boolean }> = Array.isArray(skill.files) && skill.files.length > 0
    ? skill.files
      .map(file => {
        const decoded = decodeSkillPanelFile(file)
        return { name: file.path, content: decoded.content, meta: decoded.meta, binary: file.encoding === "base64" }
      })
      .sort((a, b) => {
        if (a.name === b.name) return 0
        if (a.name === "SKILL.md") return -1
        if (b.name === "SKILL.md") return 1
        return a.name.localeCompare(b.name)
      })
    : [
      ...(skill.specs ? [{ name: "SKILL.md", content: skill.specs }] : []),
      ...(skill.scripts ?? []).map(s => ({ name: `scripts/${s.name}`, content: s.content })),
    ]

  return (
    <div className="w-[480px] border-l border-border bg-card flex flex-col shrink-0 h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-gradient-to-r from-indigo-50 to-purple-50 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="w-4 h-4 text-indigo-600 shrink-0" />
          <span className="font-semibold text-sm text-foreground truncate">{skill.name}</span>
          {skill.type && skill.type !== "Custom" && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-500/15 text-indigo-400 shrink-0">
              <Tag className="w-2.5 h-2.5" />
              {skill.type}
            </span>
          )}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-card/60 transition-colors shrink-0">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {skill.description && (
        <div className="px-4 py-2 border-b border-border/50 text-xs text-muted-foreground">{skill.description}</div>
      )}

      {/* File list */}
      <div className="overflow-y-auto flex-1">
        {files.map((f, i) => (
          <FileEntry key={f.name} name={f.name} content={f.content} meta={f.meta} binary={f.binary} defaultExpanded={i === 0} />
        ))}
      </div>
    </div>
  )
}
