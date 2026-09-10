import { createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect } from "vitest"
import { normalizeWaterfallSpec } from "./waterfall-spec"
import { compactTraceSpans, TracePreview, TraceCompactMeta, TraceCompactStatus, TraceSnapshot, TRACE_EN } from "./TraceTimeline"

const spec = normalizeWaterfallSpec({type: "waterfall", data: {
  origin_time: "2026-09-10T00:00:00Z", root_span_id: "root",
  coverage: {complete: false, observed: ["root"], missing: ["provider internals"]},
  spans: [
    {span_id: "root", label: "Request", start_ms: 0, end_ms: 1000, layer: "server"},
    {span_id: "a", label: "Slow call", start_ms: 10, end_ms: 900, layer: "http", status: "error", http_status: 500},
    {span_id: "b", label: "Overlapping call", start_ms: 20, end_ms: 800, layer: "http"},
    {span_id: "c", label: "Short call", start_ms: 900, end_ms: 990, layer: "http"},
    {span_id: "open", label: "Unfinished", start_ms: 1000, end_ms: null, layer: "http"},
  ],
}})

describe("compact trace evidence", () => {
  it("bounds the preview and retains unknown ends alongside the longest calls", () => {
    expect(compactTraceSpans(spec).map(s => s.span_id)).toEqual(["a", "b", "open"])
    const html = renderToStaticMarkup(<TracePreview spec={spec} labels={TRACE_EN} />)
    expect(html.match(/<li /g)).toHaveLength(3)
    expect(html).toContain("500")
    expect(html).toContain('title="End not observed"')
    expect(html).toContain("min(100%, calc(100% - 2px))")
  })
  it("labels the observed root duration without summing overlapping calls or claiming complete coverage", () => {
    const html = renderToStaticMarkup(<><TraceCompactMeta spec={spec} labels={TRACE_EN}/><TraceCompactStatus spec={spec} labels={TRACE_EN}/></>)
    expect(html).toContain("Root span")
    expect(html).toContain(">1 s</span>")
    expect(html).toContain("4 HTTP calls")
    expect(html).toContain("Partial trace")
    expect(html).toContain("1 observation gap")
  })
  it("keeps every span in the full PNG even when only three are previewed", () => {
    const html = renderToStaticMarkup(<TraceSnapshot spec={spec} labels={TRACE_EN} svgRef={createRef<SVGSVGElement>()}/>)
    for (const s of spec.data.spans) expect(html).toContain(s.label)
    expect(html).toContain("End not observed")
  })
  it("supports traces with only a root interval", () => {
    const single = {...spec, data: {...spec.data, spans: [spec.data.spans[0]]}}
    expect(compactTraceSpans(single).map(s => s.span_id)).toEqual(["root"])
  })
})
