# Agent prompt lifecycle

`system_prompt` is the Agent-owned identity and behaviour instruction. It has
the same semantics for `sre`, `coordinator`, and `custom` agents:

- an Agent type selects an initial default prompt;
- a non-empty persisted `system_prompt` replaces that default;
- the default is never appended behind a persisted prompt.

The editable prompt is the Agent's complete role layer; there is no hidden SRE
identity before or after it. It does not replace Siclaw's role-neutral platform
assembly. Runtime safety/mode instructions, skill and knowledge context, MCP
tool schemas, and delegated read-only constraints remain platform-owned.
Infrastructure discovery guidance is a separate platform section selected only
for `sre` agents. `custom` and `coordinator` agents never inherit it.

The same contract applies in AgentBox sessions and the Portal-backed TUI.
Persisted prompt fragments retain the legacy template conveniences:
`{{mode}}`, `{{settingsPath}}`, `{{credentialsPath}}`, `{{memoryIntro}}`,
`{{memorySection}}`, and web/CLI conditional blocks are resolved before the
fragment is inserted. The Agent-owned fragment is placed before Siclaw's
hardcoded Safety and Language sections, so editable identity text cannot gain
recency precedence over those platform-owned instructions.

For `custom` agents, the stored prompt is therefore authoritative for identity
and behaviour while common communication, task, rendering, safety, and dynamic
resource context stay intact. A knowledge assistant can use the platform's
knowledge/skill machinery without being framed as an infrastructure assistant.

Delegated read-only work is an exclusive platform constraint. It replaces the
Agent-owned identity for that delegated turn rather than composing potentially
conflicting remediation or routing instructions with a read-only toolset.

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
