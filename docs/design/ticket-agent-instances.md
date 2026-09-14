# Ticket Agent runtime contract

The integrated host can configure tenant-owned Ticket instances (`ticket`) with
independent prompts, Skills, MCP servers, knowledge and explicit built-in
capabilities. Support intake and retrospective review are examples of the same
type, not subtypes. Their result MCPs own their business schemas.

The host resolves an enabled, same-tenant bound result tool once per dispatch,
passes requiredResultToolName and requires strict session persistence. The
existing result protocol validates one successful structured result plus a final
reply before completion. Runtime retains its tool-forced result repair behavior.
Changing the business prompt does not remove the host completion requirement.

Ticket capabilities must be explicit and nonempty; no_tools is the explicit
zero-built-in selection. Missing capability provenance cannot become an
unrestricted Custom session. The type prompt provides completion guidance while
the instance prompt supplies the business task. Tenant content cannot grant
tools beyond the resolved capabilities and resource bindings.

The standalone Portal does not configure instance result contracts, so Ticket
is recognized for host execution but excluded from standalone creation. Deploy
Runtime and AgentBox before enabling the type in the host. Existing Custom and
product_support instances retain their behavior.
