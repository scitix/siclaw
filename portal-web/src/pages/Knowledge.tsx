import { useState, useEffect, useCallback, useMemo } from "react"
import { BookOpen, ChevronDown, ChevronRight, FileText, Search, Loader2, ArrowLeft, Layers, Database } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api } from "../api"

// ── Types ────────────────────────────────────────────────────────

interface KnowledgePage {
  id: string
  name: string
  title: string
  type: string
  layer: "compiled" | "raw"
  sizeBytes: number
  updatedAt: string
}

interface KnowledgePageFull extends KnowledgePage {
  content: string
}

interface TreeGroup {
  label: string
  pages: KnowledgePage[]
}

// ── Helpers ──────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

/**
 * Convert [[page]] wikilinks to clickable markdown links with #wiki: scheme.
 * Code fences and inline code are left untouched.
 */
function preprocessWikilinks(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g)
  return segments
    .map((segment, i) => {
      if (i % 2 === 1) return segment
      return segment.replace(/\[\[([^\]|]+?)\]\]/g, (_m, name) => {
        const slug = String(name).trim()
        return `[${slug}](#wiki:${slug})`
      })
    })
    .join("")
}

/** Strip YAML frontmatter from display content. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "")
}

/** Group compiled pages by their frontmatter type. */
function groupCompiled(pages: KnowledgePage[]): TreeGroup[] {
  const typeOrder = ["index", "component", "concept", "diagnostic", "unknown"]
  const typeLabels: Record<string, string> = {
    index: "Index",
    component: "Components",
    concept: "Concepts",
    diagnostic: "Diagnostics",
    unknown: "Other",
  }
  const groups = new Map<string, KnowledgePage[]>()
  for (const p of pages) {
    const t = p.type || "unknown"
    if (!groups.has(t)) groups.set(t, [])
    groups.get(t)!.push(p)
  }
  return typeOrder
    .filter((t) => groups.has(t))
    .map((t) => ({ label: typeLabels[t] || t, pages: groups.get(t)! }))
}

/** Group raw pages by their subdirectory. */
function groupRaw(pages: KnowledgePage[]): TreeGroup[] {
  const groups = new Map<string, KnowledgePage[]>()
  for (const p of pages) {
    const slash = p.id.indexOf("/")
    const dir = slash > 0 ? p.id.slice(0, slash) : "(root)"
    const label = dir.charAt(0).toUpperCase() + dir.slice(1)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(p)
  }
  return Array.from(groups.entries()).map(([label, pages]) => ({ label, pages }))
}

// ── Component ────────────────────────────────────────────────────

