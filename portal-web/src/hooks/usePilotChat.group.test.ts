import { describe, it, expect } from "vitest"
import { buildPilotMessages, carryLiveGroupProgress, hasActiveBackgroundWork, mergePage1IntoHistory, preserveUnchangedRows, reconcileRefetchedPage1, type ChatMessage } from "./usePilotChat"

// Raw-row helpers mirroring how spawn_subagent_group events are persisted.
function groupLaunchRow(jobId: string, items: unknown[], description = "diagnose pods"): ChatMessage {
  return {
    id: `launch-${jobId}`,
    role: "tool",
    content: JSON.stringify({ status: "launched", job_id: jobId }),
    tool_name: "spawn_subagent_group",
    tool_input: JSON.stringify({ description, items }),
    metadata: {},
    created_at: new Date().toISOString(),
  } as unknown as ChatMessage
}

function childEventRow(groupId: string, index: number, status: string, childSessionId: string, capsule: string): ChatMessage {
  return {
    id: `child-${groupId}-${index}`,
    role: "user",
    content: capsule,
    metadata: { kind: "delegation_event", delegation_id: `${groupId}#${index}`, status, child_session_id: childSessionId },
    created_at: new Date().toISOString(),
  } as unknown as ChatMessage
}

function groupTerminalRow(groupId: string, status: string, reduceSummary: string, reduceChildSessionId: string): ChatMessage {
  return {
    id: `term-${groupId}`,
    role: "user",
    content: reduceSummary,
    metadata: { kind: "delegation_event", delegation_id: groupId, status, child_session_id: reduceChildSessionId },
    created_at: new Date().toISOString(),
  } as unknown as ChatMessage
}

function launchMsg(msgs: ReturnType<typeof buildPilotMessages>) {
  return msgs.find((m) => m.toolName === "spawn_subagent_group")!
}

describe("annotateGroupCompletions (group card rebuild on reload)", () => {
  it("a launched group with no child events yet counts as active background work", () => {
    const msgs = buildPilotMessages([groupLaunchRow("grp1", ["a", "b", "c"])])
    const launch = launchMsg(msgs)
    expect(launch.metadata?.groupBackground).toBe(true)
    expect(launch.metadata?.groupStatus).toBeUndefined() // not terminal yet
    expect(hasActiveBackgroundWork(msgs)).toBe(true)
  })

  it("folds per-child events onto the launch card by {groupId}#{index} prefix", () => {
    const msgs = buildPilotMessages([
      groupLaunchRow("grp1", ["pod-a", "pod-b", "pod-c"]),
      childEventRow("grp1", 0, "done", "sess-0", "pod-a ok"),
      childEventRow("grp1", 2, "failed", "sess-2", "pod-c unreachable"),
    ])
    const items = launchMsg(msgs).metadata?.groupItems as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ index: 0, status: "done", childSessionId: "sess-0", summary: "pod-a ok" })
    expect(items[1]).toMatchObject({ index: 2, status: "failed", childSessionId: "sess-2" })
  })

  it("folds the group terminal event: overall status + reduce summary/child when a reduce ran", () => {
    const msgs = buildPilotMessages([
      groupLaunchRow("grp1", ["a", "b"]),
      childEventRow("grp1", 0, "done", "sess-0", "a ok"),
      childEventRow("grp1", 1, "done", "sess-1", "b ok"),
      groupTerminalRow("grp1", "done", "Two causes: net + storage", "reduce-sess"),
    ])
    const meta = launchMsg(msgs).metadata!
    expect(meta.groupStatus).toBe("done")
    expect(meta.groupSummary).toBe("Two causes: net + storage")
    expect(meta.groupReduceChildSessionId).toBe("reduce-sess")
    // Terminal folded → no longer active work.
    expect(hasActiveBackgroundWork(msgs)).toBe(false)
  })

  it("no reduce (empty terminal child_session_id): shows the group summary but no reduce drill-in", () => {
    const msgs = buildPilotMessages([
      groupLaunchRow("grp1", ["a"]),
      childEventRow("grp1", 0, "done", "sess-0", "a ok"),
      groupTerminalRow("grp1", "done", "1 item(s): 1 done", ""),
    ])
    const meta = launchMsg(msgs).metadata!
    expect(meta.groupStatus).toBe("done")
    // The capsule is ALWAYS surfaced (so a no-reduce circuit-break reason stays visible on the card)…
    expect(meta.groupSummary).toBe("1 item(s): 1 done")
    // …but the reduce transcript drill-in is gated on a real reduce child (absent here).
    expect(meta.groupReduceChildSessionId).toBeUndefined()
  })

  it("#3/#7 renders skipped items from the terminal item_statuses snapshot + surfaces the breaker reason", () => {
    // Circuit-broke at 2 failures: items 0-1 have their own child events; 2-4 were skipped (never
    // persisted as children), so the terminal event's item_statuses snapshot is their ONLY record.
    const termRow = {
      id: "term-grp1",
      role: "user",
      content: "Circuit breaker: the first 2 sub-agents all failed with no success.",
      metadata: {
        kind: "delegation_event",
        delegation_id: "grp1",
        status: "failed",
        child_session_id: "", // no reduce ran
        item_statuses: [
          { index: 0, status: "failed" }, { index: 1, status: "failed" },
          { index: 2, status: "skipped" }, { index: 3, status: "skipped" }, { index: 4, status: "skipped" },
        ],
      },
      created_at: new Date().toISOString(),
    } as unknown as ChatMessage
    const msgs = buildPilotMessages([
      groupLaunchRow("grp1", ["a", "b", "c", "d", "e"]),
      childEventRow("grp1", 0, "failed", "s0", "boom 0"),
      childEventRow("grp1", 1, "failed", "s1", "boom 1"),
      termRow,
    ])
    const meta = launchMsg(msgs).metadata!
    expect(meta.groupStatus).toBe("failed")
    // #7: the breaker reason (capsule) is surfaced even though no reduce child ran.
    expect(meta.groupSummary).toMatch(/circuit breaker/i)
    // #3: indices 2-4 come from the snapshot (no child event) → "skipped", not the "running" fallback.
    const items = meta.groupItems as Array<{ index: number; status: string }>
    expect(items.map((i) => i.status)).toEqual(["failed", "failed", "skipped", "skipped", "skipped"])
  })

  it("does not treat a single sub-agent's bare delegation_event as a group terminal", () => {
    // No group launch present → groupIds empty → annotate is a no-op, single-subagent path untouched.
    const msgs = buildPilotMessages([
      {
        id: "solo",
        role: "user",
        content: "solo done",
        metadata: { kind: "delegation_event", delegation_id: "solo-1", status: "done", child_session_id: "s1" },
        created_at: new Date().toISOString(),
      } as unknown as ChatMessage,
    ])
    expect(msgs.every((m) => m.metadata?.groupBackground === undefined)).toBe(true)
  })
})

