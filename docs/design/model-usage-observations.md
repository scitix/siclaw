# Provider usage observations

The AgentBox records one logical call at the Pi stream-function boundary. API
and subscription models use the same observation contract. Routing retries
create separate calls; HTTP retries hidden inside Pi remain one logical call.
This is runtime consumption telemetry, not an invoice or remaining allowance.

## Evidence and identity

Each call has a UUID, immutable dispatch timestamp, session and trace identity,
model configuration snapshot, routing attempt and agent/auxiliary kind.
Started and finished observations share that identity. Failed, cancelled and
auxiliary calls are observed independently of visible assistant messages.

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
