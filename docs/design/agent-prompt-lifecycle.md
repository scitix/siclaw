# Agent prompt lifecycle

`system_prompt` is the Agent-owned identity and behaviour instruction. It has
the same semantics for `sre`, `coordinator`, `knowledge_qa`, and `custom`
agents:

- an Agent type selects an initial default prompt;
- a non-empty persisted `system_prompt` replaces that default;
- the default is never appended behind a persisted prompt.

The editable prompt does not replace Siclaw's platform assembly. Every session
entry point passes Agent type, resolved capabilities, mode, and delegation
constraints to `compileAgentContext()`. The compiler produces two coupled
outputs:

- a role-neutral platform prompt plus only the type/capability sections the
  harness can actually support;
- an enforceable harness policy for built-in tools, MCP, memory, and skill
  roots.

Prompt text is descriptive, never the permission gate. The model-visible tool
schemas and skill index are filtered from the same policy that selected their
prompt guidance. In particular:

- SRE, and Custom Agents that selected discovery tools, get infrastructure
  guidance; QA/Coordinator do not;
- planning and sub-agent guidance appear only when their tools are allowed;
- QA knowledge catalog text asks for evidence synthesis and never suggests
  shell checks;
- QA/Coordinator do not inherit repo-bundled or user-global operational skills;
- delegated read-only sessions suppress MCP, memory, writes, and operational
  guidance;
- an unresolved control-plane lookup exposes no tools, MCP, memory, or ambient
  skills until a later successful sync.

`custom` plus a successfully resolved null capability selection retains the
legacy unrestricted behavior. This compatibility is explicit in the harness;
an unresolved lookup never falls into it.

The same contract applies in AgentBox sessions and the Portal-backed TUI.
Persisted prompt fragments retain the legacy template conveniences:
`{{mode}}`, `{{settingsPath}}`, `{{credentialsPath}}`, `{{memoryIntro}}`,
`{{memorySection}}`, and web/CLI conditional blocks are resolved before the
fragment is inserted. The Agent-owned fragment is placed before Siclaw's
hardcoded Safety and Language sections, so editable identity text cannot gain
recency precedence over those platform-owned instructions.

For `custom` agents this is an intentional semantic migration: their stored
prompt used to replace the whole Siclaw template. It now replaces only the
Agent-owned identity/behaviour layer, so the platform assembly is present for
all agent types.

Delegated read-only work is an exclusive platform constraint. It replaces the
Agent-owned identity for that delegated turn rather than composing potentially
conflicting remediation or routing instructions with a read-only toolset.

## Audit manifests

Session creation emits an `agent-context/v1` manifest containing Agent type,
resolution state, mode, policy flags, resource names, model-visible tool and
skill names, and prompt hashes. It never logs prompt or user-message content.

Provider payload hooks additionally emit a wire-level manifest for the final
request envelope after provider transforms. It records only system-prompt
length/hash, the full tool-schema hash, sorted tool names, and boolean markers
for known SRE/infrastructure/memory/workflow prompt sections. This is the source
of truth for answering "what prompt and tools did this model call actually
receive?" and whether an unexpected platform section was present, without
storing sensitive text.

## Hot application

Saving an effectively changed prompt sends `agent.reload` with
`resources: ["prompt"]`. Re-saving an identical form, changing unrelated Agent
fields, and binding resources do not include `prompt`. Runtime
calls the running AgentBox's `/api/reload-prompt` endpoint. AgentBox has no
prompt payload to cache: the Gateway already resolves the latest value for
each message. The reload only invalidates warm sessions.

- An in-flight turn completes with the prompt it started with.
- An idle, quiescent session is scheduled for immediate release.
- Detached background work is allowed to finish rather than being torn down.
  Because it does not own `brain.prompt()`, the chat may continue on the old
  in-memory prompt while that work is outstanding. Its buffered completion
  notification drains first, including the coalescing window and any synthetic
  model turn; only then is the deferred release scheduled. An invalidated
  session uses a next-tick release at that point rather than the idle TTL.
- The next turn restores the existing JSONL conversation into a new in-memory
  brain with the latest prompt.
- The AgentBox process/pod is not killed, and the 30-second idle release TTL is
  not part of prompt propagation.

This contract preserves conversation history while avoiding mid-turn prompt
mutation.

Changing Agent type also changes the built-in capability set. If the submitted
prompt is still effectively unchanged from the old stored prompt, the server initializes the
new type's default instead of carrying an SRE persona onto Coordinator tools
(or the reverse). A prompt edited in the same request remains authoritative.
