# Evidence-only release review harness

`evidence_review` analyzes the supplied request snapshot. It is an additive type;
SRE, coordinator, knowledge Q&A and custom behavior remain unchanged.

## Enforced boundary

The context compiler always returns `allowedTools=[]` for this type, even when a
caller supplies tool names or an unrestricted selection. An empty capability
selection elsewhere retains its existing unrestricted meaning; this harness is
the enforcement point. MCP exposure, memory, bundled/platform skills, planning,
subagents and infrastructure guidance are disabled.

The factory disables knowledge indexing and citation support, omits all append
context, and configures Pi with `noContextFiles`, `noSkills`, `noExtensions` and
`noPromptTemplates`. It also removes inline extension factories and additional
skill paths. Neither workspace AGENTS files nor APPEND_SYSTEM, skills, memory
profiles or knowledge catalogs enter the model context. AgentBox shared index
initialization is skipped. No default Pi tools are registered.

The compiler selects a fixed English evidence-only system prompt independently of
`src/core/prompt.ts`; administrator prompts/templates cannot override this boundary.
Snapshot text is untrusted data. Findings must distinguish facts, inference and
missing evidence. Completion never grants deployment or approval authority.

## Rollout

Upgrade Runtime and AgentBox before SiCore publishes the `evidence_review` Type
Release. SiCore must validate empty instance and effective Release resource
bindings. SiForge submits each attempt with its own A2A context and original key.
No live infrastructure, repository or knowledge fetching is promised.

Targeted tests cover the harness across unrestricted and explicitly supplied tool
lists, prompt override exclusion, type registry parity and AgentBox config sync.
A real Pi DefaultResourceLoader test first proves its control directory discovers
AGENTS, APPEND_SYSTEM, a skill and an extension, then proves the factory resource
policy excludes all four, including explicit paths and inline extensions.
Real model-envelope verification in each deployed runtime shape remains an
integration check; compiler tests alone do not prove a production rollout.
