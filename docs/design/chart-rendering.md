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

The frontend recognises legacy pie/bar/line output through a fenced Markdown
block tagged `chart`. Request timelines additionally use versioned structured
tool attachments, rendered directly from persisted message metadata.

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
        ├── spec.type === "line" → renderLine
        └── spec.type === "waterfall" → TraceTimelineRenderer
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


## Structured request timelines

`render_chart(type="waterfall")` returns a short summary and
`structuredContent = {schema_version:2, visuals:[{visual_id,kind:"chart",spec,exports:{png:{status}}}]}`.
The normalized `spec` has `schema_version:1` and the same `visual_id`. Supported
clients render tool attachments automatically; the assistant should explain the
finding without repeating the JSON or a chart fence. Legacy fences still work;
a fence matching an already attached visual ID is suppressed.

Canonical fields/validation live in `mcp/create-chart/src/waterfall-spec.ts`.
`data` carries origin_time, request_id/trace_id/root_span_id, verified scope,
coverage and spans. Every span preserves its true parent, status, layer and
observed endpoints; attempt_id groups rows without rewriting the hierarchy.
UTC nanosecond timestamps are subtracted before converting to milliseconds.
Unknown ends stay null. Route/HTTP overlaps must never be added. HTTP timing is
not provider queue/inference or token timing. At most 200 spans / 256 KiB;
both input and the final normalized spec (including its visual ID) must fit.
Oversized output fails before PNG export or a successful tool response. Do not send raw attributes, bodies, headers,
URLs, ARN, prompts or credentials; only safe labels/IDs/evidence refs.

`output=web` needs no exporter; `both` retains data if PNG fails; `image` requires
successful PNG. Default waterfall=both, legacy=image. PNG uses a deterministic
SVG of the same data including coverage. Web interaction provides grouping,
zoom/brush, keyboard, detail selection and larger view. Only an explicit
investigate action sends evidence context back into the current conversation;
read-only hosts omit that callback.

Conversation attachments start as a compact card (up to three key HTTP intervals,
observed root duration and evidence gaps). Unfinished calls stay visible; preview
rows never sum nested durations. View timeline expands a scrollable detail region
capped at 640px / 65dvh. Collapse and larger view retain the current selection and
zoom. The transcript owns visual navigation and auto-follow: a visual deep link
expands and takes precedence over initial scrolling, including when its history
arrives later. New answers preserve that position; a new user turn resumes follow.
Unknown or unloaded visuals leave normal scrolling available. The hidden full
TraceSnapshot always contains every supplied span, so PNG export and message copy
are independent of disclosure state. No new tool argument is required.

Runtime persists details for Web, Lark, delegated and synthetic turns with the
shared metadata helper. Direct Lark responses forward PNG and, when supported,
request `chat.getVisualLink` from the host. Hosted conversations use the tool
event's `dbMessageId`, relayed after destination Runtime persistence, without
writing the transcript again. Raw AgentBox events use the locally persisted row
ID. Replayed message/visual pairs do not issue duplicate link requests. The RPC accepts session_id,
message_id and visual_id and returns `{url:string|null}`. SiCore verifies the
persisted attachment and Runtime/session relationship and returns its normal
login-protected chat URL. No access token is created. Standalone Portal returns
null because it has no comparable user permission model. Old hosts and export
failures retain text output. Background notification PNG forwarding is not
implemented; its tool attachment remains available in conversation history.

Keep frontend copies synchronized without a new package dependency:

```sh
node scripts/sync-waterfall-contract.mjs --sicore /absolute/path/to/sicore
node scripts/sync-waterfall-contract.mjs --check --sicore /absolute/path/to/sicore
```

Source interaction code is Portal's `TraceTimeline.tsx`; wrappers use each
product's own components and locale. Run contract, metadata, message and browser
checks before changing a shared field. Deploy readers before tools/skills.


## Standalone Portal PNG export

Portal serves a stateless `/siclaw-visual-export` page using the same chart and
Mermaid renderers as chat. The headless MCP browser passes data in the URL
fragment, so the server and access logs do not receive the chart payload.
The page does not read chat history or grant access to a session.

Set `SICLAW_VISUAL_EXPORT_URL` in the **create-chart MCP server's `env` config**
to the Portal URL reachable from AgentBox, for example
`http://siclaw-portal:3003/siclaw-visual-export`. Setting it only on Runtime is
insufficient: stdio MCP processes receive their configured environment.
`output=web` needs no exporter; `output=both` retains the structured timeline
when PNG export fails. Portal exports charts and Mermaid.


## Timeline language and responsive layout

The chart provides Auto / 中文 / English. Auto follows the SiCore platform locale,
or browser language in standalone Portal; `TraceHostContext.locale` can supply a
host override. The explicit preference is stored under `siclaw.traceLanguage.v1`
and updates every chart without resetting selection or zoom. Controls, statuses,
help, follow-up prompts and user-downloaded PNG use the selected language. Original
span labels and evidence remain unchanged. This does not localize Portal navigation
or select a Feishu recipient's language for the headless exporter.

Layout follows the chart container through ResizeObserver: at 980px it splits
into a timeline and 288px inspector; below that details are stacked, and plot
containers below 580px use mobile rows and a compact view selector. Dialog headers
remain fixed while rows and evidence scroll within bounded regions. The dialog is
at most 1240px wide and keeps a 12px viewport margin. Styles use host fonts/theme,
include coarse-pointer targets and respect reduced motion. `trace-locale.ts` and
`trace-timeline.css` are included in the shared sync/check script.

The PNG is a complete independent SVG. The partial-trace badge also accounts for
missing coverage, open spans and spans outside the root interval, even when trace
collection itself reports complete.
