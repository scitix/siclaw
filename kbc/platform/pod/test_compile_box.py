#!/usr/bin/env python3
"""compile_box 协议冒烟:注入假编译驱动(不调 LLM),验 HTTP + SSE + park→rulings 全管线。

跑:platform/pod/.venv/bin/python platform/pod/test_compile_box.py
"""
import asyncio
import base64
import hashlib
import io
import json
import os
import shutil
import tarfile
import tempfile
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

import compile_box


async def fake_driver(run):
    """模拟编译:summary → parked(阻塞)→ 收到 rulings → done。不烧 LLM。"""
    assert "authoring/CLAUDE.md" in run.instruction, run.instruction
    await run.emit({"type": "summary", "summary": "read 2 docs, 1 conflict"})
    fut = asyncio.get_event_loop().create_future()
    run.pending_park = fut
    await run.emit({"type": "parked", "checkpoint": {
        "round": run.round,
        "contradictions": [{"id": "c1", "summary": "cap 100 vs 300", "evidence": [], "options": ["100", "300", "unsure"]}],
        "ledger_ref": run.ledger_ref,
    }})
    rulings = await fut
    run.pending_park = None
    assert rulings == [{"contradiction_id": "c1", "option_index": 1}], rulings
    run.done = True
    await run.emit({"type": "done", "bundle_b64": base64.b64encode(b"bundle").decode(), "bytes": 6})


async def fake_driver_writes_bundle_without_submit(run):
    """模拟 Claude 写好了 bundle/ 但忘了调用 submit_bundle。"""
    bdir = Path(run.workdir) / "bundle"
    bdir.mkdir(parents=True, exist_ok=True)
    (bdir / "index.md").write_text("# fallback bundle\n")
    await run.emit({"type": "summary", "summary": "bundle files written"})


async def read_until(resp, stop_type):
    events = []
    while True:
        raw = await resp.content.readline()
        if not raw:
            break
        line = raw.decode().strip()
        if not line or line.startswith(":"):  # blank / heartbeat comment
            continue
        if line.startswith("data:"):
            ev = json.loads(line[5:].strip())
            events.append(ev)
            if ev.get("type") == stop_type:
                break
    return events


def make_source_bundle(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, data in files.items():
            payload = data if isinstance(data, bytes) else data.encode()
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            tf.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


def deterministic_bytes(size):
    out = bytearray()
    i = 0
    while len(out) < size:
        out.extend(hashlib.sha256(str(i).encode()).digest())
        i += 1
    return bytes(out[:size])


async def test_workspace_sync():
    """B5: _collect_workspace_artifacts excludes raw/; _sync_workspace emits
    only changed files."""
    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "candidate").mkdir(parents=True)
        (wd / "eval").mkdir(parents=True)
        (wd / "raw").mkdir(parents=True)
        (wd / "candidate" / "01.md").write_text("# Overview\n")
        (wd / "eval" / "TESTS.md").write_text("# Tests\n")
        (wd / "raw" / "src.md").write_text("raw stays\n")  # raw must NOT sync

        paths = sorted(a["path"] for a in compile_box._collect_workspace_artifacts(str(wd)))
        assert paths == ["candidate/01.md", "eval/TESTS.md"], paths

        run = compile_box.CompileRun("sync-run", str(wd), 1)
        sent: dict = {}
        assert await compile_box._sync_workspace(run, sent) == 2
        ev = run.events.get_nowait()
        assert ev["type"] == "syncArtifacts" and len(ev["artifacts"]) == 2, ev
        # unchanged → no emit
        assert await compile_box._sync_workspace(run, sent) == 0 and run.events.empty()
        # one file changes → only it re-syncs
        (wd / "candidate" / "01.md").write_text("# Overview v2\n")
        assert await compile_box._sync_workspace(run, sent) == 1
        ev = run.events.get_nowait()
        assert [a["path"] for a in ev["artifacts"]] == ["candidate/01.md"], ev
    print("✓ workspace sync (B5)")


# Test doubles for the Agent SDK message stream. _emit_message dispatches on
# type(msg).__name__, so these MUST be named exactly like the SDK's classes.
class TextBlock:
    def __init__(self, text):
        self.text = text


class AssistantMessage:
    def __init__(self, text):
        self.content = [TextBlock(text)]


class ResultMessage:
    pass


