// Browser helpers shared by chat visualisations that render as inline SVG.
// They intentionally know nothing about ChartSpec or Mermaid syntax.

// Inline the CSS properties that affect chart/Mermaid appearance before the
// SVG leaves the document. The <img> used for rasterisation cannot see parent
// Tailwind classes or Mermaid's in-document stylesheet.
const INLINEABLE_PROPS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "marker-end",
  "marker-start",
  "marker-mid",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
] as const

function inlineComputedStyles(src: SVGElement, dst: SVGElement) {
  const srcAll = [src, ...Array.from(src.querySelectorAll<SVGElement>("*"))]
  const dstAll = [dst, ...Array.from(dst.querySelectorAll<SVGElement>("*"))]
  for (let i = 0; i < srcAll.length; i++) {
    const cs = window.getComputedStyle(srcAll[i])
    const tgt = dstAll[i]
    for (const prop of INLINEABLE_PROPS) {
      const v = cs.getPropertyValue(prop)
      if (v) tgt.style.setProperty(prop, v)
    }
    // Strip class attrs because colors/styles are now inlined. Keeping classes
    // would bloat the serialized output and require Tailwind/Mermaid CSS in the
    // consumer's context.
    tgt.removeAttribute("class")
  }
}

function svgCanvasSize(svg: SVGSVGElement): { width: number; height: number } {
  const vb = svg.viewBox.baseVal
  if (vb && vb.width && vb.height) return { width: vb.width, height: vb.height }
  const rect = svg.getBoundingClientRect()
  return {
    width: rect.width || svg.clientWidth || 900,
    height: rect.height || svg.clientHeight || 520,
  }
}

function svgBackground(svg: SVGSVGElement): string {
  // Chart SVGs include .chart-bg; sample its live fill before cloning so the
  // canvas base matches what the user sees, even if future style inlining fails
  // to carry the background fill onto the detached clone. Mermaid SVGs do not
  // have .chart-bg and are currently rendered/exported on the intentional white
  // base from mermaidConfig().
  const bgRect = svg.querySelector<SVGRectElement>(".chart-bg")
  const liveBg = bgRect ? window.getComputedStyle(bgRect).fill : ""
  return liveBg && liveBg !== "none" && liveBg !== "transparent" ? liveBg : "#ffffff"
}

export async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const { width, height } = svgCanvasSize(svg)
  const canvasBg = svgBackground(svg)

  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineComputedStyles(svg, clone)
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  clone.setAttribute("width", String(width))
  clone.setAttribute("height", String(height))

  const xml = new XMLSerializer().serializeToString(clone)
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml)

  const img = new Image()
  img.crossOrigin = "anonymous"
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error("SVG rasterisation failed"))
    img.src = url
  })

  const canvas = document.createElement("canvas")
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("canvas 2d context unavailable")
  ctx.fillStyle = canvasBg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png")
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("blob -> data URL failed"))
    reader.readAsDataURL(blob)
  })
}

export async function svgToPngDataUrl(svg: SVGSVGElement, scale = 2): Promise<string> {
  // Used by rich clipboard text/html payloads so copied chat bubbles contain a
  // real image instead of raw chart JSON or Mermaid source.
  const blob = await svgToPngBlob(svg, scale)
  return await blobToDataUrl(blob)
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
    return true
  } catch (err) {
    console.warn("[copy] clipboard image write failed:", err)
    return false
  }
}

export function safeDownloadName(input: string, fallback: string): string {
  const safe = input.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60)
  return safe || fallback
}
