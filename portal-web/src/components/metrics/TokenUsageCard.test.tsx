import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { TokenUsageCard } from "./TokenUsageCard"
import type { TokenUsageData, UsageActor, UsageGroup } from "../../hooks/useMetrics"

// portal-web ships no DOM environment, so this asserts the RENDER CONTRACT via
// react-dom/server. That is the right level here anyway: every rule under test
// is about what a number on screen claims, not about interaction.

const totals = (total: number | null, reportedCalls: number) => ({ total, reportedCalls })

const group = (over: Partial<UsageGroup> = {}): UsageGroup => ({
  provider: "example-gateway", modelId: "gpt-5", apiType: "openai-responses",
  calls: 2,
  input: totals(3_000, 2), output: totals(300, 2), reasoning: totals(null, 0),
  cacheRead: totals(500, 2), cacheWrite: totals(600, 2),
  billable: 3_300,
  ...over,
})

const actor = (over: Partial<UsageActor> = {}): UsageActor => ({
  kind: "user", id: "user-a", calls: 2,
  input: totals(3_000, 2), output: totals(300, 2),
  cacheRead: totals(500, 2), cacheWrite: totals(600, 2),
  billable: 3_300, mixedProtocols: false,
  ...over,
})

const data = (over: Partial<TokenUsageData> = {}): TokenUsageData => ({
  from: "2026-09-01T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z",
  sort: "billable",
  models: [group()], actors: [actor()],
  coverage: { trustworthy: 2, excluded: 0 },
  ...over,
})

const render = (d: TokenUsageData | null, sort: TokenUsageData["sort"] = "billable") =>
  renderToStaticMarkup(
    <TokenUsageCard data={d} loading={false} rangeLabel="last 7d" sort={sort} onSort={() => {}} />,
  )

describe("TokenUsageCard", () => {
  it("shows a dash for a field nothing reported — never a zero", () => {
    // The collection side kept "reported 0" and "never reported" apart through
    // the whole pipeline; painting the second as 0 here would undo it at the
    // last step, and the reader would take it as a measured fact.
    const html = render(data({
      models: [group({ cacheWrite: totals(null, 0), billable: null })],
      actors: [],
    }))
    expect(html).toContain("—")
    expect(html).toContain("No call in this row reported this field")
  })

  it("keeps a reported zero as 0, distinct from the dash", () => {
    const html = render(data({
      models: [group({ cacheRead: totals(0, 2), cacheWrite: totals(null, 0) })],
      actors: [],
    }))
    expect(html).toContain(">0<")   // the reported zero renders as a number
    expect(html).toContain("—")     // the unreported field does not
  })

  it("marks a sum taken over fewer calls than the row has", () => {
    // Otherwise a partial sum is visually identical to a complete one.
    const html = render(data({
      models: [group({ calls: 5, cacheWrite: totals(600, 1) })],
      actors: [],
    }))
    expect(html).toContain("Summed over 1 of 5 calls")
    expect(html).toContain("summed over only the calls that reported that")
  })

  it("says so when an unpriceable total is unknown rather than zero", () => {
    const html = render(data({ models: [group({ billable: null })], actors: [] }))
    expect(html).toContain("the total is unknown")
  })

  it("states coverage when calls were excluded from the figures", () => {
    const html = render(data({ coverage: { trustworthy: 7, excluded: 3 } }))
    expect(html).toContain("7/10 measured")
  })

  it("breaks users out with the four token columns", () => {
    const html = render(data({ actors: [actor({ id: "ou_alice", kind: "channel" })] }))
    expect(html).toContain("By user")
    expect(html).toContain("ou_alice")
    expect(html).toContain("channel sender")
    for (const label of ["Input", "Output", "Cache write", "Cache read"]) {
      expect(html).toContain(label)
    }
  })

  it("flags an actor whose calls span protocols that bill cache differently", () => {
    const html = render(data({ actors: [actor({ mixedProtocols: true })] }))
    expect(html).toContain("bill cache differently")
  })

  it("marks the active sort column, so the ranking basis is visible", () => {
    const html = render(data(), "cacheWrite")
    // The heading carries the marker; which column it sits on is what tells the
    // reader what the rows are ordered by.
    expect(html).toMatch(/Cache write<span[^>]*>↓<\/span>/)
  })

  it("says the window is empty rather than rendering an empty table", () => {
    const html = render(data({ models: [], actors: [] }))
    expect(html).toContain("No measured calls in this window")
  })
})
