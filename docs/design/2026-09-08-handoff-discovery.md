# On-demand handoff discovery

Tool descriptions and schemas are independent of the number of targets and assets.
`search_handoff_targets` asks the external portal for complete binding matches, with exact cluster
name/ID, host name/ID/IP, configured capability keywords, or exact Agent name/ID.
This replaces the old 24-name manifest excerpt, which concealed tail resources.

At session creation GatewayClient requests `GET /api/internal/handoff-targets?indexOnly=true`.
The result is an internal authorization index, never a model-facing destination enum.
The query tool calls `POST /api/internal/handoff-targets/search`, forwarded as
`config.searchHandoffTargets`. Gateway derives the caller from its authenticated
identity and accepts only query fields. The external portal verifies Runtime ownership, permitted
relationships, organization, active state and ordinary Agent kind.

Each search returns at most five candidates with short descriptions and at most five
matching evidence items each, plus total/nextOffset and per-target matchCount. No
credential, full asset list, skill body or MCP configuration is returned. Capability
queries match configured text, not semantic embeddings or live tool-health checks.
Host matching covers explicit Host bindings, not inferred Kubernetes nodes.

Search errors are explicit and never converted to an empty match. Search results
cannot expand the session's permitted index. A session-local discovered-target map
allows transfer only to a previously returned routeKey. No target enum, manifest or
full previous-routing brief is serialized into tool definitions. The external portal rechecks
ownership and authorization at actual transfer. Existing trace propagation, source
termination and bounded handoff policy remain unchanged.

Web, channel and task conversation owners receive both tools across Agent types.
Unresolved harnesses, delegated peers and spawned subagents remain closed. The
search operation does not execute commands or create another Agent. Pagination
must retain kind/query; it is not a snapshot across administrator binding changes.

Deploy the external portal first. Older control planes can still return full index metadata,
but without the search RPC discovery reports unavailable and cannot authorize a
transfer by guessing. There is no full-inventory prompt fallback. No migration or
new dependency is required. The server currently resolves complete authorized
bindings per query rather than maintaining a second resource index; model context
is bounded, while server lookup cost follows inventory size.
