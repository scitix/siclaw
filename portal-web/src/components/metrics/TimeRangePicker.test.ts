import { describe, it, expect } from "vitest"
import { buildMonthGrid, extractTime } from "./TimeRangePicker"

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate()

describe("extractTime", () => {
  it("pulls HH:mm from a `date HH:mm` draft", () => {
    expect(extractTime("2026-06-15 10:30")).toBe("10:30")
  })

  it("drops the seconds field instead of matching it", () => {
    // Regression: a trailing-anchored regex matched "30:45" out of "10:30:45".
    expect(extractTime("2026-06-15 10:30:45")).toBe("10:30")
  })

  it("handles an ISO `T`-separated draft, dropping seconds/timezone", () => {
    expect(extractTime("2026-06-15T10:30:45Z")).toBe("10:30")
    expect(extractTime("2026-06-15T08:05")).toBe("08:05")
  })

  it("keeps single-digit hours intact", () => {
    expect(extractTime("2026-06-15 9:30:45")).toBe("9:30")
  })

  it("returns '' when there is no time-of-day", () => {
    expect(extractTime("now-7d")).toBe("")
    expect(extractTime("now")).toBe("")
    expect(extractTime("2026-06-15")).toBe("")
    expect(extractTime("")).toBe("")
  })
})

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
