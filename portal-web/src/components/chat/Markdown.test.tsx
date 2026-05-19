import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Markdown } from "./Markdown"

const incompleteChart = '```chart\n{"type":"bar","data":\n```'

describe("Markdown chart fences", () => {
  it("keeps incomplete chart fences in loading state while streaming", () => {
    const html = renderToStaticMarkup(<Markdown isStreaming>{incompleteChart}</Markdown>)

    expect(html).toContain("Generating chart")
    expect(html).not.toContain("Chart output incomplete")
  })

  it("shows an error for incomplete chart fences after streaming finishes", () => {
    const html = renderToStaticMarkup(<Markdown>{incompleteChart}</Markdown>)

    expect(html).toContain("Chart output incomplete")
    expect(html).not.toContain("Generating chart")
  })
})
