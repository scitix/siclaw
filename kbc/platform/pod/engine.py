"""Engine adapter for one-shot read-only agent runs (red-blue self-check).

This is the ONLY file in the self-check stack that touches the Claude Agent
SDK. The orchestrator (redblue.py) depends on the `ReadonlyAgentEngine`
protocol alone; swapping the box engine (e.g. Codex) means adding another
adapter class here — model/effort stay plain string knobs, structured output
stays "text JSON + lenient parse" precisely so no engine-specific tool-forcing
leaks into the orchestration.

Design: improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §9.2.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from pathlib import Path
from typing import Protocol

# Tool-input keys that name a filesystem path (same set the test-session guard
# uses: Read.file_path, Glob/Grep.path, NotebookRead.notebook_path).
_PATH_KEYS = ("file_path", "path", "notebook_path")


class ReadonlyAgentEngine(Protocol):
    """One read-only agentic run: file Read/Glob/Grep over allowed roots, one
    user message in, final assistant text out. No writes, no network tools."""

    async def run_readonly_agent(
        self, *, cwd: str, system_prompt: str, user_message: str,
        model: str, effort: str | None = None,
        allowed_read_roots: list[str], timeout_secs: float,
    ) -> str: ...


def path_escape_multi(roots: list[Path], tool_name: str, tool_input: dict) -> str | None:
    """Multi-root generalization of compile_box._test_path_escape: return a
    human-readable offender when a tool input reaches OUTSIDE every allowed
    root, else None. Pure function → unit-tested without the SDK."""
    resolved_roots = [r.resolve() for r in roots]

    def _inside(target: Path) -> bool:
        t = target.resolve()
        for root in resolved_roots:
            try:
                t.relative_to(root)
                return True
            except ValueError:
                continue
        return False

    primary = resolved_roots[0]
    for key in _PATH_KEYS:
        v = tool_input.get(key)
        if not isinstance(v, str) or not v.strip():
            continue
        p = Path(v)
        target = p if p.is_absolute() else primary / p
        if not _inside(target):
            return f"{key}={v}"
    if tool_name == "Glob":
        pattern = tool_input.get("pattern")
        if isinstance(pattern, str) and pattern.startswith("/"):
            base = pattern.split("*", 1)[0]
            if not _inside(Path(base)):
                return f"pattern={pattern}"
    return None


def _make_multiroot_guard(roots: list[Path]):
    """PreToolUse hook confining a read-only run to its allowed roots. A hook
    (not can_use_tool) because hooks fire under bypassPermissions too."""

    async def guard(input_data, tool_use_id, context):
        offender = path_escape_multi(
            roots, str(input_data.get("tool_name", "")), input_data.get("tool_input") or {})
        if offender:
            allowed = ", ".join(str(r) for r in roots)
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"这是只读的自检会话,只允许读这些目录:{allowed};{offender} 在允许范围之外。"
                    ),
                }
            }
        return {}

    return guard


def parse_json_lenient(text: str):
    """Extract the first parseable JSON value from agent output. Tolerates
    prose/fences around it. Raises ValueError when nothing parses — the caller
    retries once with an explicit re-emit instruction, then fails the stage."""
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    fenced = re.search(r"```(?:json)?\s*\n(.*?)```", text or "", re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    dec = json.JSONDecoder()
    for m in re.finditer(r"[\[{]", text or ""):
        try:
            val, _ = dec.raw_decode(text[m.start():])
            return val
        except json.JSONDecodeError:
            continue
    raise ValueError("no parseable JSON in agent output")


class ClaudeEngine:
    """ReadonlyAgentEngine on the Claude Agent SDK: one ephemeral session per
    call (connect → query → collect final text → disconnect), read-only tools,
    mechanical multi-root path guard, per-call model override. `effort` has no
    Claude mapping yet (reserved knob; a Codex adapter maps it to
    reasoning_effort)."""

    async def run_readonly_agent(
        self, *, cwd: str, system_prompt: str, user_message: str,
        model: str, effort: str | None = None,
        allowed_read_roots: list[str], timeout_secs: float,
    ) -> str:
        # Lazy import: keeps engine.py importable (protocol + pure helpers) in
        # SDK-less environments; only an actual run needs the SDK.
        from claude_agent_sdk import (
            ClaudeSDKClient, ClaudeAgentOptions, HookMatcher, InMemorySessionStore,
        )
        roots = [Path(r) for r in allowed_read_roots] or [Path(cwd)]
        opts = ClaudeAgentOptions(
            cwd=cwd,
            system_prompt={"type": "preset", "preset": "claude_code", "append": system_prompt},
            allowed_tools=["Read", "Glob", "Grep"],
            mcp_servers={},
            permission_mode="bypassPermissions",  # pod 本身即 sandbox;守卫走 hook
            hooks={"PreToolUse": [HookMatcher(hooks=[_make_multiroot_guard(roots)])]},
            setting_sources=[],                   # 多租户隔离
            model=model,
            max_turns=int(os.environ.get("KBC_PK_MAX_TURNS", "40")),
            session_id=str(uuid.uuid4()),
            session_store=InMemorySessionStore(),
        )
        client = ClaudeSDKClient(options=opts)
        parts: list[str] = []

        async def _run():
            await client.connect()
            await client.query(user_message)
            async for msg in client.receive_response():
                if type(msg).__name__ == "AssistantMessage":
                    for block in getattr(msg, "content", []) or []:
                        if type(block).__name__ == "TextBlock":
                            t = (getattr(block, "text", "") or "").strip()
                            if t:
                                parts.append(t)

        try:
            await asyncio.wait_for(_run(), timeout=timeout_secs)
        finally:
            await client.disconnect()
        return "\n\n".join(parts)
