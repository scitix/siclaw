"""Real Claude SDK process contracts with only the provider HTTP replaced."""

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import json
import os
import uuid

from aiohttp import web
import pytest

import compile_box
import pi_config
from claude_engine import ClaudeAgentClient
from engine import create_agent_client, selected_readonly_engine
from execution_observation import observe_sessions
from pi_file_tools import FileTools
from test_pi_engine import allow


def response(*, tool=None, text="done"):
    block = ({"type": "tool_use", "id": "tool_" + uuid.uuid4().hex, "name": tool[0], "input": {}}
             if tool else {"type": "text", "text": ""})
    events = [
        {"type": "message_start", "message": {"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant",
         "content": [], "model": "claude-fixture", "stop_reason": None, "stop_sequence": None,
         "usage": {"input_tokens": 42, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": block},
        {"type": "content_block_delta", "index": 0, "delta":
         {"type": "input_json_delta", "partial_json": json.dumps(tool[1])} if tool else {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None},
         "usage": {"input_tokens": 42, "output_tokens": 8}},
        {"type": "message_stop"},
    ]
    return web.Response(text="".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events), content_type="text/event-stream")


@asynccontextmanager
async def provider(respond):
    requests = []

    async def messages(request):
        body = await request.json()
        requests.append(body)
        assert request.headers.get("x-api-key") == "fixture-private-key"
        return respond(body, len(requests))

    app = web.Application()
    app.router.add_post("/v1/messages", messages)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield {"model": {"id": "claude-fixture", "name": "Claude fixture", "provider": "fixture",
                          "api": "anthropic-messages", "baseUrl": f"http://127.0.0.1:{port}",
                          "input": ["text"], "reasoning": False, "contextWindow": 200000, "maxTokens": 2048},
               "api_key": "fixture-private-key", "auth_header": False, "thinking_level": "off"}, requests
    finally:
        await runner.cleanup()


def configure(monkeypatch, config):
    monkeypatch.setattr(os, "environ", dict(os.environ))
    monkeypatch.setattr(pi_config, "_roles", {})
    monkeypatch.setattr(pi_config, "_agent_type", None)
    monkeypatch.setenv("KBC_ENGINE", "claude_agent_sdk")
    compile_box._apply_session_config({"llm": {"engine": "claude_agent_sdk", "execution": {
        "version": 1, "roles": {r: deepcopy(config) for r in ("compile", "blue", "judge", "transcribe", "compare")}}}})


async def test_selected_claude_executes_host_tools_and_records_observations(tmp_path, monkeypatch):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw/source.md").write_text("Synthetic retention: 19 days.")
    observed = []

    async def observe(event):
        observed.append(event)

    def respond(body, number):
        if number == 1:
            assert {t["name"] for t in body["tools"]} == {"mcp__kbc__Read", "mcp__kbc__Write"}
            return response(tool=("mcp__kbc__Read", {"file_path": "raw/source.md"}))
        if number == 2:
            assert "Synthetic retention: 19 days." in json.dumps(body["messages"])
            return response(tool=("mcp__kbc__Write", {"file_path": "candidate/page.md", "content": "Keep records for 19 days."}))
        return response(text="Compiled the source.")

    async with provider(respond) as (config, requests):
        configure(monkeypatch, config)
        with observe_sessions(observe):
            client = create_agent_client(cwd=str(tmp_path), system_prompt="Use the supplied tools.", session_id=str(uuid.uuid4()),
                                         model_config=pi_config.for_role("compile"),
                                         tools=FileTools(str(tmp_path), ["Read", "Write"], allow).tools())
            assert isinstance(client, ClaudeAgentClient)
            try:
                async with asyncio.timeout(30):
                    await client.connect()
                    await client.query("Read the source and write a candidate page.")
                    events = [e async for e in client.receive_response()]
            finally:
                await client.disconnect()
        assert (tmp_path / "candidate/page.md").read_text() == "Keep records for 19 days."
        assert events[-1].data["outcome"] == "completed"
        assert events[-1].data["tool_calls"] == 2
        assert len(requests) == 3
        usage = [e["data"]["observation"] for e in observed if e["kind"] == "model_usage"]
        finished = [e for e in usage if e["phase"] == "finished"]
        assert len(finished) == len(requests)
        assert len({e["callId"] for e in finished}) == len(requests)
        assert all(e["executorRole"] == "compile" for e in finished)
        assert all(e["usageEvidence"]["finality"] == "terminal" for e in finished)
        assert all(e["usageEvidence"]["rawUsage"]["input_tokens"] == 42 for e in finished)
        assert all(e["usageEvidence"]["rawUsage"]["output_tokens"] == 8 for e in finished)
        assert {"ready", "model_request", "model_envelope", "assistant", "tool_start", "tool_end", "result"} <= {e["kind"] for e in observed}
        assert "fixture-private-key" not in json.dumps(observed)
        assert "Synthetic retention" not in json.dumps(observed)


async def test_claude_readonly_and_provider_failure(tmp_path, monkeypatch):
    async with provider(lambda *_: web.json_response({"type": "error", "error": {"type": "invalid_request_error", "message": "fixture failure"}}, status=400)) as (config, _):
        configure(monkeypatch, config)
        with pytest.raises(RuntimeError):
            await selected_readonly_engine().run_readonly_agent(
                cwd=str(tmp_path), system_prompt="Read only.", user_message="Check sources.", model="claude-fixture", role="blue",
                allowed_read_roots=[str(tmp_path)], timeout_secs=30)


async def test_claude_interrupt_settles_host_writes_before_next_turn(tmp_path):
    from agent_protocol import AgentTransportError, EngineTool
    entered, stopped = asyncio.Event(), asyncio.Event()

    async def hold(_):
        entered.set()
        try:
            await asyncio.Future()
        finally:
            await asyncio.sleep(0.02)
            stopped.set()

    tool = EngineTool("hold", "Wait for cancellation", {"type": "object", "properties": {}}, hold)
    async with provider(lambda _, n: response(tool=("mcp__kbc__hold", {})) if n == 1 else response()) as (config, _):
        client = ClaudeAgentClient(cwd=str(tmp_path), system_prompt="Use the tool.", session_id=str(uuid.uuid4()), model_config=config, tools=[tool])
        try:
            await client.connect()
            await client.query("Wait.")
            await asyncio.wait_for(entered.wait(), 15)
            with pytest.raises(AgentTransportError, match="Previous Claude turn"):
                await client.query("Must not overlap")
            await client.interrupt()
            assert stopped.is_set()
            async with asyncio.timeout(15):
                result = [e async for e in client.receive_response()]
            assert result[-1].data["outcome"] == "aborted"
            await client.query("Continue")
            async with asyncio.timeout(15):
                result = [e async for e in client.receive_response()]
            assert result[-1].data["outcome"] == "completed"
        finally:
            await client.disconnect()


@pytest.mark.parametrize("engine", ["claude_agent_sdk", "pi_agent"])
async def test_fresh_question_session_can_locate_raw_outside_wiki(tmp_path, monkeypatch, engine):
    from redblue import _agent_json

    raw, wiki = tmp_path / "raw", tmp_path / "wiki"
    raw.mkdir()
    wiki.mkdir()
    (raw / "source.md").write_text("The staging watchdog is 45 seconds.")
    expected = {"questions": [{"question": "What is the watchdog timeout?", "expected": "45 seconds"}]}
    tool_name = "mcp__kbc__Read" if engine == "claude_agent_sdk" else "Read"

    def respond(body, number):
        # Question generation is a fresh session. The survey's directory map
        # is not in its conversation, so the engine must disclose allowed roots.
        context = json.dumps([body.get("system"), body["messages"]])
        if str(raw) not in context:
            return response(text='The raw source is not accessible. {"id":"q1","question":"Watchdog?"}')
        if number == 1:
            return response(tool=(tool_name, {"file_path": str(raw / "source.md")}))
        assert "The staging watchdog is 45 seconds." in json.dumps(body["messages"])
        return response(text=json.dumps(expected))

    async with provider(respond) as (config, requests):
        config["model"]["cost"] = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        configure(monkeypatch, config)
        monkeypatch.setenv("KBC_ENGINE", engine)
        result = await _agent_json(
            selected_readonly_engine(), stage="questions", system="Check raw ground truth.",
            user='Return one question as {"questions": [...]}.', model="claude-fixture", role="judge",
            cwd=str(wiki), roots=[str(wiki), str(raw)], timeout=30)
        assert result == expected
        assert len(requests) == 2


async def test_claude_assembles_text_blocks_before_returning_json(tmp_path, monkeypatch):
    expected = {"questions": [{"question": "What is the timeout?", "expected": "45 seconds"}]}
    encoded = json.dumps(expected)
    parts = [encoded[:len(encoded) // 2], encoded[len(encoded) // 2:]]
    observed = []

    async def observe(event):
        observed.append(event)

    def respond(_, number):
        if number == 1:
            return response(tool=("mcp__kbc__Read", {"file_path": "source.md"}))
        template = [json.loads(line[6:]) for line in response().text.splitlines() if line.startswith("data: ")]
        events = [template[0]]
        for index, part in enumerate(parts):
            events.append({"type": "content_block_start", "index": index,
                           "content_block": {"type": "text", "text": ""}})
            for offset in range(0, len(part), 13):
                events.append({"type": "content_block_delta", "index": index,
                               "delta": {"type": "text_delta", "text": part[offset:offset + 13]}})
            events.append({"type": "content_block_stop", "index": index})
        events.extend(template[-2:])
        return web.Response(text="".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events),
                            content_type="text/event-stream")

    (tmp_path / "source.md").write_text("The timeout is 45 seconds.")
    async with provider(respond) as (config, requests):
        configure(monkeypatch, config)
        with observe_sessions(observe):
            answer = await selected_readonly_engine().run_readonly_agent(
                cwd=str(tmp_path), system_prompt="Read the source and return JSON.", user_message="Write a question.",
                model="claude-fixture", role="judge", allowed_read_roots=[str(tmp_path)], timeout_secs=30)
        assert json.loads(answer) == expected
        assert len(requests) == 2
        assert [e["data"]["stop_reason"] for e in observed if e["kind"] == "assistant"] == ["tool_use", "end_turn"]
        assert [e["data"]["model_calls"] for e in observed if e["kind"] == "result"] == [2]
