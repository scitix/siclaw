"""Claude Agent SDK adapter for KBC's host tools and neutral event contract."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import asdict
import hashlib
from importlib.metadata import version
import json
import os
import tempfile
import uuid

from agent_protocol import AgentEvent, AgentTransportError, EngineTool
from execution_observation import ExecutionObserver
from model_usage import ClaudeUsageRecorder


def sdk_version() -> str:
    return version("claude-agent-sdk")


class ClaudeAgentClient:
    def __init__(self, *, cwd: str, system_prompt: str, session_id: str,
                 model_config: dict, tools: list[EngineTool], max_model_calls: int = 150):
        if model_config["model"]["api"] != "anthropic-messages":
            raise ValueError("Claude Agent SDK requires an Anthropic model")
        self.cwd, self.system_prompt, self.session_id = cwd, system_prompt, session_id
        self.config = deepcopy(model_config)
        self.tools = {tool.name: tool for tool in tools}
        if len(self.tools) != len(tools):
            raise ValueError("Duplicate compiler tool name")
        self.max_model_calls = max_model_calls
        self.sdk_version = sdk_version()
        self._observations = ExecutionObserver(session_id, self.config)
        self._usage_recorder = ClaudeUsageRecorder(session_id, self.config, self._observations)
        self._client = None
        self._reader = None
        self._state = None
        self._events = asyncio.Queue()
        self._queued_bytes = 0
        self._tools: set[asyncio.Task] = set()
        self._settled = asyncio.Event()
        self._settled.set()
        self._closing = False
        self._failure = None
        self._turn_id = ""
        self._aborted = False
        self._tool_calls = 0
        self._model_calls = 0
        self._usage = {}
        self._status = None
        self._assistant = None
        self._message_usage = {}
        self._message_stop_reason = None
        self._names = {"mcp__kbc__" + name: name for name in self.tools}

    @property
    def returncode(self):
        transport = getattr(self._client, "_transport", None)
        return getattr(getattr(transport, "_process", None), "returncode", None)

    def _safe_error(self, error) -> str:
        text = str(error)
        for secret in [self.config["api_key"], *(self.config.get("headers") or {}).values()]:
            if secret:
                text = text.replace(secret, "[REDACTED]")
        return text[:2000]

    async def _emit(self, kind: str, data: dict):
        await self._observations.emit(kind, data, self._turn_id)
        size = len(json.dumps(data, ensure_ascii=False).encode())
        self._queued_bytes += size
        if self._queued_bytes > 128 * 1024 * 1024:
            raise AgentTransportError("Claude event queue exceeds its byte budget")
        self._events.put_nowait((AgentEvent(kind, self.session_id, self._turn_id, data), size))

    def _sdk_tool(self, definition):
        from claude_agent_sdk import tool

        async def invoke(args):
            if self._closing or self._aborted:
                return {"content": [{"type": "text", "text": "Turn cancelled"}], "isError": True}
            call = {"call_id": str(uuid.uuid4()), "name": definition.name}
            self._tool_calls += 1
            await self._emit("tool_start", call)
            task = asyncio.create_task(definition.handler(args))
            self._tools.add(task)
            try:
                result = await task
                if isinstance(result, str):
                    result = {"content": [{"type": "text", "text": result}]}
                await self._emit("tool_end", {**call, "is_error": bool(result.get("isError"))})
                return result
            except Exception as error:
                # Tool boundary: return a failed tool result so the model can
                # correct invalid input without mistaking it for success.
                await self._emit("tool_end", {**call, "is_error": True})
                return {"content": [{"type": "text", "text": self._safe_error(error)}], "isError": True}
            finally:
                self._tools.discard(task)

        return tool(definition.name, definition.description, definition.input_schema)(invoke)

    async def connect(self):
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, InMemorySessionStore, create_sdk_mcp_server

        if self._client or self._closing:
            raise AgentTransportError("Claude session cannot be connected twice")
        self._state = tempfile.TemporaryDirectory(prefix="kbc-claude-")
        model = self.config["model"]
        # SDK env overlays its parent. Clear inherited provider/SDK credentials
        # and use a private config directory before installing this role's key.
        env = {key: "" for key in os.environ if key.startswith(("ANTHROPIC_", "OPENAI_", "CLAUDE_"))}
        env.update({"CLAUDE_CONFIG_DIR": self._state.name,
                    "ANTHROPIC_BASE_URL": model["baseUrl"],
                    "ANTHROPIC_API_KEY": "" if self.config.get("auth_header") else self.config["api_key"],
                    "ANTHROPIC_AUTH_TOKEN": self.config["api_key"] if self.config.get("auth_header") else "",
                    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    "DISABLE_AUTO_COMPACT": "1", "DISABLE_AUTOCOMPACT": "1",
                    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(model["maxTokens"]),
                    "ANTHROPIC_CUSTOM_HEADERS": "\n".join(f"{k}: {v}" for k, v in (self.config.get("headers") or {}).items() if v)})
        model_id = model["id"]
        if model_id.startswith("claude-") and model["contextWindow"] > 200000 and not model_id.endswith("[1m]"):
            model_id += "[1m]"
        effort = self.config.get("thinking_level", "off")
        options = ClaudeAgentOptions(
            cwd=self.cwd, system_prompt=self.system_prompt, model=model_id,
            tools=[], allowed_tools=list(self._names),
            mcp_servers={"kbc": create_sdk_mcp_server(name="kbc", tools=[self._sdk_tool(t) for t in self.tools.values()])},
            strict_mcp_config=True, skills=[], setting_sources=[],
            permission_mode="bypassPermissions", max_turns=self.max_model_calls,
            session_id=self.session_id, session_store=InMemorySessionStore(),
            include_partial_messages=True, env=env, max_buffer_size=64 * 1024 * 1024,
            thinking={"type": "disabled"} if effort == "off" else {"type": "adaptive"},
            effort=None if effort == "off" else "low" if effort == "minimal" else effort,
            stderr=lambda _: None,  # Provider bodies belong in owner errors, not raw process logs.
        )
        self._client = ClaudeSDKClient(options=options)
        await self._client.connect()
        await self._observations.emit("ready", {"sdk_version": self.sdk_version})
        self._reader = asyncio.create_task(self._read_messages())

    async def _flush_assistant(self):
        if self._assistant is None:
            return
        message, self._assistant = self._assistant, None
        await self._usage_recorder.record_unobserved(message["id"], self._turn_id)
        self._model_calls += 1
        self._usage = dict(self._message_usage)
        await self._emit("assistant", {
            "content": message["content"], "stop_reason": self._message_stop_reason,
            "llm_call": {"model": {"id": self.config["model"]["id"]}, "usage": self._usage},
        })

    async def _read_messages(self):
        try:
            async for message in self._client.receive_messages():
                kind = type(message).__name__
                if kind == "StreamEvent":
                    event = message.event
                    await self._usage_recorder.observe(event, self._turn_id)
                    if event.get("type") == "message_start":
                        await self._flush_assistant()
                        self._message_usage = dict((event.get("message") or {}).get("usage") or {})
                        self._message_stop_reason = None
                    elif event.get("type") == "message_delta":
                        self._message_usage.update(event.get("usage") or {})
                        self._message_stop_reason = (event.get("delta") or {}).get("stop_reason")
                    elif event.get("type") == "message_stop":
                        await self._flush_assistant()
                    await self._emit("activity", {})
                elif kind == "AssistantMessage":
                    # The SDK emits one AssistantMessage per completed content
                    # block, sharing a message ID. Normalize them to the single
                    # completed-message contract used by both compiler engines.
                    if self._assistant is not None and self._assistant["id"] != message.message_id:
                        await self._flush_assistant()
                    if self._assistant is None:
                        self._assistant = {"id": message.message_id, "content": []}
                    if not self._message_usage:
                        self._message_usage = dict(message.usage or {})
                    if message.stop_reason:
                        self._message_stop_reason = message.stop_reason
                    if message.error:
                        self._status = {"billing_error": 402, "rate_limit": 429, "authentication_failed": 401,
                                        "invalid_request": 400, "server_error": 500}.get(message.error)
                    blocks = self._assistant["content"]
                    for block in message.content:
                        value = asdict(block)
                        if type(block).__name__ == "TextBlock":
                            if blocks and blocks[-1]["type"] == "text":
                                blocks[-1]["text"] += value["text"]
                            else:
                                blocks.append({"type": "text", "text": value["text"]})
                        elif type(block).__name__ == "ToolUseBlock":
                            blocks.append({"type": "toolCall", "id": value["id"],
                                           "name": self._names.get(value["name"], value["name"]), "arguments": value["input"]})
                elif kind == "ResultMessage":
                    await self._usage_recorder.finish("cancelled" if self._aborted else "error" if message.is_error else "success", self._turn_id)
                    await self._flush_assistant()
                    await self._stop_tools()
                    data = {"outcome": "aborted" if self._aborted else "failed" if message.is_error else "completed",
                            "model_calls": self._model_calls, "tool_calls": self._tool_calls,
                            "usage": message.usage or self._usage, "api_error_status": message.api_error_status or self._status}
                    if message.is_error:
                        data["error"] = ("KBC_MODEL_CALL_BUDGET_EXCEEDED" if message.subtype == "error_max_turns"
                                         else self._safe_error("; ".join(message.errors or [message.result or message.subtype])))
                    self._settled.set()
                    await self._emit("result", data)
            if not self._closing:
                raise AgentTransportError("Claude SDK stream closed before the session was closed")
        except Exception as error:
            await self._usage_recorder.finish("error", self._turn_id)
            # Background transport boundary: wake the consumer with a failure.
            self._failure = AgentTransportError(self._safe_error(error))
            await self._observations.emit("transport_error", {}, self._turn_id)
        finally:
            await self._stop_tools()
            self._settled.set()
            self._events.put_nowait((self._failure, 0))

    async def query(self, message: str):
        if self._failure:
            raise self._failure
        if not self._client or self._closing or not self._settled.is_set():
            raise AgentTransportError("Previous Claude turn has not settled or session is unavailable")
        self._turn_id = str(uuid.uuid4())
        self._usage_recorder.seen.clear()
        self._settled.clear()
        self._aborted, self._tool_calls, self._model_calls, self._status = False, 0, 0, None
        await self._emit("model_request", {"call": 1, "model": self.config["model"]["id"], "provider": self.config["model"]["provider"]})
        await self._emit("model_envelope", {"manifest": {"system_prompt_sha256": hashlib.sha256(self.system_prompt.encode()).hexdigest(),
                                                       "tools": list(self.tools), "model": self.config["model"]["id"]}})
        await self._usage_recorder.begin(self._turn_id)
        try:
            await self._client.query(message)
        except Exception:
            await self._usage_recorder.finish("error", self._turn_id)
            raise

    async def receive_messages(self):
        while True:
            event, size = await self._events.get()
            self._queued_bytes -= size
            if isinstance(event, Exception):
                raise event
            if event is None:
                return
            yield event

    async def receive_response(self):
        async for event in self.receive_messages():
            yield event
            if event.kind == "result":
                return

    async def _stop_tools(self):
        tasks = list(self._tools)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def interrupt(self):
        if self._settled.is_set():
            return
        self._aborted = True
        await self._stop_tools()
        await self._client.interrupt()
        try:
            await asyncio.wait_for(self._settled.wait(), 10)
        except asyncio.TimeoutError as error:
            raise AgentTransportError("Claude interruption did not settle; rebuild the session") from error

    async def get_context_usage(self):
        return {"maxTokens": self.config["model"]["contextWindow"],
                "totalTokens": sum(self._usage.get(key, 0) for key in
                                   ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))}

    async def disconnect(self):
        self._closing = True
        await self._stop_tools()
        if self._reader:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
        try:
            if self._client:
                await self._client.disconnect()
        finally:
            if self._state:
                self._state.cleanup()