class _FakeSDKClient:
    """Stands in for ClaudeSDKClient: records connect/query, yields preloaded
    messages then stops (the real client blocks for the next turn)."""
    last = None

    def __init__(self, options=None):
        self.options = options
        self.connected_prompt = None
        self.queries = []
        self._pending = []
        _FakeSDKClient.last = self

    async def connect(self, prompt=None):
        self.connected_prompt = prompt
        self._pending = [AssistantMessage("seed reply"), ResultMessage()]

    async def query(self, prompt, session_id="default"):
        self.queries.append(prompt)
        self._pending += [AssistantMessage("reply: " + prompt), ResultMessage()]

    async def receive_messages(self):
        while self._pending:
            yield self._pending.pop(0)

    async def disconnect(self):
        pass


async def test_compile_kickoff_session():
    """P1/P2.2: the compile path sets run.kickoff → run_session connects WITH the
    kickoff prompt and relays assistant text + turn_done (carrying the reply text)."""
    orig = compile_box.ClaudeSDKClient
    compile_box.ClaudeSDKClient = _FakeSDKClient
    try:
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.CompileRun("ps1", td, 1, instruction="authoring/CLAUDE.md present")
            run.kickoff = compile_box.BOX_COMPILE_TASK
            await compile_box.run_session(run)  # fake yields seed reply + result, then ends
            evs = []
            while not run.events.empty():
                evs.append(run.events.get_nowait())
            types = [e["type"] for e in evs]
            assert "session" in types and "log" in types and "turn_done" in types, types
            assert run.session_id, "session_id not set"
            assert _FakeSDKClient.last.connected_prompt == compile_box.BOX_COMPILE_TASK, "kickoff not sent on connect"
            turn = next(e for e in evs if e["type"] == "turn_done")
            assert turn.get("text") == "seed reply", turn
    finally:
        compile_box.ClaudeSDKClient = orig
    print("✓ compile kickoff session (P1/P2.2)")


async def test_conversational_session():
    """P2.2: a conversational session (no kickoff) connects WITHOUT a prompt and
    waits — a later /message (query) drives the turn that relays log + turn_done."""
    orig = compile_box.ClaudeSDKClient
    compile_box.ClaudeSDKClient = _FakeSDKClient
    try:
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.CompileRun("cs1", td, 1)
            # No kickoff → connect() with no prompt. Pre-load a queued turn so the
            # fake's receive_messages yields it (mirrors a /message arriving).
            client = _FakeSDKClient()
            await client.query("what should this KB cover?")  # queue one turn
            run.client = client
            run.session_id = "sid-cs1"
            await run.emit({"type": "session", "session_id": run.session_id})
            async for msg in client.receive_messages():
                await compile_box._emit_message(run, msg)
            evs = []
            while not run.events.empty():
                evs.append(run.events.get_nowait())
            types = [e["type"] for e in evs]
            assert "session" in types and "log" in types and "turn_done" in types, types
            turn = next(e for e in evs if e["type"] == "turn_done")
            assert turn.get("text") == "reply: what should this KB cover?", turn
    finally:
        compile_box.ClaudeSDKClient = orig
    print("✓ conversational session (P2.2)")


async def test_message_waits_for_connect():
    """P2.2 race fix: a /message that races ahead of the async connect() must wait
    for it, not hit the SDK's 'Not connected' (→500). 503 while still connecting,
    200 once connected, 409 if connect failed (event set but client None)."""
    os.environ["KBC_CONNECT_TIMEOUT_SECS"] = "0.3"
    compile_box.RUNS.clear()
    client = TestClient(TestServer(compile_box.build_app()))
    await client.start_server()
    try:
        # (a) run exists but still connecting (connected unset) → 503, not 500
        compile_box.RUNS["m-pending"] = compile_box.CompileRun("m-pending", "/tmp", 1)
        r = await client.post("/message/m-pending", json={"message": "hi"})
        assert r.status == 503, await r.text()

        # (b) connected + live client → 200 and the turn is injected
        class _C:
            def __init__(self):
                self.queries = []

            async def query(self, text, session_id="default"):
                self.queries.append(text)

        run_live = compile_box.CompileRun("m-live", "/tmp", 1)
        fake = _C()
        run_live.client = fake
        run_live.connected.set()
        compile_box.RUNS["m-live"] = run_live
        r = await client.post("/message/m-live", json={"message": "hello"})
        assert r.status == 200, await r.text()
        assert fake.queries == ["hello"], fake.queries

        # (c) connect failed: event set but client None → 409, not 500
        run_failed = compile_box.CompileRun("m-failed", "/tmp", 1)
        run_failed.connected.set()
        compile_box.RUNS["m-failed"] = run_failed
        r = await client.post("/message/m-failed", json={"message": "hi"})
        assert r.status == 409, await r.text()
    finally:
        await client.close()
        compile_box.RUNS.clear()
        os.environ.pop("KBC_CONNECT_TIMEOUT_SECS", None)
    print("✓ message waits for connect (P2.2 race fix)")


