# All-type conversation handoff and target capability summaries

> Historical design: Coordinator and peer delegation have been retired. See [the retirement design](../design/2026-09-12-coordinator-retirement-assessment.md). Same-Agent subagents remain supported.

## Behavior

Handoff belongs to a conversation, independently of the Agent's SRE, Coordinator,
Knowledge Q&A, Product Support or Custom type. No new Agent type or database
migration is needed. A resolved web conversation owner with an event emitter and
a nonempty authorized roster receives `transfer_to_agent`, even with a restricted
Custom tool selection. The existing capability key remains compatible with stored
selections. This does not grant command execution, delegation, or resource access.

Web, API and A2A use the web session mode. CLI, channel and scheduled-task modes
remain excluded because they do not implement control-plane ownership transfer.
Delegated peers and spawned children cannot transfer the parent's conversation.
An unresolved harness remains closed. Runtime terminates the successful sender;
SiCore remains the sole owner of authorization and active-agent updates.

> The static destination menu described below is superseded by
> [on-demand handoff discovery](2026-09-08-handoff-discovery.md).

## Discovery and selection

`config.getHandoffTargets` builds the permitted roster. An entry Agent sees its
backends; a backend sees its entry Agent and siblings. Active, ordinary and same-org
filters remain. The model gets a static menu in one `transfer_to_agent` tool, with
`route_key` constrained to that menu. It does not browse all Agents or query their
private prompts. The menu is loaded at session construction, not live tool-health
discovery. Execution-time authorization checks remain authoritative when it changes.

Each target includes the administrator's description, bound cluster/host names,
`agentType`, `toolCapabilities`, and configured `skills`, `knowledgeBases`, and
`mcpServers` names. Binding IDs come from GetAgentResources, including released
product bindings. Only labels are queried; no MCP connection configuration,
credentials, full skill content or private knowledge authoring instructions are exposed.

Runtime expands built-in allowances using its own Agent type/capability registry,
so Go does not maintain a second permission mapping. SiCore currently sends explicit
null for toolCapabilities, matching GetAgentInfo; built-in types use their locked
lists and Custom retains its legacy defaults. Other control planes can send a
restricted Custom selection. Missing or unknown type/selection is described as
unknown, never silently promoted to unrestricted Custom.

The model matches the request's domain, required action and target resources to
these descriptions. List priority only orders the menu. An Agent should continue
itself if capable, clarify ambiguity, and avoid speculative transfers or cycles.
The conversation contract distinguishes transferring the main request from delegating
an independent subtask; Coordinator's generic routing guidance follows that contract.

## Limits and compatibility

Configured labels and built-in allowances are routing evidence, not proof that a
bound skill version is executable, an MCP exposes a particular operation, or a
network is reachable. Accurate domain descriptions still matter. Lists show at
most 24 names per category with an omitted count; absence in a truncated list does
not prove lack of coverage. Reported lookup failures set resourcesResolved=false,
and Runtime displays unknown resources. Older control planes may omit the new
fields; Runtime preserves the existing routing description and coverage.

The existing facade/backend topology is unchanged. This does not make every Agent
an authorized destination for every other Agent. Where a backend belongs to several
facades, the existing agent-scoped lookup selects one facade; session-scoped roster
disambiguation remains separate work, and execution authorization still uses the
conversation's actual entry Agent.
