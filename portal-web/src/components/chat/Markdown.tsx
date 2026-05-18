import { useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { ChartRenderer, chartSpecLooksIncomplete, tryParseChartSpec } from "./ChartRenderer"

interface MarkdownProps {
  children: string
}

// CommonMark renders any line indented 4+ spaces as an "indented code block" —
// a grey monospace box. LLM chat output never intends these (it always fences
// code with ```), but a stray leading indent on an ordinary sentence makes a
// plain message render as a code block. This remark plugin rewrites every
// *indented* code block back into a normal paragraph; *fenced* blocks (which
// includes ```chart) are detected via the source text and left untouched.
function remarkDemoteIndentedCode() {
  return (tree: unknown, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : ""
    const isFenced = (node: {
      position?: { start?: { offset?: number } }
    }): boolean => {
      const off = node.position?.start?.offset
      if (off == null) return true // can't tell — keep it as code, the safe default
      const head = source.slice(off, off + 16).replace(/^[ \t]*/, "")
      return head.startsWith("```") || head.startsWith("~~~")
    }
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return
      const children = (node as { children?: unknown }).children
      if (!Array.isArray(children)) return
      for (const child of children) {
        if (
          child &&
          typeof child === "object" &&
          (child as { type?: string }).type === "code" &&
          !isFenced(child as { position?: { start?: { offset?: number } } })
        ) {
          const c = child as {
            type: string
            value?: string
            lang?: unknown
            meta?: unknown
            children?: unknown
          }
          c.type = "paragraph"
          c.children = [{ type: "text", value: c.value ?? "" }]
          delete c.value
          delete c.lang
          delete c.meta
        } else {
          walk(child)
        }
      }
    }
    walk(tree)
  }
}

/**
 * Escape underscores between word characters to prevent markdown from
 * interpreting them as emphasis markers (e.g. roll_dice.py → italic).
 * Preserves fenced code blocks and inline code.
 */
function escapeIntraWordUnderscores(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g)
  return segments
    .map((segment, i) => {
      if (i % 2 === 1) return segment // code — leave untouched
      return segment.replace(/(?<=\w)_(?=\w)/g, "\\_")
    })
    .join("")
}

// Allow data: URIs for inline images (e.g. SVG charts produced by render_chart).
// react-markdown's defaultUrlTransform strips data: from img src as a safety
// default; we re-allow it for image MIME types only. SVG is rendered as an
// image (not via <object>), so embedded scripts inside the SVG do not execute.
const ALLOWED_DATA_IMAGE_MIME = /^data:image\/(svg\+xml|png|jpeg|gif|webp);base64,/i
function permissiveUrlTransform(uri: string): string {
  if (ALLOWED_DATA_IMAGE_MIME.test(uri)) return uri
  // Fall back to default-safe behaviour for everything else.
  if (/^(https?|mailto|tel|ircs?|xmpp):/i.test(uri)) return uri
  if (uri.startsWith("/") || uri.startsWith("#") || uri.startsWith("?") || uri.startsWith(".")) return uri
  return ""
}

function hasLanguageClass(className: string | undefined, language: string): boolean {
  return className?.split(/\s+/).includes(`language-${language}`) ?? false
}

function ChartLoading() {
  return (
    <div
      className="my-3 flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-4 py-6 text-sm text-muted-foreground"
      role="status"
      aria-label="Chart loading"
    >
      <svg
        className="h-4 w-4 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      Generating chart…
    </div>
  )
}

function ChartParseError({ source }: { source: string }) {
  return (
    <div className="my-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
      <div className="font-semibold">Failed to parse chart JSON</div>
      <div className="mt-1 text-xs opacity-80">
        Check whether the chart block returned by render_chart was rewritten or extra-escaped.
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium">View raw chart content</summary>
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
          {source}
        </pre>
      </details>
    </div>
  )
}

