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
    expect(
      validateMermaidSource(
        [
          "xychart-beta",
          '  title "事故单AI可解决性分析"',
          '  x-axis ["AI可解决", "AI不可解决", "有条件可解决"]',
          '  y-axis "数量" 0 --> 2',
          "  bar [1, 0, 2]",
        ].join("\n"),
      ),
    ).toMatchObject({
      ok: true,
      kind: "xychart",
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

describe("Markdown intra-word underscores", () => {
  const R = (s: string) => renderToStaticMarkup(<Markdown>{s}</Markdown>)

  it("renders plain intra-word underscores literally (no italic)", () => {
    const html = R("mlx5_0 and mlx5_1")
    expect(html).toContain("mlx5_0 and mlx5_1")
    expect(html).not.toContain("<em>")
  })

  it("strips a model-escaped intra-word underscore", () => {
    expect(R("mlx5\\_0")).toContain("mlx5_0")
    expect(R("mlx5\\_0")).not.toContain("mlx5\\_0")
  })

  it("strips a DOUBLE-escaped intra-word underscore (the visible-backslash bug)", () => {
    const html = R("**跨网卡 061 mlx5\\\\_0 → 062 mlx5\\\\_1 成功**")
    expect(html).toContain("mlx5_0")
    expect(html).toContain("mlx5_1")
    expect(html).not.toContain("\\_")
  })

  it("preserves intentional _emphasis_ at word boundaries", () => {
    expect(R("this is _italic_ text")).toContain("<em>")
  })

  it("leaves underscores inside inline code untouched", () => {
    expect(R("`mlx5\\_0`")).toContain("mlx5\\_0")
  })
})

describe("Markdown CJK-flanked underscores", () => {
  const R = (s: string) => renderToStaticMarkup(<Markdown>{s}</Markdown>)
  it("strips a double-escaped underscore flanked by CJK", () => {
    const html = R("主\\\\_网卡 和 接\\\\_口")
    expect(html).toContain("主_网卡")
    expect(html).toContain("接_口")
    expect(html).not.toContain("\\_")
  })
  it("strips a single-escaped underscore flanked by CJK", () => {
    expect(R("网卡\\_接口")).toContain("网卡_接口")
    expect(R("网卡\\_接口")).not.toContain("\\_")
  })
})

describe("Markdown CJK full-width-space markers", () => {
  const R = (s: string) => renderToStaticMarkup(<Markdown>{s}</Markdown>)
  it("renders a heading written with a full-width space after the #'s", () => {
    const html = R("##　RoCE连通性测试结果")
    expect(html).toContain("<h2")
    expect(html).toContain("RoCE连通性测试结果")
    expect(html).not.toContain("##")
  })
  it("renders a list item written with a full-width space after the marker", () => {
    expect(R("-　第一项")).toContain("<li")
  })
  it("leaves a normal (ascii-space) heading untouched", () => {
    expect(R("## 正常标题")).toContain("<h2")
  })
})
