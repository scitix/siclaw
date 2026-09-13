"""Real Pi process contracts with only the provider HTTP boundary replaced."""

import asyncio
import json
from contextlib import asynccontextmanager
from copy import deepcopy

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from agent_protocol import AgentTransportError, EngineTool
from pi_engine import PiAgentClient, observe_sessions
from pi_file_tools import FileTools
import destream


def completion(text="done", *, tool=None):
    delta = {"content": text}
    if tool:
        name, args = tool
        delta = {"tool_calls": [{"index": 0, "id": "call-fixture", "type": "function",
                  "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}
    chunk = {"id": "response-fixture", "object": "chat.completion.chunk", "created": 1,
             "model": "fixture-model", "choices": [{"index": 0, "delta": delta,
             "finish_reason": "tool_calls" if tool else "stop"}],
             "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}}
    return web.Response(text=f"data: {json.dumps(chunk, ensure_ascii=False)}\n\ndata: [DONE]\n\n",
                        content_type="text/event-stream")


@asynccontextmanager
async def provider(respond, *, api="openai-completions"):
    requests = []

    async def handler(request):
        body = await request.json()
        requests.append(body)
        assert request.headers["Authorization"].split() == ["Bearer", "private-fixture-key"]
        return respond(body, len(requests))

    app = web.Application(client_max_size=4 * 1024 * 1024)
    app.router.add_post("/v1/responses" if api == "openai-responses" else "/v1/chat/completions", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield {"model": {
            "id": "fixture-model", "name": "Fixture model", "provider": "kbc-fixture",
            "api": api, "baseUrl": f"http://127.0.0.1:{port}/v1",
            "reasoning": False, "input": ["text", "image"], "contextWindow": 128000,
            "maxTokens": 2048, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        }, "api_key": "private-fixture-key", "thinking_level": "off"}, requests
    finally:
        await runner.cleanup()


@asynccontextmanager
async def client(tmp_path, config, tools=(), **kwargs):
    instance = PiAgentClient(cwd=str(tmp_path), system_prompt="Use the supplied tools.",
                             session_id="fixture-session", model_config=config,
                             tools=list(tools), **kwargs)
    try:
        await instance.connect()
        yield instance
    finally:
        await instance.disconnect()


async def collect(instance):
    async with asyncio.timeout(15):
        return [event async for event in instance.receive_response()]


async def allow(*_):
    return {}


async def test_real_worker_unicode_tool_and_observation(tmp_path):
    content = "故障恢复与编译检查。\n" * 12000
    observed = []

    async def observe(event):
        observed.append(event)
    async with provider(lambda _, n: completion(tool=("Write", {"file_path": "page.md", "content": content}))
                        if n == 1 else completion("已写入")) as (config, requests):
        tools = FileTools(str(tmp_path), ["Write"], allow).tools()
        with observe_sessions(observe):
            instance = PiAgentClient(cwd=str(tmp_path), system_prompt="Use the supplied tools.",
                                     session_id="fixture-session", model_config=config, tools=tools)
        try:
            await instance.connect()
            await instance.query("Write the page")
            events = await collect(instance)
            assert instance.sdk_version == "0.85.1"
            assert (tmp_path / "page.md").read_text() == content
            assert events[-1].data["outcome"] == "completed"
            assert events[-1].data["model_calls"] == 2
            assert [event.kind for event in events].count("tool_end") == 1
            assistants = [event.data for event in events if event.kind == "assistant"]
            assert all(event["llm_call"]["model"]["id"] == "fixture-model" for event in assistants)
            assert "content" not in assistants[0]["content"][0]["arguments"]
            assert len(requests) == 2
            finished = [e["data"]["observation"] for e in observed if e["kind"] == "model_usage"
                        and e["data"]["observation"]["phase"] == "finished"]
            assert len(finished) == len(requests)
            assert len({e["callId"] for e in finished}) == len(requests)
            assert all(e["executorRole"] == "compile" for e in finished)
            assert all(e["usageEvidence"]["rawUsage"]["prompt_tokens"] == 20 for e in finished)
            assert all(e["usageEvidence"]["rawUsage"]["completion_tokens"] == 5 for e in finished)
        finally:
            await instance.disconnect()


async def test_cancellation_waits_for_host_tool_before_next_turn(tmp_path):
    entered, stopped = asyncio.Event(), asyncio.Event()

    async def hold(_):
        entered.set()
        try:
            await asyncio.Future()
        finally:
            await asyncio.sleep(0.03)
            stopped.set()

    tool = EngineTool("hold", "Wait until interrupted", {"type": "object", "properties": {}}, hold)
    async with provider(lambda _, n: completion(tool=("hold", {})) if n == 1 else completion()) as (config, requests):
        async with client(tmp_path, config, [tool]) as instance:
            await instance.query("Wait")
            await asyncio.wait_for(entered.wait(), 15)
            with pytest.raises(AgentTransportError, match="Previous Pi turn"):
                await instance.query("Must not overlap")
            await instance.interrupt()
            assert stopped.is_set()
            assert (await collect(instance))[-1].data["outcome"] == "aborted"
            await instance.query("Continue after the barrier")
            assert (await collect(instance))[-1].data["outcome"] == "completed"
            assert len(requests) == 2


async def test_worker_exit_cancels_host_tool_and_never_succeeds(tmp_path):
    entered, stopped = asyncio.Event(), asyncio.Event()

    async def hold(_):
        entered.set()
        try:
            await asyncio.Future()
        finally:
            stopped.set()

    tool = EngineTool("hold", "Wait", {"type": "object", "properties": {}}, hold)
    async with provider(lambda *_: completion(tool=("hold", {}))) as (config, _):
        async with client(tmp_path, config, [tool]) as instance:
            await instance.query("Wait")
            await asyncio.wait_for(entered.wait(), 15)
            instance.process.kill()
            await instance.process.wait()
            with pytest.raises(AgentTransportError):
                await collect(instance)
            assert stopped.is_set()
            with pytest.raises(AgentTransportError):
                await instance.query("Cannot reuse a dead worker")


async def test_provider_failure_is_terminal_and_redacted(tmp_path):
    observations = []

    async def observe(event):
        observations.append(event)

    async with provider(lambda body, _: web.json_response({"error": {"message":
            "private-fixture-key rejected " + json.dumps(body)}}, status=400)) as (config, requests):
        with observe_sessions(observe):
            instance = PiAgentClient(cwd=str(tmp_path), system_prompt="Private system fixture",
                                     session_id="failure", model_config=config, tools=[])
        try:
            await instance.connect()
            await instance.query("Private user fixture")
            events = await collect(instance)
            assert events[-1].data["outcome"] == "failed"
            assert events[-1].data["api_error_status"] == 400
            assert "private-fixture-key" not in json.dumps([event.data for event in events])
            assert "Private user fixture" in events[-1].data["error"]
            assert "Private" not in json.dumps(observations)
            assert observations[-1]["data"]["failure_code"] == "model_request_failed"
            assert observations[-1]["data"]["api_error_status"] == 400
            # Auxiliary model errors obey the same projection, without changing
            # the private source record needed for owner-facing failure details.
            nested = {"llm_call": {"aux_calls": [{"error_message": "Private tool input", "round": 1}]}}
            await instance._observe("assistant", nested)
            assert "Private" not in json.dumps(observations)
            assert nested["llm_call"]["aux_calls"][0]["error_message"] == "Private tool input"
            assert len(requests) == 1
        finally:
            await instance.disconnect()


async def test_model_call_budget_stops_tool_loop(tmp_path):
    async def echo(_):
        return "ok"

    tool = EngineTool("echo", "Echo", {"type": "object", "properties": {}}, echo)
    async with provider(lambda *_: completion(tool=("echo", {}))) as (config, requests):
        async with client(tmp_path, config, [tool], max_model_calls=1) as instance:
            await instance.query("Loop")
            events = await collect(instance)
            assert events[-1].data["outcome"] == "failed"
            assert "KBC_MODEL_CALL_BUDGET_EXCEEDED" in events[-1].data["error"]
            assert len(requests) == 1


async def test_anthropic_roles_preserve_auth_context_unicode_and_cache_usage(tmp_path, monkeypatch):
    """Real SDK requests cross the same local shim as deployed compiler roles."""
    monkeypatch.delenv("KBC_DESTREAM", raising=False)
    monkeypatch.setattr(destream, "_UPSTREAM", "http://unselected.invalid")
    seen = []

    async def upstream(request):
        body = await request.json()
        seen.append((request.path, body))
        assert request.headers["Authorization"].split() == ["Bearer", "private-fixture-key"]
        assert request.headers["anthropic-beta"] == "context-1m-2025-08-07"
        assert "x-api-key" not in request.headers
        assert body["model"] == "claude-sonnet-4-6"
        assert body["max_tokens"] == 64000
        assert body["stream"] is False
        assert body["thinking"]["type"] == "adaptive"
        assert body["output_config"]["effort"] == "high"
        assert "context_management" not in body
        return web.json_response({
            "id": "msg_fixture", "type": "message", "role": "assistant", "model": body["model"],
            "content": [{"type": "text", "text": "编译恢复与中文边界完整。"}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 40,
                      "cache_creation_input_tokens": 10},
        })

    app = web.Application()
    app.router.add_post("/{role}/v1/messages", upstream)
    server = TestServer(app)
    await server.start_server()
    shim = web.Application()
    await destream.start(shim)
    try:
        for role in ("compile", "judge"):
            endpoint = str(server.make_url(f"/{role}"))
            assert destream.session_endpoint("test", endpoint) == endpoint
            config = {"model": {
                "id": "claude-sonnet-4-6", "name": "Fixture", "provider": f"fixture-{role}",
                "api": "anthropic-messages", "baseUrl": destream.session_endpoint("verify", endpoint),
                "reasoning": True, "input": ["text", "image"], "contextWindow": 1000000,
                "maxTokens": 64000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            }, "api_key": "private-fixture-key", "thinking_level": "high", "auth_header": True,
                "headers": {"anthropic-beta": "context-1m-2025-08-07", "x-api-key": None}}
            async with client(tmp_path, deepcopy(config)) as instance:
                await instance.query("检查中文编码")
                events = await collect(instance)
                assert events[-1].data["outcome"] == "completed", events[-1].data
                assistant = next(event for event in events if event.kind == "assistant")
                assert assistant.data["content"][0]["text"] == "编译恢复与中文边界完整。"
                assert assistant.data["llm_call"]["usage"]["cache_read"] == 40
                assert assistant.data["llm_call"]["usage"]["cache_write"] == 10
        assert [path for path, _ in seen] == ["/compile/v1/messages", "/judge/v1/messages"]
    finally:
        await shim["_destream_runner"].cleanup()
        destream._PORT = None
        destream._PI_UPSTREAMS.clear()
        await server.close()
