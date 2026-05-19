import { describe, it, expect } from "vitest"
import {
  fmtNumber,
  niceAxis,
  logAxis,
  axisFrac,
  logPossible,
  logBeneficial,
  collectChartValues,
  layoutLegendRows,
  computePlot,
  barTickLayout,
  BAR_TICK_ROTATE_DEG,
  approxTextWidth,
  legendRowsFor,
  chartCanvasSize,
  seriesDash,
  seriesShape,
  type ChartSpec,
} from "./chart-utils"

describe("fmtNumber", () => {
  it("formats everyday integers with thousands separators, no scientific notation", () => {
    expect(fmtNumber(0)).toBe("0")
    expect(fmtNumber(42)).toBe("42")
    expect(fmtNumber(1000)).toBe("1,000")
    expect(fmtNumber(1005)).toBe("1,005")
    expect(fmtNumber(1200)).toBe("1,200")
    expect(fmtNumber(-1500)).toBe("-1,500")
  })

  it("uses SI suffixes for millions and above", () => {
    expect(fmtNumber(1_000_000)).toBe("1M")
    expect(fmtNumber(1_500_000)).toBe("1.5M")
    expect(fmtNumber(2_000_000_000)).toBe("2G")
  })

  it("keeps significant digits for sub-1 values instead of rounding to 0 (regression)", () => {
    // toFixed(2) used to turn 0.003 into "0.00" -> "0"; that hid real data.
    expect(fmtNumber(0.003)).not.toBe("0")
    expect(fmtNumber(0.003)).toBe("0.003")
    expect(fmtNumber(0.5)).toBe("0.5")
    expect(fmtNumber(0.12345)).toBe("0.12")
    expect(fmtNumber(12.345)).toBe("12.35")
  })

  it("falls back to exponential only for values outside any sane chart range", () => {
    expect(fmtNumber(1e-9)).toMatch(/e-9$/)
    expect(fmtNumber(1e20)).toMatch(/e/)
  })

  it("passes non-finite values through", () => {
    expect(fmtNumber(NaN)).toBe("NaN")
    expect(fmtNumber(Infinity)).toBe("Infinity")
  })
})

describe("niceAxis", () => {
  it("produces a covering range with sorted ticks", () => {
    const a = niceAxis(0, 1005)
    expect(a.min).toBeLessThanOrEqual(0)
    expect(a.max).toBeGreaterThanOrEqual(1005)
    expect(a.ticks.length).toBeGreaterThanOrEqual(2)
    expect([...a.ticks]).toEqual([...a.ticks].sort((x, y) => x - y))
  })

  it("does not collapse when min === max", () => {
    const a = niceAxis(5, 5)
    expect(a.max).toBeGreaterThan(a.min)
  })

  it("returns a safe default for non-finite input", () => {
    expect(niceAxis(NaN, NaN)).toEqual({ min: 0, max: 1, ticks: [0, 0.5, 1] })
  })
})

describe("logAxis", () => {
  it("spans whole powers of ten with power-of-ten ticks", () => {
    const a = logAxis(10, 1000)
    expect(a.log).toBe(true)
    expect(a.min).toBe(10)
    expect(a.max).toBe(1000)
    expect(a.ticks).toEqual([10, 100, 1000])
  })
})

describe("axisFrac", () => {
  it("maps linearly for a linear axis", () => {
    const a = niceAxis(0, 100)
    expect(axisFrac(a, a.min)).toBe(0)
    expect(axisFrac(a, a.max)).toBe(1)
  })

  it("maps logarithmically for a log axis", () => {
    const a = logAxis(10, 1000)
    expect(axisFrac(a, 10)).toBeCloseTo(0)
    expect(axisFrac(a, 100)).toBeCloseTo(0.5)
    expect(axisFrac(a, 1000)).toBeCloseTo(1)
  })
})

