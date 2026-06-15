import { describe, it, expect } from "vitest"
import { buildMonthGrid } from "./TimeRangePicker"

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate()

describe("buildMonthGrid", () => {
  it("always returns a 42-cell (6×7) grid", () => {
    expect(buildMonthGrid(2026, 5)).toHaveLength(42)
    expect(buildMonthGrid(2026, 0)).toHaveLength(42)
  })

  it("first column is always Sunday-aligned", () => {
    // The first cell's date must fall on a Sunday for every month.
    // Anchor at local noon so a DST transition can't shift the weekday.
    for (let m = 0; m < 12; m++) {
      const first = buildMonthGrid(2026, m)[0]
      expect(new Date(first.iso + "T12:00").getDay()).toBe(0)
    }
  })

  it("marks exactly the in-month days, starting at 1", () => {
    const grid = buildMonthGrid(2026, 5) // June 2026
    const inMonth = grid.filter((c) => c.inMonth)
    expect(inMonth).toHaveLength(daysInMonth(2026, 5)) // 30
    expect(inMonth[0].day).toBe(1)
    expect(inMonth[0].iso).toBe("2026-06-01")
    expect(inMonth[inMonth.length - 1].day).toBe(30)
    expect(inMonth[inMonth.length - 1].iso).toBe("2026-06-30")
  })

  it("handles leap vs non-leap February", () => {
    expect(buildMonthGrid(2024, 1).filter((c) => c.inMonth)).toHaveLength(29)
    expect(buildMonthGrid(2025, 1).filter((c) => c.inMonth)).toHaveLength(28)
  })

  it("rolls over December into the next January", () => {
    const grid = buildMonthGrid(2026, 11) // Dec 2026
    expect(grid.some((c) => !c.inMonth && c.iso.startsWith("2027-01"))).toBe(true)
    expect(grid.filter((c) => c.inMonth)).toHaveLength(31)
  })

  it("rolls leading days back into the previous December for January", () => {
    const grid = buildMonthGrid(2026, 0) // Jan 2026
    expect(grid.some((c) => !c.inMonth && c.iso.startsWith("2025-12"))).toBe(true)
  })

  it("produces strictly contiguous calendar days", () => {
    // Anchor at local noon + round so a DST 23h/25h day still reads as +1 day.
    const grid = buildMonthGrid(2026, 1)
    for (let i = 1; i < grid.length; i++) {
      const prev = new Date(grid[i - 1].iso + "T12:00").getTime()
      const cur = new Date(grid[i].iso + "T12:00").getTime()
      expect(Math.round((cur - prev) / 86_400_000)).toBe(1)
    }
  })
})
