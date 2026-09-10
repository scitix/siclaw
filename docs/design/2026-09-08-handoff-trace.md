# Handoff trace continuity — 2026-09-08

## Problem

The source AgentBox assigned a prompt trace ID, but `handoff_requested` and the
next `chat.send` carried only the destination and brief. The receiving AgentBox
started an unrelated trace. Export-disabled / unattached Recorder paths also
ignored inherited IDs. A logical user turn therefore split across audit records
and exported traces.

## Contract and ownership

Capture the actual transfer tool span before eviction; carry an optional owned
`traceContext` (traceId, parentSpanId, traceFlags) through the control event and
trusted handoff envelope. Validate nonzero lowercase OTel IDs at boundaries.
The external portal copies scalars, never modifies shared event maps, and retains the first
known trace ID within the ChatSend loop. AgentBox creates a new span with the
remote parent while retaining the trace ID. ID-only operation inherits the ID
without requiring export. Ordinary new prompts inherit nothing.

Trace metadata belongs to the execution harness, not model arguments. Keep
existing authorization, turn ownership and sequential terminal transfer logic.
No schema migration, public caller override or new dependency is required.

## Scope and limitations

The implementation covers the existing web handoff loop, including A→B→A and
message persistence. `/run` and A2A currently lack an equivalent handoff loop;
the Runtime exposing a tool in web session mode is not sufficient. This audit
corrects previous claims of complete cross-entry-point handoff support.

Upgrade both services. Older senders without context remain compatible but can
split traces; forwarding cannot merge already exported spans or old DB records.
No collector has been exercised in this change, and export remains best effort.
The external portal HTTP/WS/DB operations are not all instrumented by this propagation change.
