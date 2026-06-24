import { describe, it, expect } from "vitest"
import { isRelativeExpr, resolveRange, isValidRange, rangeLabel, ENTRY_MODES, ENTRY_LABELS, originLabel } from "./useMetrics"

describe("entry axis", () => {
  it("exposes the overview + four entry forms + scheduled", () => {
    expect(ENTRY_MODES).toEqual(["all", "web", "api", "a2a", "channel", "scheduled"])
  })

  it("labels every mode (Overview for the combined view)", () => {
    expect(ENTRY_LABELS.all).toBe("Overview")
    expect(ENTRY_LABELS.web).toBe("Web")
    expect(ENTRY_LABELS.scheduled).toBe("Scheduled")
    for (const m of ENTRY_MODES) expect(ENTRY_LABELS[m]).toBeTruthy()
  })
})

describe("originLabel", () => {
  it("maps null/empty/'web' origin to Web", () => {
    expect(originLabel(null)).toBe("Web")
    expect(originLabel("")).toBe("Web")
    expect(originLabel("web")).toBe("Web")
  })
  it("maps the raw origin values to display labels", () => {
    expect(originLabel("api")).toBe("API")
    expect(originLabel("a2a")).toBe("A2A")
    expect(originLabel("channel")).toBe("Channel")
    expect(originLabel("task")).toBe("Scheduled")
    expect(originLabel("delegation")).toBe("Delegation")
  })
  it("passes through an unknown origin verbatim", () => {
    expect(originLabel("future-mode")).toBe("future-mode")
  })
})

describe("isRelativeExpr", () => {
  it("accepts `now` and `now-<n><unit>`", () => {
    expect(isRelativeExpr("now")).toBe(true)
    expect(isRelativeExpr("now-30m")).toBe(true)
    expect(isRelativeExpr("now-7d")).toBe(true)
    expect(isRelativeExpr("  now-12h  ")).toBe(true)
  })

  it("rejects absolute strings and garbage", () => {
    expect(isRelativeExpr("2026-06-15")).toBe(false)
    expect(isRelativeExpr("now+1h")).toBe(false)
    expect(isRelativeExpr("now-5x")).toBe(false) // unsupported unit
    expect(isRelativeExpr("")).toBe(false)
  })
})

describe("resolveRange", () => {
  it("resolves a relative window to an exact span (single `now` for both bounds)", () => {
    const { fromMs, toMs } = resolveRange({ from: "now-1h", to: "now" })
    expect(toMs - fromMs).toBe(3_600_000)
  })

  it("resolves absolute ISO bounds to their parsed ms", () => {
    const from = "2026-06-01T00:00:00Z"
    const to = "2026-06-02T00:00:00Z"
    const { fromMs, toMs } = resolveRange({ from, to })
    expect(fromMs).toBe(Date.parse(from))
    expect(toMs).toBe(Date.parse(to))
  })

  it("falls back to a trailing 7d window on unparseable input", () => {
    const { fromMs, toMs } = resolveRange({ from: "garbage", to: "now" })
    expect(toMs - fromMs).toBe(7 * 86_400_000)
  })
})

describe("isValidRange", () => {
  it("is true when both parse and from < to", () => {
    expect(isValidRange({ from: "2026-06-01", to: "2026-06-02" })).toBe(true)
    expect(isValidRange({ from: "now-1h", to: "now" })).toBe(true)
  })

  it("is false when from >= to", () => {
    expect(isValidRange({ from: "2026-06-02", to: "2026-06-01" })).toBe(false)
    expect(isValidRange({ from: "2026-06-01", to: "2026-06-01" })).toBe(false)
  })

  it("is false when a bound is unparseable", () => {
    expect(isValidRange({ from: "garbage", to: "2026-06-02" })).toBe(false)
    expect(isValidRange({ from: "2026-06-01", to: "garbage" })).toBe(false)
  })
})

describe("rangeLabel", () => {
  it("shows a quick range's canned label", () => {
    expect(rangeLabel({ from: "now-30m", to: "now" })).toBe("Last 30 minutes")
    expect(rangeLabel({ from: "now-7d", to: "now" })).toBe("Last 7 days")
  })

  it("passes a non-canned relative range through verbatim", () => {
    expect(rangeLabel({ from: "now-99h", to: "now" })).toBe("now-99h → now")
  })
})