async def test_compile_turn_in_session():
    """P3: /compile-turn injects the box's own BOX_COMPILE_TASK as a turn into the
    live session (compile on the SAME box). 200 + query == BOX_COMPILE_TASK; an
    extra instruction is appended; unknown run → 404."""
    compile_box.RUNS.clear()
    client = TestClient(TestServer(compile_box.build_app()))
    await client.start_server()
    try:
        class _C:
            def __init__(self):
                self.queries = []

            async def query(self, text, session_id="default"):
                self.queries.append(text)

        run = compile_box.CompileRun("ct1", "/tmp", 1)
        fake = _C()
        run.client = fake
        run.connected.set()
        compile_box.RUNS["ct1"] = run

        r = await client.post("/compile-turn/ct1", json={})
        assert r.status == 200, await r.text()
        assert fake.queries and fake.queries[0] == compile_box.BOX_COMPILE_TASK, fake.queries

        r = await client.post("/compile-turn/ct1", json={"instruction": "focus on GPU triage"})
        assert r.status == 200, await r.text()
        assert fake.queries[1].startswith(compile_box.BOX_COMPILE_TASK) and "focus on GPU triage" in fake.queries[1]

        r = await client.post("/compile-turn/nope", json={})
        assert r.status == 404, await r.text()
    finally:
        await client.close()
        compile_box.RUNS.clear()
    print("✓ compile turn in session (P3)")


async def test_compile_turn_ends_clean():
    """Slice 2: a compile turn ends like any other turn (one ResultMessage → turn_done),
    with NO submit_bundle gate and NO nudging — so a live session can never get stuck
    'compiling'. The candidate pages it wrote are synced; the owner publishes separately."""
    orig = compile_box.ClaudeSDKClient
    compile_box.ClaudeSDKClient = _FakeSDKClient
    try:
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.CompileRun("ac1", td, 1)
            run.compiling = True  # simulate a /compile-turn in flight
            await compile_box.run_session(run)
            evs = []
            while not run.events.empty():
                evs.append(run.events.get_nowait())
            types = [e["type"] for e in evs]
            # the turn ended (turn_done), the compiling flag cleared, and NOTHING was
            # nudged or failed — a finished turn is simply finished.
            assert "turn_done" in types, types
            assert not any(e["type"] == "error" for e in evs), evs
            assert _FakeSDKClient.last.queries == [], _FakeSDKClient.last.queries
            assert run.compiling is False
    finally:
        compile_box.ClaudeSDKClient = orig
    print("✓ compile turn ends clean — no submit_bundle gate, no nudge (Slice 2)")


# ── 起测试会话 (read-only test session) ──

