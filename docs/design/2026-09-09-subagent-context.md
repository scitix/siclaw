# Selectable parent context for subagents

## Interface and snapshot boundary

Add optional `fork_turns: "none" | "all" | positive integer` to `spawn_subagent`.
Default remains independent context. Positive integers select the most recent N
user-message turns; all selects the active native pi context, not the append-only
archive. Existing compaction summaries stay summaries. This option is new-child
only: resume restores the child's own transcript and rejects a new fork selection.

The manager validates the parent session/user and projects its current messages
synchronously before artifact ticket creation yields. One immutable snapshot is
shared by the collapsed single child, every map child, and the optional reducer.
Later parent messages cannot change the starting context of queued workers.

## Content and authority

Projection preserves user/assistant text, images, completed diagnostic calls and
results, bash observations, and native branch/compaction summaries. It omits
system/developer messages, thinking/signatures, opaque tool details, custom runtime
controls, pending calls, and task/spawn/handoff coordination calls/results.
The history is serialized as reference data in one native custom message, injected
with triggerTurn=false before the child's assignment. It is never installed as a
system prompt or replayed as executable tool calls. Images remain native image
blocks. On later resume, native transcript restoration retains the context without
re-importing parent history. Normal child compaction still applies.

Business rules and child roles remain separately compiled; tool/resource permissions
are unchanged. Parent task IDs and file paths grant no authority. Referenced files
are not copied by arbitrary path; children must use their own authorized tools.

## Long evidence and lifecycle

Remap only artifact IDs referenced by selected history. Each read uses the parent's
original Agent/session scope and the existing integrity/TTL/private-path checks.
Copy sanitized full contents to each child's existing artifact store; recursively
remap nested references with deduplication. Do not copy internal capability artifacts
or resume tickets. Cycles, graphs larger than 256 IDs, and graphs exceeding 64 MiB
of referenced artifact content fail explicitly. The child gets fresh IDs; historical
reference checksums/expiry metadata are not authoritative for the copies. Existing
child quotas and cleanup remain in force.

Missing evidence or exhausted quotas fail the child visibly instead of silently
clipping it. Copies made before failure remain bounded by the existing TTL cleanup.
Stop/deadline checks prevent further graph traversal after cancellation. The selected
model gets a context-fit check including the injected history before the first prompt;
oversized input asks for a narrower selection or larger tier. No extra LLM prompt
optimizer or forced reasoning steps are introduced.

## Compatibility

No control-plane rendering change, HTTP endpoint, database migration, production dependency
or Helm value change is needed for context selection. Product docs are bilingual.
Native read and artifact access controls remain unchanged.
