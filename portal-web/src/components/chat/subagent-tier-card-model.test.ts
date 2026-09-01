/**
 * Persisted event → fold → card model → badge, for every sub-agent form.
 *
 * `subagent-tier-view.test.ts` covers `extractTierOutcome` in isolation, and that
 * was not enough: the extractor was correct while three of the four forms handed it
 * an object with no tier in it, so the badge never rendered.
 *
 *   FOREGROUND single — the card read `item_results[0]` off the MODEL-VISIBLE
 *     content, where the tier fields deliberately do not exist (they name a
 *     provider and a model). They live only under `toolDetails`.
 *   BACKGROUND single — `annotateSubagentCompletions` reduced the terminal event to
 *     {status, summary}.
 *   BACKGROUND group — `annotateGroupCompletions` reduced child events and the
 *     `item_statuses` snapshot the same way.
 *
 * All four are driven here from raw persisted rows through the real
 * `buildPilotMessages` pipeline, so a fold that drops the field fails this file
 * rather than passing every unit test and shipping a blank badge.
 */
import { describe, it, expect } from "vitest"
import { buildPilotMessages, type ChatMessage } from "../../hooks/usePilotChat"
import { agentWorkSummary, groupWorkSummary } from "./PilotArea"

/** The nested shape the runtime persists on a terminal event. */
const TIER_FAST = { requestedTier: "fast", resolvedTier: "fast", source: "request" }
/** A fallback, where requested and resolved disagree — the case the badge exists for. */
const TIER_FELLBACK = {
  requestedTier: "fast",
  resolvedTier: null,
  source: "request",
  fallbackReason: "candidate_missing",
}

function row(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "tool",
    content: "",
    metadata: {},
    created_at: new Date().toISOString(),
    ...partial,
  } as unknown as ChatMessage
}

describe("foreground single spawn", () => {
  it("renders the badge from toolDetails, not from the model-visible content", () => {
    // The two item_results differ ON PURPOSE: content is what the model sees and
    // must not name a model; details is the UI's copy. Reading content gave the
    // most common path no badge at all.
    const msgs = buildPilotMessages([
      row({
        id: "fg-1",
        tool_name: "spawn_subagent",
        tool_input: JSON.stringify({ description: "read logs", items: [{ task: "read logs" }] }),
        content: JSON.stringify({
          status: "done",
          item_results: [{ item: "read logs", status: "done", summary: "found it" }],
        }),
        // Persisted tool details live in `metadata` and surface as `toolDetails`
        // (usePilotChat maps them from the same object) — there is no separate
        // column, so this is the shape a reload actually produces.
        metadata: {
          item_results: [
            {
              item: "read logs",
              status: "done",
              summary: "found it",
              requested_tier: "fast",
              resolved_tier: "fast",
              selection_source: "request",
            },
          ],
        },
      }),
    ])

    const card = agentWorkSummary(msgs.find((m) => m.toolName === "spawn_subagent")!)
    expect(card.tier).toMatchObject({ requestedTier: "fast", resolvedTier: "fast" })
  })
})

describe("background single spawn", () => {
  function rows(tier: unknown) {
    return [
      row({
        id: "launch-j1",
        tool_name: "spawn_subagent",
        tool_input: JSON.stringify({ description: "read logs", items: [{ task: "read logs" }] }),
        content: JSON.stringify({ status: "launched", job_id: "j1" }),
      }),
      row({
        id: "term-j1",
        role: "user",
        content: "done reading",
        metadata: { kind: "delegation_event", delegation_id: "j1", status: "done", tier },
      }),
    ]
  }

  it("carries the tier from the persisted terminal event onto the launch card", () => {
    // The launch returned `launched` before any tier was resolved, so this event is
    // the ONLY record of which model ran — surviving the fold is the whole point.
    const msgs = buildPilotMessages(rows(TIER_FAST) as ChatMessage[])
    const card = agentWorkSummary(msgs.find((m) => m.toolName === "spawn_subagent")!)
    expect(card.tier).toMatchObject({ requestedTier: "fast", resolvedTier: "fast" })
  })

  it("carries a FALLBACK outcome, which is the one worth seeing", () => {
    const msgs = buildPilotMessages(rows(TIER_FELLBACK) as ChatMessage[])
    const card = agentWorkSummary(msgs.find((m) => m.toolName === "spawn_subagent")!)
    expect(card.tier).toMatchObject({ requestedTier: "fast", fallbackReason: "candidate_missing" })
    expect(card.tier?.resolvedTier).toBeUndefined()
  })

  it("leaves the badge absent when no tier was involved", () => {
    // The common case. A badge on every card would be noise.
    const msgs = buildPilotMessages(rows(undefined) as ChatMessage[])
    const card = agentWorkSummary(msgs.find((m) => m.toolName === "spawn_subagent")!)
    expect(card.tier).toBeUndefined()
  })
})

describe("background group", () => {
  it("carries each child's tier through the group fold", () => {
    const msgs = buildPilotMessages([
      row({
        id: "launch-g1",
        tool_name: "spawn_subagent",
        tool_input: JSON.stringify({
          description: "sweep",
          items: [{ task: "logs" }, { task: "config" }],
        }),
        content: JSON.stringify({ status: "launched", job_id: "g1" }),
      }),
      row({
        id: "c0",
        role: "user",
        content: "logs ok",
        metadata: { kind: "delegation_event", delegation_id: "g1#0", status: "done", tier: TIER_FAST },
      }),
      row({
        id: "c1",
        role: "user",
        content: "config ok",
        metadata: { kind: "delegation_event", delegation_id: "g1#1", status: "done", tier: TIER_FELLBACK },
      }),
      row({
        id: "term-g1",
        role: "user",
        content: "swept",
        metadata: { kind: "delegation_event", delegation_id: "g1", status: "done" },
      }),
    ] as ChatMessage[])

    const card = groupWorkSummary(msgs.find((m) => m.toolName === "spawn_subagent")!)
    expect(card.items[0].tier).toMatchObject({ resolvedTier: "fast" })
    expect(card.items[1].tier).toMatchObject({ fallbackReason: "candidate_missing" })
  })

  it("carries the tier of an item that only exists in the item_statuses snapshot", () => {
    // A skipped item never persists its own child event, so the terminal snapshot is
    // its only record — the reason that snapshot has to carry the field too.
    const msgs = buildPilotMessages([
      row({
        id: "launch-g2",
        tool_name: "spawn_subagent",
        tool_input: JSON.stringify({ description: "sweep", items: [{ task: "a" }, { task: "b" }] }),
        content: JSON.stringify({ status: "launched", job_id: "g2" }),
      }),
      row({
        id: "c0",
        role: "user",
        content: "a ok",
        metadata: { kind: "delegation_event", delegation_id: "g2#0", status: "done", tier: TIER_FAST },
      }),
      row({
        id: "term-g2",
        role: "user",
        content: "swept",
        metadata: {
          kind: "delegation_event",
          delegation_id: "g2",
          status: "partial",
          item_statuses: [
            { index: 0, status: "done" },
            { index: 1, status: "skipped", tier: TIER_FELLBACK },
          ],
        },
      }),
    ] as ChatMessage[])

    const card = groupWorkSummary(msgs.find((m) => m.toolName === "spawn_subagent")!)
    expect(card.items[1].status).toBe("skipped")
    expect(card.items[1].tier).toMatchObject({ requestedTier: "fast", fallbackReason: "candidate_missing" })
  })
})
