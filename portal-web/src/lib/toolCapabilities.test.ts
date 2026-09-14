import { describe, it, expect } from "vitest"
import {
  CAPABILITY_GROUPS,
  countToolsForSelection,
  toCapabilitySet,
} from "./toolCapabilities"

const KNOWN_KEYS = CAPABILITY_GROUPS.map((g) => g.key)

describe("CAPABILITY_GROUPS shape", () => {
  it("declares the designed capability groups, including conversation handoff", () => {
    expect([...KNOWN_KEYS].sort()).toEqual([
      "inspect_infra",
      "no_tools",
      "plan_tasks",
      "read_files",
      "run_commands",
      "run_local_scripts",
      "run_sandbox",
      "run_scripts",
      "scheduling",
      "search_memory",
      "session_output",
      "spawn_subagents",
      "transfer_conversation",
      "write_sandbox",
    ])
  })

  it("has unique group keys", () => {
    expect(new Set(KNOWN_KEYS).size).toBe(KNOWN_KEYS.length)
  })

  it("gives each group a unique tool list, including the explicit zero-tool group", () => {
    for (const g of CAPABILITY_GROUPS) {
      if (g.key === "no_tools") expect(g.tools).toEqual([])
      else expect(g.tools.length).toBeGreaterThan(0)
      expect(new Set(g.tools).size).toBe(g.tools.length)
      expect(g.name.trim()).not.toBe("")
      expect(g.description.trim()).not.toBe("")
    }
  })

  it("shares local_script only between the local subset and the existing script group", () => {
    const all = CAPABILITY_GROUPS.flatMap((g) => g.tools)
    expect(all.filter((tool, index) => all.indexOf(tool) !== index)).toEqual(["local_script"])
    expect(countToolsForSelection(new Set(["run_local_scripts", "run_scripts"]))).toBe(4)
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
    expect(countToolsForSelection(new Set(["read_files"]))).toBe(6)
    expect(countToolsForSelection(new Set(["scheduling"]))).toBe(1)
  })

  it("counts the deduped union across multiple groups", () => {
    // read_files (6) + search_memory (2), no shared tools → 8 distinct.
    expect(countToolsForSelection(new Set(["read_files", "search_memory"]))).toBe(8)
  })

  it("ignores unknown keys in the selection", () => {
    expect(countToolsForSelection(new Set(["read_files", "ghost"]))).toBe(6)
    expect(countToolsForSelection(new Set(["ghost"]))).toBe(0)
  })

  it("counts every distinct built-in tool when all groups are selected", () => {
    const all = countToolsForSelection(new Set(KNOWN_KEYS))
    const distinct = new Set(CAPABILITY_GROUPS.flatMap((g) => g.tools)).size
    expect(all).toBe(distinct)
    // The local subset adds no tools when the full script group is selected.
    const withoutSubset = new Set(KNOWN_KEYS.filter((key) => key !== "run_local_scripts"))
    expect(all).toBe(countToolsForSelection(withoutSubset))
  })
})
