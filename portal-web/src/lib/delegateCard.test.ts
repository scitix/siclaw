import { describe, it, expect } from "vitest"
import { latestDelegateCardStatus } from "./delegateCard"
import type { PilotMessage } from "../components/chat/types"

function card(id: string, childSessionId: string, status: string): PilotMessage {
  return {
    id,
    role: "tool",
    content: "",
    toolName: "delegate_to_agent",
    toolDetails: { child_session_id: childSessionId, status },
    metadata: { child_session_id: childSessionId, status },
    timestamp: "",
  } as PilotMessage
}

describe("latestDelegateCardStatus", () => {
  it("returns the NEWEST card's status for a reused child_session_id (continuation)", () => {
    // A continued delegation reuses one peer session across turns: an older card is
    // terminal, a newer one is running. The drawer must follow the newer (running) one.
    const messages = [
      card("m1", "peer-1", "done"),      // first delegation turn — finished
      { id: "u", role: "user", content: "follow up", timestamp: "" } as PilotMessage,
      card("m2", "peer-1", "running"),   // continuation — in flight
    ]
    expect(latestDelegateCardStatus(messages, "peer-1")).toBe("running")
  })

  it("ignores cards for other peer sessions", () => {
    const messages = [
      card("m1", "peer-1", "running"),
      card("m2", "peer-2", "done"),
    ]
    expect(latestDelegateCardStatus(messages, "peer-1")).toBe("running")
    expect(latestDelegateCardStatus(messages, "peer-2")).toBe("done")
  })

  it("returns undefined when no card matches", () => {
    expect(latestDelegateCardStatus([card("m1", "peer-1", "done")], "peer-x")).toBeUndefined()
    expect(latestDelegateCardStatus([], "peer-1")).toBeUndefined()
  })

  it("falls back to metadata.child_session_id / status when toolDetails is absent", () => {
    const m = {
      id: "m1", role: "tool", content: "", toolName: "delegate_to_agent",
      metadata: { child_session_id: "peer-1", status: "input_required" }, timestamp: "",
    } as PilotMessage
    expect(latestDelegateCardStatus([m], "peer-1")).toBe("input_required")
  })
})
