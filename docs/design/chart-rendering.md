---
title: "Chart Rendering"
sidebarTitle: "Chart Rendering"
description: "Contract between MCP chart tools and the Portal frontend renderer."
---

# Chart Rendering

> **Purpose**: Document the contract between any MCP tool that produces charts and
> the Portal chat frontend that renders them. Read this before writing a new chart
> tool or adding a new chart type.

---

## How It Works

The frontend recognises chart output through a single convention: a fenced
Markdown code block with the language tag `chart`.

```
```chart
{"type":"pie","data":{"slices":[{"label":"kube-system","value":1005}]}}
```
```

Any MCP tool that produces this block will have its output rendered as an
interactive SVG chart inside the chat bubble. No frontend changes are required
as long as the fence tag is `chart` and the JSON matches the `ChartSpec` schema
(see [§ ChartSpec schema](#chartspec-schema) below).

---

## The Rendering Pipeline

```
MCP tool
  └── emits  ```chart\n{JSON}\n```  in its text response

Markdown.tsx  (portal-web/src/components/chat/Markdown.tsx)
  └── react-markdown encounters a <pre><code className="language-chart">
        └── hasLanguageClass(className, "chart") → true
              └── <ChartFence text={rawJson} />

ChartFence  (inside Markdown.tsx)
  └── useMemo → tryParseChartSpec(text)
        ├── JSON incomplete (still streaming)  → <ChartLoading /> spinner
        ├── JSON complete, parse fails         → <ChartParseError />
        └── JSON complete, parse succeeds      → <ChartRenderer spec={spec} />

ChartRenderer  (portal-web/src/components/chat/ChartRenderer.tsx)
  └── wrapped in React.memo — skips re-render when spec is unchanged
        ├── spec.type === "pie"  → renderPie
        ├── spec.type === "bar"  → renderBar
        └── spec.type === "line" → renderLine
```

## Mermaid Diagram Rendering

Mermaid is a separate baseline Markdown capability, not a `ChartSpec` type and
not an MCP requirement. The chat frontend recognises fenced Markdown blocks with
the language tag `mermaid` and renders these supported diagram families:

- `flowchart` / `graph` for process, dependency, cause/effect, and remediation
  flows.
- `sequenceDiagram` for cross-component request or event ordering.
- `timeline` for task lifecycles, incidents, and investigation progress.
- `xychart-beta` for lightweight x/y bars or trends when a full `chart` fence is
  unnecessary.

Mermaid blocks are rendered client-side with Mermaid's strict security mode and
bounded text/edge limits. Init/config directives in chat-authored diagrams are
rejected so a response cannot weaken the renderer's security configuration.

Mermaid diagrams share the frontend SVG export helpers used by charts:

- streaming messages keep a stable loading state instead of repeatedly
  rendering half-arrived diagrams;
- rendered diagrams expose source copy, larger preview, PNG clipboard copy, and
  PNG download controls;
- message/session rich-copy treats rendered Mermaid SVGs as images, matching the
  chart copy path.

Use `chart` fences for finalized pie/bar/line data that should use Siclaw's
native chart interactivity and validation. Use Mermaid `xychart-beta` for compact
inline comparisons that are naturally authored as a diagram.

### Why the spinner, not a partial chart?

The `chart` fence contains a single JSON object. Until the LLM finishes
streaming that object the JSON is syntactically incomplete (`tryParseChartSpec`
returns `null`). There is no meaningful partial state to display, so the
frontend shows a spinner until the spec is fully parseable.

### Why React.memo?

The chat bubble re-renders on every streamed token. Without memoization the SVG
subtree (hundreds of nodes) would be rebuilt on every token the LLM emits
*after* the chart fence has closed — producing visible flicker for as long as
the model keeps streaming prose. `React.memo` with a `JSON.stringify`-based
comparator ensures the chart paints exactly once after the spec arrives and is
then frozen until the spec actually changes.

---

## ChartSpec Schema

`tryParseChartSpec` (in `portal-web/src/components/chat/chart-utils.ts`)
validates and normalises the JSON. The accepted shapes are:

### Pie chart

```json
{
  "type": "pie",
  "data": {
    "slices": [
      { "label": "kube-system", "value": 1005 },
      { "label": "monitoring",  "value": 383  }
    ]
  },
  "title": "Pod distribution",
  "width": 760,
  "height": 480
}
```

### Bar chart

```json
{
  "type": "bar",
  "data": {
    "categories": ["kube-system", "monitoring"],
    "series": [
      { "name": "Pods", "values": [1005, 383] }
    ]
  },
  "title": "Top namespaces",
  "y_label": "Pod count"
}
```

### Line chart

```json
{
  "type": "line",
  "data": {
    "series": [
      {
        "name": "total pods",
        "points": [
          { "x": 1716000000, "y": 1840 },
          { "x": 1716003600, "y": 1856 }
        ]
      }
    ]
  },
  "title": "Pod count over time",
  "x_label": "Time",
  "y_label": "Pods"
}
```

**Common optional fields** (all chart types): `title`, `width`, `height`,
`x_label`, `y_label`.

**Line chart x values**: pass epoch seconds as a `number` for time-series data;
the renderer formats them as `HH:MM`. Pass a `string` for categorical x-axes.

---

## Writing a New MCP Chart Tool

The only contract the frontend enforces is the fence tag and the JSON shape.
To have your tool's output rendered as a chart:

1. Serialise your data as one of the `ChartSpec` shapes above.
2. Wrap it in a `chart` fence and include it verbatim in your tool's text
   response:

```ts
const markdownEmbed = "```chart\n" + JSON.stringify(spec) + "\n```"
```

3. Instruct the LLM to paste the block as-is (do not re-escape or re-wrap it).

The frontend needs no changes. All three chart types — and any future type added
to `ChartSpec` — share the same fence tag and the same anti-flicker path.

---

## Adding a New Chart Type

If pie/bar/line do not cover your use case, add a new type to the union:

| File | Change |
|---|---|
| `portal-web/src/components/chat/chart-utils.ts` | Extend `ChartSpec` union; add validation in `tryParseChartSpec`; add any new layout helpers |
| `portal-web/src/components/chat/ChartRenderer.tsx` | Add a `renderXxx` function; add a branch in the `useMemo` inside `ChartRenderer` |
| `mcp/create-chart/src/handler.ts` | Add the new type to the input schema enum and `validate()` |
| `mcp/create-chart/src/types.ts` | Extend `RenderChartArgs` |

**No changes needed in `Markdown.tsx`** — the `hasLanguageClass(className, "chart")`
gate and the `ChartFence` memoization cover every type in the `ChartSpec` union
automatically.

---

## What the Frontend Does NOT Support

- **Unsupported Mermaid families and other diagram tags**: ` ```echarts `,
  unsupported Mermaid diagram types, and other diagram DSLs fall through to an
  error/source view or the generic `<pre>` renderer rather than executing custom
  rendering logic.
- **Inline `<img>` tags or `data:` URIs as chart output**: these bypass
  `ChartRenderer` entirely and receive no interactivity (hover tooltip,
  copy/download toolbar, log-scale toggle).
- **Streaming partial charts**: the spinner is the only streaming state; there
  is no incremental render of partially-arrived data.
