# Handoff trace continuity — 2026-09-08

## Implemented

- Capture the source transfer tool span before eviction, then propagate its trace
  context through the external portal to the receiving Runtime / AgentBox.
- Reuse the logical turn trace ID with distinct Agent execution spans, including
  A→B→A. A new question gets an independent trace.
- Preserve inherited audit IDs with export disabled or no recorder attachment.
- Validate IDs and copy scalar transport fields rather than mutate shared maps.
- Keep tracing out of model tool parameters and ignore ordinary caller overrides.
- Document the internal contract and correct the unsupported `/run` / A2A
  handoff claims in product documentation.

## Validation

Targeted suites cover actual HTTP prompt ACKs, gateway forwarding, message and
control-event persistence, OTel parent relationships with an in-memory exporter,
export-disabled behavior, malformed IDs, next-question isolation and concurrent
serialization of copied context. Results on the target worktrees:

- Runtime: 8 suites, 391 tests passed.
- Runtime: TypeScript `tsc --noEmit` passed.
- The external portal: full proxy and agentroute suites passed with `go test -race`.
- OpenAPI YAML and internal trace schema references validated.
- Whitespace / conflict-marker diff checks passed.

The initial sandboxed full Go run could not write the local build cache; rerun
with cache access passed. The macOS linker emitted existing LC_DYSYMTAB warnings;
no race report or test failure occurred in the completed run.

## Delivery limits

No deployment or live collector acceptance was performed. Both services need the
new protocol support. Old records cannot be merged automatically. `/run` and A2A
still need their own complete handoff orchestration; they are not covered by the
web loop fix. Export is best effort and complete control-plane instrumentation
is outside this change.
