import { describe, expect, it } from "vitest"
import { stripAttachmentOcrEvidence } from "./user-message-text"

describe("stripAttachmentOcrEvidence", () => {
  it("leaves ordinary user text unchanged", () => {
    expect(stripAttachmentOcrEvidence("这个能看到吗")).toBe("这个能看到吗")
  })

  it("removes OCR evidence from user-visible text", () => {
    const content = [
      "这个能看到吗",
      "",
      "[System: The user pasted image or PDF attachment(s). OCR evidence extracted by Siclaw is below. Use it as evidence.]",
      "",
      "### image.png",
      "kind: screenshot",
      "route: text",
      "kubectl get pods",
    ].join("\n")

    expect(stripAttachmentOcrEvidence(content)).toBe("这个能看到吗")
  })
})
