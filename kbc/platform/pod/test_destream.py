"""Tests for the in-pod de-streaming shim (destream.py)."""

import asyncio
import json
import os

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import destream


def _parse_sse(raw: bytes) -> list[tuple[str, dict]]:
    events = []
    for block in raw.decode("utf-8").split("\n\n"):
        lines = [ln for ln in block.splitlines() if ln]
        if not lines:
            continue
        ev = next((ln[7:] for ln in lines if ln.startswith("event: ")), "")
        data = next((ln[6:] for ln in lines if ln.startswith("data: ")), "{}")
        events.append((ev, json.loads(data)))
    return events


UPSTREAM_MSG = {
    "id": "msg_01", "type": "message", "role": "assistant",
    "model": "claude-opus-4-6",
    "content": [
        {"type": "text", "text": "中文正文，多字节字符完好。"},
        {"type": "tool_use", "id": "tu_1", "name": "Write",
         "input": {"path": "候选/页.md", "content": "含中文内容"}},
    ],
    "stop_reason": "tool_use", "stop_sequence": None,
    "usage": {"input_tokens": 321, "output_tokens": 54},
}


async def _run_with_fake_upstream(upstream_handler, exercise):
    up_app = web.Application()
    up_app.router.add_route("*", "/{tail:.*}", upstream_handler)
    up_server = TestServer(up_app)
    await up_server.start_server()

    shim_app = web.Application()
    await destream.start(shim_app)
    try:
        destream._UPSTREAM = str(up_server.make_url("")).rstrip("/")
        shim_client_app = web.Application()
        shim_client_app.router.add_route("*", "/{tail:.*}", destream._handle)
        client = TestClient(TestServer(shim_client_app))
        await client.start_server()
        try:
            await exercise(client)
        finally:
            await client.close()
    finally:
        destream._UPSTREAM = None
        await shim_app["_destream_runner"].cleanup()
        await up_server.close()


async def test_destream_synthesizes_valid_sse():
    seen = {}

    async def upstream(request):
        seen["body"] = await request.json()
        seen["path"] = request.path
        return web.json_response(UPSTREAM_MSG)

    async def exercise(client):
        resp = await client.post("/v1/messages", json={
            "model": "claude-opus-4-6", "stream": True, "max_tokens": 2048,
            "messages": [{"role": "user", "content": "hi"}]})
        assert resp.status == 200
        assert resp.headers["Content-Type"].startswith("text/event-stream")
        events = _parse_sse(await resp.read())
        kinds = [e for e, _ in events if e != "ping"]
        assert kinds == ["message_start", "content_block_start",
                        "content_block_delta", "content_block_stop",
                        "content_block_start", "content_block_delta",
                        "content_block_stop", "message_delta",
                        "message_stop"], kinds
        # upstream leg was NON-streaming (the whole point)
        assert seen["body"]["stream"] is False
        assert seen["path"] == "/v1/messages"
        # text reconstructs byte-perfect
        text = "".join(d["delta"]["text"] for e, d in events
                       if e == "content_block_delta"
                       and d["delta"].get("type") == "text_delta")
        assert text == "中文正文，多字节字符完好。"
        # tool_use input travels as one valid partial_json
        pj = next(d["delta"]["partial_json"] for e, d in events
                  if e == "content_block_delta"
                  and d["delta"].get("type") == "input_json_delta")
        assert json.loads(pj) == UPSTREAM_MSG["content"][1]["input"]
        # usage split across start/delta
        start = next(d for e, d in events if e == "message_start")
        assert start["message"]["usage"] == {"input_tokens": 321, "output_tokens": 0}
        md = next(d for e, d in events if e == "message_delta")
        assert md["usage"] == {"output_tokens": 54}
        assert md["delta"]["stop_reason"] == "tool_use"

    await _run_with_fake_upstream(upstream, exercise)
    print("OK  destream synthesizes a valid SSE sequence from a non-streaming turn")


