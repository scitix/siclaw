"""Codex SDK adapter for the KBC compile box.

This module is the only persistent-session code in KBC that imports the
OpenAI Codex SDK.  ``compile_box`` keeps its existing Claude message-shaped
orchestration and asks this adapter for a duck-compatible client when the
consumer selects ``codex_sdk``.

Codex exposes application tools through MCP rather than in-process Python
callables.  The adapter therefore hosts a loopback-only callback endpoint and
starts ``mcp_tool_server.py`` as a stdio MCP server.  The subprocess only
speaks MCP; every tool body still executes in this process against the live
``CompileRun``.  That keeps plan/ticket/summary semantics identical across
engines and prevents a second implementation of KBC policy.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Iterator, Mapping

from aiohttp import web


@dataclass(frozen=True)
class EngineTool:
    """One engine-neutral MCP tool owned by KBC."""

    name: str
    description: str
    input_schema: dict
    handler: Callable[[dict], Awaitable[str]]


# Claude-message-shaped compatibility values.  ``compile_box`` deliberately
# dispatches by class name so these need only carry the fields it reads.
class TextBlock:
    def __init__(self, text: str):
        self.text = text


class ToolUseBlock:
    def __init__(self, name: str, input_: dict | None = None):
        self.name = name
        self.input = input_ or {}


class AssistantMessage:
    def __init__(self, content: list):
        self.content = content


class StreamEvent:
    pass


class ResultMessage:
    def __init__(
        self,
        *,
        is_error: bool = False,
        api_error_status: int | None = None,
        subtype: str = "success",
    ):
        self.is_error = is_error
        self.api_error_status = api_error_status
        self.subtype = subtype


_CLOSED = object()


def _toml(value: object) -> str:
    """JSON literals are valid TOML literals for the scalar/list shapes here."""
    return json.dumps(value, ensure_ascii=False)


def _status_from_error(value: object) -> int | None:
    text = str(value or "")
    match = re.search(r"(?:status|HTTP)\D{0,8}(429|503|529)\b", text, re.I)
    return int(match.group(1)) if match else None


def _safe_error_message(value: object) -> str:
    text = str(getattr(value, "message", value) or "Codex turn failed")
    text = re.sub(r"\bsk-[A-Za-z0-9_+\-/=]{8,}", "[REDACTED]", text)
    return text[:1000]


def _copy_readonly_tree(source: Path, destination: Path) -> None:
    """Make an isolated filesystem view without preserving source symlinks.

    Use independent file copies rather than hard links. Restricted Kubernetes
    hosts require Codex full-access inside the already isolated KBC Pod, so a
    reviewer that accidentally writes its staged view must not mutate the
    original raw/candidate inode.
    """

    def copy_file(src: str, dst: str) -> str:
        return shutil.copy2(src, dst)

    def ignore_symlinks(directory: str, names: list[str]) -> list[str]:
        return [name for name in names if Path(directory, name).is_symlink()]

    if source.is_dir():
        shutil.copytree(
            source,
            destination,
            copy_function=copy_file,
            ignore=ignore_symlinks,
        )
    elif source.is_file() and not source.is_symlink():
        destination.parent.mkdir(parents=True, exist_ok=True)
        copy_file(str(source), str(destination))
    else:
        raise ValueError(f"read-only source is not a regular file or directory: {source}")


@contextmanager
def isolated_readonly_workspace(sources: Mapping[str, str | Path]) -> Iterator[Path]:
    """Expose exactly ``sources`` in a disposable Codex workspace.

    Read-only subflows receive disposable copies of exactly the declared KBC
    trees (for example raw/ plus candidate/). The single-run Pod remains the
    process boundary; writes to the staged view cannot alter source artifacts.
    """
    state_root = Path(os.environ.get("KBC_CODEX_STATE_ROOT", "/work"))
    state_root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix=".kbc-codex-ro-", dir=str(state_root)))
    try:
        for name, raw_source in sources.items():
            rel = Path(name)
            if rel.is_absolute() or len(rel.parts) != 1 or rel.name in {"", ".", ".."}:
                raise ValueError(f"invalid isolated workspace entry: {name!r}")
            source = Path(raw_source).resolve()
            _copy_readonly_tree(source, workspace / rel.name)
        yield workspace
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


class CodexSDKClient:
    """Persistent KBC session backed by the official ``openai-codex`` SDK.

    Public methods intentionally mirror ``ClaudeSDKClient`` so the mature KBC
    lifecycle (turn retries, stall watchdog, batch orchestration, sync and
    post-turn checks) remains engine-neutral without a parallel control loop.
    """

    def __init__(
        self,
        *,
        cwd: str,
        system_prompt: str,
        model: str,
        session_id: str,
        read_only: bool = False,
        tools: list[EngineTool] | None = None,
        reasoning_effort: str | None = None,
        max_tool_calls: int | None = None,
    ):
        self.cwd = str(Path(cwd).resolve())
        self.system_prompt = system_prompt
        self.model = model
        self.session_id = session_id
        self.read_only = read_only
        self.tools = tools or []
        # Mass GPT-5.6 high/medium can spend longer than KBC's 90s model-idle
        # safety bound before its first actionable item. Low still retains the
        # model's agentic workflow and is the reliable unattended default; a
        # deployment may raise it together with an appropriate watchdog bound.
        self.reasoning_effort = reasoning_effort or os.environ.get("KBC_CODEX_REASONING_EFFORT", "low")
        self.max_tool_calls = max_tool_calls if max_tool_calls is not None else int(
            os.environ.get("KBC_CODEX_MAX_TOOL_CALLS", os.environ.get("KBC_MAX_TURNS", "150"))
        )
        self._codex = None
        self._thread = None
        self._turn = None
        self._events: asyncio.Queue = asyncio.Queue()
        self._prompts: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._callback_runner: web.AppRunner | None = None
        self._callback_token = secrets.token_urlsafe(24)
        self._tool_by_name = {item.name: item for item in self.tools}
        self._tool_calls_this_turn = 0
        self._budget_exhausted = False
        state_root = Path(os.environ.get("KBC_CODEX_STATE_ROOT", "/work"))
        state_root.mkdir(parents=True, exist_ok=True)
        self._codex_home = tempfile.mkdtemp(prefix=".kbc-codex-", dir=str(state_root))

    async def connect(self) -> None:
        # Lazy import keeps the Claude image/test environment importable even if
        # only the original SDK dependency is installed.
        from openai_codex import ApprovalMode, AsyncCodex, CodexConfig, Sandbox

        base_url = os.environ.get("OPENAI_BASE_URL", "").strip()
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not base_url:
            raise RuntimeError("codex_sdk requires llm.base_url (OpenAI Responses endpoint)")
        if not api_key:
            raise RuntimeError("codex_sdk requires llm.api_key/auth_token")

        overrides = [
            "model_provider=" + _toml("kbc_mass"),
            "model_providers.kbc_mass.name=" + _toml("KBC OpenAI Responses provider"),
            "model_providers.kbc_mass.base_url=" + _toml(base_url.rstrip("/")),
            "model_providers.kbc_mass.env_key=" + _toml("OPENAI_API_KEY"),
            "model_providers.kbc_mass.wire_api=" + _toml("responses"),
            "model_providers.kbc_mass.requires_openai_auth=false",
            "web_search=" + _toml("disabled"),
            # KBC supplies the complete system contract. Uploaded corpora must
            # never inject Codex configuration, AGENTS.md, hooks, plugins,
            # connectors, memories, goals or subagents into a multi-tenant box.
            "project_doc_max_bytes=0",
            "features.apps=false",
            "features.goals=false",
            "features.hooks=false",
            "features.memories=false",
            "features.multi_agent=false",
            "features.remote_plugin=false",
            "features.shell_snapshot=false",
            # The Python SDK does not provide Codex's host-side JavaScript
            # executor. Force native shell/file tools instead of code-mode
            # calls such as `exec -> tools.exec_command(...)` that cannot be
            # serviced by this compile-box host.
            "features.code_mode.enabled=false",
            "features.shell_tool=true",
            # Model-proposed shell commands receive no API key/token.  PATH and
            # HOME are sufficient for the preinstalled deterministic KBC tools.
            "shell_environment_policy.inherit=" + _toml("none"),
            "shell_environment_policy.include_only=" + _toml(["PATH", "HOME"]),
            "shell_environment_policy.set.PATH=" + _toml(os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")),
            "shell_environment_policy.set.HOME=" + _toml(self._codex_home),
        ]
        if self.tools:
            callback_url = await self._start_callback_listener()
            server_path = Path(__file__).resolve().with_name("mcp_tool_server.py")
            tool_specs = [
                {"name": item.name, "description": item.description, "inputSchema": item.input_schema}
                for item in self.tools
            ]
            overrides.extend([
                "mcp_servers.kbc.command=" + _toml(sys.executable),
                "mcp_servers.kbc.args=" + _toml([str(server_path)]),
                "mcp_servers.kbc.required=true",
                "mcp_servers.kbc.startup_timeout_sec=15",
                "mcp_servers.kbc.tool_timeout_sec=120",
                "mcp_servers.kbc.default_tools_approval_mode=" + _toml("approve"),
                "mcp_servers.kbc.env.KBC_MCP_CALLBACK_URL=" + _toml(callback_url),
                "mcp_servers.kbc.env.KBC_MCP_CALLBACK_TOKEN=" + _toml(self._callback_token),
                "mcp_servers.kbc.env.KBC_MCP_TOOLS_JSON=" + _toml(json.dumps(tool_specs, ensure_ascii=False)),
            ])
            # Non-interactive app-server calls need an explicit per-tool approve
            # policy; the server default alone is currently insufficient.
            for item in self.tools:
                overrides.append(
                    f"mcp_servers.kbc.tools.{item.name}.approval_mode=" + _toml("approve")
                )

        config = CodexConfig(
            cwd=self.cwd,
            config_overrides=tuple(overrides),
            env={
                "CODEX_HOME": self._codex_home,
                "OPENAI_API_KEY": api_key,
            },
            client_name="siclaw_kbc",
            client_title="Siclaw KB Compiler",
        )
        self._codex = AsyncCodex(config=config)
        self._thread = await self._codex.thread_start(
            # KBC is an unattended compiler. auto_review still routes workspace
            # commands through an approval reviewer, which can reject ordinary
            # raw/ reads and candidate/ writes. `deny_all` means "do not ask for
            # approval" in the SDK; the single-run KBC Pod is the same mechanical
            # boundary used by Claude's bypassPermissions mode.
            approval_mode=ApprovalMode.deny_all,
            cwd=self.cwd,
            developer_instructions=self.system_prompt,
            ephemeral=True,
            model=self.model,
            model_provider="kbc_mass",
            # Restricted Kubernetes container hosts can refuse Codex's nested
            # bubblewrap split policies. The box itself contains one KB run and
            # is already the process/filesystem boundary, so both writer and
            # staged closed-book reviewers use the Claude-parity full-access
            # preset inside that Pod. Model subprocesses still receive only
            # PATH/HOME, never the provider key/token.
            sandbox=Sandbox.full_access,
        )
        # Public session identity must be the resumable Codex thread id, not the
        # provisional box UUID passed to the constructor.
        self.session_id = self._thread.id
        self._worker = asyncio.create_task(self._turn_worker())

    async def query(self, text: str) -> None:
        if self._thread is None:
            raise RuntimeError("CodexSDKClient is not connected")
        await self._prompts.put(text)

    async def receive_messages(self):
        while True:
            value = await self._events.get()
            if value is _CLOSED:
                return
            yield value

    async def receive_response(self):
        async for value in self.receive_messages():
            yield value
            if type(value).__name__ == "ResultMessage":
                return

    async def interrupt(self) -> None:
        turn = self._turn
        if turn is not None:
            await turn.interrupt()

    async def disconnect(self) -> None:
        worker, self._worker = self._worker, None
        if worker is not None:
            worker.cancel()
            try:
                await worker
            except asyncio.CancelledError:
                pass
        if self._codex is not None:
            codex, self._codex = self._codex, None
            await codex.close()
        if self._callback_runner is not None:
            await self._callback_runner.cleanup()
            self._callback_runner = None
        shutil.rmtree(self._codex_home, ignore_errors=True)
        await self._events.put(_CLOSED)

    async def _start_callback_listener(self) -> str:
        app = web.Application(client_max_size=1024 * 1024)
        app.add_routes([web.post("/tool-call", self._handle_tool_call)])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        sockets = site._server.sockets if site._server else None
        if not sockets:
            await runner.cleanup()
            raise RuntimeError("failed to bind Codex MCP callback listener")
        self._callback_runner = runner
        port = sockets[0].getsockname()[1]
        return f"http://127.0.0.1:{port}/tool-call"

    async def _handle_tool_call(self, request: web.Request) -> web.Response:
        if request.headers.get("x-kbc-token") != self._callback_token:
            return web.json_response({"error": "forbidden"}, status=403)
        body = await request.json()
        name = str(body.get("name", ""))
        item = self._tool_by_name.get(name)
        if item is None:
            return web.json_response({"error": f"unknown tool {name!r}"}, status=400)
        args = body.get("arguments")
        if not isinstance(args, dict):
            return web.json_response({"error": "arguments must be an object"}, status=400)
        try:
            text = await item.handler(args)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response({"text": str(text)})

    async def _turn_worker(self) -> None:
        from openai_codex.generated.v2_all import ReasoningEffort

        effort = None
        try:
            effort = ReasoningEffort(self.reasoning_effort)
        except ValueError:
            pass
        while True:
            prompt = await self._prompts.get()
            self._tool_calls_this_turn = 0
            self._budget_exhausted = False
            try:
                self._turn = await self._thread.turn(prompt, effort=effort)
                async for notification in self._turn.stream():
                    await self._relay_notification(notification)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._events.put(AssistantMessage([
                    TextBlock("Codex turn failed: " + _safe_error_message(exc))
                ]))
                await self._events.put(ResultMessage(
                    is_error=True,
                    api_error_status=_status_from_error(exc),
                    subtype="error_max_turns" if self._budget_exhausted else "error_during_execution",
                ))
            finally:
                self._turn = None

    async def _relay_notification(self, notification) -> None:
        # Every SDK notification is transport liveness for the existing stall
        # watchdog, even when the event has no user-visible representation.
        await self._events.put(StreamEvent())
        payload = getattr(notification, "payload", None)
        name = type(payload).__name__
        if name == "ItemStartedNotification":
            item = getattr(payload, "item", None)
            item = getattr(item, "root", item)
            item_name = type(item).__name__
            if item_name in {
                "CommandExecutionThreadItem",
                "FileChangeThreadItem",
                "McpToolCallThreadItem",
                "DynamicToolCallThreadItem",
            }:
                self._tool_calls_this_turn += 1
                if (
                    not self._budget_exhausted
                    and self.max_tool_calls >= 0
                    and self._tool_calls_this_turn > self.max_tool_calls
                ):
                    self._budget_exhausted = True
                    await self._events.put(AssistantMessage([
                        TextBlock(
                            f"Codex turn budget exhausted after {self.max_tool_calls} tool calls."
                        )
                    ]))
                    if self._turn is not None:
                        await self._turn.interrupt()
            if item_name == "McpToolCallThreadItem":
                await self._events.put(AssistantMessage([
                    ToolUseBlock(str(getattr(item, "tool", "") or "mcp"), getattr(item, "arguments", None) or {})
                ]))
            elif item_name == "CommandExecutionThreadItem":
                await self._events.put(AssistantMessage([ToolUseBlock("Shell", {})]))
        elif name == "ItemCompletedNotification":
            item = getattr(payload, "item", None)
            item = getattr(item, "root", item)
            if type(item).__name__ == "AgentMessageThreadItem":
                text = str(getattr(item, "text", "") or "").strip()
                if text:
                    await self._events.put(AssistantMessage([TextBlock(text)]))
        elif name == "TurnCompletedNotification":
            turn = getattr(payload, "turn", None)
            status = str(getattr(getattr(turn, "status", None), "value", getattr(turn, "status", "")))
            error = getattr(turn, "error", None)
            is_error = self._budget_exhausted or status not in {"completed", ""}
            if is_error and not self._budget_exhausted:
                await self._events.put(AssistantMessage([
                    TextBlock("Codex turn failed: " + _safe_error_message(error))
                ]))
            await self._events.put(ResultMessage(
                is_error=is_error,
                api_error_status=_status_from_error(getattr(error, "message", error)),
                subtype=(
                    "error_max_turns" if self._budget_exhausted
                    else "success" if not is_error
                    else f"error_{status or 'unknown'}"
                ),
            ))
