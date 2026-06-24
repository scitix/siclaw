import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { CapabilityGroupSelector } from "./CapabilityGroupSelector"
import { CAPABILITY_GROUPS } from "../lib/toolCapabilities"

// portal-web ships neither @testing-library/react nor a DOM environment
// (jsdom/happy-dom), so we cannot dispatch click/change events to exercise the
// toggle / Select All / Clear onChange callbacks here. Those handlers are thin
// Set operations over `selected`; rather than re-derive them in the test, we
// assert the component's *render contract* against react-dom/server (already a
// dependency): banner state, group/tool counts, and per-group checkbox
// reflection — everything that is a pure function of the `selected` prop.
// Adding a DOM env to cover the callbacks would mean a new dependency, which
// this phase explicitly avoids.

const render = (selected: Set<string>) =>
  renderToStaticMarkup(<CapabilityGroupSelector selected={selected} onChange={() => {}} />)

// A controlled checkbox renders `checked=""` in static markup; count them to
// verify the box state reflects `selected` exactly.
const countChecked = (html: string) => (html.match(/checked=""/g) || []).length

// react-dom/server HTML-escapes text nodes (e.g. "&" → "&amp;"); match the
// escaped form when asserting label text.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

describe("CapabilityGroupSelector — render contract", () => {
  it("shows the Unrestricted banner and no checked boxes for an empty selection", () => {
    const html = render(new Set())
    expect(html).toContain("Unrestricted")
    expect(html).not.toContain("Restricted")
    expect(html).toContain("agent can use ALL tools")
    expect(html).toContain("Capability groups (0 / 10)")
    expect(countChecked(html)).toBe(0)
  })

  it("shows the Restricted banner with the singular group label + tool count", () => {
    const html = render(new Set(["read_files"]))
    expect(html).toContain("Restricted")
    expect(html).not.toContain("Unrestricted")
    // read_files grants 4 tools; "1 group" must be singular.
    expect(html).toContain("1 group · 4 tools")
    expect(html).toContain("Capability groups (1 / 10)")
    expect(countChecked(html)).toBe(1)
  })

  it("pluralizes groups and sums the deduped tool count for a multi-group selection", () => {
    const html = render(new Set(["read_files", "run_commands"]))
    // 4 + 4 distinct tools, plural "groups".
    expect(html).toContain("2 groups · 8 tools")
    expect(html).toContain("Capability groups (2 / 10)")
    expect(countChecked(html)).toBe(2)
  })

  it("checks every box and reports all groups when the full set is selected", () => {
    const all = new Set(CAPABILITY_GROUPS.map((g) => g.key))
    const html = render(all)
    expect(html).toContain(`Capability groups (${CAPABILITY_GROUPS.length} / ${CAPABILITY_GROUPS.length})`)
    expect(html).toContain(`${CAPABILITY_GROUPS.length} groups`)
    expect(countChecked(html)).toBe(CAPABILITY_GROUPS.length)
  })

  it("renders every group's name, description and tool chips", () => {
    const html = render(new Set())
    for (const g of CAPABILITY_GROUPS) {
      expect(html).toContain(esc(g.name))
      expect(html).toContain(esc(g.description))
      for (const tool of g.tools) {
        expect(html).toContain(`>${tool}<`)
      }
    }
  })

  it("states the MCP-exemption rule", () => {
    const html = render(new Set())
    expect(html).toContain("MCP server tools are controlled separately")
  })
})
