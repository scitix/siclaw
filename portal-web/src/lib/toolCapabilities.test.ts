import { describe, it, expect } from "vitest"
import {
  CAPABILITY_GROUPS,
  countToolsForSelection,
  toCapabilitySet,
} from "./toolCapabilities"

const KNOWN_KEYS = CAPABILITY_GROUPS.map((g) => g.key)

describe("CAPABILITY_GROUPS shape", () => {
  it("declares exactly the 11 designed groups", () => {
    expect(CAPABILITY_GROUPS).toHaveLength(11)
    expect([...KNOWN_KEYS].sort()).toEqual([
      "delegate_agents",
      "inspect_infra",
      "plan_tasks",
      "read_files",
      "run_commands",
      "run_scripts",
      "scheduling",
      "search_memory",
      "session_output",
      "spawn_subagents",
      "write_sandbox",
    ])
  })

  it("has unique group keys", () => {
    expect(new Set(KNOWN_KEYS).size).toBe(KNOWN_KEYS.length)
  })

  it("gives every group a non-empty, internally-unique tool list, a name and a description", () => {
    for (const g of CAPABILITY_GROUPS) {
      expect(g.tools.length).toBeGreaterThan(0)
      expect(new Set(g.tools).size).toBe(g.tools.length)
      expect(g.name.trim()).not.toBe("")
      expect(g.description.trim()).not.toBe("")
    }
  })

  it("assigns each tool to exactly one group (no cross-group overlap)", () => {
    const all = CAPABILITY_GROUPS.flatMap((g) => g.tools)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("toCapabilitySet", () => {
  it("returns an empty Set for null / undefined / non-array, non-string values", () => {
    expect(toCapabilitySet(null).size).toBe(0)
    expect(toCapabilitySet(undefined).size).toBe(0)
    expect(toCapabilitySet(123).size).toBe(0)
    expect(toCapabilitySet({}).size).toBe(0)
    expect(toCapabilitySet(true).size).toBe(0)
  })

  it("accepts an already-parsed array of known keys", () => {
    expect(toCapabilitySet(["read_files", "run_commands"])).toEqual(
      new Set(["read_files", "run_commands"]),
    )
  })

  it("filters unknown keys and non-string entries out of an array", () => {
    expect(toCapabilitySet(["read_files", "does_not_exist", 42, null, "scheduling"])).toEqual(
      new Set(["read_files", "scheduling"]),
    )
  })

  it("parses the raw JSON-string wire form (GET returns TEXT, not an array)", () => {
    // Regression: the portal API returns tool_capabilities as the raw TEXT
    // column — a JSON string, not a decoded array. Echo must still work.
    expect(toCapabilitySet('["read_files","run_commands"]')).toEqual(
      new Set(["read_files", "run_commands"]),
    )
  })

  it("filters unknown keys out of the JSON-string form too", () => {
    expect(toCapabilitySet('["read_files","ghost"]')).toEqual(new Set(["read_files"]))
  })

  it("returns an empty Set for a malformed JSON string", () => {
    expect(toCapabilitySet("not json").size).toBe(0)
    expect(toCapabilitySet("[unterminated").size).toBe(0)
  })

  it("returns an empty Set when a JSON string parses to a non-array", () => {
    expect(toCapabilitySet('"read_files"').size).toBe(0)
    expect(toCapabilitySet("123").size).toBe(0)
    expect(toCapabilitySet("null").size).toBe(0)
    expect(toCapabilitySet('{"read_files":true}').size).toBe(0)
  })

  it("treats an empty selection (array or JSON string) as the empty Set", () => {
    expect(toCapabilitySet([]).size).toBe(0)
    expect(toCapabilitySet("[]").size).toBe(0)
  })
})

describe("countToolsForSelection", () => {
  it("is 0 for an empty selection", () => {
    expect(countToolsForSelection(new Set())).toBe(0)
  })

  it("counts a single group's tools", () => {
    expect(countToolsForSelection(new Set(["read_files"]))).toBe(4)
    expect(countToolsForSelection(new Set(["scheduling"]))).toBe(1)
  })

  it("counts the deduped union across multiple groups", () => {
    // read_files (4) + search_memory (2), no shared tools → 6 distinct.
    expect(countToolsForSelection(new Set(["read_files", "search_memory"]))).toBe(6)
  })

  it("ignores unknown keys in the selection", () => {
    expect(countToolsForSelection(new Set(["read_files", "ghost"]))).toBe(4)
    expect(countToolsForSelection(new Set(["ghost"]))).toBe(0)
  })

  it("counts every distinct built-in tool when all groups are selected", () => {
    const all = countToolsForSelection(new Set(KNOWN_KEYS))
    const distinct = new Set(CAPABILITY_GROUPS.flatMap((g) => g.tools)).size
    expect(all).toBe(distinct)
    // Groups never share a tool, so the union equals the simple sum.
    const sum = CAPABILITY_GROUPS.reduce((n, g) => n + g.tools.length, 0)
    expect(all).toBe(sum)
  })
})
