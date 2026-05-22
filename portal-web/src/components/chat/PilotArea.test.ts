import { describe, expect, it } from "vitest"
import { findLatestEditableUserMessageId, hideEditedUserMessageBubbles } from "./PilotArea"

describe("hideEditedUserMessageBubbles", () => {
  it("hides only the edited user bubble and keeps the old assistant reply visible", () => {
    const messages = [
      { id: "user-old", role: "user", content: "old prompt" },
      { id: "assistant-old", role: "assistant", content: "old answer" },
      { id: "user-new", role: "user", content: "edited prompt" },
    ]

    expect(hideEditedUserMessageBubbles(messages, new Set(["user-old"]))).toEqual([
      { id: "assistant-old", role: "assistant", content: "old answer" },
      { id: "user-new", role: "user", content: "edited prompt" },
    ])
  })
})

describe("findLatestEditableUserMessageId", () => {
  it("treats a steered user message as the latest editable user bubble", () => {
    expect(
      findLatestEditableUserMessageId(
        [
          { id: "user-normal", role: "user", content: "normal prompt" },
          { id: "assistant", role: "assistant", content: "answer" },
          {
            id: "user-steer",
            role: "user",
            content: "follow-up",
            metadata: { kind: "steer", steer_status: "steered" },
          },
        ],
        false,
      ),
    ).toBe("user-steer")
  })

  it("allows an already-steered message to be edited while the run is still loading", () => {
    expect(
      findLatestEditableUserMessageId(
        [
          { id: "user-normal", role: "user", content: "normal prompt" },
          {
            id: "user-steered",
            role: "user",
            content: "follow-up",
            metadata: { kind: "steer", steer_status: "steered" },
          },
        ],
        true,
      ),
    ).toBe("user-steered")
  })

  it("does not offer edit for a pending steer that cannot be cancelled client-side", () => {
    expect(
      findLatestEditableUserMessageId(
        [
          { id: "user-normal", role: "user", content: "normal prompt" },
          {
            id: "user-pending-steer",
            role: "user",
            content: "follow-up",
            metadata: { kind: "steer", steer_status: "pending" },
          },
        ],
        true,
      ),
    ).toBeNull()
  })
})
