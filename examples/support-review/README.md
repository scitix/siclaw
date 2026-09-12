# Customer support and completed-ticket review

Use two independent Custom Agent instances, each with its own prompt, bindings,
required result tool and API key. The same `POST /api/v1/run` transport serves both
instances; the bearer key chooses the instance. Callers do not supply an Agent ID.

## Configure the two instances

The control plane must support tenant-owned Custom harnesses and provide a usable
published Custom model. Use the normal Agent creation and configuration pages:

1. Create separate support and review instances. New Custom prompts are empty.
2. Apply `support-prompt.md` or `review-prompt.md` through the prompt editor
   (`PUT /api/v1/agents/:id/prompt`, body `{ "system_prompt": "..." }`).
3. Bind each instance's resources. Support needs product knowledge and its result
   MCP. Review needs the `ticket-review` Skill and its result MCP; supplied records
   are enough for the initial workflow. Reader integrations are optional.
4. Configure each required result using the corresponding `*-harness.json`
   (`PUT /api/v1/agents/:id/harness`). Replace the placeholder with that instance's
   actual bound tenant MCP ID. Use the original tool name, without an MCP prefix.
5. Issue distinct API keys and validate each instance through `/api/v1/run`.

The result servers are stdio MCPs packaged with AgentBox:

| Instance | MCP command | Required tool |
| --- | --- | --- |
| Support | `mcp-product-support-result` | `submit_product_support_result` |
| Review | `mcp-ticket-review-result` | `submit_ticket_review_result` |

Both use an empty arguments array and environment object by default. Create and enable
the MCP in the same tenant as its Agent, then bind it using the MCP resource tab.
Installing the executable does not create that binding. A saved `pending` reload
needs runtime confirmation; saving a tool name does not establish tool availability.
Built-in `read_files` does not restrict the operations offered by an MCP: bind
read-only readers, not general ticket-writing or remediation servers.

Existing release-managed product-support instances retain their contract. They
do not need to be migrated to deliver the new review instance. New managed Agent
Types or changes to the shared Custom release are not needed for these prompts
and result tools. Model combinations remain governed by the platform.

## Call and consume

`run-client.ts` is a source example for a server-side integration. It reuses both
MCP validators and accepts a result only after `result` followed by `done`. It
rejects wrong ticket IDs, references absent from supplied records, malformed
results and incomplete streams. Optional `onChatEvent` forwards assistant events
for customer-facing streaming. Keys stay on the backend; redirects are refused.

```ts
import { runTicketReview } from "./run-client.js";

const completed = await runTicketReview({
  baseUrl: process.env.SICLAW_BASE_URL!,
  apiKey: process.env.SICLAW_REVIEW_API_KEY!,
  signal: AbortSignal.timeout(180_000),
}, {
  ticket: { id: "ticket-example", status: "resolved", revision: "completion-1" },
  records: [{
    source: "ticket_comment", id: "comment-example", time: "2026-01-01T10:00:00Z",
    text: "Requests recovered after restart. Pre-restart diagnostics are unavailable.",
  }],
  coverage: { complete: false, missing: ["Pre-restart diagnostics"] },
});
// Save the full result, including needs_review, evidence and open_questions.
// The ticket application owns this write and any later human correction.
```

The example sends only `text`, `stream`, and an optional `session_id` in the HTTP
body. Context JSON is task data inside `text`; `revision` is the caller's material
version, not a new server idempotency key. A fresh ticket gets a fresh session;
only subsequent work on that ticket can reuse its review session. Never pass the
support session to the review instance.

The supplied-record example bounds serialized context at 256 KiB and individual
SSE frames at 128 KiB. These are client limits, not advertised server limits or a
promise that every model can ingest that much text. Select relevant records for
the chosen model and declare missing material; never silently truncate it. The
MCP's result limit is independently 24 KiB. Schemas validate shape, not factual
truth; reference membership does not prove that a conclusion follows from it.

## Completion and ownership

Trigger review after the ticket's handling state and records are saved. Support
`label=true` means intake is complete; it is not a ticket-completion event.
Map the ticket application's completed states explicitly to `resolved`/`closed`
in this example. Model results must not decide whether a ticket is closed.

The application must durably deduplicate a completion revision, retain the input
snapshot plus run/session/turn identifiers, and retry failed attempts deliberately.
This client does not automatically replay a request: a lost connection is not
proof that no model work ran. Save no successful result before `done`. New ticket
material creates a new review revision; do not overwrite a human correction.

Store the original classification alongside the retrospective classification.
`type` is free text, not a stable routing code. Review folds model/API incidents
into `incident`; support's `llm_incident` intake route remains independent.
`ready` means an evidence-sufficient machine draft, never human approval.

## Acceptance

Run local contract checks from the repository root:

```sh
npx vitest run examples/support-review mcp/ticket-review-result mcp/product-support-result
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 \
  --esModuleInterop --skipLibCheck --resolveJsonModule examples/support-review/run-client.ts
```

The tests consume actual MCP-validated outputs through a controlled SSE response.
They are not real-provider or deployed-control-plane acceptance. For live checks,
use `scripts/smoke/support-review.ts` with separately configured keys. Keep outputs
private. Inputs and expected checks are separate: expected answers are never sent
to the model. Manually inspect causal support and final disposition in addition
to machine-checkable classification and reference membership.

Load the two keys into the backend environment using your secret manager, then run:

```sh
npx tsx scripts/smoke/support-review.ts
```

Required environment names are `SICLAW_BASE_URL`, `SICLAW_SUPPORT_API_KEY` and
`SICLAW_REVIEW_API_KEY`. Set `SICLAW_ACCEPTANCE_DIR` to a private directory to
retain inputs, results and failure diagnostics. The script never prints keys.

Required business cases: support answer/handoff; confirmed incident; completed
governance; deferred product request; answered consultation; unknown cause;
missing/conflicting records; concurrent tickets; wrong session; interrupted run;
duplicate completion; and rerun after human edits. The last two require the actual
ticket application's persistence integration, which is outside this example.
