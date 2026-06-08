import { describe, it, expect } from "vitest"
import { toPilotMessage } from "./usePilotChat"

// A tool the user Stopped is persisted with metadata.status="stopped" (outcome stays null) by the
// gateway's abort finalization. toPilotMessage must map that to toolStatus "aborted" so the card
// shows the terminal ⊘ state even after a history refetch — not fall through to a forever-spinner.
function toolMsg(over: Record<string, unknown> = {}) {
  return { id: "m1", role: "tool", content: "", tool_name: "node_exec", ...over } as never
}

describe("toPilotMessage — stopped tool rows render as aborted", () => {
  it("maps metadata.status=\"stopped\" (outcome null) to toolStatus \"aborted\"", () => {
    const pm = toPilotMessage(toolMsg({ outcome: null, metadata: { status: "stopped" } }))
    expect(pm.toolStatus).toBe("aborted")
  })

  it("also treats \"aborted\"/\"killed\" status as aborted", () => {
    expect(toPilotMessage(toolMsg({ metadata: { status: "aborted" } })).toolStatus).toBe("aborted")
    expect(toPilotMessage(toolMsg({ metadata: { status: "killed" } })).toolStatus).toBe("aborted")
  })

  it("still maps a genuinely running row (no terminal status) to \"running\"", () => {
    const pm = toPilotMessage(toolMsg({ outcome: null, metadata: { status: "running", started_at: new Date().toISOString() } }))
    expect(pm.toolStatus).toBe("running")
  })

  it("does not disturb success/error mapping", () => {
    expect(toPilotMessage(toolMsg({ outcome: "success" })).toolStatus).toBe("success")
    expect(toPilotMessage(toolMsg({ outcome: "error" })).toolStatus).toBe("error")
  })
})
