"""Pi SDK 0.82.1 adapter for persistent KBC sessions.

The Python compile controller remains authoritative.  A small Node companion
owns the Pi AgentSession and calls KBC-owned ``EngineTool`` handlers over a
private JSONL pipe.  No credential is placed in the runner environment or
written to disk, and model-visible filesystem tools are confined to declared
workspace roots.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Iterable, Mapping

from engine_protocol import (
    AssistantMessage,
    EngineTool,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolUseBlock,
)


_CLOSED = object()
PI_SDK_VERSION = "0.82.1"
_VALID_THINKING = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
_DEFAULT_WRITER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"]
_DEFAULT_READER_TOOLS = ["Read", "Glob", "Grep"]


class PiConnectionError(RuntimeError):
    """Recoverable Pi runner process or protocol failure."""


def resolve_pi_binding(
    *, base_url: str, provider: str | None, model: str | None,
) -> tuple[str, str]:
    """Resolve the explicit Pi catalog identity without guessing from model text.

    Official Kimi endpoints have stable provider identities in Pi 0.82.1.
    A proxied endpoint defaults to the Moonshot Open Platform catalog; callers
    may override ``provider`` when they intentionally expose another catalog.
    """
    normalized_provider = (provider or "").strip().lower()
    host = base_url.lower()
    if not normalized_provider:
        if "api.kimi.com/coding" in host:
            normalized_provider = "kimi-coding"
        elif "api.moonshot.cn" in host:
            normalized_provider = "moonshotai-cn"
        else:
            normalized_provider = "moonshotai"
    normalized_model = (model or "").strip()
    if not normalized_model:
        normalized_model = "k3" if normalized_provider == "kimi-coding" else "kimi-k3"
    return normalized_provider, normalized_model


def _safe_error(value: object, secrets: Iterable[str] = ()) -> str:
    text = str(getattr(value, "message", value) or "Pi runner failed")
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"\bsk-[A-Za-z0-9_+\-/=]{8,}", "[REDACTED]", text)
    return text[:1000]


class PiSDKClient:
    """Duck-compatible persistent client backed by Pi's AgentSession."""

    def __init__(
        self,
        *,
        cwd: str,
        system_prompt: str,
        model: str,
        session_id: str,
        read_only: bool = False,
        allowed_read_roots: list[str] | None = None,
        allowed_read_tools: list[str] | None = None,
        tools: list[EngineTool] | None = None,
        writer_filesystem_access: Mapping[str, str] | None = None,
        reasoning_effort: str | None = None,
        max_tool_calls: int | None = None,
    ):
        self.cwd = str(Path(cwd).resolve())
        self.system_prompt = system_prompt
        self.model = model
        self.session_id = session_id
        self.read_only = read_only
        self.allowed_read_roots = [
            str(Path(value).resolve()) for value in (allowed_read_roots or [cwd])
        ]
        self.allowed_read_tools = list(
            allowed_read_tools
            if allowed_read_tools is not None
            else (_DEFAULT_READER_TOOLS if read_only else _DEFAULT_WRITER_TOOLS)
        )
        self.tools = list(tools or [])
        self.writer_filesystem_access = dict(writer_filesystem_access or {})
        if read_only and self.writer_filesystem_access:
            raise ValueError(
                "writer_filesystem_access is only valid for writer Pi sessions"
            )
        invalid_access = {
            value for value in self.writer_filesystem_access.values()
            if value not in {"read", "write", "deny"}
        }
        if invalid_access:
            raise ValueError(f"invalid Pi filesystem access values: {sorted(invalid_access)}")
        workspace_root = Path(self.cwd)
        for raw_path in self.writer_filesystem_access:
            target = Path(raw_path).resolve()
            try:
                target.relative_to(workspace_root)
            except ValueError as error:
                raise ValueError(
                    f"Pi writer filesystem override is outside the session workspace: {raw_path!r}"
                ) from error
            if target == workspace_root:
                raise ValueError(
                    "Pi writer filesystem override cannot replace the workspace root"
                )
        self.reasoning_effort = (
            reasoning_effort
            or os.environ.get("KBC_PI_REASONING_EFFORT")
            or "high"
        ).strip().lower()
        if self.reasoning_effort not in _VALID_THINKING:
            raise ValueError(f"invalid KBC_PI_REASONING_EFFORT {self.reasoning_effort!r}")
        self.max_tool_calls = max_tool_calls if max_tool_calls is not None else int(
            os.environ.get("KBC_PI_MAX_TOOL_CALLS", os.environ.get("KBC_MAX_TURNS", "150"))
        )
        if self.max_tool_calls < 1:
            raise ValueError("Pi max_tool_calls must be positive")
        names = [item.name for item in self.tools]
        if len(names) != len(set(names)):
            raise ValueError("Pi engine tool names must be unique")
        collisions = sorted(set(names).intersection(self.allowed_read_tools))
        if collisions:
            raise ValueError(
                f"Pi file tool names are reserved: {', '.join(collisions)}"
            )

        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._events: asyncio.Queue = asyncio.Queue()
        self._ready = asyncio.Event()
        self._connect_error: str | None = None
        self._write_lock = asyncio.Lock()
        self._last_context_usage: dict = {"totalTokens": 0, "maxTokens": 0}
        self._api_key = ""
        self._state_home: str | None = None
        self._closing = False

    def _runner_path(self) -> Path:
        override = os.environ.get("KBC_PI_RUNNER")
        if override:
            return Path(override).resolve()
        return Path(__file__).resolve().with_name("pi-runner") / "dist" / "main.js"

    async def _send(self, value: dict) -> None:
        process = self._process
        if process is None or process.stdin is None or process.returncode is not None:
            raise PiConnectionError("Pi runner is not connected")
        payload = (json.dumps(value, ensure_ascii=False) + "\n").encode()
        async with self._write_lock:
            process.stdin.write(payload)
            await process.stdin.drain()

    async def _drain_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        # Drain to prevent a noisy dependency from blocking. Never forward raw
        # stderr: provider errors can contain request headers or tenant paths.
        while await process.stderr.readline():
            pass

    async def _handle_tool_call(self, value: dict) -> None:
        call_id = str(value.get("id") or "")
        name = str(value.get("name") or "")
        args = value.get("args")
        if not call_id or not name or not isinstance(args, dict):
            await self._send({
                "type": "tool_result",
                "id": call_id,
                "error": "malformed Pi tool call",
            })
            return
        tool = next((item for item in self.tools if item.name == name), None)
        if tool is None:
            await self._send({
                "type": "tool_result",
                "id": call_id,
                "error": f"unknown KBC tool {name}",
            })
            return
        try:
            result = await tool.handler(args)
            await self._send({"type": "tool_result", "id": call_id, "result": str(result)})
        except Exception as error:
            await self._send({
                "type": "tool_result",
                "id": call_id,
                "error": _safe_error(error, [self._api_key]),
            })

    async def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    break
                try:
                    value = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    self._connect_error = "Pi runner emitted malformed JSONL"
                    self._ready.set()
                    await self._events.put(ResultMessage(
                        is_error=True, subtype="error_runner_protocol"))
                    continue
                if not isinstance(value, dict):
                    continue
                kind = value.get("type")
                if kind == "ready":
                    self.session_id = str(value.get("sessionId") or self.session_id)
                    self._ready.set()
                elif kind == "activity":
                    await self._events.put(StreamEvent())
                elif kind == "assistant":
                    text = str(value.get("text") or "").strip()
                    blocks = [TextBlock(text)] if text else []
                    tool_calls = value.get("tools")
                    if isinstance(tool_calls, list):
                        for item in tool_calls:
                            if not isinstance(item, dict):
                                continue
                            name = str(item.get("name") or "")
                            args = item.get("args")
                            if name and isinstance(args, dict):
                                blocks.append(ToolUseBlock(name, args))
                    if blocks:
                        await self._events.put(AssistantMessage(blocks))
                elif kind == "tool_call":
                    await self._handle_tool_call(value)
                elif kind == "turn_result":
                    context = value.get("contextUsage")
                    if isinstance(context, dict):
                        self._last_context_usage = {
                            "totalTokens": int(context.get("totalTokens") or 0),
                            "maxTokens": int(context.get("maxTokens") or 0),
                        }
                    usage = value.get("usage")
                    await self._events.put(ResultMessage(
                        is_error=bool(value.get("isError")),
                        subtype=str(value.get("subtype") or "success"),
                        usage=usage if isinstance(usage, dict) else None,
                        num_turns=int(value.get("numTurns") or 0),
                    ))
                elif kind == "fatal":
                    error = _safe_error(value.get("error"), [self._api_key])
                    if not self._ready.is_set():
                        self._connect_error = error
                        self._ready.set()
                    else:
                        await self._events.put(ResultMessage(
                            is_error=True, subtype="error_runner_protocol"))
                elif kind == "closed":
                    break
        finally:
            if not self._ready.is_set():
                self._connect_error = "Pi runner exited before initialization"
                self._ready.set()
            await self._events.put(_CLOSED)

    async def connect(self) -> None:
        runner = self._runner_path()
        if not runner.is_file():
            raise PiConnectionError(f"Pi runner is not built: {runner}")
        node = shutil.which(os.environ.get("KBC_PI_NODE", "node"))
        if not node:
            raise PiConnectionError("pi_sdk requires Node.js 22")
        base_url = os.environ.get("KBC_PI_BASE_URL", "").strip()
        api_key = os.environ.get("KBC_PI_API_KEY", "").strip()
        provider, model = resolve_pi_binding(
            base_url=base_url,
            provider=os.environ.get("KBC_PI_PROVIDER"),
            model=os.environ.get("KBC_PI_MODEL") or self.model,
        )
        if not api_key:
            raise PiConnectionError("pi_sdk requires llm.api_key/auth_token")
        self._api_key = api_key

        state_root = Path(os.environ.get("KBC_PI_STATE_ROOT", "/tmp"))
        state_root.mkdir(parents=True, exist_ok=True)
        self._state_home = tempfile.mkdtemp(prefix=".kbc-pi-home-", dir=str(state_root))
        child_env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": self._state_home,
            "NO_COLOR": "1",
            "PI_OFFLINE": "1",
        }
        self._process = await asyncio.create_subprocess_exec(
            node,
            str(runner),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            env=child_env,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        await self._send({
            "type": "init",
            "cwd": self.cwd,
            "sessionId": self.session_id,
            "systemPrompt": self.system_prompt,
            "provider": provider,
            "model": model,
            "baseUrl": base_url or None,
            "apiKey": api_key,
            "thinkingLevel": self.reasoning_effort,
            "maxToolCalls": self.max_tool_calls,
            "readOnly": self.read_only,
            "allowedReadRoots": self.allowed_read_roots,
            "filesystemAccess": self.writer_filesystem_access,
            "fileTools": self.allowed_read_tools,
            "tools": [
                {
                    "name": item.name,
                    "description": item.description,
                    "inputSchema": item.input_schema,
                }
                for item in self.tools
            ],
        })
        try:
            try:
                await asyncio.wait_for(self._ready.wait(), timeout=20)
            except asyncio.TimeoutError as error:
                raise PiConnectionError("Pi runner initialization timed out") from error
            if self._connect_error:
                raise PiConnectionError(self._connect_error)
        except Exception:
            await self.disconnect()
            raise

    async def query(self, text: str) -> None:
        if not self._ready.is_set() or self._connect_error:
            raise PiConnectionError("PiSDKClient is not connected")
        await self._send({"type": "query", "text": text})

    async def receive_messages(self):
        while True:
            value = await self._events.get()
            if value is _CLOSED:
                return
            yield value

    async def interrupt(self) -> None:
        await self._send({"type": "interrupt"})

    async def get_context_usage(self) -> dict:
        return dict(self._last_context_usage)

    async def disconnect(self) -> None:
        if self._closing:
            return
        self._closing = True
        process = self._process
        if process is not None and process.returncode is None:
            try:
                await self._send({"type": "close"})
                await asyncio.wait_for(process.wait(), timeout=5)
            except (RuntimeError, BrokenPipeError, asyncio.TimeoutError):
                process.kill()
                await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is not None:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        if self._state_home:
            shutil.rmtree(self._state_home, ignore_errors=True)
        self._process = None
        self._api_key = ""
