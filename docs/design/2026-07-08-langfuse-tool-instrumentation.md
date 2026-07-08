# Langfuse Native Tool Instrumentation on the `llm.call` Generation

> Status: accepted (2026-07-08). Scope: agent-behavior tracing (plane A). Additive to the
> existing OTLP export — no SDK change, no change to the standalone TOOL spans.
> Related: `2026-06-22-unified-model-routing-entry.md` (routing event flow the recorder mirrors),
> `sanitization.md` (the content redactor reused here).

## Purpose

Langfuse (≥ v3.143.0) exposes native tool filters/dashboards: **Tool Names (Available)**,
**Tool Names (Called)**, **Available Tools** (count), **Tool Calls** (count), plus dashboard
splits by `toolNames`. These are populated by a dedicated ingestion extractor
(`extractToolsBackend.ts`) that reads **only** structured `tool_calls` and tool definitions from
an observation's `input` / `output` / attributes. It does **not** read the `tool.name` attribute
of siclaw's standalone TOOL spans.

siclaw's `llm.call` generation observation previously carried only assistant text on `output` and
nothing tool-shaped on `input`, so all four native filters were empty for siclaw traces. This
change adds the structured tool data those filters require, on the generation observation, while
leaving the standalone TOOL spans (which still serve Name/Metadata filtering) untouched.

## Langfuse extraction contract (the ground this design stands on)

Verified against `extractToolsBackend.ts` + `OtelIngestionProcessor.ts`:

- OpenInference `input.value` / `output.value` map to the observation `input` / `output` as raw
  strings; the tool extractor internally `JSON.parse`s a string field (`parseIfString`) before
  inspecting it. **Consequence:** a JSON string written into `output.value` / `input.value` is
  parsed and mined for tools.
- **Called tools are extracted only from the observation `output`** (top-level `tool_calls`,
  `choices[].message.tool_calls`, or content-array `tool_use` / `tool-call` parts). There is **no
  metadata fallback** for called tools — they must live on the generation's `output`.
- **Tool definitions** are extracted from the observation `input` (an object with a `tools`
  array) **or** from raw metadata attributes.
- `input` for definitions must be an **object** with tools under the `tools` key; a bare top-level
  array is treated as `messages`, not tools.
- The OpenAI nested-call shape is recognised by `functionCall?.name && "arguments" in
  functionCall` — the **`arguments` key must be present** (even as `""`) or the call is not
  recognised as OpenAI-shaped.

## Instrumentation contract

On the `llm.call` generation span (OpenInference span-kind LLM → a Langfuse GENERATION):

```
┌───────────────────────────────────────────────────────────────────────────┐
│  llm.call (GENERATION)                                                      │
│                                                                             │
│   input.value  = {"tools":[{ "type":"function",                            │
│                              "function":{ name, description?, parameters? }}]}│
│                  └─ written ONCE per prompt, on the FIRST llm.call only      │
│                     → Tool Names (Available) / Available Tools              │
│                                                                             │
│   output.value = {"tool_calls":[{ id, "type":"function",                   │
│                                    "function":{ name, arguments }}],         │
│                    "content"?: <assistant text> }                           │
│                  └─ written on EVERY llm.call that requested tool calls      │
│                     → Tool Names (Called) / Tool Calls                      │
└───────────────────────────────────────────────────────────────────────────┘
```

**Structure = OpenAI.** `output.tool_calls` and `input.tools` in OpenAI Chat/request shape.
Langfuse recognises several dialects; OpenAI is the most stable and the one this design emits.

**Called tools are written per generation; definitions are written once per prompt.** Called
tools come only from the `output` and differ turn to turn, so each generation carries its own.
Tool definitions are static for the session, so writing them on every generation is pure
redundancy that scales with turn count; lighting up the Available filters requires only one
observation per trace to carry definitions. The first `llm.call` of each prompt writes them; a
per-prompt `toolsWritten` latch suppresses the rest.

