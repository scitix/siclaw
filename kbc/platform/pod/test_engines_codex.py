#!/usr/bin/env python3
"""Codex engine adapter tests — a FAKE codex binary (no LLM, no real CLI):
auth materialization invariants, config.toml/AGENTS.md assembly, exec --json
event mapping + resume threading, wall-clock guardrail, the tool-callback
listener, the stdio MCP server protocol, and the driver e2e on KBC_ENGINE=codex.

跑:platform/pod/.venv/bin/python platform/pod/test_engines_codex.py
(stdlib + aiohttp only — no claude-agent-sdk, no codex CLI needed)
"""
import asyncio
import base64
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import compile_box
import compile_tools
from engines.base import SessionSpec
from engines.codex import CodexEngineSession

# ── fake codex binary ──
# Records every invocation (argv / stdin / CODEX_HOME) to $KBC_FAKE_RECORD as
# JSONL, then behaves per $KBC_FAKE_MODE: ok → a happy JSONL turn; fail → exit 3
# with stderr; hang → sleep past any test timeout.
_FAKE_BIN = r'''#!/usr/bin/env python3
import json, os, sys, time
rec = {"argv": sys.argv[1:], "stdin": sys.stdin.read(), "codex_home": os.environ.get("CODEX_HOME", "")}
with open(os.environ["KBC_FAKE_RECORD"], "a") as f:
    f.write(json.dumps(rec) + "\n")
mode = os.environ.get("KBC_FAKE_MODE", "ok")
if mode == "fail":
    sys.stderr.write("boom: subscription quota exhausted (429)\n")
    sys.exit(3)
if mode == "hang":
    time.sleep(30)
    sys.exit(0)
print(json.dumps({"type": "thread.started", "thread_id": "t-fake-1"}))
print(json.dumps({"type": "item.completed", "item": {"item_type": "agent_message", "text": "hello from codex"}}))
print("this line is not JSON and must be ignored")
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}))
'''


def _install_fake_bin(td: Path) -> Path:
    p = td / "codex"
    p.write_text(_FAKE_BIN)
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return p


def _spec(td: Path, events: list, prompt="role text") -> SessionSpec:
    async def emit(ev):
        events.append(ev)
    return SessionSpec(kind="compile", cwd=str(td), system_prompt=prompt,
                       session_id="sid-cx", emit=emit, workdir=str(td))


async def _collect_turn(engine, timeout=5.0) -> list:
    """Drain engine events until (and including) the next turn_end."""
    out = []
    gen = engine.events()
    while True:
        ev = await asyncio.wait_for(gen.__anext__(), timeout)
        out.append(ev)
        if ev["type"] == "turn_end":
            return out


def _env(record: Path, bin_path: Path, **extra):
    base = {
        "KBC_CODEX_BIN": str(bin_path),
        "KBC_FAKE_RECORD": str(record),
        "CODEX_ACCESS_TOKEN": "at-test-token",
        "CODEX_ACCOUNT_ID": "acct-1",
    }
    base.update(extra)
    return base


