/**
 * Lightweight Markdown renderer — no external dependencies.
 *
 * Handles the most common markdown patterns:
 * - Code blocks (fenced ```)
 * - Inline code
 * - Bold / italic
 * - Headings (h1-h3)
 * - Bullet / numbered lists
 * - Links
 * - Blockquotes
 * - Horizontal rules
 * - Line breaks
 */

import { useMemo } from "react"

interface MarkdownProps {
  children: string
}

/** Escape HTML entities. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Convert inline markdown to HTML (bold, italic, code, links). */
function inlineMarkdown(line: string): string {
  let out = esc(line)
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code class="bg-secondary text-pink-600 px-1.5 py-0.5 rounded text-[13px] font-mono">$1</code>')
  // Bold + italic
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
  // Bold
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong class=\"font-semibold\">$1</strong>")
  // Italic
  out = out.replace(/\*(.+?)\*/g, "<em>$1</em>")
  // Links
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline">$1</a>',
  )
  return out
}

function renderMarkdown(text: string): string {
  const lines = text.split("\n")
  const html: string[] = []
  let i = 0
  let inList: "ul" | "ol" | null = null

  function closeList() {
    if (inList) {
      html.push(inList === "ul" ? "</ul>" : "</ol>")
      inList = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.startsWith("```")) {
      closeList()
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      html.push(
        `<pre class="bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto my-3 text-sm leading-relaxed"><code${
          lang ? ` class="language-${esc(lang)}"` : ""
        }>${esc(codeLines.join("\n"))}</code></pre>`,
      )
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      closeList()
      html.push('<hr class="my-3 border-border" />')
      i++
      continue
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      closeList()
      const level = headingMatch[1].length
      const cls =
        level === 1
          ? "text-xl font-bold mb-2 mt-3"
          : level === 2
            ? "text-lg font-bold mb-2 mt-3"
            : "text-base font-bold mb-1.5 mt-2"
      html.push(`<h${level} class="${cls}">${inlineMarkdown(headingMatch[2])}</h${level}>`)
      i++
      continue
    }

    // Blockquote
    if (line.startsWith("> ")) {
      closeList()
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2))
        i++
      }
      html.push(
        `<blockquote class="border-l-4 border-border pl-4 my-2 text-muted-foreground italic">${quoteLines
          .map((l) => `<p class="mb-1 last:mb-0">${inlineMarkdown(l)}</p>`)
          .join("")}</blockquote>`,
      )
      continue
    }

    // Unordered list item
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/)
    if (ulMatch) {
      if (inList !== "ul") {
        closeList()
        html.push('<ul class="list-disc pl-5 mb-2 space-y-1">')
        inList = "ul"
      }
      html.push(`<li class="leading-relaxed">${inlineMarkdown(ulMatch[2])}</li>`)
      i++
      continue
    }

    // Ordered list item
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)/)
    if (olMatch) {
      if (inList !== "ol") {
        closeList()
        html.push('<ol class="list-decimal pl-5 mb-2 space-y-1">')
        inList = "ol"
      }
      html.push(`<li class="leading-relaxed">${inlineMarkdown(olMatch[2])}</li>`)
      i++
      continue
    }

    // Close list if we're no longer in one
    closeList()

    // Empty line
    if (!line.trim()) {
      i++
      continue
    }

    // Normal paragraph
    html.push(`<p class="mb-2 last:mb-0">${inlineMarkdown(line)}</p>`)
    i++
  }

  closeList()
  return html.join("\n")
}

export function Markdown({ children }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(children), [children])
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
