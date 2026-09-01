# Agent prompt lifecycle

Siclaw compiles prompt text and the enforceable runtime harness from the same
Agent Context. Prompt wording explains behavior; tool schemas, resource
bindings, and runtime gates decide what the model can actually do.

## Assembly contract

The effective system prompt is an ordered set of owned layers:

1. **Platform Kernel** — stable completion, evidence, communication, tool, and
   runtime rules shared by every Agent.
2. **Capability and mode policy** — only sections supported by the compiled
   harness, such as SRE infrastructure guidance, planning, sub-agents, channel
   format, or automated-task behavior.
3. **Agent Type Contract** — immutable behavior for `sre`, `coordinator`, or
   `knowledge_qa`. `custom` intentionally has no built-in contract.
4. **Agent Addendum** — optional administrator-authored specialization stored
   in the legacy `agents.system_prompt` column. It extends a built-in contract;
   it never replaces it.
5. **Platform Safety** — operational and common safety rules, placed after
   editable Agent text.
6. **Runtime context** — Pi's ResourceLoader appends the current Profile, Wiki
   navigation/retrieval contract, citations, context files, Skills, and working
   directory.
7. **Provider transform** — the provider adapter may convert the assembled
   prompt and tools into its wire envelope.

`buildSystemPromptAssembly()` records the identity, owner, source, mutability,
text length, and hash of every static layer. `session.systemPrompt` is the exact
assembled prompt after runtime context. The payload hook observes the final
provider-visible instructions and tool schemas after provider transforms.

The Platform Kernel deliberately distinguishes progress from completion. A
turn must end with the requested answer/result, one necessary clarification,
an insufficient-evidence result, or a concrete failure/blocker. A short
progress update alone is not a completed turn.

## Type and capability alignment

Each entry point passes Agent type, resolved capabilities, mode, and delegation
constraints to `compileAgentContext()`. The compiler returns:

- the prompt assembly described above;
- an enforceable harness for built-in tools, configured MCP exposure, memory,
  and skill roots.

The model-visible tool schemas and Skill index are filtered from the same
policy that selected prompt guidance:

- SRE, and Custom Agents with discovery tools, receive infrastructure guidance;
  QA and Coordinator do not.
- Planning and sub-agent guidance appears only when those tools are available.
- Automated-task mode grants only its transport-owned `task_report` tool in
  addition to the type's ordinary capabilities, keeping the required terminal
  report aligned for every Agent Type.
- QA/Coordinator do not inherit repo-bundled or user-global operational Skills;
  explicitly bound Skills, knowledge, and MCP remain available.
- Delegated read-only sessions suppress MCP, memory, writes, and operational
  guidance, and use an exclusive read-only worker contract.
- An unresolved control-plane lookup exposes no tools, MCP, memory, or ambient
  Skills until a successful sync.

The two availability axes remain independent:

| Agent type | Built-in capability groups | Explicitly configured resources |
|---|---|---|
| SRE | infrastructure, commands, scripts, files, memory, planning, sub-agents, session output | Skills, knowledge, MCP |
| Coordinator | files and delegation; no own `cluster_list` / `host_list` | knowledge/Skills for answering and routing, MCP for an attached resource locator |
| Knowledge QA | `knowledge_search`, Grep/Find, Read, `knowledge_cite` | knowledge, explicitly bound Skills and query/visual MCP |
| Custom | Portal selection, or legacy unrestricted built-ins only when an explicit Custom type has no selection | Skills, knowledge, MCP |

`allowedTools` controls built-in tools, not dynamically named MCP tools. In
scoped AgentBox/Portal sessions the MCP config already contains only that
Agent's resource bindings. The current MCP wire payload has no trustworthy
read/write classification or binding-source provenance, so Siclaw must not
guess safety from a server or tool name. Until the contract carries enforceable
effect metadata, Agent-type-safe MCP binding remains a control-plane
responsibility.

