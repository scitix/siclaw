# Native assistant narration

This supersedes the tool-intent fallback in `2026-09-07-web-conversation-progress.md`. The user requested the Codex approach: ordinary model-authored commentary, independent tool execution, and one final answer. Do not add narration fields to tool schemas or synthesize commentary from tool arguments.

## Contract

- pi's public text blocks map to separate assistant items. Runtime emits `item/started`, `item/agentMessage/delta`, and `item/completed`, with thread/turn/item identity and an item-local sequence. Delta frames carry incremental text; completion supplies authoritative text. This is an adapter for the existing runtime, not a claim of complete Codex App Server protocol compatibility.
- Preserve provider `textSignature` (output identity and phase) and api/provider/model on each persisted item. Unknown phase remains unknown. Do not infer final_answer from stopReason. No private reasoning content belongs in these public rows.
- Store items separately. message_end and its turn_end echo have one persistence effect. A later DB acknowledgement updates the same item; it does not create another paragraph. Preserve deferred writes and rollback for model routing.
- Restore metadata and real model origin when reconstructing same-model history; cross-model signature conversion remains governed by the existing provider adapter.
- Frontend renders by item identity, including polling and completion. Older events without nativeItems remain supported. New compatibility message events carry nativeItems=true to avoid rendering their body twice. Completion of a text item does not complete the logical task.
- Text and handoffs separate consecutive command groups. Multiple commands can follow one paragraph. Existing whole-process folding and actual executor labels remain.

## Verification and rollout

Cover multiple native phases in one pi message, parallel tool starts, end-only text, duplicate completion delivery, polling, real SessionManager restore, cancellation, and shared Go event forwarding. Run an unmodified synthetic tool through the real model/engine/Brain/Gateway and replay its public events in the real frontend components.

Publish API/web before Runtime and AgentBox. Allow current executions to finish before recreating brains to replace previous schemas and prompts. Do not silently change production API/model/reasoning settings. Current live acceptance uses the user-authorized Responses endpoint; Chat Completions returned an explicit protocol compatibility error during this run.
