# All-Agent handoff — implementation and verification

## Result

All five existing Agent types support ownership transfer in resolved web main
conversations with an authorized roster and control-event emitter, including
restricted Custom Agents. No new Agent type, migration or execution permission
was added. Spawned and delegated workers cannot transfer the parent conversation.

The model's transfer tool now includes destination type-based built-in allowances,
admin descriptions and bound cluster/host/skill/knowledge/MCP names. Runtime uses
its existing capability registry. Only labels cross the discovery interface;
connection configuration and private content do not. Unknown metadata remains
unknown. The main-conversation contract distinguishes handoff from delegation.

The external portal's roster topology and execution authorization remain unchanged. A roster
must still be configured; this is not unrestricted Agent-to-Agent discovery.
See ../design/2026-09-07-all-agent-handoff.md for compatibility and limitations.

## Verification

- Runtime: 106 tests passed across agent-context, agent-types, tool-capabilities,
  tool-registry, transfer-to-agent and gateway handoff-targets API tests.
  Repeated on the actual a2a-runtime-p1 worktree after synchronizing the tested
  implementation from the temporary overlay.
- Runtime TypeScript: tsc --noEmit passed on the synchronized-source overlay.
- The external portal: go test -race ./internal/siclaw/adapter ./internal/siclaw/roster
  ./internal/siclaw/agentroute passed. Tests cover every Agent type in rosters,
  bound-only label disclosure, MCP secret exclusion, unknown lookup failures,
  and existing authorization/session ownership constraints.
- OpenAPI YAML parsed successfully and the new internal RPC response schemas
  resolve. Chinese and English unified-entry product docs updated.
- git diff --check passed in both worktrees.

No deployment or live-model handoff acceptance was performed for this change.
Configured summaries do not guarantee tool health or correct model selection.