export function Knowledge() {
  const [compiled, setCompiled] = useState<KnowledgePage[]>([])
  const [raw, setRaw] = useState<KnowledgePage[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  // Content viewer state
  const [activePage, setActivePage] = useState<KnowledgePageFull | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [history, setHistory] = useState<KnowledgePageFull[]>([])

  // Tree collapse state — default all open
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    api<{ compiled: KnowledgePage[]; raw: KnowledgePage[] }>("/siclaw/knowledge")
      .then((data) => {
        setCompiled(data.compiled ?? [])
        setRaw(data.raw ?? [])
      })
      .catch((err) => console.error("[Knowledge] load failed:", err))
      .finally(() => setLoading(false))
  }, [])

  const openPage = useCallback(
    async (page: KnowledgePage, pushHistory: boolean) => {
      setContentLoading(true)
      try {
        const full = await api<KnowledgePageFull>(
          `/siclaw/knowledge/${page.layer}/_?path=${encodeURIComponent(page.id)}`,
        )
        if (pushHistory && activePage) {
          setHistory((h) => [...h, activePage])
        }
        setActivePage(full)
      } catch (err) {
        console.error("[Knowledge] fetch failed:", err)
      } finally {
        setContentLoading(false)
      }
    },
    [activePage],
  )

  const handleWikilink = useCallback(
    (target: string) => {
      const fileId = target.endsWith(".md") ? target : `${target}.md`
      // Try compiled first
      const found = compiled.find((p) => p.id === fileId)
      if (found) {
        openPage(found, true)
      } else {
        // Try raw
        const rawFound = raw.find((p) => p.id === fileId || p.id.endsWith("/" + fileId))
        if (rawFound) openPage(rawFound, true)
      }
    },
    [compiled, raw, openPage],
  )

  const handleBack = useCallback(() => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setActivePage(prev)
  }, [history])

  // Filtered & grouped data
  const filteredCompiled = useMemo(() => {
    if (!search.trim()) return compiled
    const q = search.toLowerCase()
    return compiled.filter(
      (p) => p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
    )
  }, [compiled, search])

  const filteredRaw = useMemo(() => {
    if (!search.trim()) return raw
    const q = search.toLowerCase()
    return raw.filter(
      (p) => p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
    )
  }, [raw, search])

  const compiledGroups = useMemo(() => groupCompiled(filteredCompiled), [filteredCompiled])
  const rawGroups = useMemo(() => groupRaw(filteredRaw), [filteredRaw])

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* ── Left: Tree Navigation ── */}
      <aside className="w-[280px] border-r border-border flex flex-col bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Knowledge</span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {compiled.length + raw.length} pages
            </span>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages..."
              className="w-full pl-8 pr-3 py-1.5 text-[12px] bg-secondary/50 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-1">
          {/* Compiled Wiki section */}
          {compiledGroups.length > 0 && (
            <div className="mb-1">
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                <Layers className="w-3 h-3" />
                Wiki
              </div>
              {compiledGroups.map((group) => (
                <TreeGroupView
                  key={`compiled-${group.label}`}
                  groupKey={`compiled-${group.label}`}
                  group={group}
                  collapsed={collapsed}
                  toggleGroup={toggleGroup}
                  activePage={activePage}
                  onSelect={(p) => openPage(p, false)}
                />
              ))}
            </div>
          )}

          {/* Raw Materials section */}
          {rawGroups.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border">
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                <Database className="w-3 h-3" />
                Raw Materials
              </div>
              {rawGroups.map((group) => (
                <TreeGroupView
                  key={`raw-${group.label}`}
                  groupKey={`raw-${group.label}`}
                  group={group}
                  collapsed={collapsed}
                  toggleGroup={toggleGroup}
                  activePage={activePage}
                  onSelect={(p) => openPage(p, false)}
                />
              ))}
            </div>
          )}

          {filteredCompiled.length === 0 && filteredRaw.length === 0 && (
            <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
              {compiled.length === 0 && raw.length === 0
                ? "No wiki pages found. Add .md files under knowledge/"
                : "No matching pages"}
            </div>
          )}
        </nav>
      </aside>

      {/* ── Right: Content Viewer ── */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {activePage ? (
          <>
            <header className="flex items-center gap-3 px-6 py-3 border-b border-border bg-card">
              {history.length > 0 && (
                <button
                  onClick={handleBack}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
                  title="Back"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold truncate">{activePage.title}</h2>
                <span className="text-[11px] text-muted-foreground">
                  {activePage.layer === "compiled" ? "Wiki" : "Raw"} &middot;{" "}
                  {formatBytes(activePage.sizeBytes)}
                </span>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto px-8 py-6">
              {contentLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <article className="max-w-3xl">
                  <WikiMarkdown
                    content={stripFrontmatter(activePage.content || "")}
                    onWikilink={handleWikilink}
                  />
                </article>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <BookOpen className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Select a page to view</p>
              <p className="text-[11px] text-muted-foreground/60 mt-1">
                {compiled.length} wiki pages &middot; {raw.length} raw materials
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

// ── Tree Group Sub-component ─────────────────────────────────────

function TreeGroupView({
  groupKey,
  group,
  collapsed,
  toggleGroup,
  activePage,
  onSelect,
}: {
  groupKey: string
  group: TreeGroup
  collapsed: Set<string>
  toggleGroup: (key: string) => void
  activePage: KnowledgePageFull | null
  onSelect: (page: KnowledgePage) => void
}) {
  const isCollapsed = collapsed.has(groupKey)
  const Chevron = isCollapsed ? ChevronRight : ChevronDown
  return (
    <div>
      <button
        onClick={() => toggleGroup(groupKey)}
        className="flex items-center gap-1.5 w-full px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
      >
        <Chevron className="w-3 h-3 flex-shrink-0" />
        <span className="font-medium">{group.label}</span>
        <span className="ml-auto text-[10px] opacity-60">{group.pages.length}</span>
      </button>
      {!isCollapsed &&
        group.pages.map((page) => {
          const isActive = activePage?.id === page.id && activePage?.layer === page.layer
          const displayName = page.id.includes("/")
            ? page.id.split("/").pop()!.replace(/\.md$/, "")
            : page.name
          return (
            <button
              key={`${page.layer}-${page.id}`}
              onClick={() => onSelect(page)}
              className={`flex items-center gap-2 w-full pl-7 pr-3 py-1.5 text-[12px] transition-colors ${
                isActive
                  ? "text-foreground bg-secondary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"
              }`}
              title={page.title}
            >
              <FileText className="w-3 h-3 flex-shrink-0 opacity-50" />
              <span className="truncate">{displayName}</span>
            </button>
          )
        })}
    </div>
  )
}

// ── Markdown with Wikilink support ───────────────────────────────

function WikiMarkdown({
  content,
  onWikilink,
}: {
  content: string
  onWikilink: (target: string) => void
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1({ children }) {
          return <h1 className="text-xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>
        },
        h2({ children }) {
          return (
            <h2 className="text-lg font-bold mb-2 mt-5 pb-1 border-b border-border">
              {children}
            </h2>
          )
        },
        h3({ children }) {
          return <h3 className="text-base font-semibold mb-2 mt-4">{children}</h3>
        },
        h4({ children }) {
          return <h4 className="text-sm font-semibold mb-1.5 mt-3">{children}</h4>
        },
        p({ children }) {
          return <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
        },
        ul({ children }) {
          return <ul className="list-disc pl-6 mb-3 space-y-1">{children}</ul>
        },
        ol({ children }) {
          return <ol className="list-decimal pl-6 mb-3 space-y-1">{children}</ol>
        },
        li({ children }) {
          return <li className="leading-relaxed">{children}</li>
        },
        strong({ children }) {
          return <strong className="font-semibold">{children}</strong>
        },
        hr() {
          return <hr className="my-5 border-border" />
        },
        pre({ children }) {
          return (
            <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto my-3 text-[12px] leading-relaxed">
              {children}
            </pre>
          )
        },
        code({ className, children, ...props }) {
          const isInline = !className
          if (isInline) {
            return (
              <code
                className="bg-secondary text-orange-400 px-1.5 py-0.5 rounded text-[12px] font-mono"
                {...props}
              >
                {children}
              </code>
            )
          }
          return (
            <code className={`font-mono text-[12px] ${className ?? ""}`} {...props}>
              {children}
            </code>
          )
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-4 border-border pl-4 my-3 text-muted-foreground italic">
              {children}
            </blockquote>
          )
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full text-sm border border-border rounded">
                {children}
              </table>
            </div>
          )
        },
        thead({ children }) {
          return <thead className="bg-secondary/50">{children}</thead>
        },
        th({ children }) {
          return (
            <th className="border-b border-border px-3 py-2 text-left font-semibold">
              {children}
            </th>
          )
        },
        td({ children }) {
          return (
            <td className="border-b border-border/50 px-3 py-2 align-top">{children}</td>
          )
        },
        a({ href, children }) {
          if (href && href.startsWith("#wiki:")) {
            const target = href.slice("#wiki:".length)
            return (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  onWikilink(target)
                }}
                className="text-blue-400 hover:text-blue-300 hover:underline font-medium bg-transparent border-0 p-0 cursor-pointer"
              >
                {children}
              </button>
            )
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              {children}
            </a>
          )
        },
      }}
    >
      {preprocessWikilinks(content)}
    </ReactMarkdown>
  )
}