// v3 single-tool merge: the batch form is now a `spawn_subagent` (toolName) call whose items list
// has >1 entry OR carries a reduce_prompt. It must rebuild as a group card exactly like the legacy
// spawn_subagent_group; a single-item, no-reduce spawn_subagent (the collapse form) must NOT.
describe("annotateGroupCompletions — unified spawn_subagent batch form", () => {
  function unifiedLaunchRow(jobId: string, input: Record<string, unknown>): ChatMessage {
    return {
      id: `launch-${jobId}`,
      role: "tool",
      content: JSON.stringify({ status: "launched", job_id: jobId }),
      tool_name: "spawn_subagent",
      tool_input: JSON.stringify(input),
      metadata: {},
      created_at: new Date().toISOString(),
    } as unknown as ChatMessage
  }

  it("treats a multi-item spawn_subagent (items > 1) as a batch and folds its child events", () => {
    const msgs = buildPilotMessages([
      unifiedLaunchRow("grpU", { description: "diagnose pods", task_template: "{{item}}", items: ["pod-a", "pod-b"] }),
      childEventRow("grpU", 0, "done", "sess-0", "pod-a ok"),
      childEventRow("grpU", 1, "failed", "sess-1", "pod-b unreachable"),
    ])
    const launch = msgs.find((m) => m.toolName === "spawn_subagent")!
    expect(launch.metadata?.groupBackground).toBe(true)
    const items = launch.metadata?.groupItems as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ index: 0, status: "done", childSessionId: "sess-0" })
  })

  it("treats a single-item spawn_subagent with a reduce_prompt as a batch", () => {
    const msgs = buildPilotMessages([
      unifiedLaunchRow("grpR", { description: "x", items: ["only"], reduce_prompt: "summarize" }),
    ])
    const launch = msgs.find((m) => m.toolName === "spawn_subagent")!
    expect(launch.metadata?.groupBackground).toBe(true)
    expect(hasActiveBackgroundWork(msgs)).toBe(true)
  })

  it("does NOT treat a single-item, no-reduce spawn_subagent (collapse form) as a batch", () => {
    const msgs = buildPilotMessages([
      unifiedLaunchRow("solo2", { description: "x", items: ["only"], run_in_background: true }),
    ])
    const launch = msgs.find((m) => m.toolName === "spawn_subagent")!
    expect(launch.metadata?.groupBackground).toBeUndefined() // handled by the single-subagent card, not the group card
  })
})

