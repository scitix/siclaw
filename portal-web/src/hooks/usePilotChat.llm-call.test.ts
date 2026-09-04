import { describe, expect, it } from "vitest"
import { attachLiveAssistantCall, type PilotMessage } from "./usePilotChat"

describe("attachLiveAssistantCall", () => {
  it("does not put a tool-only call's timing on the previous completed bubble", () => {
    const messages: PilotMessage[] = [{
      id: "previous",
      role: "assistant",
      content: "previous answer",
      timestamp: "12:00",
      isStreaming: false,
      timing: { totalMs: 100 },
    }]

    expect(attachLiveAssistantCall(messages, { totalMs: 900 })).toBe(messages)
    expect(messages[0].timing).toEqual({ totalMs: 100 })
  })

  it("attaches timing to the current streaming assistant bubble", () => {
    const messages: PilotMessage[] = [{
      id: "current",
      role: "assistant",
      content: "answer",
      timestamp: "12:00",
      isStreaming: true,
    }]

    const updated = attachLiveAssistantCall(messages, { netTtftMs: 20, totalMs: 100 })
    expect(updated[0].timing).toEqual({ netTtftMs: 20, totalMs: 100 })
  })
})
