import { describe, it, expect } from "vitest"
import {
  EMPTY_SELECTION,
  isSelected,
  selectVisible,
  toggleMessage,
  selectAll,
  selectedIds,
  selectedCount,
} from "./selection-model"

const ids = (s: Parameters<typeof selectedIds>[0]) => [...selectedIds(s)].sort()

describe("selection-model (visibility accumulate)", () => {
  it("selects nothing by default", () => {
    expect(selectedCount(EMPTY_SELECTION)).toBe(0)
  })

  it("auto-selects whatever is currently visible", () => {
    const s = selectVisible(EMPTY_SELECTION, ["b", "c"])
    expect(ids(s)).toEqual(["b", "c"])
  })

  it("accumulates as new messages scroll into view (up or down)", () => {
    let s = selectVisible(EMPTY_SELECTION, ["c", "d"]) // initial screenful
    s = selectVisible(s, ["d", "e"]) // scroll down
    s = selectVisible(s, ["a", "b"]) // scroll up past the start
    expect(ids(s)).toEqual(["a", "b", "c", "d", "e"])
  })

  it("returns the same state object when nothing new becomes visible", () => {
    const s = selectVisible(EMPTY_SELECTION, ["a", "b"])
    expect(selectVisible(s, ["a", "b"])).toBe(s)
  })

  it("un-checking excludes a message and scrolling past it won't re-select it", () => {
    let s = selectVisible(EMPTY_SELECTION, ["a", "b", "c"])
    s = toggleMessage(s, "b") // user un-checks b
    expect(ids(s)).toEqual(["a", "c"])
    s = selectVisible(s, ["a", "b", "c"]) // scroll past b again
    expect(ids(s)).toEqual(["a", "c"]) // stays excluded
  })

  it("re-checking clears the exclusion", () => {
    let s = selectVisible(EMPTY_SELECTION, ["a"])
    s = toggleMessage(s, "a") // off
    expect(isSelected(s, "a")).toBe(false)
    s = toggleMessage(s, "a") // on again
    expect(isSelected(s, "a")).toBe(true)
    s = selectVisible(s, ["a"]) // and stays on while visible
    expect(isSelected(s, "a")).toBe(true)
  })

  it("toggle works on a not-yet-seen message", () => {
    const s = toggleMessage(EMPTY_SELECTION, "z")
    expect(ids(s)).toEqual(["z"])
  })

  it("selectAll selects all and resets exclusions", () => {
    let s = selectVisible(EMPTY_SELECTION, ["a"])
    s = toggleMessage(s, "a") // exclude a
    s = selectAll(["a", "b", "c"])
    expect(ids(s)).toEqual(["a", "b", "c"])
    // exclusion cleared: scrolling keeps everything
    expect(selectVisible(s, ["a", "b", "c"])).toBe(s)
  })
})