def test_pack_candidates_to_wiki():
    """_pack_candidates_to_wiki mirrors buildPublishBundleFromCandidates: candidate/
    prefix stripped, only .md|.json, root index.md required, content byte-identical —
    so the test session reads exactly what a publish would serve. Hash is stable."""
    with tempfile.TemporaryDirectory() as wd, tempfile.TemporaryDirectory() as dest_root:
        cand = Path(wd) / "candidate"
        (cand / "sub").mkdir(parents=True)
        (cand / "index.md").write_text("# index\n- [[roce-modes]]\n")
        (cand / "roce-modes.md").write_text("# roce modes\nbody\n")
        (cand / "meta.json").write_text('{"k":1}')
        (cand / "ignore.txt").write_text("not a wiki file")
        (cand / "sub" / "nested.md").write_text("# nested\n")
        dest = Path(dest_root) / "snap"
        h, pages = compile_box._pack_candidates_to_wiki(wd, dest)
        kdir = dest / ".siclaw" / "knowledge"
        # candidate/ stripped & rooted, byte-identical; .txt excluded; nesting kept
        assert (kdir / "index.md").read_text() == "# index\n- [[roce-modes]]\n"
        assert (kdir / "roce-modes.md").is_file()
        assert (kdir / "meta.json").read_text() == '{"k":1}'
        assert (kdir / "sub" / "nested.md").is_file()
        assert not (kdir / "ignore.txt").exists()
        assert pages == 4, pages
        assert len(h) == 64, h
        # deterministic: same draft → same hash
        dest2 = Path(dest_root) / "snap2"
        h2, _ = compile_box._pack_candidates_to_wiki(wd, dest2)
        assert h == h2, (h, h2)

    # no root index.md → error (cannot serve without an index)
    with tempfile.TemporaryDirectory() as wd, tempfile.TemporaryDirectory() as dr:
        (Path(wd) / "candidate").mkdir()
        (Path(wd) / "candidate" / "page.md").write_text("x")
        try:
            compile_box._pack_candidates_to_wiki(wd, Path(dr) / "s")
            assert False, "expected FileNotFoundError (no index)"
        except FileNotFoundError:
            pass
    # no candidate pages at all → error
    with tempfile.TemporaryDirectory() as wd, tempfile.TemporaryDirectory() as dr:
        try:
            compile_box._pack_candidates_to_wiki(wd, Path(dr) / "s")
            assert False, "expected FileNotFoundError (no pages)"
        except FileNotFoundError:
            pass
    print("✓ pack candidates to wiki (snapshot parity with publish)")


async def test_test_session_driver_readonly():
    """The read-only consumer driver configures Read/Glob/Grep ONLY (no Write/Edit/
    Bash, no MCP), cwd = the snapshot dir, persona = TEST_ROLE, no kickoff; it emits
    session + log + turn_done like the authoring session."""
    orig = compile_box.ClaudeSDKClient
    compile_box.ClaudeSDKClient = _FakeSDKClient
    try:
        with tempfile.TemporaryDirectory() as snap:
            run = compile_box.TestRun("t-drv", snap, parent_run_id="p1", snapshot_hash="h")
            await compile_box.test_session_driver(run)  # fake yields seed reply + result, then ends
            opts = _FakeSDKClient.last.options
            assert opts.allowed_tools == ["Read", "Glob", "Grep"], opts.allowed_tools
            assert "Write" not in opts.allowed_tools and "Bash" not in opts.allowed_tools
            assert opts.cwd == snap, opts.cwd
            assert opts.mcp_servers == {}, opts.mcp_servers
            assert compile_box.TEST_ROLE in opts.system_prompt["append"]
            assert _FakeSDKClient.last.connected_prompt is None, "test session must not kickoff"
            types = []
            while not run.events.empty():
                types.append(run.events.get_nowait()["type"])
            assert "session" in types and "log" in types and "turn_done" in types, types
            assert run.session_id
    finally:
        compile_box.ClaudeSDKClient = orig
    print("✓ test session driver is read-only (Read/Glob/Grep, no MCP, no kickoff)")


