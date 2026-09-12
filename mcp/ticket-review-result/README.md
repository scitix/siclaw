# Ticket review result MCP

A standalone stdio MCP for an internal SRE assistant that classifies and reviews
closed tickets. `submit_ticket_review_result` validates the result and returns
the same JSON object in MCP text and `structuredContent`. It does not read ticket
systems, send messages, create tickets or write closure fields.

Use it with the [ticket-review Skill](../../skills/core/ticket-review/SKILL.md).
The pre-ticket product-support assistant keeps its existing result contract.

## Input to the assistant

Send `/ticket-review ticket-example-1` as an ordinary task message, followed by
available context. There is no new slash-command parser or `/query` endpoint.
The assistant can use attached material or separately configured read-only tools.

Example task text (all data is synthetic):

```text
/ticket-review ticket-example-1

Context:
{
  "ticket": {
    "id": "ticket-example-1",
    "status": "closed",
    "title": "Application writes fail because the data volume is full"
  },
  "records": [
    {
      "source": "ticket_comment",
      "id": "comment-example-1",
      "time": "2026-01-01T10:00:00Z",
      "text": "Confirmed log rotation configuration was not loaded. Logs filled the volume. Loaded the configuration and removed old logs; writes recovered."
    },
    {
      "source": "group_message",
      "id": "message-example-1",
      "chat_id": "chat-example-1",
      "time": "2026-01-01T10:20:00Z",
      "text": "Verified new logs rotate and application writes succeed."
    }
  ],
  "coverage": { "complete": true, "missing": [] }
}
```

Keep ticket and record IDs, source kinds, timestamps and group associations.
State missing pages, unread attachments or failed reads. A coverage declaration
describes the query scope; it does not certify the content. With an ID alone and
no working reader, the assistant returns `needs_review` and names the missing
material. Reader authentication and retrieval remain the integration's concern.

## Output contract

```json
{
  "ticket_id": "ticket-example-1",
  "ticket_type": "incident",
  "requirement_kind": null,
  "type": "Log rotation failure",
  "result": "Unloaded log rotation configuration allowed logs to fill the data volume, blocking application writes. Loading the configuration and removing old logs restored writes; the associated group confirmed successful rotation and writes.",
  "review_status": "ready",
  "evidence": [
    { "source": "ticket_comment", "id": "comment-example-1" },
    { "source": "group_message", "id": "message-example-1" }
  ],
  "open_questions": []
}
```

| Field | Meaning |
| --- | --- |
| `ticket_id` | Current ticket ID, preserved exactly. |
| `ticket_type` | `incident`, `requirement`, `consultation`, or `null` when unresolved. Includes model/API incidents under `incident`. |
| `requirement_kind` | `governance` for remediation of existing module problems; `product` for product feature requests. `null` for non-requirements or unresolved requirement subtype. |
| `type` | Short concrete category name, free text in the requested language. |
| `result` | Evidence-based explanation of cause, actual handling/disposition and verification, appropriate to the category. |
| `review_status` | `ready` for an evidence-sufficient machine draft; `needs_review` for important gaps, unresolved classification or conflicting conclusions. Neither means human approval. |
| `evidence` | Unique `{source, id}` references to content actually read. Sources: `ticket`, `ticket_comment`, `operate_log`, `group_message`, `attachment`. |
| `open_questions` | Specific missing facts or unresolved questions for the reviewer. |

Consumers displaying only two fields can use `type` and `result`; retain the
other fields for classification, provenance and review state.

The [JSON Schema](src/result.schema.json) is the single source for both advertised
tool schemas and runtime shape validation. All eight fields are required, extra
fields and blank strings are rejected, and arrays must not contain duplicates.
Non-requirements must have a null subtype. Unknown category or requirement subtype
requires `needs_review`. Ready drafts need evidence and no questions; incomplete
drafts need at least one question. Values are preserved without coercion, trimming
or invented defaults. The additional serialized-size check rejects results over
24 KiB of UTF-8 JSON to leave room in downstream result metadata; nothing is silently
truncated. Validation failures return `isError=true` without `structuredContent`.

The MCP is stateless. Ticket identity, reference existence, material completeness,
cause correctness and exactly one successful submission per task require the
assistant and consumer's task context; schema validation does not establish them.

## Assistant and API setup

Build the package with `npm ci && npm run build` in this directory. The AgentBox
image builds packages in `mcp/MCP_LIST.txt` and exposes the binary on `PATH`:

```json
{
  "name": "ticket-review-result",
  "transport": "stdio",
  "command": "mcp-ticket-review-result",
  "args": [],
  "env": {}
}
```

Create a separate ticket-review assistant instance, bind this MCP and the ticket-review
Skill, and configure any required ticket/group readers as read-only. Its system
prompt should instruct it to use the Skill for each review task and submit the
result through this MCP. Packaging alone does not create or bind an assistant.

For a control plane supporting tenant-owned Custom harnesses, create an independent
Custom Agent instance and configure its required result contract as
`kind=mcp_tool`, the bound MCP server's ID, `tool_name=submit_ticket_review_result`,
and `required=true`. Associate a dedicated API Key with that assistant. Reuse the
existing `POST /api/v1/run` transport:

```json
{
  "text": "/ticket-review ticket-example-1\n\nContext:\n<ticket and related records>",
  "stream": true
}
```

The context is part of `text`; `query` and `context` are not new HTTP fields.
Use a fresh task/session per ticket, and reuse its returned session ID only to
continue that ticket's review. Consume the structured result on a successful
`result` then `done` terminal sequence according to the existing `/run` contract.
`done` is execution success; it does not turn `needs_review` into `ready`.

Use the instance prompt and resource configuration, with a usable platform-published
Custom model. A new managed Agent Type is not required. This package supplies the
MCP and Skill; it does not provision an instance or publish an API key. Control
planes without instance result contracts need that capability before this setup
can enforce the result through `/run`. Keep the shared Custom and product-support
release contracts unchanged. See the [two-instance setup and caller example](../../examples/support-review/README.md).

This package does not change the endpoint, session lifecycle or SSE envelope.
Preview/MCP validation does not establish an API-key HTTP deployment.

## Verification

From the repository root, run:

```bash
npx vitest run mcp/ticket-review-result mcp/product-support-result
npm run build --prefix mcp/ticket-review-result
```

Contract tests cover valid categories, incomplete drafts, invalid relationships,
size limits and real MCP client/server calls. For model acceptance, supply only
inputs (never expected outputs), then check classification before checking causal
claims, disposition and actual source references. Include confirmed incidents,
completed governance, deferred product requests, answered consultations, restored
incidents with unknown cause, and unavailable context.
