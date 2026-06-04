import { describe, it, expect } from "vitest"
import {
  stripImageData,
  stripVisualizationFences,
  serializeMessagesToText,
  serializeMessagesToMarkdown,
} from "./transcript"
import type { PilotMessage } from "./types"

function msg(partial: Partial<PilotMessage> & Pick<PilotMessage, "role">): PilotMessage {
  return { id: Math.random().toString(36), content: "", timestamp: "12:00", ...partial }
}

describe("stripImageData", () => {
  it("collapses a base64 data-URL image to a short placeholder", () => {
    const big = "data:image/png;base64," + "A".repeat(5000)
    const out = stripImageData(`before ![a diagram](${big}) after`)
    expect(out).toBe("before [image: a diagram] after")
    expect(out).not.toContain("base64")
  })

  it("uses a bare placeholder when the image has no alt text", () => {
    expect(stripImageData("x ![](https://e/i.png) y")).toBe("x [image] y")
  })

  it("leaves non-image text untouched", () => {
    expect(stripImageData("just [a link](https://e)")).toBe("just [a link](https://e)")
  })
})

describe("stripVisualizationFences", () => {
  it("replaces chart and mermaid fences with placeholders", () => {
    const md = "intro\n\n```chart\n{\"x\":1}\n```\n\nmid\n\n```mermaid\ngraph TD\n```\n\nend"
    const out = stripVisualizationFences(md)
    expect(out).toContain("[chart]")
    expect(out).toContain("[diagram]")
    expect(out).not.toContain("graph TD")
  })
})

describe("serializeMessagesToText", () => {
  it("labels roles and skips hidden / status-notice messages", () => {
    const out = serializeMessagesToText([
      msg({ role: "user", content: "hello" }),
      msg({ role: "assistant", content: "hi there" }),
      msg({ role: "tool", toolName: "kubectl", toolInput: "get pods", content: "pod-1 Running" }),
      msg({ role: "user", content: "secret", hidden: true }),
      msg({ role: "assistant", content: "notice", metadata: { kind: "delegation_status_notice" } }),
    ])
    expect(out).toContain("You:\nhello")
    expect(out).toContain("Assistant:\nhi there")
    expect(out).toContain("[kubectl]\n$ get pods\npod-1 Running")
    expect(out).not.toContain("secret")
    expect(out).not.toContain("notice")
  })

  it("markdown export keeps content, bold role headers, fenced tool output, and rules", () => {
    const md = serializeMessagesToMarkdown([
      msg({ role: "user", content: "hello" }),
      msg({ role: "assistant", content: "see ![pic](https://e/i.png)" }),
      msg({ role: "tool", toolName: "kubectl", toolInput: "get pods", content: "pod-1 Running" }),
    ])
    expect(md).toContain("**You** · 12:00\n\nhello")
    expect(md).toContain("**Siclaw**")
    expect(md).toContain("![pic](https://e/i.png)") // images kept so they render in a viewer
    expect(md).toContain("**[kubectl]**")
    expect(md).toContain("```\npod-1 Running\n```")
    expect(md).toContain("\n---\n") // messages separated by horizontal rules
  })

  it("markdown export keeps chart spec blocks verbatim (HTML export carries the rendered image)", () => {
    const content = 'intro\n\n```chart\n{"type":"bar"}\n```\n\nmore'
    const md = serializeMessagesToMarkdown([msg({ id: "a1", role: "assistant", content })])
    expect(md).toContain("```chart")
    expect(md).toContain('"type":"bar"')
    expect(md).toContain("intro")
    expect(md).toContain("more")
  })

  it("markdown export omits user attachments (transient OCR inputs)", () => {
    const md = serializeMessagesToMarkdown([
      msg({
        role: "user",
        content: "look at this",
        attachments: [
          { kind: "image", filename: "shot.png", mimeType: "image/png", data: "AAAB" },
          { kind: "pdf", filename: "report.pdf", mimeType: "application/pdf", data: "ZZZ" },
        ],
      }),
    ])
    expect(md).toContain("look at this") // persisted content kept
    expect(md).not.toContain("data:image/png;base64,AAAB") // attachment image omitted
    expect(md).not.toContain("report.pdf") // attachment file omitted
  })

  it("does not dump raw base64 image data in assistant or user text", () => {
    const big = "data:image/png;base64," + "Z".repeat(4000)
    const out = serializeMessagesToText([
      msg({ role: "user", content: `look ![shot](${big})` }),
      msg({ role: "assistant", content: `here ![result](${big})` }),
    ])
    expect(out).not.toContain("base64")
    expect(out).toContain("[image: shot]")
    expect(out).toContain("[image: result]")
  })
})