// Smoke defect S1: when the user has paged back (pageRef > 1), the background-turn refetch used to
// bail out entirely, so a completed group's card stayed stuck on "Running…" until a manual reload.
// The fix merges the fresh page 1 into the loaded scrollback (dedup by id) and re-runs the annotate
// chain, so the card converges to its terminal state even when the launch card has scrolled into an
// older page. These tests exercise the pure merge that the refetch now uses.
describe("mergePage1IntoHistory — paged-back completion converges (S1)", () => {
  function olderRow(id: string, text: string): ChatMessage {
    return {
      id,
      role: "assistant",
      content: text,
      metadata: {},
      created_at: new Date().toISOString(),
    } as unknown as ChatMessage
  }

  it("folds a group's terminal event onto a launch card that has scrolled into an older page", () => {
    // Loaded scrollback: older messages + the group launch card, still running (no terminal folded).
    // Modelling the real regression: the launch card was in page 1 when first shown, then the user
    // scrolled up; by completion time the accumulated child events pushed the launch card out of the
    // DB's page 1, so the fresh page 1 no longer contains it.
    const current = buildPilotMessages([
      olderRow("old-1", "earlier chatter"),
      olderRow("old-2", "more chatter"),
      groupLaunchRow("grp1", ["pod-a", "pod-b"]),
    ])
    const launchBefore = launchMsg(current)
    expect(launchBefore.metadata?.groupBackground).toBe(true)
    expect(launchBefore.metadata?.groupStatus).toBeUndefined() // still running before the merge
    expect(hasActiveBackgroundWork(current)).toBe(true)

    // Fresh page 1 after completion: only the recent child + terminal events (launch card scrolled
    // out). On its own it can't fold — no launch present — so groupIds is empty here.
    const freshPage1 = buildPilotMessages([
      childEventRow("grp1", 0, "done", "sess-0", "pod-a ok"),
      childEventRow("grp1", 1, "done", "sess-1", "pod-b ok"),
      groupTerminalRow("grp1", "done", "Two causes: net + storage", "reduce-sess"),
    ])
    expect(launchMsg(freshPage1)).toBeUndefined() // launch card is NOT in the fresh page

    const merged = mergePage1IntoHistory(current, freshPage1)

    // Card converged to its terminal state.
    const launchAfter = launchMsg(merged)
    const meta = launchAfter.metadata!
    expect(meta.groupStatus).toBe("done")
    expect(meta.groupSummary).toBe("Two causes: net + storage")
    expect(meta.groupReduceChildSessionId).toBe("reduce-sess")
    expect((meta.groupItems as unknown[]).length).toBe(2)
    // No longer counted as active background work → the input's Stop button clears.
    expect(hasActiveBackgroundWork(merged)).toBe(false)

    // Scrollback preserved (no loss) and de-duplicated (no repeated launch card).
    expect(merged.filter((m) => m.content === "earlier chatter")).toHaveLength(1)
    expect(merged.filter((m) => m.content === "more chatter")).toHaveLength(1)
    expect(merged.filter((m) => m.toolName === "spawn_subagent_group")).toHaveLength(1)
  })

  it("dedups overlapping ids (page 1 wins) and keeps the older scrollback ahead of the fresh page", () => {
    const current = buildPilotMessages([
      olderRow("old-1", "scrollback"),
      groupLaunchRow("grp2", ["a", "b"]),
      childEventRow("grp2", 0, "running", "sess-0", ""),
    ])
    // Fresh page 1 re-returns the launch + child 0 (now done) and adds the terminal event.
    const freshPage1 = buildPilotMessages([
      groupLaunchRow("grp2", ["a", "b"]),
      childEventRow("grp2", 0, "done", "sess-0", "a ok"),
      childEventRow("grp2", 1, "done", "sess-1", "b ok"),
      groupTerminalRow("grp2", "done", "1 item(s): 2 done", ""),
    ])

    const merged = mergePage1IntoHistory(current, freshPage1)
    // The launch card that overlaps both lists appears exactly once and reflects the terminal state.
    const launches = merged.filter((m) => m.toolName === "spawn_subagent_group")
    expect(launches).toHaveLength(1)
    expect(launches[0].metadata?.groupStatus).toBe("done")
    // Older scrollback is still present and stays ahead of the fresh page-1 block.
    const idxOld = merged.findIndex((m) => m.content === "scrollback")
    const idxLaunch = merged.findIndex((m) => m.toolName === "spawn_subagent_group")
    expect(idxOld).toBeGreaterThanOrEqual(0)
    expect(idxOld).toBeLessThan(idxLaunch)
  })
})