class _EnvPatch:
    def __init__(self, mapping):
        self.mapping = mapping
        self.saved = {}

    def __enter__(self):
        for k, v in self.mapping.items():
            self.saved[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def __exit__(self, *a):
        for k, old in self.saved.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old


async def test_start_materializes_auth_config_agents():
    """start() writes auth.json with an EMPTY refresh_token (the box must never
    rotate the subscription's refresh token — sicore is the single refresher),
    config.toml declaring the compile MCP server + callback wiring, and the
    standing role into <cwd>/AGENTS.md."""
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        events = []
        with _EnvPatch(_env(td / "rec.jsonl", bin_path)):
            engine = CodexEngineSession(_spec(td, events, prompt="ROLE-MARKER content"))
            await engine.start()
            try:
                home = td / ".codex"
                auth = json.loads((home / "auth.json").read_text())
                assert auth["auth_mode"] == "chatgpt", auth
                assert auth["tokens"]["access_token"] == "at-test-token"
                assert auth["tokens"]["refresh_token"] == "", "box must hold NO refresh token"
                assert auth["tokens"]["account_id"] == "acct-1"
                assert auth["last_refresh"], "last_refresh=now suppresses proactive refresh"
                mode = (home / "auth.json").stat().st_mode
                assert not (mode & 0o077), f"auth.json must be 0600, got {oct(mode)}"

                cfg = (home / "config.toml").read_text()
                assert "[mcp_servers.compile]" in cfg and "mcp_compile_server.py" in cfg, cfg
                assert engine.callback_url in cfg and engine._callback_token in cfg, cfg

                agents = (td / "AGENTS.md").read_text()
                assert "ROLE-MARKER content" in agents
            finally:
                await engine.close()
    print("✓ codex start(): auth.json (no refresh token, 0600) + config.toml + AGENTS.md")


async def test_no_credentials_fails_loudly():
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        events = []
        with _EnvPatch({**_env(td / "r.jsonl", bin_path), "CODEX_ACCESS_TOKEN": None, "CODEX_API_KEY": None}):
            engine = CodexEngineSession(_spec(td, events))
            try:
                await engine.start()
                assert False, "expected RuntimeError (no credentials)"
            except RuntimeError as e:
                assert "CODEX_ACCESS_TOKEN" in str(e)
    print("✓ codex start() without credentials fails loudly (boundary validation)")


async def test_api_key_wins_over_subscription():
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        events = []
        with _EnvPatch({**_env(td / "r.jsonl", bin_path), "CODEX_API_KEY": "sk-test"}):
            engine = CodexEngineSession(_spec(td, events))
            await engine.start()
            try:
                auth = json.loads((td / ".codex" / "auth.json").read_text())
                assert auth["auth_mode"] == "apikey" and auth["OPENAI_API_KEY"] == "sk-test", auth
            finally:
                await engine.close()
    print("✓ CODEX_API_KEY wins over the subscription token (official automation path)")


async def test_turn_event_mapping_and_resume():
    """One query = one subprocess turn: JSONL maps to text/turn_end (non-JSON
    lines ignored); the second query resumes the SAME thread with the prompt on
    stdin; CODEX_HOME points at the session home."""
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        record = td / "rec.jsonl"
        events = []
        with _EnvPatch(_env(record, bin_path)):
            engine = CodexEngineSession(_spec(td, events))
            await engine.start()
            try:
                await engine.query("first prompt")
                evs = await _collect_turn(engine)
                assert [e["type"] for e in evs] == ["text", "turn_end"], evs
                assert evs[0]["text"] == "hello from codex"

                await engine.query("second prompt")
                await _collect_turn(engine)

                recs = [json.loads(x) for x in record.read_text().splitlines()]
                assert len(recs) == 2, recs
                assert recs[0]["stdin"] == "first prompt" and "resume" not in recs[0]["argv"]
                assert "--json" in recs[0]["argv"] and "--skip-git-repo-check" in recs[0]["argv"]
                assert recs[0]["codex_home"] == str(td / ".codex")
                # turn 2 resumes the thread announced by turn 1
                i = recs[1]["argv"].index("resume")
                assert recs[1]["argv"][i + 1] == "t-fake-1", recs[1]["argv"]
                assert recs[1]["stdin"] == "second prompt"
            finally:
                await engine.close()
    print("✓ codex turn: JSONL→text/turn_end mapping, stdin prompt, thread resume")


async def test_turn_failure_surfaces_error_and_closes_turn():
    """A nonzero codex exit surfaces as an explicit error event (stderr tail —
    e.g. a 429 quota hit must be VISIBLE, never silently retried) and the turn
    still closes (never-stuck)."""
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        events = []
        with _EnvPatch({**_env(td / "r.jsonl", bin_path), "KBC_FAKE_MODE": "fail"}):
            engine = CodexEngineSession(_spec(td, events))
            await engine.start()
            try:
                await engine.query("go")
                evs = await _collect_turn(engine)
                assert evs[-1]["type"] == "turn_end"
                err = next(e for e in evs if e["type"] == "error")
                assert "exited 3" in err["error"] and "quota" in err["error"], err
            finally:
                await engine.close()
    print("✓ codex failure: explicit error event (stderr surfaced) + turn still closes")


async def test_turn_timeout_guardrail():
    """max_turns has no codex equivalent — the driver-level wall-clock guardrail
    kills a runaway turn, reports it, and closes the turn."""
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        events = []
        with _EnvPatch({**_env(td / "r.jsonl", bin_path), "KBC_FAKE_MODE": "hang",
                        "KBC_CODEX_TURN_TIMEOUT_SECS": "0.3"}):
            engine = CodexEngineSession(_spec(td, events))
            await engine.start()
            try:
                await engine.query("go")
                evs = await _collect_turn(engine, timeout=5.0)
                assert evs[-1]["type"] == "turn_end"
                err = next(e for e in evs if e["type"] == "error")
                assert "wall-clock guardrail" in err["error"], err
            finally:
                await engine.close()
    print("✓ codex wall-clock guardrail: runaway turn killed + reported + turn closed")


async def test_tool_callback_listener():
    """The loopback callback runs the engine-neutral tool bodies with the run's
    emit; a bad token is refused; an unknown tool is a 400."""
    import aiohttp
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        events = []
        with _EnvPatch(_env(td / "r.jsonl", bin_path)):
            engine = CodexEngineSession(_spec(td, events))
            await engine.start()
            try:
                async with aiohttp.ClientSession() as http:
                    hdr = {"x-kbc-token": engine._callback_token}
                    r = await http.post(engine.callback_url, headers=hdr,
                                        json={"name": "report_summary", "arguments": {"summary": "hi"}})
                    assert r.status == 200 and (await r.json())["text"] == "summary recorded"
                    assert events and events[-1] == {"type": "summary", "summary": "hi"}

                    r = await http.post(engine.callback_url, headers={"x-kbc-token": "wrong"},
                                        json={"name": "report_summary", "arguments": {}})
                    assert r.status == 403, r.status

                    r = await http.post(engine.callback_url, headers=hdr,
                                        json={"name": "nope", "arguments": {}})
                    assert r.status == 400, r.status
            finally:
                await engine.close()
    print("✓ tool callback: same bodies + emit as claude; token-gated; unknown tool 400")


async def test_mcp_compile_server_stdio():
    """The stdio MCP server speaks newline JSON-RPC (initialize / tools/list /
    tools/call), forwards tools/call to the box callback, and surfaces callback
    failures as isError results (to the MODEL, not as protocol crashes)."""
    calls = []

    async def stub(request: web.Request):
        body = await request.json()
        calls.append(body)
        if body["name"] == "explode":
            return web.json_response({"error": "no such tool"}, status=400)
        return web.json_response({"text": f"pong:{body['arguments'].get('summary', '')}"})

    app = web.Application()
    app.add_routes([web.post("/tool-call", stub)])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    env = dict(os.environ)
    env["KBC_COMPILE_CALLBACK_URL"] = f"http://127.0.0.1:{port}/tool-call"
    env["KBC_COMPILE_CALLBACK_TOKEN"] = "tok"
    server_py = Path(__file__).resolve().parent / "mcp_compile_server.py"
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(server_py), env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)

    async def rpc(payload):
        proc.stdin.write((json.dumps(payload) + "\n").encode())
        await proc.stdin.drain()
        line = await asyncio.wait_for(proc.stdout.readline(), 5)
        return json.loads(line)

    try:
        r = await rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2025-03-26"}})
        assert r["result"]["serverInfo"]["name"] == "kbc-compile", r

        r = await rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [t["name"] for t in r["result"]["tools"]]
        assert names == [t["name"] for t in compile_tools.TOOL_SPECS], names
        schema = r["result"]["tools"][0]["inputSchema"]
        assert schema["type"] == "object" and "summary" in schema["properties"], schema

        r = await rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                       "params": {"name": "report_summary", "arguments": {"summary": "s1"}}})
        assert r["result"]["isError"] is False
        assert r["result"]["content"][0]["text"] == "pong:s1", r
        assert calls[-1] == {"name": "report_summary", "arguments": {"summary": "s1"}}

        r = await rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                       "params": {"name": "explode", "arguments": {}}})
        assert r["result"]["isError"] is True and "failed" in r["result"]["content"][0]["text"], r
    finally:
        proc.stdin.close()
        await proc.wait()
        await runner.cleanup()
    print("✓ mcp_compile_server: initialize/tools list+call over stdio; callback errors → isError")


