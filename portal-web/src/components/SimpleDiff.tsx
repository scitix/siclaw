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

import { useEffect, useId, useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, FileText, Folder, Search } from "lucide-react"

// ── Diff algorithm ──────────────────────────────────────────────

interface DiffLine {
  type: "add" | "remove" | "unchanged"
  content: string
  lineOld?: number
  lineNew?: number
}

export function computeDiff(oldText: string, newText: string): DiffLine[] {
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
        line.type === "add" ? "text-green-700 dark:text-green-300" :
        line.type === "remove" ? "text-red-700 dark:text-red-300" : "text-muted-foreground/20"
      }`}>
        {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
      </span>
      <span className={`flex-1 whitespace-pre-wrap break-all pr-2 ${
        line.type === "add" ? "text-green-800 dark:text-green-200" :
        line.type === "remove" ? "text-red-800 dark:text-red-200" : ""
      }`}>{line.content || "\u00A0"}</span>
    </div>
  )
}

export function DiffBlock({ oldText, newText, maxHeightClassName = "max-h-80" }: { oldText: string; newText: string; maxHeightClassName?: string }) {
  const diffLines = computeDiff(oldText, newText)
  const [expandedRanges, setExpandedRanges] = useState<Set<number>>(new Set())
  const containerClassName = `text-[11px] font-mono ${maxHeightClassName} ${maxHeightClassName ? "overflow-y-auto" : ""}`

  // Find changed line indices
  const changedSet = new Set<number>()
  diffLines.forEach((line, i) => {
    if (line.type !== "unchanged") changedSet.add(i)
  })

  // If few lines or mostly changed, show everything
  if (diffLines.length <= 20 || changedSet.size === 0) {
    return (
      <div className={containerClassName}>
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
    <div className={containerClassName}>
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
  id?: string
  title: string
  badge: "added" | "modified" | "removed" | "unchanged"
  defaultOpen?: boolean
  additions?: number
  removals?: number
  stickyHeader?: boolean
  bodyClassName?: string
  children: ReactNode
}

const BADGE_STYLES: Record<string, string> = {
  added: "text-green-400 bg-green-500/15",
  modified: "text-blue-400 bg-blue-500/15",
  removed: "text-red-400 bg-red-500/15",
  unchanged: "text-muted-foreground bg-secondary",
}

export function CollapsibleFileSection({ id, title, badge, defaultOpen, additions, removals, stickyHeader, bodyClassName, children }: CollapsibleFileSectionProps) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <div id={id} className="border border-border rounded-md overflow-hidden bg-card">
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] font-medium transition-colors ${
          stickyHeader ? "sticky top-0 z-10" : ""
        } ${
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
      {open && <div className={`border-t border-border ${bodyClassName ?? ""}`}>{children}</div>}
    </div>
  )
}

// ── Top-level SkillDiffView ─────────────────────────────────────

type FileDiffBadge = "added" | "modified" | "removed" | "unchanged"

interface FileDiffValue {
  old: string | null
  new: string | null
  encoding?: string
}

export interface SkillDiffPayload {
  specs_diff?: { old: string | null; new: string | null }
  scripts_diff?: { old: string | null; new: string | null }
  files_diff?: Record<string, FileDiffValue>
}

interface SkillDiffViewProps {
  diff: {
    specs_diff?: { old: string | null; new: string | null }
    scripts_diff?: { old: string | null; new: string | null }
    files_diff?: Record<string, { old: string | null; new: string | null; encoding?: string }>
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
export function decodeStr(raw: string | null): string {
  if (!raw) return ""
  let s = raw
  // Unwrap double-encoding: "\"---\\nname:...\"" → "---\nname:..."
  if (s.startsWith('"')) { try { s = JSON.parse(s) } catch {} }
  return s
}

interface FileDiffSection {
  path: string
  badge: FileDiffBadge
  oldContent: string
  newContent: string
  additions: number
  removals: number
  binary: boolean
}

interface DiffTreeNode {
  name: string
  path: string
  type: "file" | "dir"
  section?: FileDiffSection
  children: DiffTreeNode[]
}

function parseDiff(rawDiff: SkillDiffViewProps["diff"]): SkillDiffPayload | null {
  if (!rawDiff) return null
  if (typeof rawDiff !== "string") return rawDiff
  try { return JSON.parse(rawDiff) } catch { return null }
}

function badgeForValue(value: FileDiffValue, oldContent: string, newContent: string): FileDiffBadge {
  if (value.old === null || value.old === undefined) return "added"
  if (value.new === null || value.new === undefined) return "removed"
  return oldContent !== newContent ? "modified" : "unchanged"
}

function sectionFromTexts(path: string, oldContent: string, newContent: string, badge: FileDiffBadge, binary = false): FileDiffSection {
  if (binary) return { path, badge, oldContent: "", newContent: "", additions: 0, removals: 0, binary }
  const lines = computeDiff(oldContent, newContent)
  return {
    path,
    badge,
    oldContent,
    newContent,
    additions: lines.filter(l => l.type === "add").length,
    removals: lines.filter(l => l.type === "remove").length,
    binary,
  }
}

function fileSectionsFromDiff(diff: SkillDiffPayload): FileDiffSection[] {
  const filesDiff = diff?.files_diff
  if (filesDiff) {
    return (Object.entries(filesDiff) as Array<[string, FileDiffValue]>)
      .map(([path, value]) => {
        const binary = value.encoding === "base64"
        const oldContent = binary ? "" : decodeStr(value.old)
        const newContent = binary ? "" : decodeStr(value.new)
        const badge = badgeForValue(value, oldContent, newContent)
        return sectionFromTexts(path, oldContent, newContent, badge, binary)
      })
      .filter(s => s.badge !== "unchanged")
  }

  const specsDiff = diff?.specs_diff
  const scriptsDiff = diff?.scripts_diff
  const sections: FileDiffSection[] = []

  if (specsDiff && (specsDiff.old || specsDiff.new)) {
    const oldContent = decodeStr(specsDiff.old)
    const newContent = decodeStr(specsDiff.new)
    const badge: FileDiffBadge = !specsDiff.old ? "added" : !specsDiff.new ? "removed" : oldContent !== newContent ? "modified" : "unchanged"
    if (badge !== "unchanged") sections.push(sectionFromTexts("SKILL.md", oldContent, newContent, badge))
  }

  if (scriptsDiff && (scriptsDiff.old || scriptsDiff.new)) {
    const oldScripts = parseScriptsList(scriptsDiff.old)
    const newScripts = parseScriptsList(scriptsDiff.new)
    const allScriptNames = [...new Set([...oldScripts.map(s => s.name), ...newScripts.map(s => s.name)])]
    for (const name of allScriptNames) {
      const oldScript = oldScripts.find(s => s.name === name)
      const newScript = newScripts.find(s => s.name === name)
      const oldContent = oldScript?.content || ""
      const newContent = newScript?.content || ""
      const badge: FileDiffBadge = !oldScript ? "added" : !newScript ? "removed" : oldContent !== newContent ? "modified" : "unchanged"
      if (badge !== "unchanged") sections.push(sectionFromTexts(`scripts/${name}`, oldContent, newContent, badge))
    }
  }

  return sections
}

function buildDiffTree(sections: FileDiffSection[]): DiffTreeNode[] {
  const root: DiffTreeNode = { name: "", path: "", type: "dir", children: [] }
  const dirMap = new Map<string, DiffTreeNode>([["", root]])
  const ensureDir = (dirPath: string) => {
    if (!dirPath) return root
    const parts = dirPath.split("/")
    let current = root
    let currentPath = ""
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let dir = dirMap.get(currentPath)
      if (!dir) {
        dir = { name: part, path: currentPath, type: "dir", children: [] }
        dirMap.set(currentPath, dir)
        current.children.push(dir)
      }
      current = dir
    }
    return current
  }

  for (const section of sections) {
    const idx = section.path.lastIndexOf("/")
    const dir = ensureDir(idx >= 0 ? section.path.slice(0, idx) : "")
    dir.children.push({
      name: idx >= 0 ? section.path.slice(idx + 1) : section.path,
      path: section.path,
      type: "file",
      section,
      children: [],
    })
  }

  const sortNodes = (nodes: DiffTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.path === "SKILL.md") return -1
      if (b.path === "SKILL.md") return 1
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach(n => sortNodes(n.children))
  }
  sortNodes(root.children)
  return root.children
}

const STATUS_LABELS: Record<FileDiffBadge, string> = {
  added: "A",
  modified: "M",
  removed: "D",
  unchanged: "U",
}

const STATUS_TEXT: Record<FileDiffBadge, string> = {
  added: "Added",
  modified: "Modified",
  removed: "Deleted",
  unchanged: "Unchanged",
}

function statusClassName(badge: FileDiffBadge) {
  if (badge === "added") return "text-green-700 bg-green-500/10 border-green-500/20 dark:text-green-300"
  if (badge === "removed") return "text-red-700 bg-red-500/10 border-red-500/20 dark:text-red-300"
  if (badge === "modified") return "text-blue-700 bg-blue-500/10 border-blue-500/20 dark:text-blue-300"
  return "text-muted-foreground bg-secondary border-border"
}

function DiffSummary({ sections }: { sections: FileDiffSection[] }) {
  const additions = sections.reduce((sum, s) => sum + s.additions, 0)
  const removals = sections.reduce((sum, s) => sum + s.removals, 0)
  return (
    <div className="h-10 px-3 border-b border-border flex items-center gap-3 shrink-0 bg-card">
      <span className="text-[12px] font-medium">{sections.length} file{sections.length === 1 ? "" : "s"} changed</span>
      <span className="text-[11px] text-green-700 dark:text-green-300">+{additions}</span>
      <span className="text-[11px] text-red-700 dark:text-red-300">-{removals}</span>
      <span className="ml-auto hidden sm:inline text-[11px] text-muted-foreground">Unified diff</span>
    </div>
  )
}

function BinaryDiffNotice({ section }: { section: FileDiffSection }) {
  return (
    <div className="px-4 py-8 text-center text-[12px] text-muted-foreground bg-secondary/20">
      Binary file {STATUS_TEXT[section.badge].toLowerCase()}.
    </div>
  )
}

interface PackageDiffViewProps {
  diff: SkillDiffViewProps["diff"]
  compact?: boolean
  className?: string
  emptyMessage?: string
}

export function PackageDiffView({ diff: rawDiff, compact = false, className = "", emptyMessage = "No file changes to show." }: PackageDiffViewProps) {
  const parsedDiff = useMemo(() => parseDiff(rawDiff), [rawDiff])
  const sections = useMemo(() => parsedDiff ? fileSectionsFromDiff(parsedDiff) : [], [parsedDiff])
  const [query, setQuery] = useState("")
  const [activePath, setActivePath] = useState("")
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "")

  useEffect(() => {
    if (!sections.some(s => s.path === activePath)) {
      setActivePath(sections[0]?.path ?? "")
    }
  }, [sections, activePath])

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sections
    return sections.filter(s => s.path.toLowerCase().includes(q))
  }, [sections, query])
  const tree = useMemo(() => buildDiffTree(filteredSections), [filteredSections])

  const sectionId = (path: string) => `${idPrefix}-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`
  const jumpToFile = (path: string) => {
    setActivePath(path)
    requestAnimationFrame(() => document.getElementById(sectionId(path))?.scrollIntoView({ block: "start", behavior: "smooth" }))
  }

  const renderTree = (nodes: DiffTreeNode[], depth = 0): ReactNode => nodes.map(node => {
    if (node.type === "dir") {
      return (
        <div key={node.path}>
          <div className="h-7 flex items-center gap-1.5 text-[12px] text-muted-foreground font-mono" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span className="truncate">{node.name}</span>
          </div>
          {renderTree(node.children, depth + 1)}
        </div>
      )
    }
    const section = node.section!
    const active = activePath === section.path
    return (
      <button
        key={node.path}
        type="button"
        onClick={() => jumpToFile(section.path)}
        className={`w-full h-7 flex items-center gap-1.5 rounded px-1.5 text-left text-[12px] font-mono transition-colors ${
          active ? "bg-primary/10 text-foreground ring-1 ring-primary/20" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={section.path}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
        <span className={`ml-auto shrink-0 rounded border px-1 py-0.5 text-[9px] leading-none ${statusClassName(section.badge)}`}>
          {STATUS_LABELS[section.badge]}
        </span>
      </button>
    )
  })

  if (sections.length === 0) {
    return (
      <div className={`rounded-lg border border-border bg-card px-4 py-8 text-center text-[12px] text-muted-foreground ${className}`}>
        {emptyMessage}
      </div>
    )
  }

  const renderSection = (section: FileDiffSection, i: number, full = false) => (
    <CollapsibleFileSection
      key={section.path}
      id={full ? sectionId(section.path) : undefined}
      title={section.path}
      badge={section.badge}
      defaultOpen={i === 0 || sections.length <= 3}
      additions={section.additions}
      removals={section.removals}
      stickyHeader={full}
    >
      {section.binary ? (
        <BinaryDiffNotice section={section} />
      ) : (
        <DiffBlock oldText={section.oldContent} newText={section.newContent} maxHeightClassName={full ? "" : "max-h-80"} />
      )}
    </CollapsibleFileSection>
  )

  if (compact) {
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{sections.length} file{sections.length > 1 ? "s" : ""} changed</span>
          <span className="text-green-700 dark:text-green-300">+{sections.reduce((sum, s) => sum + s.additions, 0)}</span>
          <span className="text-red-700 dark:text-red-300">-{sections.reduce((sum, s) => sum + s.removals, 0)}</span>
        </div>
        {sections.map((section, i) => renderSection(section, i))}
      </div>
    )
  }

  return (
    <div className={`h-full min-h-0 flex flex-col overflow-hidden rounded-lg border border-border bg-card ${className}`}>
      <DiffSummary sections={sections} />
      <div className="flex flex-1 min-h-0">
        <aside className="hidden md:flex md:w-72 shrink-0 border-r border-border flex-col min-h-0 bg-card">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Filter files..."
                className="w-full h-8 rounded-md border border-border bg-background pl-7 pr-2 text-[12px] outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {filteredSections.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">No matching files.</p>
            ) : (
              <div className="space-y-0.5">{renderTree(tree)}</div>
            )}
          </div>
        </aside>
        <main className="flex-1 min-w-0 overflow-y-auto bg-background">
          <div className="p-3 space-y-3">
            {filteredSections.map((section, i) => renderSection(section, i, true))}
          </div>
        </main>
      </div>
    </div>
  )
}

export function SkillDiffView({ diff: rawDiff }: SkillDiffViewProps) {
  return <PackageDiffView diff={rawDiff} compact />
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
