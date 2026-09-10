import { createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect } from "vitest"
import {
  normalizeTraceLocale,
  resolveTraceLocale,
  TRACE_EN,
  TRACE_ZH,
} from "./trace-locale"
import { traceLayout, traceStatusLabel, TraceSnapshot } from "./TraceTimeline"
import { normalizeWaterfallSpec } from "./waterfall-spec"

const spec = normalizeWaterfallSpec({
  type: "waterfall",
  data: {
    origin_time: "2026-09-10T00:00:00Z",
    root_span_id: "root",
    coverage: {
      complete: false,
      observed: ["root"],
      missing: ["provider internals"],
    },
    spans: [
      {
        span_id: "root",
        label: "Original service name",
        start_ms: 0,
        end_ms: 1000,
        status: "error",
        layer: "server",
      },
      {
        span_id: "open",
        parent_span_id: "root",
        label: "Original call name",
        start_ms: 20,
        end_ms: null,
        status: "unknown",
        layer: "http",
      },
    ],
  },
})
describe("trace locale and responsive behaviour", () => {
  it("uses the host language automatically and honours an explicit user selection", () => {
    expect(normalizeTraceLocale("zh-Hans-CN")).toBe("zh")
    expect(normalizeTraceLocale("en-GB")).toBe("en")
    expect(normalizeTraceLocale("fr-FR")).toBe("en")
    expect(resolveTraceLocale("auto", "zh-CN")).toBe("zh")
    expect(resolveTraceLocale("en", "zh-CN")).toBe("en")
    expect(resolveTraceLocale("zh", "en-US")).toBe("zh")
  })
  it("keeps complete translation coverage and localizes statuses", () => {
    expect(Object.keys(TRACE_ZH).sort()).toEqual(Object.keys(TRACE_EN).sort())
    expect(traceStatusLabel(spec.data.spans[0], TRACE_ZH)).toBe("错误")
    expect(traceStatusLabel(spec.data.spans[0], TRACE_EN)).toBe("Error")
  })
  it("adapts to the container, including a narrow embedded column on a wide desktop", () => {
    expect(traceLayout(320).narrow).toBe(true)
    expect(traceLayout(736).split).toBe(false)
    expect(traceLayout(1200).split).toBe(true)
    for (const width of [280, 320, 390, 600, 736, 980, 1240]) {
      const layout = traceLayout(width)
      expect(layout.chartWidth - layout.left - layout.right).toBeGreaterThan(0)
    }
  })
  it("exports translated chrome without rewriting source evidence or hiding unknown endpoints", () => {
    const html = renderToStaticMarkup(
      <TraceSnapshot
        spec={spec}
        labels={TRACE_ZH}
        svgRef={createRef<SVGSVGElement>()}
      />,
    )
    expect(html).toContain("未观测到终点")
    expect(html).toContain("部分链路")
    expect(html).toContain("错误")
    expect(html).toContain("Original service name")
    expect(html).toContain("Original call name")
    expect(html).toContain("provider internals")
    expect(html).toContain('stroke-dasharray="4 3"')
  })
})