async def test_run_session_e2e_on_codex_engine():
    """Full driver on KBC_ENGINE=codex: run_session announces the session, a
    /message-shaped query drives one codex subprocess turn, and the box emits
    log + turn_done exactly like the claude engine (same wire contract)."""
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        bin_path = _install_fake_bin(td)
        with _EnvPatch({**_env(td / "r.jsonl", bin_path), "KBC_ENGINE": "codex"}):
            run = compile_box.CompileRun("cx-e2e", str(td), 1, instruction="e2e")
            run.locale = "zh"  # exercise the zh box_role pack (asserted below)
            task = asyncio.create_task(compile_box.run_session(run))
            try:
                await asyncio.wait_for(run.connected.wait(), 5)
                assert run.client is not None, "engine session must be live"
                assert "authoring 助手" in (td / "AGENTS.md").read_text(), "BOX_ROLE must ride AGENTS.md"
                await run.client.query("开始编译")
                evs = []
                while True:
                    ev = await asyncio.wait_for(run.events.get(), 5)
                    evs.append(ev)
                    if ev["type"] == "turn_done":
                        break
                types = [e["type"] for e in evs]
                assert "session" in types and "log" in types, types
                assert evs[-1]["text"] == "hello from codex", evs[-1]
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
    print("✓ run_session e2e on codex: session/log/turn_done — same wire contract as claude")


