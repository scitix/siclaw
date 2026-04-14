/**
 * Diff components for skill review UI.
 *
 * - DiffBlock: line-by-line diff with context folding (shows ±3 lines around changes)
 * - CollapsibleFileSection: file-level wrapper with added/modified/removed badge
 * - SkillDiffView: top-level component that renders specs + per-script diffs
 *
 * Uses LCS-based diff algorithm; no external dependencies.
 * Dark-theme compatible (uses Tailwind CSS variable colors).
 */

import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, FileText } from "lucide-react"

// ── Diff algorithm ──────────────────────────────────────────────

interface DiffLine {
  type: "add" | "remove" | "unchanged"
  content: string
  lineOld?: number
  lineNew?: number
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.split("\n") : []
  const newLines = newText ? newText.split("\n") : []

  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const result: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "unchanged", content: oldLines[i - 1], lineOld: i, lineNew: j })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", content: newLines[j - 1], lineNew: j })
      j--
    } else {
      result.unshift({ type: "remove", content: oldLines[i - 1], lineOld: i })
      i--
    }
  }

  return result
}

// ── DiffBlock (with context folding) ────────────────────────────

const CONTEXT_LINES = 3

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={`flex ${
        line.type === "add" ? "bg-green-500/10" :
        line.type === "remove" ? "bg-red-500/10" : ""
      }`}
    >
      <span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/40 select-none border-r border-border/30">
        {line.type === "add" ? "" : line.lineOld}
      </span>
      <span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/40 select-none border-r border-border/30">
        {line.type === "remove" ? "" : line.lineNew}
      </span>
      <span className={`w-5 shrink-0 text-center select-none ${
        line.type === "add" ? "text-green-400" :
        line.type === "remove" ? "text-red-400" : "text-muted-foreground/20"
      }`}>
        {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
      </span>
      <span className={`flex-1 whitespace-pre-wrap break-all pr-2 ${
        line.type === "add" ? "text-green-300" :
        line.type === "remove" ? "text-red-300" : ""
      }`}>{line.content || "\u00A0"}</span>
    </div>
  )
}

export function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const diffLines = computeDiff(oldText, newText)
  const [expandedRanges, setExpandedRanges] = useState<Set<number>>(new Set())

  // Find changed line indices
  const changedSet = new Set<number>()
  diffLines.forEach((line, i) => {
    if (line.type !== "unchanged") changedSet.add(i)
  })

  // If few lines or mostly changed, show everything
  if (diffLines.length <= 20 || changedSet.size === 0) {
    return (
      <div className="text-[11px] font-mono max-h-80 overflow-y-auto">
        {diffLines.map((line, i) => <DiffLineRow key={i} line={line} />)}
      </div>
    )
  }

  // Build visible set: changed lines + context
  const visibleSet = new Set<number>()
  for (const idx of changedSet) {
    for (let j = Math.max(0, idx - CONTEXT_LINES); j <= Math.min(diffLines.length - 1, idx + CONTEXT_LINES); j++) {
      visibleSet.add(j)
    }
  }

  // Add expanded ranges
  for (const start of expandedRanges) {
    // Find the end of this collapsed range
    let end = start
    while (end < diffLines.length && !visibleSet.has(end)) end++
    for (let j = start; j < end; j++) visibleSet.add(j)
  }

  // Build chunks
  type Chunk = { type: "lines"; start: number; end: number } | { type: "collapsed"; start: number; end: number }
  const chunks: Chunk[] = []
  let ci = 0
  while (ci < diffLines.length) {
    if (visibleSet.has(ci)) {
      const start = ci
      while (ci < diffLines.length && visibleSet.has(ci)) ci++
      chunks.push({ type: "lines", start, end: ci })
    } else {
      const start = ci
      while (ci < diffLines.length && !visibleSet.has(ci)) ci++
      chunks.push({ type: "collapsed", start, end: ci })
    }
  }

  return (
    <div className="text-[11px] font-mono max-h-80 overflow-y-auto">
      {chunks.map((chunk, ci) => {
        if (chunk.type === "collapsed") {
          const count = chunk.end - chunk.start
          return (
            <button
              key={`c-${chunk.start}`}
              onClick={() => setExpandedRanges(prev => new Set(prev).add(chunk.start))}
              className="w-full flex items-center gap-2 px-2 py-1 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors border-y border-border/30 text-[10px]"
            >
              <ChevronDown className="w-3 h-3" />
              <span>Show {count} hidden line{count > 1 ? "s" : ""}</span>
            </button>
          )
        }
        return diffLines.slice(chunk.start, chunk.end).map((line, j) => (
          <DiffLineRow key={chunk.start + j} line={line} />
        ))
      })}
    </div>
  )
}

// ── Collapsible file section ────────────────────────────────────

interface CollapsibleFileSectionProps {
  title: string
  badge: "added" | "modified" | "removed" | "unchanged"
  defaultOpen?: boolean
  additions?: number
  removals?: number
  children: ReactNode
}

const BADGE_STYLES: Record<string, string> = {
  added: "text-green-400 bg-green-500/15",
  modified: "text-blue-400 bg-blue-500/15",
  removed: "text-red-400 bg-red-500/15",
  unchanged: "text-muted-foreground bg-secondary",
}

