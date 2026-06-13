import { describe, expect, it } from "vitest"
import { dropFailedAttemptOutput, type PilotMessage } from "./usePilotChat"

const user = (id: string): PilotMessage => ({ id, role: "user", content: "q", timestamp: "12:00" })
const asst = (id: string, isStreaming = false): PilotMessage => ({ id, role: "assistant", content: "partial", timestamp: "12:01", isStreaming })
const err = (id: string): PilotMessage => ({ id, role: "error", content: "boom", timestamp: "12:01" })
const hiddenLedger = (id: string): PilotMessage => ({ id, role: "user", content: "", timestamp: "12:01", hidden: true, metadata: { kind: "task_event" } })

describe("dropFailedAttemptOutput (model_route_rollback)", () => {
  it("drops the streaming reply and error rendered after the latest user message", () => {
    expect(dropFailedAttemptOutput([user("u1"), asst("a1", true), err("e1")]).map((m) => m.id)).toEqual(["u1"])
  })

  it("keeps earlier history and the user turn, dropping only the failed attempt's output", () => {
    expect(dropFailedAttemptOutput([user("u1"), asst("a1"), user("u2"), asst("a2", true), err("e2")]).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ])
  })

  it("keeps hidden ledger rows (task_event) that follow the user message", () => {
    expect(dropFailedAttemptOutput([user("u1"), hiddenLedger("te1"), asst("a1", true)]).map((m) => m.id)).toEqual(["u1", "te1"])
  })

  it("returns the list unchanged when there is no user message", () => {
    const input = [asst("a1", true)]
    expect(dropFailedAttemptOutput(input)).toBe(input)
  })

  it("returns the list unchanged when nothing visible follows the user message", () => {
    const input = [user("u1"), hiddenLedger("te1")]
    expect(dropFailedAttemptOutput(input)).toBe(input)
  })
})