describe("logPossible", () => {
  it("is true whenever every value is positive and there are >=2 of them", () => {
    // Permissive on purpose: a modest spread still gets the toolbar toggle so
    // line charts expose linear/log the same way bar charts do.
    expect(logPossible([10, 20, 30])).toBe(true)
    expect(logPossible([1, 1000])).toBe(true)
  })

  it("is false for a zero, a negative, or too few points", () => {
    expect(logPossible([0, 1000])).toBe(false)
    expect(logPossible([1000, -5])).toBe(false)
    expect(logPossible([1000])).toBe(false)
  })
})

describe("logBeneficial", () => {
  it("is true when every value is positive and the spread is large", () => {
    expect(logBeneficial([1, 1000])).toBe(true)
    expect(logBeneficial([5, 17, 1005])).toBe(true)
  })

  it("is false for a small spread, a zero, a negative, or too few points", () => {
    expect(logBeneficial([10, 20, 30])).toBe(false)
    expect(logBeneficial([0, 1000])).toBe(false)
    expect(logBeneficial([1000, -5])).toBe(false)
    expect(logBeneficial([1000])).toBe(false)
  })
})

const barSpec = (seriesCount: number, nameLen = 4): ChartSpec => ({
  type: "bar",
  data: {
    categories: ["a", "b"],
    series: Array.from({ length: seriesCount }, (_, i) => ({
      name: `s${i}`.padEnd(nameLen, "x"),
      values: [1, 2],
    })),
  },
})

const lineSpec = (seriesCount: number, nameLen = 16): ChartSpec => ({
  type: "line",
  data: {
    series: Array.from({ length: seriesCount }, (_, i) => ({
      name: `series-${i}`.padEnd(nameLen, "x"),
      points: [{ x: 0, y: 1 }, { x: 1, y: 2 }],
    })),
  },
})

const pieSpec: ChartSpec = {
  type: "pie",
  data: { slices: [{ label: "a", value: 1 }, { label: "b", value: 2 }] },
}

describe("layoutLegendRows", () => {
  it("keeps a short legend on one row", () => {
    expect(layoutLegendRows(["aa", "bb", "cc"], 1000)).toHaveLength(1)
  })

  it("wraps a legend that does not fit the width", () => {
    const names = Array.from({ length: 20 }, (_, i) => `long-series-name-${i}`)
    expect(layoutLegendRows(names, 300).length).toBeGreaterThan(1)
  })
})

describe("computePlot", () => {
  it("yields a non-empty plot rectangle inside the canvas", () => {
    const p = computePlot(900, 520, true, 1, true, false, true, true)
    expect(p.left).toBeGreaterThan(0)
    expect(p.right).toBeLessThan(900)
    expect(p.top).toBeGreaterThan(0)
    expect(p.bottom).toBeLessThan(520)
    expect(p.w).toBeGreaterThan(0)
    expect(p.h).toBeGreaterThan(0)
  })

  it("reserves more vertical space as legend rows grow", () => {
    const one = computePlot(900, 520, true, 1, true, false, false, false)
    const four = computePlot(900, 520, true, 4, true, false, false, false)
    expect(four.top).toBeGreaterThan(one.top)
  })
})

