# Provider usage observations

The AgentBox records one logical call at the Pi stream-function boundary. API
and subscription models use the same observation contract. Routing retries
create separate calls; HTTP retries hidden inside Pi remain one logical call.
This is runtime consumption telemetry, not an invoice or remaining allowance.

Chat, system-analysis sessions and compiler workers share this observation
contract. Workload ownership is resolved by the consuming control plane from
the authenticated session or capability run. Compiler sessions retain their
native identity and executor role; they do not impersonate a chat Agent.

## Evidence and identity

Each call has a UUID, immutable dispatch timestamp, session and trace identity,
model configuration snapshot, routing attempt and agent/auxiliary kind.
Started and finished observations share that identity. Failed, cancelled and
auxiliary calls are observed independently of visible assistant messages.
Request IDs group calls within a prompt. Chat uses the root trace when present;
compiler roles use their turn ID. Parent-call identity is optional and is not
inferred from temporal proximity.

Existing SDK usage and timing envelopes retain their meaning. The optional
llmCall.call_id joins a timeline entry to an observation. A separate
providerUsageEvidence captures allowlisted numeric fields, presence, protocol
and terminal/intermediate status. It never contains prompts, headers,
credentials or arbitrary provider properties. Invalid non-numeric values become
field names in invalidFields; their values are discarded.

The upstream normalizer owns accounting. OpenAI-compatible and Responses input
already includes cache tokens. Anthropic input excludes separately reported
cache read/write tokens. Reasoning is an output subset. Missing fields remain
missing; SDK-initialized zeroes are not evidence of reported usage.

## Persistence

The outbox lives under agent/usage-outbox, outside session transcript
directories, partitioned by agent and pod identity. Atomic file writes retain
unacknowledged observations across process restarts on the same storage.
Removing an ephemeral volume can still lose data; stale collector health must
not be presented as complete account coverage.

The authenticated AgentBox persistence channel carries usage.record_calls.
The Runtime verifies session ownership, forwards allowed observations to
usage.recordCalls, and returns per-observation acknowledgments. Accepted and
duplicate records are removed. Retryable records stay on disk; rejected and
dropped counts remain in collector state.

Limits: 8 KiB per observation, 128 observations / 512 KiB per batch, 64 MiB per
AgentBox outbox. Flushes start after 250 ms; transport errors back off from 1 to
30 seconds. Idle collectors send health every 30 seconds. Shutdown allows a
3-second flush and retains anything still unacknowledged.

## Compiler producers

The Pi compiler uses the same recorder and patched provider evidence as
AgentBox. The Claude adapter captures numeric usage from native message stream
events, including cache read/write fields. It emits one completed observation
per provider message, regardless of how many SDK content blocks represent that
message. SDK-only messages remain missing evidence; interrupted streams retain
partial evidence. Timing for Claude starts at the observed message start;
SDK-internal HTTP retries before that event are not individually measured.

Compiler observations bypass the bounded diagnostic queue. On receipt, Runtime
writes them to `capability-usage-outbox/<run>` and retries
`capability.recordModelUsage` independently of run completion. Startup recovers
pending outboxes, including completed runs. The consumer authorizes the runtime
against the persisted run and resolves catalog identity from its frozen role
snapshot before using the shared fact store. A drained collector retires only
after its final empty health report is acknowledged.

The worker-to-Runtime SSE transport and ephemeral worker storage still bound
coverage: a worker or connection failure before Runtime receives an observation
can lose that observation. The product must expose incomplete collection and
must not describe these measurements as complete provider billing records.

## Pinned SDK patch

scripts/install/pi-usage-patch.mjs patches Pi AI 0.85.1. The manifest verifies
original and patched SHA-256 values before writing; repeat installation is
idempotent. It follows the installed Pi dependency graph, including nested
copies created for peer dependencies. Unexpected versions or source hashes
fail install. The installer,
manifest and patch ship in npm packages and every backend Docker install stage.

For upgrades, inspect the actual parsers, regenerate the patch and hashes,
and run parser fixtures, logical-call tests, clean install and packed-package
install checks. Responses SSE and WebSocket share the patched finalization path.
Do not derive missing evidence from SDK counters.
