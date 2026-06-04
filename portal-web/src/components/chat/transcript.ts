/** Plain-text serialisation of chat messages for the clipboard. */

import type { PilotMessage } from "./types"

// A ```chart / ```mermaid fenced block is a JSON/diagram spec — useful as a
// rendered picture, but noise when pasted as text. Swap each for a readable
// placeholder. The rich text/html clipboard payload carries the actual image.
export function stripVisualizationFences(markdown: string): string {
  return markdown
    .replace(/```chart\s*[\s\S]*?```/g, "[chart]")
    .replace(/```mermaid\s*[\s\S]*?```/g, "[diagram]")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// Markdown image syntax `![alt](src)` embeds the whole source inline. For data:
// URLs that source is a multi-kilobyte base64 blob — pasting it as text dumps
// "the data that generates the image" instead of the picture. Collapse it to a
// short placeholder for the text/plain payload; the rich text/html payload keeps
// the real <img>.
export function stripImageData(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => {
    const label = (alt ?? "").trim()
    return label ? `[image: ${label}]` : "[image]"
  })
}

// Serialise a list of messages to a Markdown document for download. Content is
// kept verbatim — chart/Mermaid stay as their ```chart / ```mermaid spec blocks
// (compact, diff-friendly chart data); the companion HTML export carries the
// rendered colour image. Role headers are bold, tool output is fenced, and
// messages are separated by horizontal rules. User-pasted attachments
// (message.attachments) are omitted — transient OCR inputs, not persisted.
export function serializeMessagesToMarkdown(messages: PilotMessage[]): string {
  const blocks: string[] = []
  for (const m of messages) {
    if (m.hidden) continue
    if (m.metadata?.kind === "delegation_status_notice") continue
    const ts = m.timestamp ? ` · ${m.timestamp}` : ""
    if (m.role === "user") {
      blocks.push(`**You**${ts}\n\n${(m.content ?? "").trim()}`)
    } else if (m.role === "assistant") {
      const body = (m.content ?? "").trim()
      if (body) blocks.push(`**Siclaw**${ts}\n\n${body}`)
    } else if (m.role === "tool") {
      const name = m.toolName ?? "tool"
      const cmd = m.toolInput ? `\`${m.toolInput}\`\n\n` : ""
      const out = (m.content ?? "").trim()
      blocks.push(`**[${name}]**${ts}\n\n${cmd}${out ? "```\n" + out + "\n```" : ""}`.trim())
    } else if (m.role === "error") {
      blocks.push(`**Error**${ts}\n\n${(m.content ?? "").trim()}`)
    }
  }
  return blocks.join("\n\n---\n\n") + "\n"
}

// Serialise a list of messages to a plain-text transcript. Used both for the
// "copy entire session" button and the scroll-selection "copy selected" action,
// so it takes whatever subset of messages the caller hands it.
export function serializeMessagesToText(messages: PilotMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.hidden) continue
    if (m.metadata?.kind === "delegation_status_notice") continue
    if (m.role === "user") {
      lines.push(`You:\n${stripImageData((m.content ?? "").trim())}`)
    } else if (m.role === "assistant") {
      const body = stripImageData(stripVisualizationFences(m.content ?? ""))
      if (body) lines.push(`Assistant:\n${body}`)
    } else if (m.role === "tool") {
      const name = m.toolName ?? "tool"
      const input = m.toolInput ? `\n$ ${m.toolInput}` : ""
      const out = (m.content ?? "").trim()
      lines.push(`[${name}]${input}${out ? `\n${out}` : ""}`)
    } else if (m.role === "error") {
      lines.push(`Error: ${(m.content ?? "").trim()}`)
    }
  }
  return lines.join("\n\n")
}
