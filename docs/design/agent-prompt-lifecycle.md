# Agent prompt lifecycle

`system_prompt` is the Agent-owned identity and behaviour instruction. It has
the same semantics for `sre`, `coordinator`, and `custom` agents:

- an Agent type selects an initial default prompt;
- a non-empty persisted `system_prompt` replaces that default;
- the default is never appended behind a persisted prompt.

The editable prompt does not replace Siclaw's platform assembly. Runtime
safety/mode instructions, skill and knowledge context, MCP tool schemas, and
delegated read-only constraints remain platform-owned.

## Hot application

Saving a prompt sends `agent.reload` with `resources: ["prompt"]`. Runtime
calls the running AgentBox's `/api/reload-prompt` endpoint. AgentBox has no
prompt payload to cache: the Gateway already resolves the latest value for
each message. The reload only invalidates warm sessions.

- An in-flight turn completes with the prompt it started with.
- An idle, quiescent session is scheduled for immediate release. Detached
  background work is allowed to finish rather than being torn down.
- The next turn restores the existing JSONL conversation into a new in-memory
  brain with the latest prompt.
- The AgentBox process/pod is not killed, and the 30-second idle release TTL is
  not part of prompt propagation.

This contract preserves conversation history while avoiding mid-turn prompt
mutation.