For Knowledge QA, `knowledge_search` is an optional accelerator for a likely
single-page answer. A `direct_hit` is not authority: similarity is not proof,
and the Agent validates subject, task, version, environment, and scope before
adopting evidence. Broad, novel, ambiguous, comparative, weak-match, and
cross-page questions return to Agent-led Wiki exploration through Find/Grep/Read.
`explore` and `unavailable` never prove the Wiki lacks an answer. This preserves
semantic reasoning and the Wiki's linked navigation model while accelerating
clear high-frequency questions.

That retrieval policy is owned by the runtime Wiki context and tool contract,
not duplicated in the Agent Type Contract or an editable Addendum. The prompt
inspection standard reports `retrieval_below_reasoning: fail` when a deployed
tool still requires search before every answer, making a retrieval-policy drift
visible without coupling the prompt compiler to one search implementation.

## Stored Addendum compatibility

New built-in Agent rows no longer materialize a copy of the type contract in
`system_prompt`. Exact historical built-in defaults are recognized as migration
data and are not exposed as editable addenda. Any other stored text is preserved
as an Addendum and composed with the current immutable type contract.

Addenda retain the legacy fragment conveniences: `{{mode}}`,
`{{settingsPath}}`, `{{credentialsPath}}`, `{{memoryIntro}}`,
`{{memorySection}}`, and Web/CLI conditional blocks. Safety follows the Addendum
and therefore cannot be displaced by editable text.

When a built-in type changes and the submitted Addendum is unchanged, Portal
clears that old specialization instead of carrying a potentially conflicting
persona onto a new immutable contract and toolset. An Addendum edited in the
same request is retained. Switching to Custom preserves the visible text
because Custom has no type contract of its own.

## Exact inspection and design standard

Routine status and telemetry remain non-sensitive. The `agent-context/v2`
manifest records only prompt layer metadata/hashes, model-visible tool and Skill
names, resource state, and policy flags. The provider-envelope manifest records
only prompt length/hash, tool names/schema hash, and known-section markers.

An administrator can explicitly inspect a resident chat session from the
Agent's **Prompt** tab by supplying its session ID. The call follows:

```text
Portal GET /api/v1/agents/:id/prompt-inspection?session_id=...
  -> Runtime RPC agent.promptInspection
  -> AgentBox GET /api/sessions/:sessionId/prompt-inspection
```

The response contains the exact effective prompt, layer texts and provenance,
actual model-visible tool descriptions/schema hashes, visible Skill names, and
replica consistency hashes. Exact text is produced only on demand, stays behind
admin authentication plus the Runtime/AgentBox mTLS boundary, and is never
added to normal polling, sync status, or logs. A released session must be sent a
message and inspected again within its resident idle window.

`siclaw-prompt-design/v1` is a deterministic structural standard, not a claim
that prose alone proves answer quality. It checks:

- unique layer ownership and immutable built-in type contracts;
- explicit completion semantics and a stable Platform Kernel;
- capability-scoped role guidance and prompt/tool alignment;
- Knowledge QA retrieval below reasoning and linked Wiki exploration;
- duplicate sections, tool descriptions, and visible prompt size.

Its conventions are informed by current public guidance from
[OpenAI model optimization](https://developers.openai.com/api/docs/guides/latest-model),
[Codex as a harness](https://developers.openai.com/blog/codex-as-a-platform),
the [OpenAI Codex repository](https://github.com/openai/codex), and
[xAI Grok Build](https://github.com/xai-org/grok-build): keep stable policy
lean, expose only relevant tools, make boundaries and terminal outcomes
explicit, and evaluate representative task success, evidence quality, latency,
and token use. Structural `pass` therefore still requires end-to-end case
evaluation; it does not certify semantic answer correctness.

## Hot application

Saving an effectively changed Addendum sends `agent.reload` with
`resources: ["prompt"]`. Re-saving identical text, editing unrelated fields, or
binding resources does not reload the prompt. Runtime invalidates warm sessions
through AgentBox; it does not mutate an in-flight brain:

- an in-flight turn completes with the prompt it started with;
- an idle, quiescent session is released immediately;
- detached background work drains before deferred release;
- the next turn restores existing JSONL conversation history into a new brain
  with the latest Type Contract and Addendum;
- the AgentBox process is not killed, and its normal idle TTL is not the prompt
  propagation mechanism.

This preserves conversation history while avoiding mid-turn prompt mutation.
