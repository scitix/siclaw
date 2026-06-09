import { describe, it, expect } from "vitest"
import {
  EMPTY_SELECTION,
  isSelected,
  selectFollowing,
  toggleMessage,
  toggleFollowing,
  selectedIds,
  selectedCount,
} from "./selection-model"

const ids = (s: Parameters<typeof selectedIds>[0]) => [...selectedIds(s)].sort()

describe("selection-model (explicit following range)", () => {
  it("selects nothing by default", () => {
    expect(selectedCount(EMPTY_SELECTION)).toBe(0)
  })

  it("selects all loaded messages from the chosen divider", () => {
    const s = selectFollowing(["a", "b", "c", "d"], 2)
    expect(ids(s)).toEqual(["c", "d"])
  })

  it("clamps out-of-range dividers", () => {
    expect(ids(selectFollowing(["a", "b"], -1))).toEqual(["a", "b"])
    expect(ids(selectFollowing(["a", "b"], 99))).toEqual([])
  })

  it("replacing the range clears previous manual exclusions", () => {
    let s = selectFollowing(["a", "b", "c"], 0)
    s = toggleMessage(s, "b")
    expect(ids(s)).toEqual(["a", "c"])
    s = selectFollowing(["a", "b", "c"], 1)
    expect(ids(s)).toEqual(["b", "c"])
  })

  it("un-checking excludes a message from the current range", () => {
    let s = selectFollowing(["a", "b", "c"], 0)
    s = toggleMessage(s, "b")
    expect(ids(s)).toEqual(["a", "c"])
  })

  it("re-checking clears the exclusion", () => {
    let s = selectFollowing(["a"], 0)
    s = toggleMessage(s, "a") // off
    expect(isSelected(s, "a")).toBe(false)
    s = toggleMessage(s, "a") // on again
    expect(isSelected(s, "a")).toBe(true)
  })

  it("toggle works on a not-yet-seen message", () => {
    const s = toggleMessage(EMPTY_SELECTION, "z")
    expect(ids(s)).toEqual(["z"])
  })

  it("toggleFollowing clears when the same range is already selected", () => {
    let s = toggleFollowing(["a", "b", "c"], 1, EMPTY_SELECTION)
    expect(ids(s)).toEqual(["b", "c"])
    s = toggleFollowing(["a", "b", "c"], 1, s)
    expect(ids(s)).toEqual([])
  })

  it("toggleFollowing replaces a previous range", () => {
    let s = toggleFollowing(["a", "b", "c"], 1, EMPTY_SELECTION)
    s = toggleFollowing(["a", "b", "c"], 0, s)
    expect(ids(s)).toEqual(["a", "b", "c"])
  })
})
