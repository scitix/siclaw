#!/usr/bin/env python3
"""engines.claude — the Claude Agent SDK adapter (the box's original engine).

Pure relocation of the SDK code that used to live inline in compile_box.py:
options assembly (claude_code preset + role append), the in-process SDK MCP
wrapping of the compile tool bodies, the PreToolUse snapshot guard, and the
connect → receive_messages lifecycle. Behavior is unchanged — the existing
protocol tests pin it.

This module imports the SDK at top level ON PURPOSE: it is only imported when
KBC_ENGINE=claude (lazily, via engines.create_session), so the codex image can
omit claude-agent-sdk entirely; and a module-level `ClaudeSDKClient` symbol
keeps the client patchable by tests (engines.claude.ClaudeSDKClient = Fake).
"""
import os
import uuid
from pathlib import Path

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    HookMatcher,
    tool,
    create_sdk_mcp_server,
    InMemorySessionStore,
)

import compile_tools
from .base import SessionSpec, make_test_path_guard

# Default tool whitelist for a kb-compile session, used when the runtime profile
# declares no allowed_tools (profile.allowedTools = null → box default). A profile
# that DOES declare a list (e.g. kb-test) overrides this.
DEFAULT_COMPILE_ALLOWED_TOOLS = [
    "Read", "Write", "Edit", "Glob", "Grep", "Bash",
    "mcp__compile__report_summary",
    "mcp__compile__propose_plan",
    "mcp__compile__resolve_ticket",
    "mcp__compile__propose_questions",
]

# Default tool whitelist for a read-only kb-test session, used when the runtime
# profile declares none. Read-only by construction: cannot mutate the snapshot.
DEFAULT_TEST_ALLOWED_TOOLS = ["Read", "Glob", "Grep"]


def _make_sdk_compile_tools(workdir: str, emit):
    """Wrap the engine-neutral tool bodies (compile_tools.py) as an in-process
    SDK MCP server. Only the decorator layer is SDK-specific."""

    def _wrap(name):
        async def handler(args):
            text = await compile_tools.execute_compile_tool(name, args, workdir=workdir, emit=emit)
            return {"content": [{"type": "text", "text": text}]}
        return handler

    wrapped = []
    for spec in compile_tools.TOOL_SPECS:
        schema = {p: (list if t == "array" else str) for p, t in spec["params"].items()}
        wrapped.append(tool(spec["name"], spec["description"], schema)(_wrap(spec["name"])))
    return create_sdk_mcp_server("compile", tools=wrapped)


class ClaudeEngineSession:
    """EngineSession on ClaudeSDKClient: one persistent conversational session
    (connect() with no kickoff → receive_messages() blocks between turns);
    query() injects the next user turn."""

    def __init__(self, spec: SessionSpec):
        self.spec = spec
        self.session_id = spec.session_id or str(uuid.uuid4())
        self._client = None

    def _options(self) -> ClaudeAgentOptions:
        s = self.spec
        common = dict(
            cwd=s.cwd,
            # Keep the Claude Code preset (agentic tool conventions) and append the
            # role on top, rather than replacing it.
            system_prompt={"type": "preset", "preset": "claude_code", "append": s.system_prompt},
            permission_mode="bypassPermissions",  # pod 本身即 sandbox
            setting_sources=[],                    # 多租户隔离:不加载外部 settings/CLAUDE.md
            session_id=self.session_id,
            session_store=InMemorySessionStore(),
        )
        if s.kind == "test":
            return ClaudeAgentOptions(
                allowed_tools=s.allowed_tools or DEFAULT_TEST_ALLOWED_TOOLS,
                mcp_servers={},                    # no compile signal tools
                # C4: path confinement — absolute/../ reads must not escape the snapshot
                # to the live /work draft. Hook, not can_use_tool: hooks fire under bypass.
                hooks={"PreToolUse": [HookMatcher(hooks=[make_test_path_guard(Path(s.readonly_root or s.cwd))])]},
                # The test session mimics the REAL consumer → the gate/consumer tier
                # (sonnet), not the compile tier. Massapi-served id; overridable per-deploy.
                model=os.environ.get("KBC_TEST_MODEL", "claude-sonnet-4-6"),
                max_turns=int(os.environ.get("KBC_TEST_MAX_TURNS", "60")),
                **common,
            )
        return ClaudeAgentOptions(
            allowed_tools=s.allowed_tools or DEFAULT_COMPILE_ALLOWED_TOOLS,
            mcp_servers={"compile": _make_sdk_compile_tools(s.workdir or s.cwd, s.emit)},
            # Pin the compile model explicitly: the box talks to massapi (Bedrock),
            # which serves specific ids — the SDK default may not be one, and the KB
            # compile default is opus by product decision. Overridable per-deploy.
            model=os.environ.get("KBC_COMPILE_MODEL", "claude-opus-4-6"),
            max_turns=int(os.environ.get("KBC_MAX_TURNS", "150")),
            **common,
        )

    async def start(self) -> None:
        # Conversational by construction: connect with NO kickoff prompt and wait
        # for the first query(). Module-global lookup keeps the client patchable.
        self._client = ClaudeSDKClient(options=self._options())
        await self._client.connect()

    async def query(self, text: str, session_id: str = "default") -> None:
        await self._client.query(text)

    async def events(self):
        """Translate the SDK message stream into the neutral engine vocabulary.
        receive_messages() is persistent: it yields the in-flight turn's output,
        then blocks for the next turn, keeping the session alive until cancelled."""
        async for msg in self._client.receive_messages():
            name = type(msg).__name__
            if name == "AssistantMessage":
                for block in getattr(msg, "content", []) or []:
                    if type(block).__name__ == "TextBlock":
                        t = (getattr(block, "text", "") or "").strip()
                        if t:
                            yield {"type": "text", "text": t}
            elif name == "ResultMessage":
                yield {"type": "turn_end"}

    async def close(self) -> None:
        if self._client is not None:
            client, self._client = self._client, None
            await client.disconnect()
