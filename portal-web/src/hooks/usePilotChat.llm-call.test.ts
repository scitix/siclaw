import { describe, expect, it } from "vitest"
import { attachLiveAssistantCall, toPilotMessage, type PilotMessage } from "./usePilotChat"

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


it("hides empty call carriers but preserves explicit error and route notices", () => {
  const row = { id: "m", role: "assistant", content: "", created_at: "2026-09-01", metadata: { llm_call: {} } };
  expect(toPilotMessage(row as any).hidden).toBe(true);
  for (const kind of ["error_response", "model_route_notice"]) {
    expect(toPilotMessage({ ...row, metadata: { ...row.metadata, kind } } as any).hidden).toBeFalsy();
  }
});