async def test_open_close_test_session_http():
    """POST /test-session pins the parent draft into a snapshot dir and starts a
    session (200 + hash + pages); unknown parent → 404; missing index.md → 400;
    concurrency cap → 429; close tears down (snapshot dir + registry entry gone)."""
    orig = compile_box.ClaudeSDKClient
    compile_box.ClaudeSDKClient = _FakeSDKClient
    compile_box.RUNS.clear()
    compile_box.TEST_SESSIONS.clear()
    snap_root = tempfile.mkdtemp()
    os.environ["KBC_TEST_SNAPSHOT_ROOT"] = snap_root
    client = TestClient(TestServer(compile_box.build_app()))
    await client.start_server()
    try:
        wd = tempfile.mkdtemp()
        cand = Path(wd) / "candidate"
        cand.mkdir()
        (cand / "index.md").write_text("# index\n")
        (cand / "p.md").write_text("# page\n")
        compile_box.RUNS["p1"] = compile_box.CompileRun("p1", wd, 1)

        # unknown parent run → 404
        assert (await client.post("/test-session/nope")).status == 404

        # open → 200 + snapshot materialized at .siclaw/knowledge/
        r = await client.post("/test-session/p1")
        assert r.status == 200, await r.text()
        body = await r.json()
        tid = body["test_session_id"]
        assert body["pages"] == 2 and len(body["snapshot_hash"]) == 64, body
        kidx = Path(snap_root) / tid / ".siclaw" / "knowledge" / "index.md"
        assert kidx.read_text() == "# index\n"

        # close → teardown removes the snapshot dir + registry entry
        assert (await client.post(f"/test-session/{tid}/close")).status == 200
        assert tid not in compile_box.TEST_SESSIONS
        assert not (Path(snap_root) / tid).exists()

        # concurrency cap → 429 (deterministic: a non-done stub occupies the only slot)
        os.environ["KBC_MAX_TEST_SESSIONS"] = "1"
        compile_box.TEST_SESSIONS["busy"] = compile_box.TestRun("busy", "/tmp/x", "p1", "h")
        assert (await client.post("/test-session/p1")).status == 429
        compile_box.TEST_SESSIONS.clear()
        os.environ.pop("KBC_MAX_TEST_SESSIONS", None)

        # parent draft with no root index.md → 400
        wd2 = tempfile.mkdtemp()
        (Path(wd2) / "candidate").mkdir()
        (Path(wd2) / "candidate" / "only.md").write_text("x")
        compile_box.RUNS["p2"] = compile_box.CompileRun("p2", wd2, 1)
        assert (await client.post("/test-session/p2")).status == 400
    finally:
        await client.close()
        compile_box.ClaudeSDKClient = orig
        compile_box.RUNS.clear()
        compile_box.TEST_SESSIONS.clear()
        os.environ.pop("KBC_TEST_SNAPSHOT_ROOT", None)
        os.environ.pop("KBC_MAX_TEST_SESSIONS", None)
        shutil.rmtree(snap_root, ignore_errors=True)
    print("✓ open/close test session over HTTP (snapshot pinned, cap, teardown)")


async def test_test_message_path():
    """/test-message injects a user turn into a LIVE test session (200 + query
    forwarded); an unknown test session → 404."""
    compile_box.TEST_SESSIONS.clear()
    client = TestClient(TestServer(compile_box.build_app()))
    await client.start_server()
    try:
        assert (await client.post("/test-message/nope", json={"message": "hi"})).status == 404

        class _C:
            def __init__(self):
                self.queries = []

            async def query(self, text, session_id="default"):
                self.queries.append(text)

        run = compile_box.TestRun("tm1", "/tmp", "p1", "h")
        fake = _C()
        run.client = fake
        run.connected.set()
        compile_box.TEST_SESSIONS["tm1"] = run
        r = await client.post("/test-message/tm1", json={"message": "what is roce?"})
        assert r.status == 200, await r.text()
        assert fake.queries == ["what is roce?"], fake.queries
    finally:
        await client.close()
        compile_box.TEST_SESSIONS.clear()
    print("✓ test-message injects a turn into a live test session")


