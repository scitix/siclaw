"""In-pod de-streaming shim for the Anthropic Messages route (charset fix).

massapi's Anthropic-compatible STREAMING route corrupts multibyte characters
whose bytes straddle an SSE chunk boundary (the gateway decodes each chunk
independently with errors=replace → U+FFFD); its NON-streaming route returns
the same bytes intact (gateway bug report, 2026-07). The compile box is
non-interactive — nobody reads its model output token-by-token — so it can
trade streaming latency for byte-correct text. The CLI (Claude Code) has no
non-streaming switch, hence a localhost shim:

    CLI --stream:true--> 127.0.0.1 shim --stream:false--> upstream gateway
                         <-- synthesized SSE (+ pings while waiting) --

Scope: only POST .../v1/messages bodies with "stream": true are de-streamed.
Everything else (count_tokens, models, non-streaming posts) passes through
verbatim as RAW BYTES — the shim must never introduce a decode step of its
own. Activation is DEFAULT-ON and session-scoped in the binary (no deployment
config): authoring/batch/planner/verify sessions get the shim via per-session
CLI env, TEST sessions always keep true streaming for interactive UX, the
codex/OpenAI route is untouched, and KBC_DESTREAM=0/off is the operator
escape hatch (e.g. once the gateway ships cross-chunk incremental decoding).
Blast radius is this container image only: the shim binds 127.0.0.1 inside
the siclaw-kbc-box pod; runtime/agentbox/sicore LLM callers never see it.
"""

from __future__ import annotations

import asyncio
import json
import os

import aiohttp
from aiohttp import web

_PORT: int | None = None
_UPSTREAM: str | None = None
_HOP_BY_HOP = {"host", "content-length", "connection", "transfer-encoding",
               "keep-alive", "upgrade", "te", "trailers", "proxy-authorization"}


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "on", "yes")


def _ping_seconds() -> float:
    return float(os.environ.get("KBC_DESTREAM_PING_SECONDS", "15"))


def _upstream_timeout() -> float:
    # A single non-streaming turn can legitimately run for minutes; the ping
    # task keeps the CLIENT side warm while this governs the upstream leg.
    return float(os.environ.get("KBC_DESTREAM_TIMEOUT", "3600"))


def _explicitly_off() -> bool:
    return (os.environ.get("KBC_DESTREAM") or "").strip().lower() in (
        "0", "off", "false", "no")


def enabled() -> bool:
    """Default ON for the Anthropic engine — the corruption is a standing
    gateway bug and the compile box is non-interactive, so byte-correct text
    is the right default. KBC_DESTREAM=0/off is the operator escape hatch
    (e.g. after the gateway ships cross-chunk decoding). Codex/OpenAI routes
    are out of scope."""
    if _PORT is None or _explicitly_off():
        return False
    if os.environ.get("KBC_ENGINE", "claude_agent_sdk") == "codex_sdk":
        return False
    return bool(_UPSTREAM or os.environ.get("ANTHROPIC_BASE_URL"))


def session_env(kind: str) -> dict:
    """Per-session CLI env override (merged over the inherited environment by
    the SDK). Authoring/verify sessions are non-interactive → de-streamed;
    TEST sessions keep true streaming for interactive UX and always get {}."""
    if kind not in ("authoring", "verify") or not enabled():
        return {}
    return {"ANTHROPIC_BASE_URL": f"http://127.0.0.1:{_PORT}"}


def model_idle_floor() -> float:
    """De-streamed turns emit no SDK deltas until the request completes, so
    the fine-grained stall watchdog would false-kill any generation longer
    than its idle bound. When the shim is active the idle bound must cover a
    whole model request; black-hole reaping degrades from seconds to this
    bound — the honest price of the charset fix, still far under the CLI's
    own ~60min request timeout."""
    if not enabled():
        return 0.0
    return float(os.environ.get("KBC_DESTREAM_MODEL_IDLE_TIMEOUT_S", "900"))


def _upstream_url() -> str | None:
    """Resolved per request: the box's own environment keeps pointing at the
    REAL gateway (only CLI child processes get the shim URL), so no global
    rewrite/restore bookkeeping is needed."""
    if _UPSTREAM:
        return _UPSTREAM
    base = os.environ.get("ANTHROPIC_BASE_URL")
    if base and _PORT is not None and f"127.0.0.1:{_PORT}" in base:
        return None  # self-loop guard
    return base or None


def _fwd_headers(request: web.Request) -> dict:
    return {k: v for k, v in request.headers.items()
            if k.lower() not in _HOP_BY_HOP}


def _sse(event: str, obj: dict) -> bytes:
    return (f"event: {event}\ndata: "
            + json.dumps(obj, ensure_ascii=False)
            + "\n\n").encode("utf-8")