describe("carryLiveGroupProgress", () => {
  const frame = { phase: "map", items: [{ index: 0, status: "running" }, { index: 1, status: "queued" }] }

  it("carries the live frame onto a refetched launch card that lost it", () => {
    const prev = buildPilotMessages([groupLaunchRow("grp3", ["a", "b"])])
    prev[0] = { ...prev[0], metadata: { ...(prev[0].metadata ?? {}), groupProgress: frame } }
    const fresh = buildPilotMessages([groupLaunchRow("grp3", ["a", "b"])])

    const out = carryLiveGroupProgress(prev, fresh)
    expect(out[0].metadata?.groupProgress).toEqual(frame)
  })

  it("does not shadow a terminal fold or a newer frame, and leaves unrelated rows alone", () => {
    const prev = buildPilotMessages([groupLaunchRow("grp3", ["a", "b"])])
    prev[0] = { ...prev[0], metadata: { ...(prev[0].metadata ?? {}), groupProgress: frame } }

    // Fresh page already folded terminal → stale frame must be dropped.
    const folded = buildPilotMessages([
      groupLaunchRow("grp3", ["a", "b"]),
      childEventRow("grp3", 0, "done", "s0", "ok"),
      childEventRow("grp3", 1, "done", "s1", "ok"),
      groupTerminalRow("grp3", "done", "all done", ""),
    ])
    const outFolded = carryLiveGroupProgress(prev, folded)
    const launch = outFolded.find((m) => m.toolName === "spawn_subagent_group")!
    expect(launch.metadata?.groupStatus).toBe("done")
    expect(launch.metadata?.groupProgress).toBeUndefined()

    // Fresh page carries its own (newer) frame → it wins over the carried one.
    const newer = { phase: "reduce", items: [{ index: 0, status: "done" }, { index: 1, status: "done" }] }
    const withNewer = buildPilotMessages([groupLaunchRow("grp3", ["a", "b"])])
    withNewer[0] = { ...withNewer[0], metadata: { ...(withNewer[0].metadata ?? {}), groupProgress: newer } }
    const outNewer = carryLiveGroupProgress(prev, withNewer)
    expect(outNewer[0].metadata?.groupProgress).toEqual(newer)

    // No prev frames at all → fresh list returned as-is.
    const plain = buildPilotMessages([groupLaunchRow("grp4", ["x"])])
    expect(carryLiveGroupProgress(buildPilotMessages([]), plain)).toBe(plain)
  })
})

describe("preserveUnchangedRows / reconcileRefetchedPage1", () => {
  it("restores row identity for unchanged rows and rebuilds only the changed one", () => {
    const rows = [
      groupLaunchRow("grp5", ["a", "b"]),
      childEventRow("grp5", 0, "done", "s0", "a ok"),
    ]
    const prev = buildPilotMessages(rows)
    const freshSame = buildPilotMessages(rows)
    const same = preserveUnchangedRows(prev, freshSame)
    // Annotate rebuilt every object in freshSame, but identity is restored from prev.
    for (let i = 0; i < same.length; i++) expect(same[i]).toBe(prev[i])

    // Second child terminal arrives → launch card fold changes → launch row rebuilt,
    // untouched child row keeps its identity.
    const freshChanged = buildPilotMessages([...rows, childEventRow("grp5", 1, "done", "s1", "b ok")])
    const changed = preserveUnchangedRows(prev, freshChanged)
    const prevLaunch = prev.find((m) => m.toolName === "spawn_subagent_group")!
    const newLaunch = changed.find((m) => m.toolName === "spawn_subagent_group")!
    expect(newLaunch).not.toBe(prevLaunch)
    const prevChild0 = prev.find((m) => m.id === "child-grp5-0")!
    expect(changed.find((m) => m.id === "child-grp5-0")).toBe(prevChild0)
  })

  it("reconcile keeps BOTH the carried live frame and the previous row identity", () => {
    const frame = { phase: "map", items: [{ index: 0, status: "queued" }] }
    const prev = buildPilotMessages([groupLaunchRow("grp6", ["a", "b"])])
    prev[0] = { ...prev[0], metadata: { ...(prev[0].metadata ?? {}), groupProgress: frame } }
    const fresh = buildPilotMessages([groupLaunchRow("grp6", ["a", "b"])])

    const out = reconcileRefetchedPage1(prev, fresh)
    // carry re-attached the frame, making the row equal to prev → identity restored.
    expect(out[0]).toBe(prev[0])
    expect(out[0].metadata?.groupProgress).toEqual(frame)
  })
})
