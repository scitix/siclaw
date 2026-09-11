"""Pi execution for ephemeral read-only review sessions.

Domain orchestration owns evidence validation and result parsing. This adapter
supplies scoped Read/Glob/Grep tools and a resolved model role to the shared Pi
worker; it never loads external SDK settings or credentials.
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
        model: str, effort: str | None = None, role: str | None = None,
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






class CompilerReadonlyEngine:
    """Ephemeral Pi sessions with the same guarded host tools as compilation."""

    async def run_readonly_agent(
        self, *, cwd: str, system_prompt: str, user_message: str,
        model: str, effort: str | None = None, role: str | None = None,
        allowed_read_roots: list[str], timeout_secs: float,
    ) -> str:
        from pi_file_tools import FileTools
        import pi_config

        roots = [Path(value).resolve() for value in allowed_read_roots] or [Path(cwd).resolve()]
        if Path(cwd).resolve() not in roots:
            raise ValueError("Read-only session cwd must be a declared read root")
        client = create_agent_client(
            cwd=cwd, system_prompt=system_prompt, session_id=str(uuid.uuid4()),
            model_config=(pi_config.for_role(role, model=model, effort=effort) if role
                          else pi_config.for_model(model, effort=effort)),
            tools=FileTools(cwd, ["Read", "Glob", "Grep"], _make_multiroot_guard(roots)).tools(),
            max_model_calls=int(os.environ.get("KBC_PK_MAX_TURNS", "40")))
        parts: list[str] = []
        try:
            async with asyncio.timeout(timeout_secs):
                await client.connect()
                await client.query(user_message)
                async for event in client.receive_response():
                    if event.kind == "assistant":
                        # Each event is a completed assistant message. Tool-call
                        # commentary can contain provisional JSON; only the final
                        # message is the read-only result consumed by the caller.
                        parts = [block["text"] for block in event.data.get("content", [])
                                 if block.get("type") == "text" and block.get("text", "").strip()]
                    elif event.kind == "result" and event.data["outcome"] != "completed":
                        raise RuntimeError(event.data.get("error") or "Read-only compiler execution did not complete")
        finally:
            await client.disconnect()
        return "\n\n".join(parts)


def engine_kind() -> str:
    kind = os.environ.get("KBC_ENGINE", "pi_agent").strip().lower()
    kind = {"pi": "pi_agent", "claude": "claude_agent_sdk"}.get(kind, kind)
    if kind not in {"pi_agent", "claude_agent_sdk"}:
        raise ValueError(f"Unsupported compiler engine {kind!r}; select Claude Agent SDK or Pi Agent")
    return kind


def create_agent_client(**kwargs):
    if engine_kind() == "claude_agent_sdk":
        from claude_engine import ClaudeAgentClient
        return ClaudeAgentClient(**kwargs)
    from pi_engine import PiAgentClient
    return PiAgentClient(**kwargs)


def selected_readonly_engine() -> ReadonlyAgentEngine:
    engine_kind()
    return CompilerReadonlyEngine()
