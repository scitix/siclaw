import { describe, expect, it } from "vitest"
import { extractUserMessageText, findPendingSteerIndex, pendingSteerMatchText } from "./steer-pending"

const OCR_EVIDENCE = [
  "",
  "",
  "[System: The user pasted image or PDF attachment(s). OCR evidence extracted by Siclaw is below. Use it as evidence.]",
  "",
  "### image.png",
  "kind: screenshot",
  "kubectl get pods",
].join("\n")

describe("steer pending matching", () => {
  it("matches pending steer text even when runtime echoes OCR evidence", () => {
    expect(findPendingSteerIndex(["这个能看到吗"], `这个能看到吗${OCR_EVIDENCE}`)).toBe(0)
  })

  it("matches attachment-only steer text against the portal fallback prompt", () => {
    const matchText = pendingSteerMatchText("", true)
    expect(matchText).toBe("Please analyze the attached file(s).")
    expect(findPendingSteerIndex([matchText], `Please analyze the attached file(s).${OCR_EVIDENCE}`)).toBe(0)
  })

  it("uses trimmed user text for pending steer matching", () => {
    expect(pendingSteerMatchText("  hello  ", true)).toBe("hello")
  })

  it("does not synthesize a fallback prompt for text-only empty steer", () => {
    expect(pendingSteerMatchText("", false)).toBe("")
  })

  it("strips OCR evidence from echoed user text", () => {
    expect(extractUserMessageText(`这个能看到吗${OCR_EVIDENCE}`)).toBe("这个能看到吗")
  })
})