async def main():
    await test_workspace_sync()
    await test_compile_kickoff_session()
    await test_conversational_session()
    await test_message_waits_for_connect()
    await test_compile_turn_in_session()
    await test_compile_turn_ends_clean()
    test_pack_candidates_to_wiki()
    await test_test_session_driver_readonly()
    await test_open_close_test_session_http()
    await test_test_message_path()

    compile_box._COMPILE_IMPL = fake_driver
    compile_box.RUNS.clear()

    client = TestClient(TestServer(compile_box.build_app()))
    await client.start_server()
    try:
        assert (await (await client.get("/health")).json())["status"] == "ok"

        with tempfile.TemporaryDirectory() as td:
            large_bundle = make_source_bundle({"large.bin": deterministic_bytes(2 * 1024 * 1024)})
            assert len(base64.b64encode(large_bundle)) > 1024 * 1024
            r = await client.post("/sources", json={
                "workdir": td,
                "bundle_base64": base64.b64encode(large_bundle).decode(),
            })
            assert r.status == 200, await r.text()
            assert (Path(td) / "raw" / "large.bin").stat().st_size == 2 * 1024 * 1024

        with tempfile.TemporaryDirectory() as td:
            bundle = make_source_bundle({"ops/readme.md": "hello raw\n", "policy.md": "cap 300\n"})
            sha = hashlib.sha256(bundle).hexdigest()
            r = await client.post("/sources", json={
                "run_id": "r1",
                "workdir": td,
                "bundle_base64": base64.b64encode(bundle).decode(),
                "bundle_sha256": sha,
            })
            assert r.status == 200, await r.text()
            source_resp = await r.json()
            assert source_resp["files"] == 2 and source_resp["bundle_sha256"] == sha, source_resp
            assert (Path(td) / "raw" / "ops" / "readme.md").read_text() == "hello raw\n"
            assert (Path(td) / "drop" / "ops" / "readme.md").read_text() == "hello raw\n"
            assert (Path(td) / "constitution.md").exists()

            authoring_bundle = make_source_bundle({
                "authoring/CLAUDE.md": "follow the workspace\n",
                "authoring/PLAN.md": "- [ ] compile runbook\n",
                "eval/TESTS.md": "# Tests\n",
            })
            authoring_sha = hashlib.sha256(authoring_bundle).hexdigest()
            r = await client.post("/authoring", json={
                "run_id": "r1",
                "workdir": td,
                "bundle_base64": base64.b64encode(authoring_bundle).decode(),
                "bundle_sha256": authoring_sha,
            })
            assert r.status == 200, await r.text()
            authoring_resp = await r.json()
            assert authoring_resp["files"] == 3 and authoring_resp["bundle_sha256"] == authoring_sha, authoring_resp
            assert (Path(td) / "authoring" / "CLAUDE.md").read_text() == "follow the workspace\n"
            assert (Path(td) / "eval" / "TESTS.md").read_text() == "# Tests\n"

            bad_authoring_bundle = make_source_bundle({"raw/nope.md": "nope"})
            r = await client.post("/authoring", json={
                "workdir": td,
                "bundle_base64": base64.b64encode(bad_authoring_bundle).decode(),
            })
            assert r.status == 400, await r.text()

            bad_bundle = make_source_bundle({"../evil.md": "nope"})
            r = await client.post("/sources", json={
                "workdir": td,
                "bundle_base64": base64.b64encode(bad_bundle).decode(),
            })
            assert r.status == 400, await r.text()

            r = await client.post("/compile", json={
                "run_id": "r1",
                "workdir": td,
                "instruction": "# KB Authoring Compile Task\n\n### authoring/CLAUDE.md\nfollow the workspace",
            })
            assert r.status == 200, await r.text()

            r = await client.post("/sources", json={
                "run_id": "r1",
                "workdir": td,
                "bundle_base64": base64.b64encode(bundle).decode(),
            })
            assert r.status == 409, r.status
            # /authoring IS allowed on a live run (200): the unified compile-in-session
            # path uploads authoring assets to the running session before /compile-turn.
            r = await client.post("/authoring", json={
                "run_id": "r1",
                "workdir": td,
                "bundle_base64": base64.b64encode(authoring_bundle).decode(),
            })
            assert r.status == 200, await r.text()

            sse = await client.get("/events/r1")
            phase1 = await read_until(sse, "parked")
            t1 = [e["type"] for e in phase1]
            assert "summary" in t1 and t1[-1] == "parked", t1
            cp = phase1[-1]["checkpoint"]
            assert cp["contradictions"][0]["id"] == "c1" and cp["round"] == 1, cp

            # /rulings while not parked is a 409 only AFTER we consume the park; test the happy path first.
            r = await client.post("/rulings", json={"run_id": "r1", "rulings": [{"contradiction_id": "c1", "option_index": 1}]})
            assert r.status == 200, await r.text()

            phase2 = await read_until(sse, "end")
            t2 = [e["type"] for e in phase2]
            assert "done" in t2 and t2[-1] == "end", t2
            done = next(e for e in phase2 if e["type"] == "done")
            assert base64.b64decode(done["bundle_b64"]) == b"bundle", done

        # rulings on a no-longer-parked run → 409
        r = await client.post("/rulings", json={"run_id": "r1", "rulings": []})
        assert r.status == 409, r.status
        # duplicate run id → 409
        r = await client.post("/compile", json={"run_id": "r1"})
        assert r.status == 409, r.status
        # unknown run events → 404
        r = await client.get("/events/nope")
        assert r.status == 404, r.status

        compile_box._COMPILE_IMPL = fake_driver_writes_bundle_without_submit
        with tempfile.TemporaryDirectory() as td:
            r = await client.post("/compile", json={"run_id": "r2", "workdir": td})
            assert r.status == 200, await r.text()
            sse = await client.get("/events/r2")
            events = await read_until(sse, "end")
            types = [e["type"] for e in events]
            assert "summary" in types and "done" in types and types[-1] == "end", types
            done = next(e for e in events if e["type"] == "done")
            assert done["bytes"] > 0, done

        print("OK  compile_box protocol smoke (sources / health / compile / SSE summary+parked / rulings / done+end / 409 / 404)")
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