// Parses the inner text of a ```chart fence into a chart spec. Each <pre>
// node react-markdown produces is a separate component instance with its own
// hook state, so useMemo here keys cleanly off the chunk of JSON text — the
// returned spec is referentially stable as long as the text is unchanged,
// which lets ChartRenderer's React.memo short-circuit cleanly while the LLM
// continues streaming prose after the chart fence has closed.
function ChartFence({ text }: { text: string }) {
  const trimmed = text.trim()
  const spec = useMemo(() => tryParseChartSpec(trimmed), [trimmed])
  if (spec) return <ChartRenderer spec={spec} />
  // Don't show the red parse-failed box mid-stream — ReactMarkdown re-renders
  // on every token, so an unclosed chart fence would otherwise flash the
  // error box for every chart until streaming finishes. Only treat it as a
  // real error once the JSON has finished arriving.
  if (chartSpecLooksIncomplete(trimmed)) return <ChartLoading />
  return <ChartParseError source={trimmed} />
}

// Hoisted to module scope so each entry has stable function identity across
// <Markdown> re-renders. Inlining this object inside the render body produces
// fresh function references every token, which react-markdown surfaces as a
// *new component type* for <pre>, <code>, etc., forcing React to unmount and
// remount the entire chart subtree on every streamed token. That remount is
// what made the SVG visibly flicker during (and a few seconds after) chart
// generation while the model continued streaming prose past the chart fence.
const MARKDOWN_COMPONENTS: Components = {
  // Code blocks. ```chart fenced blocks contain a JSON spec emitted by mcp
  // render_chart; we parse and render via the React ChartRenderer (theme-
  // aware, no <pre> dark background, no SVG echo from the model).
  //
  // Every other fenced block — language-tagged or not — is rendered here by
  // extracting the raw text and drawing one soft-styled <pre>. We do NOT pass
  // `children` (the inner <code> element) through, because the `code`
  // component below can't tell block code from inline code (a no-language
  // fence's <code> carries no className) and would render it as orange inline
  // text on a slate-900 box — the "black box, yellow text" artifact. Handling
  // all block code here keeps `code` purely for inline spans.
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    const isElement =
      !!child && typeof child === "object" && "props" in child
    const className = isElement
      ? (child as { props: { className?: string } }).props.className
      : undefined
    const rawChildren = isElement
      ? (child as { props: { children?: unknown } }).props.children
      : children
    const text = Array.isArray(rawChildren)
      ? rawChildren.join("")
      : String(rawChildren ?? "")

    if (hasLanguageClass(className, "chart")) {
      return <ChartFence text={text} />
    }

    return (
      <pre className="bg-secondary/60 text-foreground border border-border rounded-lg p-3 overflow-x-auto my-3 text-[13px] leading-relaxed font-mono whitespace-pre-wrap">
        {text}
      </pre>
    )
  },
  // Inline code only — block code never reaches here (see `pre` above).
  code({ children, ...props }) {
    return (
      <code
        className="bg-secondary text-orange-400 px-1.5 py-0.5 rounded text-[13px] font-mono"
        {...props}
      >
        {children}
      </code>
    )
  },
  p({ children }) {
    return <p className="mb-2 last:mb-0">{children}</p>
  },
  ul({ children }) {
    return <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>
  },
  ol({ children }) {
    return <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>
  },
  h1({ children }) {
    return <h1 className="text-xl font-bold mb-2 mt-3 first:mt-0">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="text-base font-bold mb-1.5 mt-2 first:mt-0">{children}</h3>
  },
  a({ href, children }) {
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
  blockquote({ children }) {
    return (
      <blockquote className="border-l-4 border-border pl-4 my-2 text-muted-foreground italic">
        {children}
      </blockquote>
    )
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-2">
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
      <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td className="border-b border-border/50 px-3 py-2 text-foreground">
        {children}
      </td>
    )
  },
  hr() {
    return <hr className="my-3 border-border" />
  },
  strong({ children }) {
    return <strong className="font-semibold">{children}</strong>
  },
  // Explicit width caps so a chart fits the chat bubble.
  img({ src, alt }) {
    return (
      <img
        src={src}
        alt={alt ?? ""}
        className="-mx-5 -my-3.5 max-w-none w-[calc(100%+2.5rem)] h-auto block"
      />
    )
  },
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkDemoteIndentedCode]}
      urlTransform={permissiveUrlTransform}
      components={MARKDOWN_COMPONENTS}
    >
      {escapeIntraWordUnderscores(children)}
    </ReactMarkdown>
  )
}
