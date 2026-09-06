# mcp-product-support-result

A stateless stdio MCP server that validates and serializes the handoff decision
for a product-support conversation turn. It has no network access and performs
no ticket, group, or notification side effect.

## Tool

`submit_product_support_result(label, info)` returns the canonical result as
both MCP text content and `structuredContent`.

```json
{
  "label": true,
  "info": {
    "ticket_type": "incident",
    "product": "Example Product",
    "summary": "Training task cannot start",
    "description": "Task task-123 remains Pending after retry.",
    "evidence": ["task_id=task-123", "status=Pending"],
    "missing_fields": []
  }
}
```

`ticket_type` is one of `consultation`, `incident`, `requirement`, or
`unknown`. A `label=true` result must resolve the type, provide a non-empty
summary and description, and have no missing fields. Requirements must also
name a concrete product grounded in product knowledge. For incidents and
consultations, a concrete `product` must be established by the conversation or
authoritative product knowledge; otherwise leave it empty, preserve the
user-visible entry in `description`, and let first-line support determine
ownership. `missing_fields` contains lowercase `snake_case` machine identifiers
only, never questions or diagnostic instructions.

The server validates each call independently. It does not know Siclaw session
or turn identity, so "exactly one successful result per turn" is not enforced
here — the caller that consumes the result owns that rule.

## Portal MCP config

```json
{
  "name": "product-support-result",
  "transport": "stdio",
  "command": "mcp-product-support-result",
  "args": [],
  "env": {}
}
```

The binary is built into the AgentBox image from `mcp/MCP_LIST.txt` and linked
as `mcp-product-support-result` on `PATH`, so the config above needs no
absolute path.

A successful call appears in the streamed `tool_execution_end` event for
`mcp__product-support-result__submit_product_support_result`, carrying the
validated object as MCP `structuredContent`. A control plane that pins this
full tool name as an Agent's required result tool can therefore treat that
object as the turn's single machine-readable outcome, and fail the turn closed
when it is absent, duplicated, or upstream-failed.
