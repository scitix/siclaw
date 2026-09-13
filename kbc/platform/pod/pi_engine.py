"""Private Pi worker transport; Python owns tools, cancellation and checkpoints."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import AsyncIterator

from agent_protocol import AgentEvent, AgentTransportError, EngineTool
from execution_observation import ExecutionObserver, observe_sessions

MAX_FRAME_BYTES = 64 * 1024 * 1024
MAX_QUEUED_BYTES = 2 * MAX_FRAME_BYTES
_CLOSED = object()
def worker_command() -> list[str]:
    pod = Path(__file__).resolve().parent
    packaged = pod / "pi-worker" / "dist" / "kbc" / "pi-worker.js"
    worker = packaged if packaged.is_file() else (
        pod / ".." / ".." / ".." / "dist" / "kbc" / "pi-worker.js"
    ).resolve()
    node = shutil.which("node")
    if not node or not worker.is_file():
        raise AgentTransportError("Pi worker is not built or Node.js is unavailable")
    return [node, str(worker)]


def sdk_version() -> str:
    root = Path(worker_command()[1]).parents[2]
    package = root / "node_modules" / "@earendil-works" / "pi-coding-agent" / "package.json"
    return json.loads(package.read_text(encoding="utf-8"))["version"]


class PiAgentClient:
    """One isolated execution session with a persistent stream of neutral events.

    Credentials travel once over stdin. Tools execute in independent tasks so
    the reader can acknowledge cancellation while the model is awaiting a tool.
    A disconnect does not complete until every host tool has stopped.
    """

    def __init__(self, *, cwd: str, system_prompt: str, session_id: str,
                 model_config: dict, tools: list[EngineTool],
                 max_model_calls: int = 150, command: list[str] | None = None):
        self.cwd = str(Path(cwd).resolve())
        managed_prompt = model_config.get("system_prompt_append", "").strip()
        self.system_prompt = system_prompt + ("\n\n---\n\n# Managed compiler instructions\n\n" + managed_prompt
                                               if managed_prompt else "")
        self.session_id = session_id
        self.config = model_config
        self.tools = {tool.name: tool for tool in tools}
        if len(self.tools) != len(tools):
            raise ValueError("Duplicate compiler tool name")
        self.max_model_calls = max_model_calls
        self.command = command
        self.process: asyncio.subprocess.Process | None = None
        self._state: tempfile.TemporaryDirectory | None = None
        self._reader: asyncio.Task | None = None
        self._stderr: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._settled = asyncio.Event()
        self._settled.set()
        self._turn_id = ""
        self._failure: AgentTransportError | None = None
        self._closing = False
        self._write_lock = asyncio.Lock()
        self._events: asyncio.Queue = asyncio.Queue()
        self._queued_bytes = 0
        self._executions: dict[str, asyncio.Task] = {}
        self._replies: dict[str, asyncio.Task] = {}
        self.sdk_version: str | None = None
        self._last_usage: dict = {}
        self._observations = ExecutionObserver(session_id, model_config)

    async def _observe(self, kind: str, data: dict) -> None:
        await self._observations.emit(kind, data, self._turn_id)

    @property
    def returncode(self) -> int | None:
        return self.process.returncode if self.process else None

    def _safe_error(self, error: object) -> str:
        text = str(error)
        secrets = [self.config.get("api_key"), *(self.config.get("headers") or {}).values()]
        for secret in secrets:
            if isinstance(secret, str) and secret:
                text = text.replace(secret, "[REDACTED]")
        return text[:2000]

    async def _send(self, frame: dict) -> None:
        data = (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(data) > MAX_FRAME_BYTES:
            raise AgentTransportError("Pi input frame exceeds its byte budget")
        async with self._write_lock:
            if not self.process or self.process.returncode is not None:
                raise AgentTransportError("Pi worker exited before accepting input")
            try:
                self.process.stdin.write(data)
                await self.process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as error:
                raise AgentTransportError("Pi worker input closed") from error

    async def connect(self) -> None:
        if self.process or self._closing:
            raise AgentTransportError("Pi session cannot be connected twice")
        self._state = tempfile.TemporaryDirectory(prefix="kbc-pi-")
        try:
            # Child uses only explicit initialization credentials. Do not inherit
            # another role's SDK key or load user-owned agent configuration.
            environment = {key: value for key, value in os.environ.items() if not (
                key.endswith(("_API_KEY", "_AUTH_TOKEN")) or key.startswith(("ANTHROPIC_", "OPENAI_", "CLAUDE_"))
            )}
            self.process = await asyncio.create_subprocess_exec(
                *(self.command or worker_command()), cwd=self.cwd, env=environment,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=MAX_FRAME_BYTES,
            )
            self._reader = asyncio.create_task(self._read_frames())
            self._stderr = asyncio.create_task(self._drain_stderr())
            await self._send({
                "type": "init", "v": 1, "session_id": self.session_id,
                "cwd": self.cwd, "state_dir": self._state.name,
                "system_prompt": self.system_prompt,
                "model": self.config["model"], "api_key": self.config["api_key"],
                "executor_role": self.config.get("role", "compile"),
                "auth_header": self.config.get("auth_header", True),
                "headers": self.config.get("headers", {}),
                "thinking_level": self.config.get("thinking_level", "off"),
                "max_model_calls": self.max_model_calls,
                "tools": [{"name": tool.name, "description": tool.description,
                           "parameters": tool.input_schema} for tool in self.tools.values()],
            })
            await asyncio.wait_for(self._ready.wait(), 30)
            if self._failure:
                raise self._failure
        except BaseException:
            await self.disconnect()
            raise

    async def _drain_stderr(self) -> None:
        # Worker diagnostics are structured stdout events. Never forward raw
        # SDK stderr, which may include request headers, to public compile logs.
        while await self.process.stderr.read(8192):
            pass

    async def _reply_tool(self, frame: dict, task: asyncio.Task) -> None:
        call_id = frame["call_id"]
        try:
            try:
                result = await task
                if isinstance(result, str):
                    result = {"content": [{"type": "text", "text": result}]}
                if not isinstance(result, dict) or not isinstance(result.get("content"), list):
                    raise ValueError("Tool returned an invalid content result")
                content, is_error = result["content"], bool(result.get("isError", False))
            except asyncio.CancelledError:
                content, is_error = [{"type": "text", "text": "Tool execution cancelled"}], True
            except Exception as error:
                content, is_error = [{"type": "text", "text": self._safe_error(error)}], True
            await self._send({"type": "tool_result", "turn_id": frame["turn_id"],
                              "call_id": call_id, "content": content, "is_error": is_error})
        except AgentTransportError as error:
            self._failure = error
            # Wake a reader whose worker stopped consuming oversized tool output.
            if self.process and self.process.returncode is None:
                self.process.terminate()
        finally:
            self._executions.pop(call_id, None)
            self._replies.pop(call_id, None)

    async def _stop_tools(self) -> None:
        for task in tuple(self._executions.values()):
            task.cancel()
        replies = tuple(self._replies.values())
        if replies:
            await asyncio.gather(*replies)

    async def _read_frames(self) -> None:
        try:
            while line := await self.process.stdout.readline():
                if len(line) > MAX_FRAME_BYTES or not line.endswith(b"\n"):
                    raise AgentTransportError("Pi output frame is oversized or incomplete")
                frame = json.loads(line)
                if not isinstance(frame, dict) or frame.get("v") != 1 or frame.get("session_id") != self.session_id:
                    raise AgentTransportError("Pi output has an incompatible session or protocol")
                kind = frame.get("type")
                if kind == "ready":
                    if self._ready.is_set() or not isinstance(frame.get("sdk_version"), str):
                        raise AgentTransportError("Pi worker returned an invalid ready event")
                    self.sdk_version = frame["sdk_version"]
                    await self._observe(kind, frame)
                    self._ready.set()
                    continue
                if frame.get("turn_id") != self._turn_id or not self._turn_id:
                    raise AgentTransportError("Pi worker returned an event for an inactive turn")
                if kind == "tool_request":
                    call_id, name, args = frame.get("call_id"), frame.get("name"), frame.get("arguments")
                    if not isinstance(call_id, str) or call_id in self._executions or name not in self.tools or not isinstance(args, dict):
                        raise AgentTransportError("Pi worker returned an invalid tool request")
                    if len(self._executions) >= 64:
                        raise AgentTransportError("Pi concurrent tool budget exceeded")
                    task = asyncio.create_task(self.tools[name].handler(args))
                    self._executions[call_id] = task
                    self._replies[call_id] = asyncio.create_task(self._reply_tool(frame, task))
                    continue
                if kind == "tool_cancel":
                    task = self._executions.get(frame.get("call_id"))
                    if task:
                        task.cancel()
                    continue
                if kind not in {"activity", "assistant", "tool_start", "tool_end", "model_request", "model_envelope", "model_usage", "result"}:
                    raise AgentTransportError("Pi worker returned an unknown event")
                if kind == "result":
                    if frame.get("outcome") not in {"completed", "failed", "aborted"} or self._executions:
                        raise AgentTransportError("Pi worker completed before its tools settled")
                    self._settled.set()
                    self._last_usage = frame.get("usage") or {}
                await self._observe(kind, frame)
                self._queued_bytes += len(line)
                if self._queued_bytes > MAX_QUEUED_BYTES:
                    raise AgentTransportError("Pi event queue exceeds its byte budget")
                self._events.put_nowait((AgentEvent(kind, self.session_id, self._turn_id, frame), len(line)))
            if not self._closing:
                raise AgentTransportError("Pi worker exited without closing the session")
        except Exception as error:
            self._failure = error if isinstance(error, AgentTransportError) else AgentTransportError("Pi worker output is invalid")
            await self._observe("transport_error", {"error": self._safe_error(self._failure)})
        finally:
            await self._stop_tools()
            self._ready.set()
            self._settled.set()
            self._events.put_nowait((self._failure or _CLOSED, 0))

    async def query(self, message: str, *, images: list[dict] | None = None) -> None:
        if self._failure:
            raise self._failure
        if self._closing or not self._ready.is_set() or not self._settled.is_set():
            raise AgentTransportError("Previous Pi turn has not settled or session is unavailable")
        self._turn_id = str(uuid.uuid4())
        self._settled.clear()
        await self._send({"type": "prompt", "turn_id": self._turn_id, "text": message,
                          **({"images": images} if images else {})})

    async def receive_messages(self) -> AsyncIterator[AgentEvent]:
        while True:
            event, size = await self._events.get()
            self._queued_bytes -= size
            if event is _CLOSED:
                return
            if isinstance(event, AgentTransportError):
                raise event
            yield event

    async def receive_response(self) -> AsyncIterator[AgentEvent]:
        async for event in self.receive_messages():
            yield event
            if event.kind == "result":
                return

    async def interrupt(self) -> None:
        if self._settled.is_set():
            return
        await self._send({"type": "interrupt", "turn_id": self._turn_id})
        try:
            await asyncio.wait_for(self._settled.wait(), 10)
        except asyncio.TimeoutError as error:
            raise AgentTransportError("Pi interruption did not settle; rebuild the session") from error
        if self._failure:
            raise self._failure

    async def get_context_usage(self) -> dict:
        usage = self._last_usage
        return {"maxTokens": self.config["model"]["contextWindow"],
                "totalTokens": sum(usage.get(key, 0) for key in (
                    "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))}

    async def disconnect(self) -> None:
        self._closing = True
        # This is the host's write barrier. Do not kill the worker and return
        # while a Python tool could still mutate the previous attempt's files.
        await self._stop_tools()
        if self.process:
            if self.process.returncode is None:
                try:
                    await self._send({"type": "close"})
                    self.process.stdin.close()
                    await asyncio.wait_for(self.process.wait(), 5)
                except (AgentTransportError, asyncio.TimeoutError):
                    if self.process.returncode is None:
                        self.process.kill()
                    await self.process.wait()
            if self._reader:
                await self._reader
            if self._stderr:
                await self._stderr
        if self._state:
            self._state.cleanup()
            self._state = None