async def test_destream_pings_while_upstream_is_slow():
    async def upstream(request):
        await request.json()
        await asyncio.sleep(0.25)
        return web.json_response(UPSTREAM_MSG)

    async def exercise(client):
        os.environ["KBC_DESTREAM_PING_SECONDS"] = "0.05"
        try:
            resp = await client.post("/v1/messages", json={"stream": True,
                                                           "messages": []})
            events = _parse_sse(await resp.read())
        finally:
            del os.environ["KBC_DESTREAM_PING_SECONDS"]
        pings = [e for e, _ in events if e == "ping"]
        assert pings, "expected keepalive pings while upstream was pending"
        assert events[-1][0] == "message_stop"

    await _run_with_fake_upstream(upstream, exercise)
    print("OK  destream keeps the client warm with pings while upstream runs")


async def test_destream_upstream_error_becomes_stream_error_event():
    async def upstream(request):
        return web.json_response(
            {"type": "error",
             "error": {"type": "rate_limit_error", "message": "slow down"}},
            status=429)

    async def exercise(client):
        resp = await client.post("/v1/messages", json={"stream": True,
                                                       "messages": []})
        assert resp.status == 200  # SSE already open; error rides the stream
        events = _parse_sse(await resp.read())
        ev, data = next((e, d) for e, d in events if e == "error")
        assert data["error"]["type"] == "rate_limit_error", data

    await _run_with_fake_upstream(upstream, exercise)
    print("OK  destream maps upstream HTTP errors to SSE error events")


async def test_non_stream_and_other_routes_pass_through_verbatim():
    async def upstream(request):
        if request.path.endswith("/models"):
            return web.Response(body=b'{"data":[{"id":"claude-opus-4-6"}]}',
                                content_type="application/json")
        body = await request.read()
        return web.Response(body=body, content_type="application/octet-stream")

    async def exercise(client):
        r1 = await client.get("/v1/models")
        assert json.loads(await r1.read())["data"][0]["id"] == "claude-opus-4-6"
        payload = json.dumps({"stream": False, "messages": []}).encode()
        r2 = await client.post("/v1/messages", data=payload,
                               headers={"Content-Type": "application/json"})
        assert await r2.read() == payload  # untouched bytes, no synthesis

    await _run_with_fake_upstream(upstream, exercise)
    print("OK  non-streaming posts and other routes pass through as raw bytes")


def test_maybe_activate_env_logic():
    destream._PORT = 45678
    shim = "http://127.0.0.1:45678"
    env_backup = {k: os.environ.get(k) for k in
                  ("KBC_DESTREAM", "KBC_ENGINE", "ANTHROPIC_BASE_URL")}
    try:
        os.environ["ANTHROPIC_BASE_URL"] = "https://api.example/model-api"
        os.environ["KBC_DESTREAM"] = "1"
        os.environ.pop("KBC_ENGINE", None)
        destream.maybe_activate()
        assert os.environ["ANTHROPIC_BASE_URL"] == shim
        assert destream._UPSTREAM == "https://api.example/model-api"
        destream.maybe_activate()  # idempotent: shim url is not re-captured
        assert destream._UPSTREAM == "https://api.example/model-api"
        os.environ["KBC_DESTREAM"] = "0"
        destream.maybe_activate()  # opt-out restores the real upstream
        assert os.environ["ANTHROPIC_BASE_URL"] == "https://api.example/model-api"
        os.environ["KBC_DESTREAM"] = "1"
        os.environ["KBC_ENGINE"] = "codex_sdk"
        destream.maybe_activate()  # codex engine is out of scope
        assert os.environ["ANTHROPIC_BASE_URL"] == "https://api.example/model-api"
    finally:
        destream._PORT = None
        destream._UPSTREAM = None
        for k, v in env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    print("OK  maybe_activate: opt-in rewrites, opt-out restores, codex untouched")


if __name__ == "__main__":
    test_maybe_activate_env_logic()
    for fn in (test_destream_synthesizes_valid_sse,
               test_destream_pings_while_upstream_is_slow,
               test_destream_upstream_error_becomes_stream_error_event,
               test_non_stream_and_other_routes_pass_through_verbatim):
        asyncio.run(fn())
