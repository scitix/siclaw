"""Tests for the in-pod de-streaming shim (destream.py)."""

import asyncio
import json
import os
from pathlib import Path

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


def test_default_on_session_scoped_activation():
    """v2 semantics: default ON for non-interactive Anthropic sessions with no
    deployment config; TEST sessions always stream; codex untouched; KBC_DESTREAM
    stays as the operator opt-out escape hatch."""
    env_backup = {k: os.environ.get(k) for k in
                  ("KBC_DESTREAM", "KBC_ENGINE", "ANTHROPIC_BASE_URL")}
    destream._PORT = 45678
    shim = {"ANTHROPIC_BASE_URL": "http://127.0.0.1:45678"}
    try:
        os.environ["ANTHROPIC_BASE_URL"] = "https://api.example/model-api"
        os.environ.pop("KBC_DESTREAM", None)
        os.environ.pop("KBC_ENGINE", None)
        # default ON, session-scoped
        assert destream.enabled()
        assert destream.session_env("authoring") == shim
        assert destream.session_env("verify") == shim
        assert destream.session_env("test") == {}          # interactive: never
        assert destream.model_idle_floor() == 900.0
        # the box's own environment is NOT rewritten (per-session env only)
        assert os.environ["ANTHROPIC_BASE_URL"] == "https://api.example/model-api"
        # operator opt-out
        os.environ["KBC_DESTREAM"] = "off"
        assert not destream.enabled()
        assert destream.session_env("authoring") == {}
        assert destream.model_idle_floor() == 0.0
        os.environ.pop("KBC_DESTREAM", None)
        # codex engine out of scope
        os.environ["KBC_ENGINE"] = "codex_sdk"
        assert not destream.enabled()
        os.environ.pop("KBC_ENGINE", None)
        # no shim listener -> off
        destream._PORT = None
        assert not destream.enabled()
    finally:
        destream._PORT = None
        destream._UPSTREAM = None
        for k, v in env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    print("OK  default-on session-scoped activation (test sessions stream, opt-out works)")


def test_verify_caller_opts_carry_shim():
    """Integration guard: the two non-interactive Claude reviewer sessions
    (test recommendation + reference-answer assist) must thread the de-stream
    shim into their SDK env, exactly like the authoring/verify entrypoints.
    Without it they keep hitting the streaming gateway and re-expose the
    cross-chunk charset corruption this PR fixes. Opt-out must clear it."""
    import tempfile
    import types

    import compile_box

    env_backup = {k: os.environ.get(k) for k in
                  ("KBC_DESTREAM", "KBC_ENGINE", "ANTHROPIC_BASE_URL")}
    destream._PORT = 45678
    shim = {"ANTHROPIC_BASE_URL": "http://127.0.0.1:45678"}
    try:
        os.environ["ANTHROPIC_BASE_URL"] = "https://api.example/model-api"
        os.environ.pop("KBC_DESTREAM", None)
        os.environ.pop("KBC_ENGINE", None)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            parent = types.SimpleNamespace(locale="en")

            rec_submit = compile_box._make_recommendation_submit_tool(root, parent, {})
            rec_opts = compile_box._recommendation_session_opts(parent, root, rec_submit)
            assert rec_opts.env == shim, rec_opts.env

            ref_submit, allowed = compile_box._make_reference_assist_submit_tool(
                root, parent, "polish", {})
            ref_opts = compile_box._reference_assist_session_opts(
                parent, root, ref_submit, allowed)
            assert ref_opts.env == shim, ref_opts.env

            # operator opt-out drops both back to true streaming (empty env)
            os.environ["KBC_DESTREAM"] = "off"
            assert compile_box._recommendation_session_opts(
                parent, root, rec_submit).env == {}
            assert compile_box._reference_assist_session_opts(
                parent, root, ref_submit, allowed).env == {}
    finally:
        destream._PORT = None
        destream._UPSTREAM = None
        for k, v in env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    print("OK  recommendation + reference-assist opts carry the shim env (opt-out clears it)")


def test_watchdog_floor_scoped_to_model_phase():
    """Integration guard for the stall watchdog: the de-stream idle floor lifts
    ONLY the model-request bound. A pending tool is local execution and must
    keep its own (shorter) bound, or a wedged tool would be reaped minutes
    late."""
    import compile_box

    tool_bound = compile_box._MODEL_TOOL_IDLE_TIMEOUT_S  # 660s default
    # tool pending: floor NEVER applies, even a large one
    assert compile_box._watchdog_idle_bound(True, 90.0, 900.0) == tool_bound
    assert compile_box._watchdog_idle_bound(True, 90.0, 0.0) == tool_bound
    # model phase: floor lifts the model bound when the shim is active
    assert compile_box._watchdog_idle_bound(False, 90.0, 900.0) == 900.0
    # model phase, shim off: bound is untouched
    assert compile_box._watchdog_idle_bound(False, 90.0, 0.0) == 90.0
    # floor never shrinks an already-larger model bound
    assert compile_box._watchdog_idle_bound(False, 1200.0, 900.0) == 1200.0
    print("OK  watchdog de-stream floor applies to the model bound only, never a pending tool")


if __name__ == "__main__":
    test_default_on_session_scoped_activation()
    test_verify_caller_opts_carry_shim()
    test_watchdog_floor_scoped_to_model_phase()
    for fn in (test_destream_synthesizes_valid_sse,
               test_destream_pings_while_upstream_is_slow,
               test_destream_upstream_error_becomes_stream_error_event,
               test_non_stream_and_other_routes_pass_through_verbatim):
        asyncio.run(fn())
