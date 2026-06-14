import { describe, it, expect } from "vitest"
import { toPilotMessage, hasActiveBackgroundWork } from "./usePilotChat"

// Minimal ChatMessage shape for toPilotMessage (only the fields it reads).
function bgLaunchRow(overrides: Partial<{ createdAtMsAgo: number; metadata: Record<string, unknown> }> = {}) {
  const msAgo = overrides.createdAtMsAgo ?? 0
  return {
    id: "tool-1",
    role: "tool" as const,
    content: "Running in the background…",
    tool_name: "node_exec",
    tool_input: JSON.stringify({ node: "n1", command: "ping -c 100", run_in_background: true }),
    metadata: overrides.metadata ?? { backgroundTaskId: "job-1" },
    created_at: new Date(Date.now() - msAgo).toISOString(),
  }
}

describe("background-work detection (input Stop button gating)", () => {
  it("a fresh background-exec launch with no completion counts as active work", () => {
    const msg = toPilotMessage(bgLaunchRow({ createdAtMsAgo: 5_000 }))
    expect((msg.metadata as Record<string, unknown>)?.bgStatus).toBeUndefined()
    expect(hasActiveBackgroundWork([msg])).toBe(true)
  })

  it("a stale launch whose completion never persisted is marked timed_out → no longer active", () => {
    // Past the 30-min non-delegation stale window with no folded bgStatus (e.g. a crash mid-job).
    const msg = toPilotMessage(bgLaunchRow({ createdAtMsAgo: 31 * 60 * 1000 }))
    expect((msg.metadata as Record<string, unknown>)?.bgStatus).toBe("timed_out")
    expect(hasActiveBackgroundWork([msg])).toBe(false)
  })

  it("a real folded completion is never overwritten by the stale guard (order-safe)", () => {
    const msg = toPilotMessage(
      bgLaunchRow({ createdAtMsAgo: 31 * 60 * 1000, metadata: { backgroundTaskId: "job-1", bgStatus: "completed" } }),
    )
    expect((msg.metadata as Record<string, unknown>)?.bgStatus).toBe("completed")
    expect(hasActiveBackgroundWork([msg])).toBe(false)
  })

  it("a tool row without a backgroundTaskId is never background work", () => {
    const msg = toPilotMessage({
      id: "tool-2",
      role: "tool",
      content: "ok",
      tool_name: "node_exec",
      tool_input: JSON.stringify({ node: "n1", command: "uptime" }),
      metadata: {},
      created_at: new Date().toISOString(),
    })
    expect(hasActiveBackgroundWork([msg])).toBe(false)
  })
})
