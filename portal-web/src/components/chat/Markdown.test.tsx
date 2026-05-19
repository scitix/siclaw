import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Markdown } from "./Markdown"
import { countMermaidEdges, validateMermaidSource } from "./MermaidRenderer"

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

describe("Markdown Mermaid fences", () => {
  it("routes mermaid fences to the diagram renderer shell", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"```mermaid\nflowchart TD\n  A --> B\n```"}</Markdown>,
    )

    expect(html).toContain("mermaid-host")
    expect(html).toContain("Rendering diagram")
    expect(html).not.toContain("language-mermaid")
  })

  it("keeps incomplete mermaid fences in loading state while streaming", () => {
    const html = renderToStaticMarkup(
      <Markdown isStreaming>{"```mermaid\nflowchart TD\n  A -->"}</Markdown>,
    )

    expect(html).toContain("Rendering diagram")
    expect(html).not.toContain("Failed to render Mermaid diagram")
  })

  it("accepts the initial diagram set", () => {
    expect(validateMermaidSource("flowchart TD\n  A --> B")).toMatchObject({
      ok: true,
      kind: "flowchart",
    })
    expect(validateMermaidSource("graph LR\n  A --> B")).toMatchObject({
      ok: true,
      kind: "flowchart",
    })
    expect(validateMermaidSource("sequenceDiagram\n  A->>B: hello")).toMatchObject({
      ok: true,
      kind: "sequence",
    })
    expect(validateMermaidSource("timeline\n  title Task lifecycle\n  Created")).toMatchObject({
      ok: true,
      kind: "timeline",
    })
  })

  it("repairs leaked stream content prefixes inside Mermaid blocks", () => {
    expect(validateMermaidSource("flowchart TD\n  178-content: A --> B")).toMatchObject({
      ok: true,
      source: "flowchart TD\nA --> B",
    })
    expect(validateMermaidSource("sequenceDiagram\n  9-text: A->>B: hello")).toMatchObject({
      ok: true,
      source: "sequenceDiagram\nA->>B: hello",
    })
  })

  it("rejects unsupported diagram families and init directives", () => {
    expect(validateMermaidSource("classDiagram\n  A <|-- B")).toMatchObject({
      ok: false,
    })
    expect(validateMermaidSource("%%{init: {'securityLevel': 'loose'}}%%\nflowchart TD\nA-->B")).toMatchObject({
      ok: false,
    })
  })

  it("counts Mermaid edges for complexity limits", () => {
    expect(countMermaidEdges("flowchart TD\n  A --> B\n  B --- C\n  C ==> D")).toBe(3)
  })
})
