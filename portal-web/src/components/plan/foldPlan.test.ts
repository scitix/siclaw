import { describe, it, expect } from "vitest"
import { foldPlan, hasPlan } from "./foldPlan"
import type { PilotMessage } from "../chat/types"

function ev(action: "upsert" | "delete", payload: Record<string, unknown>, id = Math.random().toString()): PilotMessage {
  return { id, role: "user", content: "", timestamp: 0, metadata: { kind: "task_event", action, ...payload } } as unknown as PilotMessage
}

describe("foldPlan", () => {
  it("ignores non-task_event messages", () => {
    const msgs: PilotMessage[] = [
      { id: "1", role: "assistant", content: "hi", timestamp: 0 } as unknown as PilotMessage,
      { id: "2", role: "user", content: "x", timestamp: 0, metadata: { kind: "delegation_event" } } as unknown as PilotMessage,
    ]
    expect(foldPlan(msgs)).toEqual([])
    expect(hasPlan(msgs)).toBe(false)
  })

  it("folds upserts into current state (last write wins per id)", () => {
    const msgs = [
      ev("upsert", { task: { id: "1", subject: "list nodes", status: "pending", blockedBy: [] } }),
      ev("upsert", { task: { id: "1", subject: "list nodes", status: "completed", blockedBy: [] } }),
    ]
    const plan = foldPlan(msgs)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ id: "1", status: "completed", group: "completed" })
    expect(hasPlan(msgs)).toBe(true)
  })

  it("applies delete events", () => {
    const msgs = [
      ev("upsert", { task: { id: "1", subject: "a", status: "pending", blockedBy: [] } }),
      ev("delete", { taskId: "1" }),
    ]
    expect(foldPlan(msgs)).toEqual([])
  })

  it("derives ready/blocked groups + blocks, filtering completed blockers", () => {
    const msgs = [
      ev("upsert", { task: { id: "1", subject: "n", status: "pending", blockedBy: [] } }),
      ev("upsert", { task: { id: "2", subject: "correlate", status: "pending", blockedBy: ["1"] } }),
    ]
    let plan = foldPlan(msgs)
    const t1 = plan.find((t) => t.id === "1")!
    const t2 = plan.find((t) => t.id === "2")!
    expect(t1.group).toBe("ready")
    expect(t1.blocks).toEqual(["2"])
    expect(t2.group).toBe("blocked")
    expect(t2.blockedBy).toEqual(["1"])

    plan = foldPlan([...msgs, ev("upsert", { task: { id: "1", subject: "n", status: "completed", blockedBy: [] } })])
    const t2b = plan.find((t) => t.id === "2")!
    expect(t2b.group).toBe("ready")
    expect(t2b.blockedBy).toEqual([])
  })

  it("groups in_progress separately", () => {
    const plan = foldPlan([ev("upsert", { task: { id: "1", subject: "x", status: "in_progress", owner: "sub-agent-1", blockedBy: [] } })])
    expect(plan[0].group).toBe("in_progress")
    expect(plan[0].owner).toBe("sub-agent-1")
  })
})
