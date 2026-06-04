/**
 * DOM-based rich clipboard copy for chat messages.
 *
 * The earlier "copy entire session" path re-serialised message *text* to HTML,
 * which turned an inline markdown image `![](data:image/png;base64,…)` into the
 * escaped base64 string — pasting "the data that generates the image" instead of
 * the picture. Walking the rendered DOM instead (as the per-message copy already
 * did) keeps real <img> elements intact and rasterises chart/Mermaid SVGs to
 * PNG, so charts, diagrams, generated images and uploaded attachments all copy
 * as pictures. This is the approach the old code's KNOWN LIMITATION comment
 * recommended ("walk per-message DOM nodes instead of re-parsing text").
 */

import { svgToPngDataUrl } from "./svg-export"

const VISUAL_SVG_SELECTOR = '.chart-host svg[role="img"], .mermaid-host svg[role="img"]'
const VISUAL_HOST_SELECTOR = ".chart-host, .mermaid-host"

// Clone one rendered element into copy-ready HTML: chart/Mermaid hosts become
// rasterised PNG <img>s, interactive chrome is dropped, and real <img>s survive.
// Rasterisation reads the *live* SVG (computed styles are lost on a detached
// clone), so this is async. `hasVisual` tells the caller whether anything worth
// a rich-HTML copy was found — a pure-text bubble copies better as plain markdown.
async function cloneElementForCopy(el: HTMLElement): Promise<{ html: string; hasVisual: boolean }> {
  const liveSvgs = Array.from(el.querySelectorAll<SVGSVGElement>(VISUAL_SVG_SELECTOR))
  const dataUrls = await Promise.all(
    liveSvgs.map((svg) =>
      svgToPngDataUrl(svg).catch((err): string | null => {
        console.warn("[copy] svg rasterisation failed:", err)
        return null
      }),
    ),
  )

  const clone = el.cloneNode(true) as HTMLElement
  // Strip chrome that should never land in a transcript (avatars, checkboxes,
  // timing badges — tagged at the render site).
  clone.querySelectorAll("[data-copy-ignore]").forEach((n) => n.remove())
  // Drop interactive controls, but unwrap any button that wraps an image (e.g.
  // the click-to-zoom button around an uploaded image) so the picture survives.
  clone.querySelectorAll("button").forEach((b) => {
    if (b.querySelector("img")) b.replaceWith(...Array.from(b.childNodes))
    else b.remove()
  })

  // Swap each chart/Mermaid host for its PNG, matched by document order. A host
  // with no rasterised URL (still loading, or rasterisation failed) falls back
  // to a text placeholder so nothing half-rendered ships.
  const hosts = Array.from(clone.querySelectorAll<HTMLElement>(VISUAL_HOST_SELECTOR))
  let hasVisual = false
  hosts.forEach((host, i) => {
    const url = i < dataUrls.length ? dataUrls[i] : null
    if (!url) {
      const placeholder = document.createElement("span")
      placeholder.textContent = host.classList.contains("mermaid-host") ? "[diagram]" : "[chart]"
      host.replaceWith(placeholder)
      return
    }
    const img = document.createElement("img")
    img.src = url
    img.style.maxWidth = "100%"
    img.style.height = "auto"
    host.replaceWith(img)
    hasVisual = true
  })

  if (clone.querySelector("img")) hasVisual = true
  return { html: clone.innerHTML, hasVisual }
}

/**
 * Build the copy-ready HTML for a set of rendered message elements, with each
 * visual turned into an image. Exposed separately from the clipboard write so it
 * can be exercised without a real clipboard. `hasVisual` is false when there is
 * nothing worth a rich-HTML copy.
 */
export async function buildCopyHtml(els: HTMLElement[]): Promise<{ html: string; hasVisual: boolean }> {
  const parts = await Promise.all(els.map((el) => cloneElementForCopy(el)))
  const hasVisual = parts.some((p) => p.hasVisual)
  return { html: `<div>${parts.map((p) => p.html).join("")}</div>`, hasVisual }
}

/**
 * Copy one or more rendered message elements as rich text/html (visuals as
 * images) with a plain-text fallback in the same clipboard write.
 *
 * Returns false — so the caller can fall back to a plain-text copy — when there
 * is nothing visual to preserve (a plain-text transcript reads better in an
 * editor) or the browser can't do a rich clipboard write (e.g. insecure origin,
 * no ClipboardItem).
 */
export async function copyElementsAsRichText(els: HTMLElement[], plainText: string): Promise<boolean> {
  if (els.length === 0) return false
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false
  try {
    const { html, hasVisual } = await buildCopyHtml(els)
    if (!hasVisual) return false
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      }),
    ])
    return true
  } catch (err) {
    console.warn("[copy] rich copy failed, falling back to text:", err)
    return false
  }
}