async def test_open_test_session_refused_on_codex():
    """POST /test-session on a codex box → 501 (C4 read confinement has no codex
    equivalent; the structural kb-test box is the P4 slice)."""
    with _EnvPatch({"KBC_ENGINE": "codex"}):
        compile_box.RUNS.clear()
        client = TestClient(TestServer(compile_box.build_app()))
        await client.start_server()
        try:
            with tempfile.TemporaryDirectory() as wd:
                compile_box.RUNS["p1"] = compile_box.CompileRun("p1", wd, 1)
                r = await client.post("/test-session/p1")
                assert r.status == 501, await r.text()
                assert "codex" in (await r.json())["error"]
        finally:
            await client.close()
            compile_box.RUNS.clear()
    print("✓ /test-session on codex engine → 501 (refuse > silently unguarded)")


def _tiny_pdf() -> bytes:
    """A minimal one-page PDF, hand-assembled (no deps)."""
    objs = [
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for o in objs:
        offsets.append(out.tell())
        out.write(o)
    xref = out.tell()
    out.write(b"xref\n0 4\n0000000000 65535 f \n")
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(b"trailer<</Size 4/Root 1 0 R>>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
    return out.getvalue()


async def test_pdf_render_transform():
    """KBC_RENDER_PDF_PAGES=1 → /sources renders raw PDFs to <file>.pages/*.png
    (skipped when pypdfium2 is absent — the codex image installs it); with the
    flag OFF the install result is untouched (claude-path zero change)."""
    def make_bundle(files):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for name, data in files.items():
                payload = data if isinstance(data, bytes) else data.encode()
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                tf.addfile(info, io.BytesIO(payload))
        return buf.getvalue()

    bundle = make_bundle({"doc.pdf": _tiny_pdf(), "note.md": "hello\n"})

    # flag OFF (default): no render keys in the result — claude path unchanged
    with tempfile.TemporaryDirectory() as td:
        with _EnvPatch({"KBC_RENDER_PDF_PAGES": None}):
            res = compile_box._install_source_bundle(bundle, td)
            assert "pdf_pages_rendered" not in res, res
            assert not list(Path(td).rglob("*.pages")), "no renders when the flag is off"

    try:
        import pypdfium2  # noqa: F401
    except ImportError:
        print("~ pdf render transform: pypdfium2 not installed here — flag-off path verified, render skipped")
        return

    with tempfile.TemporaryDirectory() as td:
        with _EnvPatch({"KBC_RENDER_PDF_PAGES": "1"}):
            res = compile_box._install_source_bundle(bundle, td)
            assert res["pdf_pages_rendered"] == 1, res
            page = Path(td) / "raw" / "doc.pdf.pages" / "page-001.png"
            assert page.is_file() and page.stat().st_size > 0
    print("✓ pdf render transform: gated by env, pages rendered beside the source")


async def main():
    await test_start_materializes_auth_config_agents()
    await test_no_credentials_fails_loudly()
    await test_api_key_wins_over_subscription()
    await test_turn_event_mapping_and_resume()
    await test_turn_failure_surfaces_error_and_closes_turn()
    await test_turn_timeout_guardrail()
    await test_tool_callback_listener()
    await test_mcp_compile_server_stdio()
    await test_run_session_e2e_on_codex_engine()
    await test_open_test_session_refused_on_codex()
    await test_pdf_render_transform()
    print("ALL OK  test_engines_codex")


if __name__ == "__main__":
    asyncio.run(main())
