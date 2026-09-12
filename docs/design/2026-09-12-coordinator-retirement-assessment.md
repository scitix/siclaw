# Retire Coordinator and peer delegation

Cross-Agent collaboration now uses conversation handoff. Remove the Coordinator type and peer delegation instead of exposing the old delegation workflow to more Agent types.

Baseline: `origin/main` at `946e0675227438439b2ba86dfaa7bd1d65e244fe`, fetched before creating the isolated worktree.

## Supported execution

`search_handoff_targets` discovers authorized destinations. `transfer_to_agent` transfers the main conversation through the control plane, preserving history, cancellation and the response channel. The receiving Agent answers the user directly with its own capabilities and resource bindings.

Same-Agent subagents remain available for independent tasks. They cannot transfer the main conversation. TaskCoordinator continues scheduling jobs. Standalone sessions without a handoff-capable control plane continue to execute locally.

## Removal

Remove the Coordinator registry entry and prompt, delegate roster configuration, `delegate_agents`, `delegate_to_agent`, `list_delegates`, `report_findings`, the private delegation HTTP/A2A transport, peer turn markers and roster invalidation hooks. Remove matching Portal controls and RPC handlers.

Retired type input fails closed instead of becoming Custom. Portal creation, type changes and forks reject the retired type. Runtime and AgentBox reject old peer execution requests before session creation or persistence. The standalone database migration disables remaining retired instances and drops the roster table, while retaining historical sessions and messages.

## Compatibility boundary

Historical peer cards, transcript links and trace metadata remain readable. Shared `delegation_id` fields and the internal delegation-event persistence API remain because subagents, plans and background execution still use them. Their names do not represent an active peer delegation feature.

Keep authorization, session ownership, subagent capability limits and handoff controls. The type removal does not grant another Agent additional tools or resource access. Deploy with a compatible control plane. Coordinate any destructive schema migration with the retirement of older control-plane processes; restoring an old image alone does not restore deleted configuration.

Staging acceptance must resolve tools through the complete production registry and exercise a real ownership transfer. Tests of individual tool factories cannot detect an accidentally removed registry entry. See the [implementation and staging validation](../completion/2026-09-12-coordinator-retirement.md).

## Review hardening

All retired type and peer-request refusals share `AGENT_RETIRED`, HTTP status 410 and `retriable: false`. The detail is shared across Portal, Runtime and the isolated AgentBox image; Web clients preserve both the readable message and machine fields. Portal PUT reads the current type for every mutation, including name-only and empty requests. Script authorization rejects retirement independently of the stored status. Historical instances have a read-only settings view and a retirement badge, outside the selectable type catalog.

The repeatable standalone migration removes `delegate_agents` from instance capability selections, including installations that already ran the first retirement migration. It preserves null, malformed data, future keys and historical transcripts. Removing the final key writes `["no_tools"]`, a non-empty group selection that resolves to an empty concrete tool whitelist. Both null and [] GROUP selections retain their unrestricted compatibility meaning. New capability writes share the same cleanup helper. The editor displays no_tools as a restriction and null/[] as unrestricted, and omits unchanged capability fields on save. Explicitly choosing “Clear (unrestricted)” writes null; switching between null and [] does not reload warm sessions. Like other groups, no_tools contributes its own (empty) tool set rather than vetoing other selected groups. MCP bindings and handoff/task transport grants remain separate.

The session registry now caches only ownership and provenance. Historical target metadata stays in durable records, without carry-forward in the runtime authorization cache. LRU, singleflight, invalidation and provenance checks remain covered by tests. The harness reference drops deleted files and relay acknowledgements and records the complete-tool-registry regression learned during staging acceptance.