**Called-tool source = the assistant message content.** At `message_end`, the assistant
`message.content[]` carries the fully-assembled `{ type:"toolCall", id, name, arguments }` parts
— the authoritative record of what the model requested this turn, aligned 1:1 with closing the
generation span. This is preferred over accumulating `tool_execution_start` events (no
cross-event buffering, no ordering race, and it matches Langfuse's "called" semantics = tool
calls the model emitted, not what was later executed after approval/filtering).

## Metadata-vs-content boundary

This extends the existing rule (the standalone TOOL span exports `tool.name` unconditionally and
gates `tool.parameters` behind `sendContent`) onto the generation span:

| Field | Class | Gated by `sendContent`? |
|---|---|---|
| Called tool name + call id | metadata | no — unconditional |
| Called tool arguments (`function.arguments`) | content | yes — `""` when gate closed (key retained for OpenAI recognition) |
| Assistant free text (`output.content`) | content | yes (unchanged from before) |
| Available tool name / description / parameters schema | metadata (static, config-derived) | no — unconditional (see Residual risks) |

Emitting tool identity unconditionally is what makes the filters light up at the default
`sendContent=false`. Everything emitted unconditionally is static, config-derived data (tool
names, descriptions, JSON schemas, random call ids); only user-influenceable payloads (call
arguments, free text) stay gated.

`input.value` / `output.value` carrying tool identity are therefore written **outside** the
`sendContent` gate — the gate governs only the argument/text fields nested inside them.

## Data-source contract

Tool definitions are pulled live via an optional `BrainSession.getTools(): BrainToolDefinition[]`,
called from the recorder at the first `message_start` of each prompt — the same "pull from the
brain at event time" pattern already used for `getModel()` / `getSessionStats()`. `PiAgentBrain`
implements it from `AgentSession.getAllTools()` (which, because the session is built with
`noTools:"builtin"`, is exactly the model-visible set: `allowedTools`-filtered custom tools + MCP
+ restricted file tools + extension tools).

Rationale for live-pull over an attach-time snapshot:
- Immune to staleness (a `reload()` / MCP change is reflected on the next prompt).
- Keeps `src/shared/tracing` free of pi types — the boundary stays `BrainSession`; the recorder
  never reaches into `brain.session`.
- No evaluation in an `attach()` argument position, so a throwing enumeration can never escape
  the recorder's fault-isolation try/catch (a fault must never disturb the brain-event flow, and
  a disabled recorder must stay a clean no-op).

`BrainToolDefinition { name; description?; parameters? }` is owned by `brain-session.ts` (peer of
`BrainModelInfo`), so the core brain interface carries no tracing type.

## Serialization-safety contract

The attribute builders must always emit **valid JSON** (a truncated JSON string fails
`parseIfString` and yields nothing). Therefore:

- Redaction/capping is applied **per field** (each argument string, each description), never as a
  char-cap on the assembled envelope.
- A per-tool parameter budget: a tool whose serialized `parameters` exceeds the budget drops its
  `parameters` (keeping name + description) rather than emitting a bisected schema.
- A total budget on the tools array: tools are included in order until the budget is reached;
  only whole tools are included, bounding a single span's tool payload. OTLP is configured with
  no attribute-length limit, so these budgets are the only size ceiling.

## Residual risks & known limits

- **Description / schema are exported unconditionally.** Tool names are always safe; a
  self-authored or MCP tool's *description* or schema field could embed internal hostnames or
  terminology. These are config-derived (not user-derived) and exported only to a self-hosted,
  same-trust-domain backend — the same trust premise as tracing overall. Recorded as a residual
  risk (not a guarantee), consistent with this module's redaction posture. If tightening is ever
  needed, gate description/schema behind `sendContent`; tool *names* alone still light up all four
  filters.
- **Mid-prompt tool-set changes are not reflected until the next prompt** (definitions are read
  once per prompt).
- **Background / synthetic turns** open no ROOT (an existing v1 tracing limit), so they emit no
  generation span and therefore no tool data — no regression, just uncovered.