def synth_events(msg: dict) -> list[bytes]:
    """A complete (non-streaming) Message → the standard SSE event sequence.
    Whole-block deltas are valid SSE; the CLI accumulates them the same way."""
    usage = msg.get("usage") or {}
    head = dict(msg)
    head["content"] = []
    head["stop_reason"] = None
    head["stop_sequence"] = None
    head["usage"] = {"input_tokens": usage.get("input_tokens", 0),
                     "output_tokens": 0}
    out = [_sse("message_start", {"type": "message_start", "message": head})]
    for i, block in enumerate(msg.get("content") or []):
        btype = block.get("type")
        if btype == "text":
            start = {"type": "text", "text": ""}
            deltas = [{"type": "text_delta", "text": block.get("text", "")}]
        elif btype == "tool_use":
            start = {"type": "tool_use", "id": block.get("id"),
                     "name": block.get("name"), "input": {}}
            deltas = [{"type": "input_json_delta",
                       "partial_json": json.dumps(block.get("input") or {},
                                                  ensure_ascii=False)}]
        elif btype == "thinking":
            start = {"type": "thinking", "thinking": ""}
            deltas = [{"type": "thinking_delta",
                       "thinking": block.get("thinking", "")}]
            if block.get("signature"):
                deltas.append({"type": "signature_delta",
                               "signature": block["signature"]})
        else:
            start, deltas = dict(block), []  # unknown: ship whole, no delta
        out.append(_sse("content_block_start",
                        {"type": "content_block_start", "index": i,
                         "content_block": start}))
        for d in deltas:
            out.append(_sse("content_block_delta",
                            {"type": "content_block_delta", "index": i,
                             "delta": d}))
        out.append(_sse("content_block_stop",
                        {"type": "content_block_stop", "index": i}))
    out.append(_sse("message_delta",
                    {"type": "message_delta",
                     "delta": {"stop_reason": msg.get("stop_reason"),
                               "stop_sequence": msg.get("stop_sequence")},
                     "usage": {"output_tokens": usage.get("output_tokens", 0)}}))
    out.append(_sse("message_stop", {"type": "message_stop"}))
    return out


async def _destream_messages(request: web.Request, body: dict) -> web.StreamResponse:
    resp = web.StreamResponse(status=200, headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
    })
    await resp.prepare(request)

    async def _pings():
        while True:
            await asyncio.sleep(_ping_seconds())
            await resp.write(_sse("ping", {"type": "ping"}))

    ping_task = asyncio.create_task(_pings())
    try:
        url = (_upstream_url() or "").rstrip("/") + request.path_qs
        timeout = aiohttp.ClientTimeout(total=_upstream_timeout())
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json={**body, "stream": False},
                                    headers=_fwd_headers(request)) as up:
                raw = await up.read()
        ping_task.cancel()
        if not (200 <= (up.status or 0) < 300):
            try:
                err = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                err = {"type": "error",
                       "error": {"type": "api_error",
                                 "message": raw[:500].decode("utf-8", "replace")}}
            await resp.write(_sse("error", err if err.get("type") == "error"
                                  else {"type": "error", "error": err}))
            return resp
        for chunk in synth_events(json.loads(raw)):
            await resp.write(chunk)
        return resp
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # network/parse: surface as a stream error event
        await resp.write(_sse("error", {
            "type": "error",
            "error": {"type": "api_error", "message": f"destream shim: {exc!r}"}}))
        return resp
    finally:
        ping_task.cancel()


async def _passthrough(request: web.Request, body_bytes: bytes) -> web.StreamResponse:
    """Verbatim relay, RAW BYTES both ways — never decode here."""
    url = (_upstream_url() or "").rstrip("/") + request.path_qs
    timeout = aiohttp.ClientTimeout(total=_upstream_timeout())
    async with aiohttp.ClientSession(timeout=timeout, auto_decompress=False) as session:
        async with session.request(request.method, url, data=body_bytes,
                                   headers=_fwd_headers(request)) as up:
            headers = {k: v for k, v in up.headers.items()
                       if k.lower() not in _HOP_BY_HOP}
            resp = web.StreamResponse(status=up.status, headers=headers)
            await resp.prepare(request)
            async for chunk in up.content.iter_chunked(65536):
                await resp.write(chunk)
            return resp


async def _handle(request: web.Request) -> web.StreamResponse:
    if not _upstream_url():
        return web.json_response(
            {"type": "error",
             "error": {"type": "api_error",
                       "message": "destream shim: no upstream configured"}},
            status=502)
    body_bytes = await request.read()
    if request.method == "POST" and request.path.rstrip("/").endswith("/messages"):
        try:
            body = json.loads(body_bytes)
        except (ValueError, UnicodeDecodeError):
            body = None
        if isinstance(body, dict) and body.get("stream"):
            return await _destream_messages(request, body)
    return await _passthrough(request, body_bytes)


async def start(app: web.Application) -> None:
    """on_startup hook: bind the shim on an ephemeral localhost port. Costs one
    idle listener when the profile never opts in."""
    global _PORT
    shim = web.Application(client_max_size=64 * 1024 * 1024)
    shim.router.add_route("*", "/{tail:.*}", _handle)
    runner = web.AppRunner(shim)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    _PORT = site._server.sockets[0].getsockname()[1]
    app["_destream_runner"] = runner
    app.on_shutdown.append(lambda _app: runner.cleanup())
