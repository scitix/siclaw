# KB Authoring Message Idempotency

## Contract

`capability.message` accepts an optional consumer-minted `message_id`. When it
is present, the runtime and capability box must acknowledge repeated delivery
without injecting a second conversational turn. Calls without the field retain
the original at-least-once behavior for rolling compatibility.

The KB control plane uses its durable authoring-operation UUID as the kickoff
message id. The original kickoff text is stored on the operation, so a retry
cannot silently replace the payload associated with that id.

## Crash ordering

The runtime follows this order:

1. forward `{message, message_id}` to the box;
2. persist run status `running`;
3. checkpoint the accepted id in the consumer-owned run store;
4. acknowledge the caller.

The box claims the id before invoking the model. If model dispatch itself
throws, it releases the claim so the caller can retry. If the box accepted the
turn but the runtime dies before step 3, the retry reaches the same box and is
deduplicated there. If step 3 committed, a restarted runtime restores the recent
id set from the run checkpoint and does not contact the box again.

Ids are limited to 128 characters, and only the most recent 128 are checkpointed. Capability runs are bounded by
their normal lifecycle/TTL, so this is enough for HTTP retry windows without
turning the run checkpoint into an unbounded transcript.

## Deployment

The field is additive and optional, so Sicore, the runtime, and the compile-box
image may roll independently. Full protection is active after all three pieces
are deployed; changing `compile_box.py` requires rebuilding the
`kbc-compile-box` image.
