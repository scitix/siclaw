import { useEffect, useState } from "react"
import { Markdown } from "../components/chat/Markdown"
import { svgToPngDataUrl } from "../components/chat/svg-export"

interface ExportPayload {
  markdown: string
  theme: "light" | "dark"
}
interface ExportedVisual {
  kind: "chart" | "mermaid"
  dataUrl: string
}
declare global {
  interface Window {
    __siclawVisualExportReady?: boolean
    __siclawExportVisuals?: () => Promise<ExportedVisual[]>
  }
}

function readPayload(): ExportPayload {
  try {
    // The fragment never reaches the HTTP server or its access logs.
    const hash = window.location.hash.slice(1)
    if (hash.length > 512 * 1024) throw new Error("Export payload too large")
    const normalized = hash.replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes))
    return {
      markdown: typeof payload?.markdown === "string" ? payload.markdown : "",
      theme: payload?.theme === "dark" ? "dark" : "light",
    }
  } catch {
    return { markdown: "", theme: "light" }
  }
}

async function exportVisuals(): Promise<ExportedVisual[]> {
  const root = document.querySelector("[data-siclaw-visual-export-root]")
  if (!root) throw new Error("Visual export root not found")
  const hosts = Array.from(root.querySelectorAll(".chart-host, .mermaid-host"))
  const deadline = performance.now() + 12_000
  while (hosts.some((host) => !host.querySelector('svg[role="img"]'))) {
    if (performance.now() >= deadline) throw new Error("Visual rendering timed out")
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  await document.fonts.ready
  const out: ExportedVisual[] = []
  for (const host of hosts) {
    const svg = host.querySelector<SVGSVGElement>('svg[role="img"]')!
    out.push({
      kind: host.classList.contains("mermaid-host") ? "mermaid" : "chart",
      dataUrl: await svgToPngDataUrl(svg, 2),
    })
  }
  return out
}

/** Stateless render surface used by create-chart's headless browser. */
export function VisualExport() {
  const [payload, setPayload] = useState(readPayload)
  useEffect(() => {
    const load = () => setPayload(readPayload())
    window.addEventListener("hashchange", load)
    return () => window.removeEventListener("hashchange", load)
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle("dark", payload.theme === "dark")
    document.documentElement.style.colorScheme = payload.theme
    window.__siclawVisualExportReady = true
    window.__siclawExportVisuals = exportVisuals
    return () => {
      window.__siclawVisualExportReady = false
      delete window.__siclawExportVisuals
    }
  }, [payload])
  return (
    <main className="min-h-screen bg-background p-3 sm:p-6 text-foreground">
      <div data-siclaw-visual-export-root className="w-full max-w-[1240px] text-sm leading-relaxed">
        <Markdown>{payload.markdown}</Markdown>
      </div>
    </main>
  )
}
