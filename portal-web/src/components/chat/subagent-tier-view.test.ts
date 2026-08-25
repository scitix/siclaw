import { describe, it, expect } from "vitest"
import { extractTierOutcome, tierBadge } from "./subagent-tier-view"

describe("extractTierOutcome", () => {
  it("reads the FOREGROUND shape (flattened snake_case on item_results)", () => {
    expect(extractTierOutcome({
      requested_tier: "fast",
      resolved_tier: "fast",
      selection_source: "request",
      effective_provider: "p",
      effective_model_id: "m",
    }, undefined)).toEqual({
      requestedTier: "fast",
      resolvedTier: "fast",
      selectionSource: "request",
      fallbackReason: undefined,
    })
  })

  it("reads the BACKGROUND shape (nested under tier on the persisted event)", () => {
    // The only record a detached run ever has: its tool call returned `launched`
    // before the outcome existed.
    expect(extractTierOutcome(undefined, {
      tier: { requestedTier: "deep", resolvedTier: "deep", source: "type_default" },
    })).toEqual({
      requestedTier: "deep",
      resolvedTier: "deep",
      selectionSource: "type_default",
      fallbackReason: undefined,
    })
  })

  it("accepts the persisted outcome unwrapped too", () => {
    // Some callers hold the tier object itself rather than the event around it.
    expect(extractTierOutcome(undefined, { resolvedTier: "fast", source: "env" })).toEqual({
      requestedTier: undefined,
      resolvedTier: "fast",
      selectionSource: "env",
      fallbackReason: undefined,
    })
  })

  it("prefers the foreground value when both are present", () => {
    const view = extractTierOutcome(
      { requested_tier: "fast", resolved_tier: "fast", selection_source: "request" },
      { tier: { requestedTier: "deep", resolvedTier: "deep", source: "env" } },
    )
    expect(view).toMatchObject({ requestedTier: "fast", selectionSource: "request" })
  })

  it("returns undefined when no tier was involved — the common case", () => {
    // A badge on every item of every batch would be noise, and "no tier" is not a
    // diagnostic.
    expect(extractTierOutcome({ status: "done", summary: "ok" }, undefined)).toBeUndefined()
    expect(extractTierOutcome(undefined, undefined)).toBeUndefined()
    expect(extractTierOutcome(undefined, { tier: {} })).toBeUndefined()
  })

  it("ignores non-object and blank inputs rather than throwing", () => {
    for (const raw of [null, 42, "tier", [], { requested_tier: "  " }]) {
      expect(extractTierOutcome(raw, raw)).toBeUndefined()
    }
  })
})

describe("tierBadge", () => {
  it("shows requested → actual on a fallback, because the difference IS the diagnostic", () => {
    const badge = tierBadge({
      requestedTier: "fast",
      resolvedTier: undefined,
      selectionSource: "request",
      fallbackReason: "candidate_missing",
    })
    expect(badge).toMatchObject({ fellBack: true, text: "fast → agent default" })
    expect(badge!.title).toContain("tier had no model configured")
  })

  it("shows just the tier when it applied", () => {
    expect(tierBadge({ resolvedTier: "fast", requestedTier: "fast", selectionSource: "request" }))
      .toMatchObject({ fellBack: false, text: "fast" })
  })

  it("marks an operator-pinned tier, since it explains a choice the agent did not make", () => {
    const badge = tierBadge({ requestedTier: "fast", resolvedTier: "fast", selectionSource: "env" })
    expect(badge!.text).toContain("pinned")
    expect(badge!.title).toContain("pinned by deployment")
  })

  it("renders an UNKNOWN reason verbatim instead of hiding it", () => {
    // A reason we have no wording for is still information; swallowing it would
    // leave a fallback with no explanation at all.
    const badge = tierBadge({
      requestedTier: "fast",
      resolvedTier: undefined,
      fallbackReason: "some_future_reason",
    })
    expect(badge!.title).toContain("some_future_reason")
  })

  it("renders nothing without a tier", () => {
    expect(tierBadge(undefined)).toBeNull()
    expect(tierBadge({})).toBeNull()
  })
})
