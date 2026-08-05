# Lark customer-support ticket intake

## Delivery boundary

This flow implements the product-facing work that does not depend on a ticket
backend:

1. The normal knowledge-enabled channel agent answers a consultation.
2. The requester clicks **Prepare ticket** on that answer.
3. The agent classifies the request and collects missing facts in chat.
4. Siclaw renders a deterministic review preview.
5. The same requester clicks **Confirm**.
6. Siclaw freezes and returns a `siclaw.ticket_intake.v1` payload.

No step reads or operates a cluster, host, VM, or production system. The agent
can update the draft through `ticket_intake_draft`; that tool has no confirm or
submit operation. Confirmation is accepted only from a Lark card callback whose
operator `open_id` matches the persisted requester.

## State model

`collecting -> review -> confirmed`

`collecting|review -> cancelled`

Draft updates and card transitions use optimistic `revision` checks. Repeating
the same start click is idempotent, and repeating a successful confirmation
returns the already-frozen payload.

## Handoff contract

```json
{
  "schema_version": "siclaw.ticket_intake.v1",
  "intake_id": "uuid",
  "session_id": "uuid",
  "channel": {
    "type": "lark",
    "channel_id": "channel-config-id",
    "requester_external_id": "ou_xxx",
    "source_message_id": "om_xxx"
  },
  "draft": {
    "classification": "incident_candidate",
    "summary": "...",
    "product": "...",
    "category": "...",
    "impact": "...",
    "affected_object": "...",
    "occurred_at": "...",
    "actual_behavior": "...",
    "expected_behavior": "...",
    "attempted_actions": [],
    "source_refs": [],
    "open_questions": [],
    "ready_for_review": true
  },
  "confirmed_at": "ISO-8601"
}
```

The future ticket-system adapter consumes this frozen payload after
`channel.transitionTicketIntake(action=confirm)`. It must add its own delivery
receipt, retry policy, and remote ticket identifier; those concerns are not
represented as successful ticket creation in this phase.

## Agent configuration

Use a dedicated custom agent with knowledge/skills required for product support
and explicitly select the `ticket_intake` capability group. Do not select
`inspect_infra`, `run_commands`, or `run_scripts` for this agent.

The Lark channel is also opt-in: set `ticket_intake_enabled: true` in its
configuration only after that agent setup is complete. Existing Lark bots keep
the feature disabled by default.

Standalone Portal implements all four RPCs:

- `channel.beginTicketIntake`
- `channel.getActiveTicketIntake`
- `channel.updateTicketIntakeDraft`
- `channel.transitionTicketIntake`

An upstream control plane must implement the same RPC contract before this flow
is enabled against that environment.
