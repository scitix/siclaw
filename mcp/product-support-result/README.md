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

`ticket_type` is one of `consultation`, `incident`, `llm_incident`,
`requirement`, or `unknown`. A `label=true` result marks the Agent's final
conversation turn: intake is complete and the channel can offer its human
handoff button. The user triggers that workflow; the result itself does not
initiate a handoff or create a ticket. End with an acknowledgment that the
information is prepared, without further questions or claims of completed actions.

A `label=true` result must provide a non-empty summary and description and
have no blocking clarification fields. The type may remain `unknown` when
the user cannot or declines to clarify; preserve that uncertainty and the
handoff request in the description instead of inventing a classification.
An empty `missing_fields` means no further Agent clarification is needed,
not that every fact is known.
Requirements must also name a concrete product grounded in product knowledge.
For incidents and consultations, a concrete `product` must be established by
the conversation or authoritative product knowledge; otherwise leave it empty,
preserve the user-visible entry in `description`, and let first-line support
determine ownership. `missing_fields` contains lowercase `snake_case` machine
identifiers only, never questions or diagnostic instructions.

### `llm_incident`

`llm_incident` is the fault type for problems while calling an LLM / model API
or inference endpoint: gateway errors, authentication and rate-limit or quota
failures, broken streaming, or a specific named model misbehaving. `incident`
remains every other fault.

The `llm` block carries best-effort intake details for first-line support:

```json
{
  "label": true,
  "info": {
    "ticket_type": "llm_incident",
    "product": "",
    "summary": "Chat completions return 429",
    "description": "Every request to the model API has returned HTTP 429 since this morning.",
    "evidence": ["HTTP 429", "model=example-model-v2"],
    "missing_fields": [],
    "llm": { "region": "overseas", "aspect": "model", "model": "example-model-v2" }
  }
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `llm.region` | `""`, `domestic`, `overseas` | Deployment region the user calls from, per the operator's own classification rules |
| `llm.aspect` | `""`, `platform_api`, `network`, `model` | Failing part of the path: the API platform or gateway, network reachability, or a specific model |
| `llm.model` | free text | Model name as the user stated it |

These fields are hints, not gates. Fill each one only from what the
conversation establishes and leave it empty otherwise; a `label=true`
`llm_incident` does not require any of them. While still gathering, the
identifiers `llm_region`, `llm_aspect` and `llm_model` may appear in
`missing_fields`. The block may already be filled while `ticket_type` is still
`unknown`, so a region or model the user stated up front has somewhere to
live; once the type resolves to `consultation`, `incident` or `requirement`
all three fields must be empty, so a stray value is never read as an
established fact. The block is optional on input: omitting it means all three
fields are empty, which is the correct value for every type except
`llm_incident`. It is always present in the returned result.

### Size limits

The validated result is persisted downstream as one row's metadata, so every
field is bounded and an oversized value is rejected here, where the model can
shorten it. Limits are in characters, not bytes.

| Field | Limit |
| --- | --- |
| `summary` | 200 |
| `description` | 2000 |
| `product`, `llm.model` | 128 |
| `evidence` | 20 items, 300 characters each |
| `missing_fields` | 20 items, 64 characters each |

Limits apply to the raw value before trimming, exactly as a host that
validates the advertised schema before dispatch applies `maxLength`, so the
parser is never more lenient than the schema the model was shown.

### Canonicalization

The parser mirrors the advertised JSON Schema and adds nothing the schema does
not say: enum values (`ticket_type`, `llm.region`, `llm.aspect`) must be the
exact lowercase spelling. String fields are trimmed. `evidence` and
`missing_fields` items are trimmed and post-trim duplicates are removed, so the
returned arrays can be shorter than the caller's.

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
