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
import shutil
import tempfile
import uuid
import weakref
from pathlib import Path
from typing import Protocol

# massapi proxies to Bedrock, which rejects the `context_management` request
# field ("Extra inputs are not permitted", HTTP 400). Root cause (2026-07-06,
# see compile_box.py header): the thinking-clear context edit rides the
# experimental context-management beta — CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
# is the actual kill switch; autocompact-off stays as belt-and-braces. PK
# stages are one-shot reads that need neither. setdefault so an explicit
# override wins; the SDK-spawned child inherits via os.environ (we pass no
# options.env, so ANTHROPIC_* etc. are inherited too).
os.environ.setdefault("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1")
os.environ.setdefault("DISABLE_AUTOCOMPACT", "1")
os.environ.setdefault("DISABLE_AUTO_COMPACT", "1")

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
            tools=["Read", "Glob", "Grep"],       # read-only base set; removes Bash/Write/Web from context
            allowed_tools=["Read", "Glob", "Grep"],
            disallowed_tools=[                     # belt-and-suspenders under bypass; keeps the PK closed-book
                "Bash", "Write", "Edit", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch",
            ],
            mcp_servers={},
            strict_mcp_config=True,                # ignore project/user/plugin MCP configs
            skills=[],                             # no skills for a read-only reviewer
            permission_mode="bypassPermissions",  # pod 本身即 sandbox;守卫走 hook
            hooks={"PreToolUse": [HookMatcher(hooks=[_make_multiroot_guard(roots)])]},
            setting_sources=[],                   # 多租户隔离
            model=model,
            max_turns=int(os.environ.get("KBC_PK_MAX_TURNS", "40")),
            session_id=str(uuid.uuid4()),
            session_store=InMemorySessionStore(),
        )
        # Verify agents are non-interactive too — route them through the
        # de-streaming shim when it is active (lazy import keeps this module
        # importable without aiohttp).
        import destream
        opts.env = {**(opts.env or {}), **destream.session_env("verify")}
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


class CodexEngine:
    """ReadonlyAgentEngine on the official Codex SDK.

    KBC stages independent copies of declared roots and exposes only its own
    root-confined read/search MCP tools. The caller still owns structured output
    parsing and deterministic evidence validation.
    """

    def __init__(self):
        self._stage_lock = asyncio.Lock()
        self._staged: dict[tuple[str, ...], tuple[Path, dict[str, str]]] = {}
        self._stage_root: Path | None = None
        self._stage_finalizer = None

    async def _stage_allowed_roots(self, roots: list[str]) -> tuple[Path, dict[str, str]]:
        """Cache one disposable, source-isolated view per root set.

        A red-blue run can make many calls over the same raw/wiki snapshots.
        Staging once keeps that structural isolation inexpensive while the
        engine instance lives; the finalizer removes all views after the run.
        """
        from codex_engine import _copy_readonly_tree

        key = tuple(str(Path(value).resolve()) for value in roots)
        async with self._stage_lock:
            cached = self._staged.get(key)
            if cached is not None:
                return cached
            if self._stage_root is None:
                state_root = Path(os.environ.get("KBC_CODEX_STATE_ROOT", "/work"))
                state_root.mkdir(parents=True, exist_ok=True)
                root = Path(tempfile.mkdtemp(prefix=".kbc-codex-engine-", dir=str(state_root)))
                self._stage_root = root
                self._stage_finalizer = weakref.finalize(self, shutil.rmtree, root, True)
            view = self._stage_root / f"view-{len(self._staged)}"

            def stage() -> tuple[Path, dict[str, str]]:
                replacements: dict[str, str] = {}
                if len(key) == 1:
                    source = Path(key[0])
                    _copy_readonly_tree(source, view)
                    replacements[key[0]] = str(view)
                else:
                    view.mkdir()
                    for index, value in enumerate(key):
                        source = Path(value)
                        safe_name = re.sub(r"[^A-Za-z0-9_.-]", "-", source.name) or "root"
                        destination = view / f"root-{index}-{safe_name}"
                        _copy_readonly_tree(source, destination)
                        replacements[value] = str(destination)
                return view, replacements

            staged = await asyncio.to_thread(stage)
            self._staged[key] = staged
            return staged

    @staticmethod
    def _rewrite_paths(text: str, replacements: dict[str, str]) -> str:
        for original in sorted(replacements, key=len, reverse=True):
            text = text.replace(original, replacements[original])
        return text

    async def run_readonly_agent(
        self, *, cwd: str, system_prompt: str, user_message: str,
        model: str, effort: str | None = None,
        allowed_read_roots: list[str], timeout_secs: float,
    ) -> str:
        from codex_engine import CodexSDKClient

        declared_roots = list(allowed_read_roots) or [cwd]
        roots = [str(Path(value).resolve()) for value in declared_roots]
        workspace, replacements = await self._stage_allowed_roots(roots)
        # macOS commonly spells /private/var as /var in tempfile paths. Prompts
        # carry the caller's spelling, while the staged cache keys are resolved.
        for declared, resolved in zip(declared_roots, roots):
            replacements[str(Path(declared))] = replacements[resolved]
        staged_system_prompt = self._rewrite_paths(system_prompt, replacements)
        staged_user_message = self._rewrite_paths(user_message, replacements)
        staged_roots = [replacements[value] for value in roots]
        root_contract = (
            "\n\nFilesystem contract: this is a closed-book, read-only review. "
            "Read only the following roots and never inspect parent/sibling paths: "
            + ", ".join(staged_roots)
        )
        client = CodexSDKClient(
            cwd=str(workspace),
            system_prompt=staged_system_prompt + root_contract,
            model=model,
            session_id=str(uuid.uuid4()),
            read_only=True,
            allowed_read_roots=[str(workspace)],
            reasoning_effort=effort,
            max_tool_calls=int(os.environ.get("KBC_PK_MAX_TURNS", "40")),
        )
        parts: list[str] = []

        async def _run():
            await client.connect()
            await client.query(staged_user_message)
            async for msg in client.receive_response():
                if type(msg).__name__ != "AssistantMessage":
                    continue
                for block in getattr(msg, "content", []) or []:
                    if type(block).__name__ == "TextBlock":
                        text = str(getattr(block, "text", "") or "").strip()
                        if text:
                            parts.append(text)

        try:
            await asyncio.wait_for(_run(), timeout=timeout_secs)
        finally:
            await client.disconnect()
        return "\n\n".join(parts)


def selected_readonly_engine() -> ReadonlyAgentEngine:
    kind = os.environ.get("KBC_ENGINE", "claude_agent_sdk").strip().lower()
    if kind in {"codex", "codex_sdk"}:
        return CodexEngine()
    if kind in {"claude", "claude_agent_sdk"}:
        return ClaudeEngine()
    raise ValueError(f"unknown KBC_ENGINE {kind!r}")