describe("barTickLayout", () => {
  it("keeps short labels horizontal in a 26px band", () => {
    const l = barTickLayout(["a", "b", "c"], 900)
    expect(l.rotate).toBe(false)
    expect(l.tickBandH).toBe(26)
  })

  it("rotates crowded labels and sizes the band to the overhang (no clip regression)", () => {
    // Many long category names at a narrow width: labels must rotate, and the
    // band must be tall enough to contain a -30deg label's vertical overhang —
    // a fixed 50px band used to let long labels spill past the canvas bottom.
    const cats = Array.from({ length: 10 }, (_, i) => `namespace-prefix-${i}-long`)
    const l = barTickLayout(cats, 720)
    expect(l.rotate).toBe(true)
    expect(l.tickBandH).toBeGreaterThan(50)
  })

  it("reserves left margin so a long first rotated label is not clipped", () => {
    const cats = [
      "very-long-left-edge-category-name",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]
    const l = barTickLayout(cats, 460, { hasYAxisLabel: true })
    expect(l.rotate).toBe(true)
    expect(l.sidePaddingLeft).toBeGreaterThan(0)

    const plot = computePlot(460, 520, true, 0, true, true, true, true, l.tickBandH, {
      left: l.sidePaddingLeft,
      right: l.sidePaddingRight,
    })
    const firstAnchor = plot.left + plot.w / cats.length / 2
    const firstLabelLeft =
      firstAnchor - approxTextWidth(cats[0], 12) * Math.cos((BAR_TICK_ROTATE_DEG * Math.PI) / 180)
    expect(firstLabelLeft).toBeGreaterThanOrEqual(6)
  })

  it("makes chartCanvasSize grow the canvas to fit a tall rotated tick band", () => {
    const cats = Array.from({ length: 10 }, (_, i) => `namespace-prefix-${i}-long`)
    const spec: ChartSpec = {
      type: "bar",
      data: { categories: cats, series: [{ name: "s", values: cats.map(() => 1) }] },
    }
    const { height } = chartCanvasSize(spec, 720)
    expect(height).toBeGreaterThan(520)
  })
})

describe("legendRowsFor", () => {
  it("returns 0 for a single-series chart and for pie", () => {
    expect(legendRowsFor(barSpec(1), 900)).toBe(0)
    expect(legendRowsFor(pieSpec, 900)).toBe(0)
  })

  it("returns >=1 for a multi-series bar/line chart", () => {
    expect(legendRowsFor(barSpec(3), 900)).toBeGreaterThanOrEqual(1)
    expect(legendRowsFor(lineSpec(3), 900)).toBeGreaterThanOrEqual(1)
  })
})

describe("chartCanvasSize", () => {
  it("falls back to the spec width before the container is measured", () => {
    expect(chartCanvasSize(lineSpec(2), null).width).toBe(900)
  })

  it("clamps the measured width to [300, specWidth]", () => {
    expect(chartCanvasSize(lineSpec(2), 100).width).toBe(300)
    expect(chartCanvasSize(lineSpec(2), 2000).width).toBe(900)
    expect(chartCanvasSize(lineSpec(2), 480).width).toBe(480)
  })

  it("never shrinks height below the spec height — the plot-collapse regression guard", () => {
    // A narrow width forces the 10-series legend to wrap; height must GROW to
    // keep the plot area, never scale down (which collapsed it to a sliver).
    for (const w of [320, 400, 600, 900, null]) {
      const { height } = chartCanvasSize(lineSpec(10), w)
      expect(height).toBeGreaterThanOrEqual(520)
    }
  })

  it("grows height when the legend wraps onto extra rows", () => {
    const wide = chartCanvasSize(lineSpec(10), 900)
    const narrow = chartCanvasSize(lineSpec(10), 320)
    expect(narrow.legendRows).toBeGreaterThan(wide.legendRows)
    expect(narrow.height).toBeGreaterThan(wide.height)
  })

  it("returns a legendRows count consistent with legendRowsFor at the resolved width", () => {
    const { width, legendRows } = chartCanvasSize(lineSpec(8), 500)
    expect(legendRows).toBe(legendRowsFor(lineSpec(8), width))
  })
})

describe("collectChartValues", () => {
  it("flattens bar values and line y-values, and is empty for pie", () => {
    expect(collectChartValues(barSpec(2)).sort()).toEqual([1, 1, 2, 2])
    expect(collectChartValues(lineSpec(1))).toEqual([1, 2])
    expect(collectChartValues(pieSpec)).toEqual([])
  })
})

describe("series style cycling", () => {
  it("cycles dash patterns and marker shapes by index", () => {
    expect(seriesDash(0)).toBe(seriesDash(5))
    expect(seriesShape(0)).toBe(seriesShape(4))
    expect(seriesShape(0)).not.toBe(seriesShape(1))
  })
})
