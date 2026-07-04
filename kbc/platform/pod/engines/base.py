#!/usr/bin/env python3
"""engines.base — the box's engine seam (EngineSession) + shared pure helpers.

The compile box drivers (compile_box.run_session / test_session_driver) hold an
EngineSession and know nothing about which harness runs underneath. An engine
adapter (engines/claude.py, engines/codex.py) owns everything harness-specific:
process/SDK lifecycle, prompt attachment, tool assembly, guard mechanism.

Engine event vocabulary (what events() yields — deliberately tiny, the box
contract only needs log/turn_done):

    {"type": "text",     "text": str}    one assistant-visible text chunk
    {"type": "turn_end"}                 the in-flight turn finished
    {"type": "error",    "error": str}   engine-level failure (session survives
                                         unless the adapter also ends events())

Method naming: `query()` (not `send()`) — it is the exact duck type the HTTP
handlers and tests already speak (`run.client.query(text)`), so the seam slides
under the existing call sites without churn.

Design: improve_siclaw/DESIGN-kb-box-codex-engine-2026-07-02.md §1.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Protocol


@dataclass
class SessionSpec:
    """Engine-neutral description of one persistent box session."""

    kind: str                       # "compile" (authoring) | "test" (read-only consumer)
    cwd: str                        # the session's working root
    system_prompt: str              # standing role text; the adapter decides HOW to attach it
    session_id: str                 # box-minted id, announced on the `session` event
    emit: Callable[[dict], Awaitable[None]]  # box event sink (compile tools signal through it)
    workdir: str | None = None      # compile: where tool bodies write (authoring/…); test: None
    allowed_tools: list[str] | None = None   # wire-opaque tool names (None → adapter default)
    readonly_root: str | None = None         # test: pinned snapshot root the session must not escape


class EngineSession(Protocol):
    """One live conversational session. start() connects and returns; the
    driver then relays events() until cancelled; query() injects a user turn."""

    async def start(self) -> None: ...
    async def query(self, text: str, session_id: str = "default") -> None: ...
    def events(self) -> AsyncIterator[dict]: ...
    async def close(self) -> None: ...


# ── Shared pure helpers (stdlib-only; unit-tested without any SDK) ──

# Tool-input keys that name a filesystem path (Read.file_path, Glob/Grep.path).
_TEST_PATH_KEYS = ("file_path", "path", "notebook_path")


def test_path_escape(root: Path, tool_name: str, tool_input: dict) -> str | None:
    """C4 fidelity guard predicate: return a human-readable offender when a tool
    input reaches OUTSIDE the pinned snapshot dir, else None. The allowed_tools
    whitelist already makes a test session read-only, but an ABSOLUTE path (or a
    ../ traversal) in Read/Glob/Grep would still reach the LIVE /work draft —
    breaking "the test measures the pinned snapshot". Pure function → unit-tested."""
    root = root.resolve()
    for key in _TEST_PATH_KEYS:
        v = tool_input.get(key)
        if not isinstance(v, str) or not v.strip():
            continue
        p = Path(v)
        target = p if p.is_absolute() else root / p
        try:
            target.resolve().relative_to(root)
        except ValueError:
            return f"{key}={v}"
    # Glob's pattern is itself a path expression; an absolute pattern escapes even
    # with `path` unset. (Grep's pattern is regex CONTENT — not a path; skip it.)
    if tool_name == "Glob":
        pattern = tool_input.get("pattern")
        if isinstance(pattern, str) and pattern.startswith("/"):
            base = pattern.split("*", 1)[0]
            try:
                Path(base).resolve().relative_to(root)
            except ValueError:
                return f"pattern={pattern}"
    return None


def make_test_path_guard(root: Path) -> Callable[[dict, Any, Any], Awaitable[dict]]:
    """PreToolUse hook body confining a test session to its snapshot (the shapes
    in and out are plain dicts — SDK-free, so it lives on the neutral side of the
    seam; engines/claude.py wraps it in the SDK's HookMatcher)."""

    async def guard(input_data, tool_use_id, context):
        offender = test_path_escape(root, str(input_data.get("tool_name", "")), input_data.get("tool_input") or {})
        if offender:
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"这是只读测试会话,只能读钉死的快照目录({root});{offender} 在快照之外。"
                        "请从 .siclaw/knowledge/index.md 出发用相对路径读页。"
                    ),
                }
            }
        return {}

    return guard