export function CollapsibleFileSection({ title, badge, defaultOpen, additions, removals, children }: CollapsibleFileSectionProps) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] font-medium transition-colors ${
          open ? "bg-secondary/50" : "hover:bg-secondary/30"
        }`}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="font-mono">{title}</span>
        <span className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded ${BADGE_STYLES[badge] || BADGE_STYLES.unchanged}`}>
          {badge}
        </span>
        {(additions !== undefined || removals !== undefined) && (
          <span className="text-[10px] text-muted-foreground">
            {additions !== undefined && <span className="text-green-400">+{additions}</span>}
            {removals !== undefined && <span className="text-red-400 ml-1">-{removals}</span>}
          </span>
        )}
      </button>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  )
}

// ── Top-level SkillDiffView ─────────────────────────────────────

interface SkillDiffViewProps {
  diff: {
    specs_diff?: { old: string | null; new: string | null }
    scripts_diff?: { old: string | null; new: string | null }
  } | string | null
}

function parseScriptsList(raw: string | null): { name: string; content: string }[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Decode a string that may have been double-JSON-encoded */
function decodeStr(raw: string | null): string {
  if (!raw) return ""
  let s = raw
  // Unwrap double-encoding: "\"---\\nname:...\"" → "---\nname:..."
  if (s.startsWith('"')) { try { s = JSON.parse(s) } catch {} }
  return s
}

export function SkillDiffView({ diff: rawDiff }: SkillDiffViewProps) {
  if (!rawDiff) return null

  const diff = typeof rawDiff === "string" ? JSON.parse(rawDiff) : rawDiff
  const specsDiff = diff?.specs_diff
  const scriptsDiff = diff?.scripts_diff

  const hasSpecs = specsDiff && (specsDiff.old || specsDiff.new)
  const hasScripts = scriptsDiff && (scriptsDiff.old || scriptsDiff.new)
  if (!hasSpecs && !hasScripts) return null

  // Parse old/new scripts for per-file diffing
  const oldScripts = parseScriptsList(scriptsDiff?.old)
  const newScripts = parseScriptsList(scriptsDiff?.new)

  // Build per-script diff sections
  const allScriptNames = [...new Set([...oldScripts.map(s => s.name), ...newScripts.map(s => s.name)])]
  const scriptSections = allScriptNames.map(name => {
    const oldScript = oldScripts.find(s => s.name === name)
    const newScript = newScripts.find(s => s.name === name)
    const oldContent = oldScript?.content || ""
    const newContent = newScript?.content || ""
    const badge: "added" | "removed" | "modified" | "unchanged" =
      !oldScript ? "added" : !newScript ? "removed" : oldContent !== newContent ? "modified" : "unchanged"

    const lines = computeDiff(oldContent, newContent)
    const additions = lines.filter(l => l.type === "add").length
    const removals = lines.filter(l => l.type === "remove").length

    return { name, badge, oldContent, newContent, additions, removals }
  }).filter(s => s.badge !== "unchanged")

  // Specs diff stats — decode double-encoded strings
  const specsOld = decodeStr(specsDiff?.old)
  const specsNew = decodeStr(specsDiff?.new)
  const specsLines = hasSpecs ? computeDiff(specsOld, specsNew) : []
  const specsAdded = specsLines.filter(l => l.type === "add").length
  const specsRemoved = specsLines.filter(l => l.type === "remove").length
  const specsBadge: "added" | "modified" | "removed" = !specsDiff?.old ? "added" : !specsDiff?.new ? "removed" : "modified"

  const totalFiles = (hasSpecs ? 1 : 0) + scriptSections.length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>{totalFiles} file{totalFiles > 1 ? "s" : ""} changed</span>
      </div>

      {hasSpecs && (
        <CollapsibleFileSection
          title="SKILL.md"
          badge={specsBadge}
          defaultOpen={totalFiles <= 3}
          additions={specsAdded}
          removals={specsRemoved}
        >
          <DiffBlock oldText={specsOld} newText={specsNew} />
        </CollapsibleFileSection>
      )}

      {scriptSections.map((s, i) => (
        <CollapsibleFileSection
          key={s.name}
          title={`scripts/${s.name}`}
          badge={s.badge}
          defaultOpen={i === 0 && !hasSpecs}
          additions={s.additions}
          removals={s.removals}
        >
          <DiffBlock oldText={s.oldContent} newText={s.newContent} />
        </CollapsibleFileSection>
      ))}
    </div>
  )
}

// Keep backward compat export
export function SimpleDiff({ oldText, newText, oldLabel }: { oldText: string | null; newText: string | null; oldLabel?: string }) {
  if (!oldText && !newText) return null
  if (!oldText && newText) {
    return (
      <CollapsibleFileSection title={oldLabel || "file"} badge="added" defaultOpen additions={newText.split("\n").length} removals={0}>
        <DiffBlock oldText="" newText={newText} />
      </CollapsibleFileSection>
    )
  }
  return (
    <CollapsibleFileSection title={oldLabel || "file"} badge="modified" defaultOpen>
      <DiffBlock oldText={oldText || ""} newText={newText || ""} />
    </CollapsibleFileSection>
  )
}
