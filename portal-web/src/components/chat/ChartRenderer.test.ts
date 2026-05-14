import { describe, it, expect } from "vitest"
import { tryParseChartSpec, chartSpecLooksIncomplete, collapsePieSlices } from "./ChartRenderer"

describe("tryParseChartSpec", () => {
  it("parses a well-formed pie spec", () => {
    const spec = tryParseChartSpec(
      '{"type":"pie","data":{"slices":[{"label":"a","value":1},{"label":"b","value":2}]}}',
    )
    expect(spec?.type).toBe("pie")
    expect(spec).toMatchObject({ data: { slices: [{ label: "a", value: 1 }, { label: "b", value: 2 }] } })
  })

  it("parses a well-formed bar spec", () => {
    const spec = tryParseChartSpec(
      '{"type":"bar","data":{"categories":["a","b"],"series":[{"name":"s","values":[1,2]}]}}',
    )
    expect(spec?.type).toBe("bar")
  })

  it("parses a well-formed line spec", () => {
    const spec = tryParseChartSpec(
      '{"type":"line","data":{"series":[{"name":"s","points":[{"x":1,"y":2},{"x":2,"y":3}]}]}}',
    )
    expect(spec?.type).toBe("line")
  })

  it("returns null for non-JSON, unknown type, or missing data", () => {
    expect(tryParseChartSpec("not json")).toBeNull()
    expect(tryParseChartSpec('{"type":"scatter","data":{}}')).toBeNull()
    expect(tryParseChartSpec('{"type":"pie"}')).toBeNull()
  })

  // The chart spec round-trips through the LLM as text; the model sometimes
  // double-escapes non-ASCII, leaving literal \uXXXX sequences after JSON.parse.
  it("decodes stray \\uXXXX escapes in title and labels", () => {
    const spec = tryParseChartSpec(
      '{"type":"pie","data":{"slices":[{"label":"\\\\u5404\\\\u547d","value":1}]},"title":"\\\\u5206\\\\u5e03"}',
    )
    expect(spec?.title).toBe("\u5206\u5e03")
    expect((spec as Extract<typeof spec, { type: "pie" }>)?.data.slices[0].label).toBe("\u5404\u547d")
  })

  // A numeric category would crash BarChart's approxTextWidth (for..of on a
  // number), so it must be coerced to a string.
  it("coerces numeric bar categories to strings", () => {
    const spec = tryParseChartSpec(
      '{"type":"bar","data":{"categories":[1,2],"series":[{"name":"s","values":[3,4]}]}}',
    )
    expect((spec as Extract<typeof spec, { type: "bar" }>)?.data.categories).toEqual(["1", "2"])
  })

  it("coerces numeric-string values to numbers but rejects non-finite values", () => {
    const ok = tryParseChartSpec(
      '{"type":"bar","data":{"categories":["a"],"series":[{"name":"s","values":["10"]}]}}',
    )
    expect((ok as Extract<typeof ok, { type: "bar" }>)?.data.series[0].values).toEqual([10])

    expect(
      tryParseChartSpec(
        '{"type":"bar","data":{"categories":["a"],"series":[{"name":"s","values":["oops"]}]}}',
      ),
    ).toBeNull()
  })

  it("fills a default name when series name is missing", () => {
    const spec = tryParseChartSpec(
      '{"type":"bar","data":{"categories":["a"],"series":[{"values":[1]}]}}',
    )
    expect((spec as Extract<typeof spec, { type: "bar" }>)?.data.series[0].name).toBe("series 0")
  })

  it("rejects a bar spec whose values length does not match categories", () => {
    expect(
      tryParseChartSpec(
        '{"type":"bar","data":{"categories":["a","b"],"series":[{"name":"s","values":[1]}]}}',
      ),
    ).toBeNull()
  })

  it("rejects a bar series whose values is not an array", () => {
    expect(
      tryParseChartSpec(
        '{"type":"bar","data":{"categories":["a"],"series":[{"name":"s","values":"nope"}]}}',
      ),
    ).toBeNull()
  })
})

describe("chartSpecLooksIncomplete", () => {
  it("treats a fully-streamed object as complete", () => {
    expect(chartSpecLooksIncomplete('{"type":"pie","data":{"slices":[]}}')).toBe(false)
  })

  it("treats a partial mid-stream object as incomplete", () => {
    expect(chartSpecLooksIncomplete("")).toBe(true)
    expect(chartSpecLooksIncomplete('{"type":"pie","data":')).toBe(true)
    expect(chartSpecLooksIncomplete('{"type":"pie","data":{"slices":[')).toBe(true)
  })

  it("ignores braces inside JSON strings", () => {
    expect(chartSpecLooksIncomplete('{"label":"a}b{c"}')).toBe(false)
    expect(chartSpecLooksIncomplete('{"label":"unclosed')).toBe(true)
  })
})

describe("collapsePieSlices", () => {
  it("leaves data at or below the cap untouched, with no Others slice", () => {
    const slices = Array.from({ length: 12 }, (_, i) => ({ label: `n${i}`, value: i + 1 }))
    const out = collapsePieSlices(slices)
    expect(out.slices).toBe(slices)
    expect(out.othersIndex).toBe(-1)
  })

  it("rolls the long tail into a single Others bucket, keeping the largest slices", () => {
    const slices = Array.from({ length: 20 }, (_, i) => ({ label: `n${i}`, value: i + 1 }))
    const out = collapsePieSlices(slices)
    expect(out.slices).toHaveLength(12)
    expect(out.othersIndex).toBe(11)
    // 11 largest kept (values 20..10), tail = values 9..1 = sum 45
    expect(out.slices.slice(0, 11).map(s => s.value)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10])
    expect(out.slices[11]).toEqual({ label: "Others (9)", value: 45 })
  })
})
