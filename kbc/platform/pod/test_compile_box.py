#!/usr/bin/env python3
"""compile_box 协议冒烟:注入假会话驱动(不调 LLM),验 HTTP + SSE 全管线
(sources/authoring 物化、持久会话、workspace 同步、只读测试会话)。

跑:platform/pod/.venv/bin/python platform/pod/test_compile_box.py
"""
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

import compile_box


async def fake_driver(run):
    """模拟一轮编译会话:summary → 写 candidate 页 → turn_done。不烧 LLM、永不阻塞
    (矛盾-as-turn 模型:没有 park、没有 rulings、没有 bundle 提交)。"""
    assert "authoring/CLAUDE.md" in run.instruction, run.instruction
    await run.emit({"type": "summary", "summary": "read 2 docs, wrote 1 page"})
    cand = Path(run.workdir) / "candidate"
    cand.mkdir(parents=True, exist_ok=True)
    (cand / "index.md").write_text("# smoke candidate\n")
    await run.emit({"type": "turn_done", "text": "compiled 1 page"})


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
        # deleted file → tombstone (page merge/rename must not leave orphan rows)
        (wd / "candidate" / "01.md").unlink()
        assert await compile_box._sync_workspace(run, sent) == 1
        ev = run.events.get_nowait()
        assert ev["artifacts"] == [{"path": "candidate/01.md", "deleted": True}], ev
        assert "candidate/01.md" not in sent
        # steady state after the tombstone → no re-emit
        assert await compile_box._sync_workspace(run, sent) == 0 and run.events.empty()
        # a file that becomes UNCOLLECTABLE (oversized) but still exists on disk
        # must NOT be tombstoned — deletion is judged by is_file(), not by
        # absence from the collection.
        (wd / "eval" / "TESTS.md").write_text("x" * (compile_box.MAX_SYNC_FILE_BYTES + 1))
        assert await compile_box._sync_workspace(run, sent) == 0 and run.events.empty()
        assert "eval/TESTS.md" in sent, "row kept: file exists, just oversized"
    print("✓ workspace sync (B5) + deletion tombstones")


def _drain_event_types(run) -> list:
    types = []
    while not run.events.empty():
        types.append(run.events.get_nowait()["type"])
    return types


async def test_run_wrapper_terminal_signals():
    """_run_wrapper's closing protocol: a CLEAN driver exit emits done→end (so
    the runtime terminalizes instead of leaving the run idle to 409 forever); a
    crash emits error→end with NO done; a cancellation emits neither (just end)
    and propagates."""
    orig = compile_box._COMPILE_IMPL
    try:
        with tempfile.TemporaryDirectory() as td:
            async def clean(run):
                return None
            compile_box._COMPILE_IMPL = clean
            run = compile_box.CompileRun("wrap-clean", td, 1)
            await compile_box._run_wrapper(run)
            types = _drain_event_types(run)
            assert types[-2:] == ["done", "end"], types

            async def boom(run):
                raise RuntimeError("boom")
            compile_box._COMPILE_IMPL = boom
            run = compile_box.CompileRun("wrap-boom", td, 1)
            await compile_box._run_wrapper(run)
            types = _drain_event_types(run)
            assert "error" in types and "done" not in types and types[-1] == "end", types

            async def cancelled(run):
                raise asyncio.CancelledError()
            compile_box._COMPILE_IMPL = cancelled
            run = compile_box.CompileRun("wrap-cancel", td, 1)
            try:
                await compile_box._run_wrapper(run)
                raise AssertionError("CancelledError should propagate")
            except asyncio.CancelledError:
                pass
            types = _drain_event_types(run)
            assert "done" not in types and "error" not in types and types[-1] == "end", types
    finally:
        compile_box._COMPILE_IMPL = orig
    print("✓ run wrapper terminal signals: clean→done+end, crash→error+end, cancel→end only")


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


# Stand-ins for the SDK's other message/block types — only the class NAME matters
# to the watchdog (_note_model_activity dispatches on type(msg).__name__).
class StreamEvent:  # partial-delta liveness (include_partial_messages)
    pass


class UserMessage:  # tool_result carrier
    pass


class ToolUseBlock:  # a content block that requests a tool
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


async def test_session_driver_conversational():
    """run_session connects WITHOUT a prompt (conversational by construction) and
    relays assistant text + turn_done; the session id is minted and announced."""
    orig = compile_box.ClaudeSDKClient
    compile_box.ClaudeSDKClient = _FakeSDKClient
    try:
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.CompileRun("ps1", td, 1, instruction="authoring/CLAUDE.md present")
            await compile_box.run_session(run)  # fake yields seed reply + result, then ends
            evs = []
            while not run.events.empty():
                evs.append(run.events.get_nowait())
            types = [e["type"] for e in evs]
            assert "session" in types and "log" in types and "turn_done" in types, types
            assert run.session_id, "session_id not set"
            assert _FakeSDKClient.last.connected_prompt is None, "session must connect with no kickoff"
            turn = next(e for e in evs if e["type"] == "turn_done")
            assert turn.get("text") == "seed reply", turn
    finally:
        compile_box.ClaudeSDKClient = orig
    print("✓ session driver is conversational (no kickoff, log + turn_done)")


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


# ── 起测试会话 (read-only test session) ──

async def test_test_path_escape_guard():
    """C4 guard predicate: relative + in-snapshot absolute paths pass; absolute /
    ../ escapes to the live workspace are named; Glob absolute patterns are caught
    (Grep patterns are regex content — never treated as paths)."""
    with tempfile.TemporaryDirectory() as snap:
        root = Path(snap)
        (root / ".siclaw" / "knowledge").mkdir(parents=True)
        ok = compile_box._test_path_escape
        # inside: relative, absolute-in-root, dotted-but-contained
        assert ok(root, "Read", {"file_path": ".siclaw/knowledge/index.md"}) is None
        assert ok(root, "Read", {"file_path": str(root / ".siclaw" / "knowledge" / "a.md")}) is None
        assert ok(root, "Grep", {"path": ".siclaw/knowledge", "pattern": "/dev/infiniband"}) is None  # regex content, not a path
        assert ok(root, "Glob", {"pattern": ".siclaw/knowledge/*.md"}) is None
        # escapes: absolute out-of-root, ../ traversal, Glob absolute pattern
        assert ok(root, "Read", {"file_path": "/work/candidate/index.md"}) == "file_path=/work/candidate/index.md"
        assert ok(root, "Read", {"file_path": "../../work/raw/src.md"}) is not None
        assert ok(root, "Grep", {"path": "/work"}) == "path=/work"
        assert ok(root, "Glob", {"pattern": "/work/**/*.md"}) == "pattern=/work/**/*.md"

        # the PreToolUse hook wraps the predicate into a deny decision
        guard = compile_box._make_test_path_guard(root)
        deny = await guard({"tool_name": "Read", "tool_input": {"file_path": "/work/raw/x.md"}}, "t1", None)
        assert deny["hookSpecificOutput"]["permissionDecision"] == "deny", deny
        allow = await guard({"tool_name": "Read", "tool_input": {"file_path": "index.md"}}, "t2", None)
        assert allow == {}, allow
    print("✓ test-session path guard (C4): snapshot-confined, live /work denied")



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


def test_pack_candidates_symlink_confinement():
    """Security: the compile session has Write+Bash, so it could ln -s a host file
    into candidate/. The pinner must NOT copy content whose real path escapes
    candidate/ — neither a file symlink nor a symlinked directory."""
    with tempfile.TemporaryDirectory() as wd, tempfile.TemporaryDirectory() as dest_root, tempfile.TemporaryDirectory() as outside:
        secret = Path(outside) / "secret.md"
        secret.write_text("TOP-SECRET host content\n")
        secret_dir = Path(outside) / "hostdir"
        secret_dir.mkdir()
        (secret_dir / "leak2.md").write_text("SECRET via symlinked dir\n")

        cand = Path(wd) / "candidate"
        cand.mkdir()
        (cand / "index.md").write_text("# index\n")
        (cand / "real.md").write_text("legit page\n")
        # (a) file symlink escaping candidate/ (relative name, no "..", is_file() true)
        os.symlink(secret, cand / "leak.md")
        # (b) symlinked directory pointing outside candidate/
        os.symlink(secret_dir, cand / "sub")

        dest = Path(dest_root) / "snap"
        h, pages = compile_box._pack_candidates_to_wiki(wd, dest)
        kdir = dest / ".siclaw" / "knowledge"
        # Only the two real pages are packed; neither symlink target leaked.
        assert pages == 2, pages
        assert (kdir / "index.md").is_file()
        assert (kdir / "real.md").is_file()
        assert not (kdir / "leak.md").exists(), "file symlink escaped confinement"
        assert not (kdir / "sub" / "leak2.md").exists(), "symlinked dir escaped confinement"
        # And the secret content never entered the snapshot bytes.
        for p in kdir.rglob("*"):
            if p.is_file():
                assert "SECRET" not in p.read_text(), p
    print("✓ pack candidates symlink confinement (no host-file exfil into snapshot)")


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
            # persona comes from the locale pack (TestRun without locale → en default)
            assert compile_box._prompt("test_role", None) in opts.system_prompt["append"]
            assert _FakeSDKClient.last.connected_prompt is None, "test session must not kickoff"
            # C4: the snapshot path guard is wired as a PreToolUse hook
            assert opts.hooks and "PreToolUse" in opts.hooks and opts.hooks["PreToolUse"], opts.hooks
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

        # consumer-provided snapshot bundle (e.g. a published version) → the box
        # installs THAT instead of pinning candidate/, same hash formula.
        vbundle = make_source_bundle({"index.md": "# v1 index\n", "gpu.md": "# gpu v1\n"})
        r = await client.post("/test-session/p1", json={
            "bundle_base64": base64.b64encode(vbundle).decode(),
            "bundle_sha256": hashlib.sha256(vbundle).hexdigest(),
        })
        assert r.status == 200, await r.text()
        vb = await r.json()
        assert vb["pages"] == 2, vb
        vtid = vb["test_session_id"]
        vidx = Path(snap_root) / vtid / ".siclaw" / "knowledge" / "index.md"
        assert vidx.read_text() == "# v1 index\n"
        want = hashlib.sha256()
        for rp, data in sorted([("gpu.md", b"# gpu v1\n"), ("index.md", b"# v1 index\n")]):
            want.update(rp.encode()); want.update(b"\0"); want.update(data); want.update(b"\0")
        assert vb["snapshot_hash"] == want.hexdigest(), vb
        assert (await client.post(f"/test-session/{vtid}/close")).status == 200

        # provided bundle missing index.md → 400, snapshot dir cleaned
        nobidx = make_source_bundle({"only.md": "x"})
        r = await client.post("/test-session/p1", json={"bundle_base64": base64.b64encode(nobidx).decode()})
        assert r.status == 400, await r.text()

        # sha mismatch → 400
        r = await client.post("/test-session/p1", json={
            "bundle_base64": base64.b64encode(vbundle).decode(),
            "bundle_sha256": "0" * 64,
        })
        assert r.status == 400, await r.text()
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




async def test_prompt_packs_locale():
    """Prompt packs: en/zh ship the same asset set; unknown locales fall back to
    en (the platform default); guard steering + constitution seed follow the
    locale; KBC_PLAYBOOK env still overrides the playbook (local dev)."""
    en = sorted(q.name for q in (compile_box._PROMPTS_DIR / "en").iterdir())
    zh = sorted(q.name for q in (compile_box._PROMPTS_DIR / "zh").iterdir())
    assert en == zh and "box_role.md" in en, (en, zh)
    assert compile_box._prompt("box_role", "no-such-locale") == compile_box._prompt("box_role", "en")
    assert "只读的知识消费者" in compile_box._prompt("test_role", "zh")
    assert "read-only knowledge consumer" in compile_box._prompt("test_role", "en")

    with tempfile.TemporaryDirectory() as snap:
        root = Path(snap)
        deny = await compile_box._make_test_path_guard(root, "zh")(
            {"tool_name": "Read", "tool_input": {"file_path": "/work/x"}}, "t", None)
        assert "只读测试会话" in deny["hookSpecificOutput"]["permissionDecisionReason"]
        deny = await compile_box._make_test_path_guard(root, "en")(
            {"tool_name": "Read", "tool_input": {"file_path": "/work/x"}}, "t", None)
        assert "read-only test session" in deny["hookSpecificOutput"]["permissionDecisionReason"]

    with tempfile.TemporaryDirectory() as wd:
        compile_box._ensure_workdir_constitution(wd, "zh")
        assert "铁则" in (Path(wd) / "constitution.md").read_text(encoding="utf-8")  # zh playbook section header (parallels en "Iron rules")
    with tempfile.TemporaryDirectory() as wd:
        compile_box._ensure_workdir_constitution(wd, None)  # platform default = en
        assert "Iron rules" in (Path(wd) / "constitution.md").read_text(encoding="utf-8")

    with tempfile.TemporaryDirectory() as td:
        override = Path(td) / "pb.md"
        override.write_text("OVERRIDE PLAYBOOK", encoding="utf-8")
        os.environ["KBC_PLAYBOOK"] = str(override)
        try:
            assert compile_box._playbook_text("zh") == "OVERRIDE PLAYBOOK"
        finally:
            del os.environ["KBC_PLAYBOOK"]

    # Model-facing tool strings are locale-selected too (descriptions + results).
    zh_ts = compile_box._tool_strings("zh")
    en_ts = compile_box._tool_strings("en")
    assert zh_ts.keys() == en_ts.keys()
    for key in zh_ts:
        assert zh_ts[key].keys() == en_ts[key].keys(), key
    assert "批准" in zh_ts["propose_plan"]["ack"] and "approval" in en_ts["propose_plan"]["ack"]
    assert compile_box._tool_strings("no-such") == en_ts
    assert "{tid}" in en_ts["resolve_ticket"]["not_found"]  # format slots survive
    print("✓ prompt packs: en/zh parity, en fallback, localized guard/constitution/tools, env override")


async def test_propose_plan_never_bounces():
    """propose_plan is the deterministic approve signal: the handler itself writes
    authoring/PROPOSED_PLAN.json (code, not model formatting) and always emits —
    the owner UI must never be held hostage by how the model kept its notes."""
    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "authoring").mkdir(parents=True)
        events = []

        class FakeRun:
            workdir = str(wd)
            locale = "zh"  # model-facing tool strings come from the locale pack

            async def emit(self, ev):
                events.append(ev)

        captured = {}
        orig = compile_box.create_sdk_mcp_server

        def capture(name, tools):
            captured.update({t.name: t for t in tools})
            return orig(name, tools=tools)

        compile_box.create_sdk_mcp_server = capture
        try:
            compile_box._make_compile_tools(FakeRun())
        finally:
            compile_box.create_sdk_mcp_server = orig
        pp = captured["propose_plan"].handler

        # no PLAN.md checkboxes at all → STILL proposes (advisory reminder only)
        r1 = await pp({"plan": "## 计划\n- 00 概览\n- 10 用法"})
        assert events and events[0]["type"] == "plan_proposed"
        assert "提醒" in r1["content"][0]["text"]
        proposal = json.loads((wd / "authoring" / "PROPOSED_PLAN.json").read_text("utf-8"))
        assert proposal["text"].startswith("## 计划") and proposal["proposed_at"]

        # with a maintained checklist → no reminder; re-propose overwrites
        (wd / "authoring" / "PLAN.md").write_text(
            "# Plan\n\n## Next Pages\n- [ ] 00 概览 — 平台是什么\n\n## Blocked\n- None\n", "utf-8"
        )
        r2 = await pp({"plan": "v2"})
        assert len(events) == 2
        assert "提醒" not in r2["content"][0]["text"]
        assert json.loads((wd / "authoring" / "PROPOSED_PLAN.json").read_text("utf-8"))["text"] == "v2"
    print("✓ propose_plan always signals; PROPOSED_PLAN.json written by code")


def test_install_wiki_snapshot_size_guard():
    """Fix A: the published-snapshot installer rejects an oversized compressed
    bundle AND a decompression bomb (accumulated-unpacked cap), like its sibling
    installers — else a gzip-bomb bundle_base64 OOMs the pod + the parent run."""
    import tempfile as _tf
    ok = make_source_bundle({"index.md": "# i\n", "p.md": "x" * 100})
    with _tf.TemporaryDirectory() as d:
        dest = Path(d)
        os.environ["KBC_MAX_SNAPSHOT_BUNDLE_BYTES"] = "10"      # compressed cap
        try:
            try:
                compile_box._install_wiki_snapshot(ok, dest / "a")
                assert False, "should reject oversized compressed bundle"
            except ValueError as e:
                assert "too large" in str(e), e
        finally:
            del os.environ["KBC_MAX_SNAPSHOT_BUNDLE_BYTES"]
        os.environ["KBC_MAX_SNAPSHOT_UNPACKED_BYTES"] = "5"     # unpacked cap
        try:
            try:
                compile_box._install_wiki_snapshot(ok, dest / "b")
                assert False, "should reject bundle that unpacks too large"
            except ValueError as e:
                assert "unpacks too large" in str(e), e
        finally:
            del os.environ["KBC_MAX_SNAPSHOT_UNPACKED_BYTES"]
        h, pages = compile_box._install_wiki_snapshot(ok, dest / "c")  # within limits → ok
        assert pages == 2 and len(h) == 64, (pages, h)
    print("✓ install_wiki_snapshot size guards (compressed + unpacked caps)")


# ── Protocol v3: brief consumption + append-only proposed questions ──

def test_apply_session_config():
    """Consumer-managed llm/settings from /session body (DESIGN-kb-llm-binding-v2):
    llm applies + clears a stale forwarded API key; settings whitelisted to
    KBC_*; the boot-time KBC_PK_MODE=off kill switch outranks consumer config."""
    keys = ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
            "KBC_COMPILE_MODEL", "KBC_PK_MODE")
    backup = {k: os.environ.get(k) for k in keys}
    kill_backup = compile_box._PK_KILL_AT_BOOT
    try:
        os.environ["ANTHROPIC_API_KEY"] = "stale-forwarded-key"
        os.environ.pop("KBC_PK_MODE", None)
        os.environ.pop("KBC_COMPILE_MODEL", None)
        compile_box._PK_KILL_AT_BOOT = False
        compile_box._apply_session_config({
            "llm": {"base_url": "https://massapi.example/model-api", "auth_token": "tok-1"},
            "settings": {"KBC_COMPILE_MODEL": "claude-opus-4-8",
                         "KBC_PK_MODE": "auto",
                         "EVIL_KEY": "nope", "PATH": "/pwn"},
        })
        assert os.environ["ANTHROPIC_BASE_URL"] == "https://massapi.example/model-api"
        assert os.environ["ANTHROPIC_AUTH_TOKEN"] == "tok-1"
        assert "ANTHROPIC_API_KEY" not in os.environ           # stale key cleared
        assert os.environ["KBC_COMPILE_MODEL"] == "claude-opus-4-8"
        assert os.environ["KBC_PK_MODE"] == "auto"
        assert "EVIL_KEY" not in os.environ and os.environ.get("PATH") != "/pwn"

        # ops kill switch: runtime-level off beats consumer "auto"
        os.environ["KBC_PK_MODE"] = "off"
        compile_box._PK_KILL_AT_BOOT = True
        compile_box._apply_session_config({"settings": {"KBC_PK_MODE": "auto"}})
        assert os.environ["KBC_PK_MODE"] == "off"

        # absent/None fields are a clean no-op
        compile_box._apply_session_config({})
        compile_box._apply_session_config({"llm": None, "settings": None})
    finally:
        for k, v in backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        compile_box._PK_KILL_AT_BOOT = kill_backup
    print("\u2713 _apply_session_config: llm + whitelist + kill-switch precedence")
def test_parse_brief_block():
    """The wizard's 定调标签 block parses into the BRIEF.json record (tags split on
    Chinese separators, raw kept from the marker); an ordinary message → None."""
    msg = (
        "开始生成知识库。\n\n"
        "我的定调标签(请作为本次编译的 brief):\n"
        "- 给谁看:内部工程师\n"
        "- 内容倾向:详尽百科、保留内部信息、只留最新版本\n"
        "- 自定义:偏排障场景、少写背景\n"
        "请按这些标签作为编译 brief 执行。"
    )
    brief = compile_box.parse_brief_block(msg)
    assert brief["source"] == "quickstart_message"
    assert brief["audience"] == "内部工程师", brief
    assert brief["styles"] == ["详尽百科", "保留内部信息", "只留最新版本"], brief
    assert brief["custom"] == ["偏排障场景", "少写背景"], brief
    assert brief["raw"].startswith("我的定调标签"), brief  # QUICKSTART prefix stripped off
    # no brief block → None (an ordinary prepare/compile message is left untouched)
    assert compile_box.parse_brief_block("把 raw/ 编成候选页") is None
    assert compile_box.parse_brief_block("") is None
    print("✓ parse_brief_block (tags split, raw from marker, None when absent)")


def test_merge_proposed_questions():
    """Append-merge is dedup-by-question, drops malformed entries, and never wipes
    the carried-over list."""
    existing = [{"question": "A?", "reference": "a", "source": "s"}]
    merged, added, skipped = compile_box.merge_proposed_questions(existing, [
        {"question": "A?", "reference": "dup", "source": "x"},  # dup of existing #1
        {"question": "B?", "reference": "b", "source": "s2"},   # new
        {"question": "   ", "reference": "", "source": ""},      # blank → skip
        "not-a-dict",                                            # junk → skip
    ])
    assert [q["question"] for q in merged] == ["A?", "B?"], merged
    assert added == 1 and skipped == 3, (added, skipped)
    # malformed existing entries are dropped from the carry-over; identical incoming skipped
    merged2, added2, _ = compile_box.merge_proposed_questions(
        ["junk", {"noquestion": 1}, {"question": "C?"}], [{"question": "C?"}])
    assert [q["question"] for q in merged2] == ["C?"] and added2 == 0, merged2

    # every merged entry carries a 'q-'+8hex id derived from the normalized question;
    # formula is FNV-1a — locked against the canonical vector for "a".
    for q in merged:
        assert re.fullmatch(r"q-[0-9a-f]{8}", q["id"]), q
    assert compile_box._question_id(compile_box._normalize_question("A?")) == "q-e40c292c"
    assert merged[0]["id"] == "q-e40c292c", merged[0]

    # re-propose the same question (different case/whitespace) → dedup, id unchanged
    id_A = merged[0]["id"]
    again, added3, skipped3 = compile_box.merge_proposed_questions(merged, [{"question": "  a  "}])
    assert added3 == 0 and skipped3 == 1, (added3, skipped3)
    assert next(q for q in again if q["question"] == "A?")["id"] == id_A, again

    # an explicit prior id is preserved; a legacy id-less entry is backfilled
    kept, _, _ = compile_box.merge_proposed_questions(
        [{"id": "q-legacy1", "question": "D?"}, {"question": "E?"}], [])
    by_q = {q["question"]: q for q in kept}
    assert by_q["D?"]["id"] == "q-legacy1", kept
    assert re.fullmatch(r"q-[0-9a-f]{8}", by_q["E?"]["id"]), kept
    print("✓ merge_proposed_questions (append, dedup, drop malformed, stable id)")


async def test_propose_questions_appends_dedup():
    """propose_questions writes authoring/QUESTIONS_PROPOSED.json append-only: a
    second round adds new questions and skips duplicates (never overwrites), and
    each round emits a summary line."""
    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "authoring").mkdir(parents=True)
        events = []

        class FakeRun:
            workdir = str(wd)
            locale = "zh"  # model-facing tool strings come from the locale pack

            async def emit(self, ev):
                events.append(ev)

        captured = {}
        orig = compile_box.create_sdk_mcp_server

        def capture(name, tools):
            captured.update({t.name: t for t in tools})
            return orig(name, tools=tools)

        compile_box.create_sdk_mcp_server = capture
        try:
            compile_box._make_compile_tools(FakeRun())
        finally:
            compile_box.create_sdk_mcp_server = orig
        pq = captured["propose_questions"].handler
        path = wd / "authoring" / "QUESTIONS_PROPOSED.json"

        r1 = await pq({"questions": [
            {"question": "默认 quota 是多少?", "reference": "300", "source": "policy.md: cap 300"},
            {"question": "draco 还在用吗?", "reference": "已废弃", "source": "manual.md"},
        ]})
        data = json.loads(path.read_text())
        assert [q["question"] for q in data] == ["默认 quota 是多少?", "draco 还在用吗?"], data
        assert data[0]["source"] == "policy.md: cap 300"
        # every persisted entry carries an id (frontend adopt POSTs it as proposal_id)
        assert all(re.fullmatch(r"q-[0-9a-f]{8}", q["id"]) for q in data), data
        assert "新增 2" in r1["content"][0]["text"], r1

        # round 2: one dup (only trailing punctuation differs) + one new → append, skip dup
        r2 = await pq({"questions": [
            {"question": "默认 quota 是多少", "reference": "x", "source": "y"},  # dup of #1
            {"question": "支持哪些区域?", "reference": "cn-*", "source": "regions.md"},
        ]})
        data = json.loads(path.read_text())
        assert len(data) == 3 and data[2]["question"] == "支持哪些区域?", data
        assert "新增 1" in r2["content"][0]["text"] and "跳过 1" in r2["content"][0]["text"], r2
        assert sum(1 for e in events if e["type"] == "summary") == 2, events

        # bad arg → guarded, file untouched
        bad = await pq({"questions": "nope"})
        assert "数组" in bad["content"][0]["text"], bad
        assert len(json.loads(path.read_text())) == 3
    print("✓ propose_questions appends + dedups (never overwrites prior picks)")


async def test_message_captures_brief():
    """POST /message persists a 定调标签 block to authoring/BRIEF.json before the
    turn (message still reaches the agent verbatim); an ordinary message writes none."""
    compile_box.RUNS.clear()
    client = TestClient(TestServer(compile_box.build_app()))
    await client.start_server()
    try:
        with tempfile.TemporaryDirectory() as td:
            class _C:
                def __init__(self):
                    self.queries = []

                async def query(self, text, session_id="default"):
                    self.queries.append(text)

            run = compile_box.CompileRun("brief-run", td, 1)
            run.client = _C()
            run.connected.set()
            compile_box.RUNS["brief-run"] = run

            msg = ("开始生成知识库\n\n我的定调标签(请作为本次编译的 brief):\n"
                   "- 给谁看:内部工程师\n- 内容倾向:详尽百科、只留最新版本\n"
                   "- 自定义:偏排障场景\n请按这些标签作为编译 brief 执行。")
            r = await client.post("/message/brief-run", json={"message": msg})
            assert r.status == 200, await r.text()
            brief = json.loads((Path(td) / "authoring" / "BRIEF.json").read_text())
            assert brief["audience"] == "内部工程师", brief
            assert brief["styles"] == ["详尽百科", "只留最新版本"], brief
            assert brief["custom"] == ["偏排障场景"], brief
            assert run.client.queries == [msg], run.client.queries  # agent still sees the block

            # ordinary message → no clobber (BRIEF.json stays the first brief)
            r = await client.post("/message/brief-run", json={"message": "继续编下一篇"})
            assert r.status == 200, await r.text()
            assert json.loads((Path(td) / "authoring" / "BRIEF.json").read_text())["audience"] == "内部工程师"
    finally:
        await client.close()
        compile_box.RUNS.clear()
    print("✓ /message captures 定调 brief → BRIEF.json (ordinary msg leaves it)")



async def test_incremental_route():
    """Scoped incremental (DESIGN-kb-incremental-recompile-v2): a compile trigger +
    the consumer's machine-computed RAW_CHANGES routes to the scoped path — materializes
    CHANGESET.json (affected pages reverse-looked-up), arms the byte-integrity guard
    state, injects the scoped directive — instead of a full-corpus re-plan."""
    import json as _json

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "candidate").mkdir(parents=True)
        (wd / "authoring").mkdir(parents=True)
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md)")
        (wd / "candidate" / "a.md").write_text(
            "---\ntitle: t\ncompiled_from:\n  - snap/one.md\n---\n正文。")
        run = compile_box.CompileRun("incr1", str(wd), 1)
        # no RAW_CHANGES yet → NOT incremental (falls through to normal/full route)
        assert not compile_box._should_route_to_incremental(run, "请增量重编")
        # the consumer writes the machine-computed changeset input
        (wd / "authoring" / "RAW_CHANGES.json").write_text(_json.dumps({
            "modified": ["snap/one.md"], "added": [], "deleted": [],
            "diffs": {"snap/one.md": "- old fact\n+ new fact"},
            "snapshot_fingerprint": "SNAP"}))
        assert compile_box._should_route_to_incremental(run, "请增量重编")
        assert not compile_box._should_route_to_incremental(run, "随便聊两句")  # non-trigger never routes

        fake = _FakeSDKClient()
        run.client = fake
        await compile_box._start_incremental(run, "请增量重编")
        # CHANGESET.json materialized: affected page reverse-looked-up + the consumer's diff
        cs = _json.loads((wd / "authoring" / "CHANGESET.json").read_text())
        assert cs["affected_pages"] == ["a.md"], cs
        assert cs["modified"][0]["diff"] == "- old fact\n+ new fact"
        # byte-integrity guard state armed (before-hashes captured for the post-turn check)
        assert run._incr_pending is not None and "a.md" in run._incr_pending["before"]
        # the scoped directive was injected (not a batch orchestrator)
        assert any("[Incremental recompile]" in q and "CHANGESET.json" in q for q in fake.queries), fake.queries
        # review fix: the incremental kickoff arms the stall watchdog like
        # every other model-turn injection site
        assert run._turn_active and "[Incremental recompile]" in run._last_directive
    print("OK  incremental route (RAW_CHANGES → scoped CHANGESET + guard-armed + scoped directive; absent/non-trigger → no route)")


async def test_incremental_integrity_guard():
    """M3: on an incremental turn a page touched OUTSIDE the authorized set forces a
    repair even when the coverage ledger is clean — "leave the rest untouched" is
    enforced by byte comparison, not the model's word. The guard state is one-shot."""
    import json as _json
    import incremental

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "raw" / "snap" / "two.md").write_text("two")
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md) [c](c.md)")
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        (wd / "candidate" / "c.md").write_text("---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n正文c。")
        run = compile_box.CompileRun("incrg", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 0
        # arm the guard: this round's changeset only authorizes a.md
        cs = {"affected_pages": ["a.md"], "added": [], "deleted": [],
              "modified": [{"path": "snap/one.md", "affected_pages": ["a.md"], "diff": ""}]}
        run._incr_pending = {"before": incremental.page_hashes(str(wd)), "changeset": cs}
        # model edits a.md (authorized) AND drifts into c.md (unauthorized)
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a 更新。")
        (wd / "candidate" / "c.md").write_text("---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n正文c 擅自改。")
        repair = await compile_box._post_turn_selfcheck(run)
        # coverage ledger is clean (both sources still cited) yet integrity forces a repair naming c.md
        assert repair is not None and "Incremental scope violation" in repair and "c.md" in repair, repair
        # review fix: on a violation the guard RE-ARMS for the repair turn itself
        # (the repair restores toward the ORIGINAL baseline) — it used to be
        # consumed here, leaving the repair turn unguarded.
        assert run._incr_pending is not None and run._incr_pending["changeset"] is cs
        # the repair restores c.md → the re-armed guard clears cleanly
        (wd / "candidate" / "c.md").write_text("---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n正文c。")
        run._selfcheck_key = None
        repair2 = await compile_box._post_turn_selfcheck(run)
        assert repair2 is None, repair2
        assert run._incr_pending is None  # consumed on the clean pass
        sc = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc["incremental"]["out_of_scope_pages"] == [], sc
    print("OK  incremental integrity guard (violation → repair + re-armed guard; clean pass consumes)")


async def test_incremental_guard_rearms_on_ledger_repair():
    """Round-4 review fix: an incremental turn that stayed IN scope but failed
    the coverage ledger enters repairing too — the guard must re-arm for that
    ledger-repair turn as well (it used to be gated on violations only)."""
    import json as _json
    import incremental

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "raw" / "snap" / "orphaned-src.md").write_text("never cited")  # → unaccounted
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md)")
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        run = compile_box.CompileRun("incrl", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 0
        cs = {"affected_pages": ["a.md"], "added": [], "deleted": [],
              "modified": [{"path": "snap/one.md", "affected_pages": ["a.md"], "diff": ""}]}
        armed = {"before": incremental.page_hashes(str(wd)), "changeset": cs}
        run._incr_pending = armed
        # the turn edits ONLY the authorized page (no byte violations)…
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a 更新。")
        repair = await compile_box._post_turn_selfcheck(run)
        # …but the ledger is unclean (orphaned-src.md unaccounted) → repairing
        assert repair is not None and "orphaned-src.md" in repair, repair
        sc = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc["incremental"]["out_of_scope_pages"] == [], sc
        # the guard is re-armed for the ledger-repair turn
        assert run._incr_pending is not None and run._incr_pending["changeset"] is cs
    print("OK  incremental guard re-arms on in-scope ledger repair (round-4 fix)")


async def test_incremental_violation_auto_restored():
    """L0: with the byte snapshot armed, an out-of-scope edit is restored BY CODE
    before the ledger runs — no repair turn, byte-exact tree, restored_pages in
    the report. The model cannot un-edit toward a hash; asking it to burned the
    whole repair budget and always landed unconverged (3/3 live rounds, 07-09)."""
    import json as _json
    import incremental

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "raw" / "snap" / "two.md").write_text("two")
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md) [c](c.md)")
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        c_original = "---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n正文c。"
        (wd / "candidate" / "c.md").write_text(c_original)
        run = compile_box.CompileRun("incrr", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 0
        cs = {"affected_pages": ["a.md"], "added": [], "deleted": [],
              "modified": [{"path": "snap/one.md", "affected_pages": ["a.md"], "diff": ""}]}
        run._incr_pending = {"before": incremental.page_hashes(str(wd)),
                             "before_bytes": incremental.page_bytes(str(wd)), "changeset": cs}
        # model edits a.md (authorized) AND drifts into c.md (unauthorized)
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a 更新。")
        (wd / "candidate" / "c.md").write_text("---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n正文c 擅自改。")
        repair = await compile_box._post_turn_selfcheck(run)
        assert repair is None, repair  # violation auto-restored, ledger clean → no repair turn
        assert (wd / "candidate" / "c.md").read_text() == c_original  # byte-exact restore
        sc = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc["state"] == "passed", sc
        assert sc["incremental"] == {"out_of_scope_pages": [], "restored_pages": ["c.md"]}, sc
        assert run._incr_pending is None  # consumed: nothing left to guard
    print("OK  incremental violation auto-restored by code (no repair turn, byte-exact, reported)")


async def test_unconverged_files_residual_ticket():
    """L2: repair budget spent with residuals → the driver files ONE ticket in
    the owner's question queue by code. The publish page only displays residual
    state — it must never be where the owner discovers work."""
    import json as _json

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "raw" / "snap" / "never-compiled.md").write_text("orphan")  # → unaccounted forever
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md)")
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        run = compile_box.CompileRun("uncv", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 99  # budget long spent → unconverged, not repairing
        repair = await compile_box._post_turn_selfcheck(run)
        assert repair is None, repair  # unconverged does not inject another repair
        sc = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc["state"] == "unconverged", sc
        tickets = _json.loads((wd / "authoring" / "CONTRADICTIONS.json").read_text())
        assert len(tickets) == 1 and tickets[0]["id"].startswith("selfcheck-residual-"), tickets
        assert "never-compiled.md" in tickets[0]["sources"][0]["quote"]
        # a second settle with the same residuals does not duplicate the ticket
        run._selfcheck_key = None
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a 又动了。")
        await compile_box._post_turn_selfcheck(run)
        tickets2 = _json.loads((wd / "authoring" / "CONTRADICTIONS.json").read_text())
        assert len(tickets2) == 1, tickets2
    print("OK  unconverged files a residual ticket (once, code-written, question queue)")


async def test_repair_turn_may_edit_ledger_target_pages():
    """Interlock (live 07-09): the ledger repair ordered edits on pages OUTSIDE
    the round's authorized set (a dangling-citing page) and the re-armed guard's
    mechanical restore reverted the repair itself → unconverged forever. The
    re-arm now widens the authorized set by exactly the repair's target pages."""
    import json as _json
    import incremental

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "raw" / "snap" / "two.md").write_text("two")
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md) [c](c.md)")
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        # c.md cites a source that no longer exists → dangling (out of this round's scope)
        (wd / "candidate" / "c.md").write_text("---\ntitle: c\ncompiled_from:\n  - snap/ghost.md\n---\n正文c。")
        run = compile_box.CompileRun("interlock", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 0
        cs = {"affected_pages": ["a.md"], "added": [], "deleted": [],
              "modified": [{"path": "snap/one.md", "affected_pages": ["a.md"], "diff": ""}]}
        run._incr_pending = {"before": incremental.page_hashes(str(wd)),
                             "before_bytes": incremental.page_bytes(str(wd)), "changeset": cs}
        # turn 1: model edits ONLY the authorized page — in scope, but the ledger
        # is unclean (dangling citation on c.md) → repairing, guard re-armed
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a 更新。")
        repair = await compile_box._post_turn_selfcheck(run)
        assert repair is not None and "ghost.md" in repair, repair
        assert run._incr_pending is not None
        assert run._incr_pending.get("repair_pages") == ["c.md"], run._incr_pending.get("repair_pages")
        # repair turn: model fixes the dangling citation on the OUT-OF-SCOPE page
        (wd / "candidate" / "c.md").write_text("---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n正文c。")
        run._selfcheck_key = None
        repair2 = await compile_box._post_turn_selfcheck(run)
        assert repair2 is None, repair2
        sc = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc["state"] == "passed", sc
        # the guard did NOT restore the repair's edit
        assert sc["incremental"] == {"out_of_scope_pages": [], "restored_pages": []}, sc
        assert "snap/two.md" in (wd / "candidate" / "c.md").read_text()
    print("OK  repair turn may edit ledger-target pages (guard widened, repair survives)")


async def test_incremental_index_deletion_cannot_escape_guard():
    """Review fix: an incremental turn that deletes candidate/index.md used to
    hit the mid-Execute early-return AFTER the guard state was consumed — the
    deletion escaped the byte freeze entirely. The turn must fall through: the
    guard restores out-of-scope damage and the ledger runs on the real tree."""
    import json as _json
    import incremental

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "raw" / "snap" / "two.md").write_text("two")
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md) [c](c.md)")
        c_original = "---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n正文c。"
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        (wd / "candidate" / "c.md").write_text(c_original)
        run = compile_box.CompileRun("incrx", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 0
        cs = {"affected_pages": ["a.md"], "added": [], "deleted": [],
              "modified": [{"path": "snap/one.md", "affected_pages": ["a.md"], "diff": ""}]}
        run._incr_pending = {"before": incremental.page_hashes(str(wd)),
                             "before_bytes": incremental.page_bytes(str(wd)), "changeset": cs}
        # model edits a.md (authorized), DELETES index.md and drifts into c.md
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a 更新。")
        (wd / "candidate" / "index.md").unlink()
        (wd / "candidate" / "c.md").write_text("---\ntitle: c\ncompiled_from:\n  - snap/two.md\n---\n擅自改。")
        repair = await compile_box._post_turn_selfcheck(run)
        # the guard ran: c.md restored byte-exact; index.md (always-editable, no
        # snapshot restore) leaves the tree index-less → orphan lint → repair
        assert (wd / "candidate" / "c.md").read_text() == c_original
        assert repair is not None and "index_missing" in repair, repair
        sc = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc["incremental"]["restored_pages"] == ["c.md"], sc
        assert sc["state"] == "repairing", sc
    print("OK  index deletion on an incremental turn cannot escape the guard")


async def test_incremental_arm_cleared_when_dispatch_fails():
    """Review fix: the snapshot must precede query (edits begin right after
    send), so a query that RAISES must clear the arm — a stale arm would judge
    the next unrelated turn against this round's snapshot and silently restore
    over the owner's edits. Also: ADDED_TARGETS is a per-round declaration and
    resets at round start."""
    import json as _json

    class _ExplodingClient:
        async def query(self, text):
            raise RuntimeError("stdin write failed")

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "candidate").mkdir(parents=True)
        (wd / "authoring").mkdir(parents=True)
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md)")
        (wd / "candidate" / "a.md").write_text(
            "---\ntitle: t\ncompiled_from:\n  - snap/one.md\n---\n正文。")
        # stale per-round declaration from an earlier round must not survive
        (wd / "authoring" / "ADDED_TARGETS.json").write_text('["stale-page.md"]')
        (wd / "authoring" / "RAW_CHANGES.json").write_text(_json.dumps({
            "modified": ["snap/one.md"], "added": [], "deleted": [],
            "diffs": {}, "snapshot_fingerprint": "SNAP"}))
        run = compile_box.CompileRun("incrfail", str(wd), 1)
        run.client = _ExplodingClient()
        try:
            await compile_box._start_incremental(run, "请增量重编")
            assert False, "query failure must propagate"
        except RuntimeError:
            pass
        assert run._incr_pending is None  # no stale arm on a turn that never started
        assert not (wd / "authoring" / "ADDED_TARGETS.json").exists()  # per-round reset
    print("OK  incremental arm cleared on dispatch failure + ADDED_TARGETS per-round reset")


async def test_noop_repair_turn_reaches_the_gate():
    """Review fix: a repair turn that changes nothing ledger-relevant used to
    hit the state_key dedup early-return — state stayed 'repairing' forever,
    NO residual ticket, while the seam settled. It must fall through, spend
    the budget, and file the ticket."""
    import json as _json

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "raw" / "snap" / "never-compiled.md").write_text("orphan")  # unaccounted forever
        (wd / "candidate" / "index.md").write_text("---\ntype: index\n---\n[a](a.md)")
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        run = compile_box.CompileRun("noop", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 0
        os.environ["KBC_L1_REPAIR_ROUNDS"] = "1"  # pin: the default is now 2
        repair = await compile_box._post_turn_selfcheck(run)
        assert repair is not None and "never-compiled.md" in repair  # round 1: repairing
        sc = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc["state"] == "repairing", sc
        # the repair turn does NOTHING ledger-relevant (tree unchanged, key matches)
        repair2 = await compile_box._post_turn_selfcheck(run)
        assert repair2 is None, repair2
        sc2 = _json.loads((wd / "authoring" / "SELFCHECK.json").read_text())
        assert sc2["state"] == "unconverged", sc2  # budget spent honestly, not stuck 'repairing'
        tickets = _json.loads((wd / "authoring" / "CONTRADICTIONS.json").read_text())
        assert any(str(tk.get("id", "")).startswith("selfcheck-residual-") for tk in tickets), tickets
        del os.environ["KBC_L1_REPAIR_ROUNDS"]
    print("OK  no-op repair turn reaches the gate (unconverged + residual ticket, not silent)")


async def test_batch_final_ledger_check_requires_index():
    """Batch C: the mid-Execute index exemption wrongly applied to the batch-
    final ledger pass — a train that finished without an index settled an
    unroutable draft. With _ledger_forced the pass falls through and the
    index_missing lint orders the rebuild."""
    import json as _json

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        (wd / "raw" / "snap").mkdir(parents=True)
        (wd / "candidate").mkdir()
        (wd / "authoring").mkdir()
        (wd / "raw" / "snap" / "one.md").write_text("one")
        (wd / "candidate" / "a.md").write_text("---\ntitle: a\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        run = compile_box.CompileRun("bfx", str(wd), 1)
        run._selfcheck_key = None
        run._l1_repairs_used = 0
        # plain call (mid-Execute shape): exemption applies → no check
        assert await compile_box._post_turn_selfcheck(run) is None
        # batch-final shape: forced → index_missing repair ordered
        run._selfcheck_key = None
        run._ledger_forced = True
        try:
            repair = await compile_box._post_turn_selfcheck(run)
        finally:
            run._ledger_forced = False
        assert repair is not None and "index_missing" in repair, repair
    print("OK  batch-final ledger pass requires the index (exemption is mid-Execute only)")


async def test_batch_orchestrator_routing_and_resume():
    """Batch mode (DESIGN-kb-batch-compile-2026-07-05): trigger routing honors
    the threshold gate (small KBs never batch), the orchestrator stamps batches
    done and emits exactly ONE turn_done, mid-batch owner chat queues, and an
    interrupted plan resumes from the first pending batch."""
    import batching

    with tempfile.TemporaryDirectory() as td:
        wd = Path(td)
        raw = wd / "raw"
        (raw / "a").mkdir(parents=True)
        (raw / "b").mkdir(parents=True)
        (raw / "a" / "one.md").write_bytes(b"x" * 300)
        (raw / "b" / "two.md").write_bytes(b"y" * 300)
        run = compile_box.CompileRun("rb1", str(wd), 1)

        # threshold gate: big threshold → single-session path untouched
        os.environ["KBC_BATCH_THRESHOLD_BYTES"] = "100000"
        assert not compile_box._should_route_to_batch(run, "直接开始编译")
        # over threshold + trigger → batch; non-trigger chat never batches
        os.environ["KBC_BATCH_THRESHOLD_BYTES"] = "100"
        os.environ["KBC_BATCH_BUDGET_BYTES"] = "400"
        os.environ["KBC_BATCH_PLANNER"] = "code"
        assert compile_box._should_route_to_batch(run, "直接开始编译")
        assert compile_box._should_route_to_batch(run, "原料已更新,请增量重编: xx")
        assert not compile_box._should_route_to_batch(run, "你好")

        # stub the session driver: record directives, pretend each session works
        driven: list[str] = []

        async def fake_drive(run_, directive, label):
            driven.append(label + "|" + directive.split("\n")[0])
            return f"done {label}"

        real_drive = compile_box._drive_batch_session
        compile_box._drive_batch_session = fake_drive
        try:
            await compile_box._run_batch_compile(run, "直接开始编译")
        finally:
            compile_box._drive_batch_session = real_drive

        events = []
        while not run.events.empty():
            events.append(run.events.get_nowait())
        types = [e["type"] for e in events]
        assert types.count("turn_done") == 1, types
        turn = next(e for e in events if e["type"] == "turn_done")
        assert "[Batch 1/2]" in turn["text"] and "[Final review]" in turn["text"], turn
        plan = json.loads((wd / batching.BATCH_PLAN_PATH).read_text())
        assert all(b["status"] == "done" for b in plan["batches"]), plan
        assert (wd / batching.SOURCES_INVENTORY_PATH).is_file()
        # two batches + 终审 were driven, in order
        assert len(driven) == 3 and driven[-1].startswith("final review"), driven

        # resume: mark one batch pending again → next trigger routes to batch even
        # under a huge threshold, and only the pending batch (+终审) re-runs
        plan["batches"][1]["status"] = "pending"
        (wd / batching.BATCH_PLAN_PATH).write_text(json.dumps(plan))
        os.environ["KBC_BATCH_THRESHOLD_BYTES"] = "100000"
        assert compile_box._should_route_to_batch(run, "直接开始编译")
        driven.clear()
        compile_box._drive_batch_session = fake_drive
        try:
            await compile_box._run_batch_compile(run, "直接开始编译")
        finally:
            compile_box._drive_batch_session = real_drive
        assert len(driven) == 2 and driven[0].startswith("batch 2/2"), driven

        # mid-batch owner chat queues and is relayed into the next directive
        run._batch_active = True
        run._batch_notes.append("注意保密条款")
        note = compile_box._drain_batch_notes(run)
        assert "注意保密条款" in note and compile_box._drain_batch_notes(run) == ""
        run._batch_active = False
        del os.environ["KBC_BATCH_THRESHOLD_BYTES"]
        del os.environ["KBC_BATCH_BUDGET_BYTES"]
    print("\u2713 batch orchestrator: gate/stamps/single turn_done/resume/notes")


async def test_batch_orchestrator_review_fixes():
    """Review fixes: (a) resume prunes sources deleted from raw/ (no directive
    points at a missing file; an emptied batch is skipped); (b) an orchestrator
    error still CLOSES the logical turn (error + turn_done, never-block); (c)
    owner notes arriving during the tail phases get a bounded digest session
    instead of being silently abandoned at turn_done."""
    import batching

    def _events(run):
        evs = []
        while not run.events.empty():
            evs.append(run.events.get_nowait())
        return evs

    os.environ["KBC_BATCH_THRESHOLD_BYTES"] = "100"
    os.environ["KBC_BATCH_BUDGET_BYTES"] = "400"
    os.environ["KBC_BATCH_PLANNER"] = "code"
    real_drive = compile_box._drive_batch_session
    try:
        # (a) resume after a source vanished: plan pins deleted.md in a pending
        # batch (and a fully-vanished batch) — directives must not mention them.
        with tempfile.TemporaryDirectory() as td:
            wd = Path(td)
            raw = wd / "raw"
            (raw / "a").mkdir(parents=True)
            (raw / "a" / "kept.md").write_bytes(b"x" * 300)
            plan = batching.build_plan(
                [{"path": "a/kept.md", "bytes": 300, "effective": 300}],
                [{"id": "b01", "sources": ["a/kept.md", "a/deleted.md"]},
                 {"id": "b02", "sources": ["a/vanished.md"]}],
                planner="code")
            (wd / "authoring").mkdir()
            (wd / batching.BATCH_PLAN_PATH).write_text(json.dumps(plan))
            run = compile_box.CompileRun("rf1", str(wd), 1)
            driven: list[str] = []

            async def fake_drive(run_, directive, label):
                driven.append(f"{label}|{directive}")
                return f"done {label}"

            compile_box._drive_batch_session = fake_drive
            await compile_box._run_batch_compile(run, "直接开始编译")
            evs = _events(run)
            assert any("no longer in raw/" in e.get("text", "") for e in evs
                       if e["type"] == "summary"), evs
            assert not any("deleted.md" in d or "vanished.md" in d for d in driven), driven
            assert sum(d.startswith("batch ") for d in driven) == 1, driven  # b02 emptied → skipped
            saved = json.loads((wd / batching.BATCH_PLAN_PATH).read_text())
            assert all(b["status"] == "done" for b in saved["batches"]), saved

        # (b) orchestrator error → error AND turn_done both emitted
        with tempfile.TemporaryDirectory() as td:
            wd = Path(td)
            (wd / "raw" / "a").mkdir(parents=True)
            (wd / "raw" / "a" / "one.md").write_bytes(b"x" * 300)
            run = compile_box.CompileRun("rf2", str(wd), 1)

            async def boom(run_, directive, label):
                raise RuntimeError("session exploded")

            compile_box._drive_batch_session = boom
            await compile_box._run_batch_compile(run, "直接开始编译")
            types = [e["type"] for e in _events(run)]
            assert "error" in types and types.count("turn_done") == 1, types

        # (c) a note landing during the tail phases (after the last batch has
        # drained the queue) gets its own 留言消化 session carrying the text
        with tempfile.TemporaryDirectory() as td:
            wd = Path(td)
            (wd / "raw" / "a").mkdir(parents=True)
            (wd / "raw" / "a" / "one.md").write_bytes(b"x" * 300)
            run = compile_box.CompileRun("rf3", str(wd), 1)
            driven = []

            async def drive_and_note(run_, directive, label):
                driven.append(f"{label}|{directive}")
                if label == "final review":  # owner speaks while the tail is running
                    run_._batch_notes.append("附录不要发布")
                return f"done {label}"

            compile_box._drive_batch_session = drive_and_note
            await compile_box._run_batch_compile(run, "直接开始编译")
            digest = [d for d in driven if d.startswith("note digest|")]
            assert len(digest) == 1 and "附录不要发布" in digest[0], driven
            assert [e for e in _events(run) if e["type"] == "turn_done"], "turn still closes"

        # (d) zh locale branch: the same flow narrates in Chinese when the
        # consumer declares locale=zh (platform default above was English)
        with tempfile.TemporaryDirectory() as td:
            wd = Path(td)
            (wd / "raw" / "a").mkdir(parents=True)
            (wd / "raw" / "a" / "one.md").write_bytes(b"x" * 300)
            run = compile_box.CompileRun("rf4", str(wd), 1)
            run.locale = "zh"
            driven = []

            async def fake_zh(run_, directive, label):
                driven.append(f"{label}|{directive}")
                return f"done {label}"

            compile_box._drive_batch_session = fake_zh
            await compile_box._run_batch_compile(run, "直接开始编译")
            assert driven and driven[-1].startswith("终审"), driven
            assert any(d.startswith("批 1/1|【分批编译 · 批 1/1") for d in driven), driven
            turn = next(e for e in _events(run) if e["type"] == "turn_done")
            assert "【批 1/1】" in turn["text"] and "【终审】" in turn["text"], turn
    finally:
        compile_box._drive_batch_session = real_drive
        del os.environ["KBC_BATCH_THRESHOLD_BYTES"]
        del os.environ["KBC_BATCH_BUDGET_BYTES"]
    print("✓ batch orchestrator review fixes: resume-prune / error turn_done / tail-note digest")


async def test_stall_interrupt_deadline_closes_turn():
    """Review fix: a true black-hole can swallow interrupt() too — the retry
    latch used to stay set forever (receive loop blocked, watchdog muted). Past
    the deadline the watchdog closes the turn honestly (error + turn_done) and
    disconnects to unblock the loop."""
    class _SwallowingClient(_StallingFakeClient):
        def __init__(self):
            super().__init__(produce_on_query=999)
            self.disconnects = 0

        async def interrupt(self):
            self.interrupts += 1          # accepted — but nothing ever arrives

        async def disconnect(self):
            self.disconnects += 1
            self._closed = True
            self._gate.set()              # let receive_messages exit

    fake = _SwallowingClient()
    saved = (compile_box._MODEL_IDLE_TIMEOUT_S, compile_box._MODEL_WATCHDOG_POLL_S,
             compile_box._MODEL_MAX_RETRIES, compile_box._STALL_INTERRUPT_DEADLINE_S)
    compile_box._MODEL_IDLE_TIMEOUT_S = 0.1
    compile_box._MODEL_WATCHDOG_POLL_S = 0.03
    compile_box._MODEL_MAX_RETRIES = 3
    compile_box._STALL_INTERRUPT_DEADLINE_S = 0.2
    try:
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.CompileRun("wdl", td, 1)
            run._suppress_turn_done = True
            run.client = fake
            wdog = asyncio.create_task(compile_box._model_stall_watchdog(run))
            try:
                await run.inject_user_message("批 1/10")
                await asyncio.wait_for(
                    compile_box._consume_turn_stream(run, fake, stop_on_result=True),
                    timeout=5)
            finally:
                run.done = True
                wdog.cancel()
                try:
                    await wdog
                except asyncio.CancelledError:
                    pass
            evs = _drain(run)
            types = [e["type"] for e in evs]
            assert fake.interrupts >= 1 and fake.disconnects == 1, (fake.interrupts, fake.disconnects)
            assert "error" in types and "turn_done" in types, types
            done_text = next(e["text"] for e in evs if e["type"] == "turn_done")
            assert "recreated automatically" in done_text, done_text  # honest: no in-place retry on this box
            assert not run._turn_active and not run._stall_retrying
    finally:
        (compile_box._MODEL_IDLE_TIMEOUT_S, compile_box._MODEL_WATCHDOG_POLL_S,
         compile_box._MODEL_MAX_RETRIES, compile_box._STALL_INTERRUPT_DEADLINE_S) = saved
    print("✓ stall interrupt deadline: wedged latch closes the turn (error + turn_done) and unblocks")


async def test_run_wrapper_cancels_detached_verify_tasks():
    """Audit batch B: a media/PK verify task mid-flight when the run ends kept
    burning model calls for minutes, then no-op'd its injection into a dead
    session. The wrapper's teardown now cancels both."""
    async def impl(run):
        loop = asyncio.get_running_loop()
        run._media_task = loop.create_task(asyncio.sleep(999))
        run._pk_task = loop.create_task(asyncio.sleep(999))

    saved = compile_box._COMPILE_IMPL
    compile_box._COMPILE_IMPL = impl
    try:
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.CompileRun("bgc", td, 1)
            await compile_box._run_wrapper(run)
            assert run._media_task.cancelled(), run._media_task
            assert run._pk_task.cancelled(), run._pk_task
    finally:
        compile_box._COMPILE_IMPL = saved
    print("✓ run wrapper cancels detached media/PK tasks (no token burn after run end)")


async def test_run_wrapper_closes_turn_on_driver_crash():
    """Review fix (never-block symmetry): a driver that dies mid-turn must not
    leave a consumer gating on turn_done hanging — error AND turn_done both fire."""
    async def dying_impl(run):
        run._begin_turn("owner message")   # a turn is in flight…
        raise compile_box.ModelStallError("exhausted")

    saved_impl = compile_box._COMPILE_IMPL
    compile_box._COMPILE_IMPL = dying_impl
    try:
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.CompileRun("wcr", td, 1)
            await compile_box._run_wrapper(run)
            evs = _drain(run)
            types = [e["type"] for e in evs]
            assert "error" in types and "turn_done" in types and types[-1] == "end", types
            assert types.index("error") < types.index("turn_done"), types
            assert getattr(run, "_ended", False) is True
    finally:
        compile_box._COMPILE_IMPL = saved_impl
    print("✓ run wrapper: driver crash mid-turn still closes the logical turn")


# ── Model-stall watchdog (L1) ────────────────────────────────────────────────


def _drain(run):
    evs = []
    while not run.events.empty():
        evs.append(run.events.get_nowait())
    return evs


class _StallingFakeClient:
    """Black-holes each attempt (receive blocks on a gate) until the Nth query;
    interrupt() unblocks with a bare ResultMessage (the interrupted attempt). The
    Nth query produces a real reply + ResultMessage. `produce_on_query=999` never
    recovers (exhaustion path)."""

    def __init__(self, options=None, produce_on_query=2):
        self.options = options
        self.queries = []
        self.interrupts = 0
        self._produce_on = produce_on_query
        self._gate = asyncio.Event()
        self._mode = "blackhole"
        self._closed = False

    async def connect(self, prompt=None):
        pass

    async def query(self, prompt, session_id="default"):
        self.queries.append(prompt)
        if len(self.queries) >= self._produce_on:
            self._mode = "produce"
        else:
            self._mode = "blackhole"          # no gate → receive blocks (the wedge)
        if self._mode == "produce":
            self._gate.set()

    async def interrupt(self):
        self.interrupts += 1
        self._mode = "interrupted"
        self._gate.set()

    async def receive_messages(self):
        while not self._closed:
            await self._gate.wait()
            self._gate.clear()
            if self._mode == "interrupted":
                yield ResultMessage()          # the interrupted attempt ends
            elif self._mode == "produce":
                yield AssistantMessage("批 1/10 完成")
                yield ResultMessage()
                self._closed = True
                return
            # blackhole → loop back and block on the gate again

    async def disconnect(self):
        self._closed = True


class _LiveStreamFake:
    """A live-but-slow generation: emits StreamEvent liveness faster than the idle
    bound, so the watchdog must never reap it."""

    def __init__(self, options=None, ticks=6, dt=0.05):
        self.options = options
        self.queries = []
        self.interrupts = 0
        self._ticks = ticks
        self._dt = dt

    async def connect(self, prompt=None):
        pass

    async def query(self, prompt, session_id="default"):
        self.queries.append(prompt)

    async def interrupt(self):
        self.interrupts += 1

    async def receive_messages(self):
        for _ in range(self._ticks):
            await asyncio.sleep(self._dt)
            yield StreamEvent()
        yield AssistantMessage("done streaming")
        yield ResultMessage()

    async def disconnect(self):
        pass


class _ToolGapFake:
    """A tool the CLI runs for a while: after the assistant asks for a tool
    (tool_pending), there is a model-silent gap longer than the idle bound but
    shorter than the tool bound — must NOT be reaped."""

    def __init__(self, options=None, gap=0.3):
        self.options = options
        self.queries = []
        self.interrupts = 0
        self._gap = gap

    async def connect(self, prompt=None):
        pass

    async def query(self, prompt, session_id="default"):
        self.queries.append(prompt)

    async def interrupt(self):
        self.interrupts += 1

    async def receive_messages(self):
        am = AssistantMessage("calling read")
        am.content = [TextBlock("calling read"), ToolUseBlock()]
        yield am                                # tool_pending = True
        await asyncio.sleep(self._gap)          # model-silent while the CLI runs the tool
        yield UserMessage()                     # tool_result → tool_pending = False
        yield AssistantMessage("read done")
        yield ResultMessage()

    async def disconnect(self):
        pass


async def _run_stall_scenario(fake, *, idle, poll, max_retries, tool_idle=660.0,
                              rate_base=None, rate_cap=None, rate_max=None):
    """Drive one turn through _consume_turn_stream with the watchdog running, at
    test-tuned knobs (restored after). Returns (run, drained events, raised)."""
    saved = (
        compile_box._MODEL_IDLE_TIMEOUT_S,
        compile_box._MODEL_TOOL_IDLE_TIMEOUT_S,
        compile_box._MODEL_MAX_RETRIES,
        compile_box._MODEL_WATCHDOG_POLL_S,
        compile_box._MODEL_RATE_BACKOFF_BASE_S,
        compile_box._MODEL_RATE_BACKOFF_CAP_S,
        compile_box._MODEL_RATE_MAX_RETRIES,
    )
    compile_box._MODEL_IDLE_TIMEOUT_S = idle
    compile_box._MODEL_TOOL_IDLE_TIMEOUT_S = tool_idle
    compile_box._MODEL_MAX_RETRIES = max_retries
    compile_box._MODEL_WATCHDOG_POLL_S = poll
    if rate_base is not None:
        compile_box._MODEL_RATE_BACKOFF_BASE_S = rate_base
    if rate_cap is not None:
        compile_box._MODEL_RATE_BACKOFF_CAP_S = rate_cap
    if rate_max is not None:
        compile_box._MODEL_RATE_MAX_RETRIES = rate_max
    raised = None
    with tempfile.TemporaryDirectory() as td:
        run = compile_box.CompileRun("wd", td, 1)
        run._suppress_turn_done = True          # isolate the watchdog from post-turn machinery
        run.client = fake
        wdog = asyncio.create_task(compile_box._model_stall_watchdog(run))
        try:
            await run.inject_user_message("批 1/10")
            await compile_box._consume_turn_stream(run, fake, stop_on_result=True)
        except compile_box.ModelStallError as e:
            raised = e
        finally:
            run.done = True
            wdog.cancel()
            try:
                await wdog
            except asyncio.CancelledError:
                pass
            (
                compile_box._MODEL_IDLE_TIMEOUT_S,
                compile_box._MODEL_TOOL_IDLE_TIMEOUT_S,
                compile_box._MODEL_MAX_RETRIES,
                compile_box._MODEL_WATCHDOG_POLL_S,
                compile_box._MODEL_RATE_BACKOFF_BASE_S,
                compile_box._MODEL_RATE_BACKOFF_CAP_S,
                compile_box._MODEL_RATE_MAX_RETRIES,
            ) = saved
    return run, _drain(run), raised


async def test_model_stall_retries_then_completes():
    """A black-holed model request is interrupted and re-issued on a fresh query;
    the retry produces output and the turn finishes (turn_stalled then completes)."""
    fake = _StallingFakeClient(produce_on_query=2)
    run, evs, raised = await _run_stall_scenario(fake, idle=0.15, poll=0.03, max_retries=3)
    types = [e["type"] for e in evs]
    assert raised is None, raised
    assert fake.interrupts == 1, fake.interrupts
    assert fake.queries == ["批 1/10", "批 1/10"], fake.queries
    assert "turn_stalled" in types, types
    assert run._last_turn_reply == "批 1/10 完成", run._last_turn_reply
    print("✓ model stall: interrupt + retry recovers a black-holed request")


async def test_model_stall_live_stream_not_reaped():
    """A live-but-slow generation (StreamEvents flowing) is never reaped (I4)."""
    fake = _LiveStreamFake(ticks=6, dt=0.05)
    run, evs, raised = await _run_stall_scenario(fake, idle=0.15, poll=0.03, max_retries=3)
    assert raised is None, raised
    assert fake.interrupts == 0, fake.interrupts
    assert "turn_stalled" not in [e["type"] for e in evs]
    print("✓ model stall: a live-but-slow stream is never reaped")


async def test_model_stall_tool_gap_not_reaped():
    """A model-silent gap while the CLI runs a tool (tool_pending) uses the longer
    tool bound — not mistaken for a model stall (I4)."""
    fake = _ToolGapFake(gap=0.3)
    run, evs, raised = await _run_stall_scenario(fake, idle=0.15, poll=0.03, max_retries=3, tool_idle=1.0)
    assert raised is None, raised
    assert fake.interrupts == 0, fake.interrupts
    assert "turn_stalled" not in [e["type"] for e in evs]
    print("✓ model stall: a long tool (tool_pending) is not mistaken for a stall")


async def test_model_stall_exhausts_to_error():
    """A request that never recovers is retried up to the bound, then fails the
    turn with ModelStallError (the run fails fast instead of hanging for ~1h)."""
    fake = _StallingFakeClient(produce_on_query=999)
    run, evs, raised = await _run_stall_scenario(fake, idle=0.1, poll=0.03, max_retries=2)
    types = [e["type"] for e in evs]
    assert isinstance(raised, compile_box.ModelStallError), raised
    assert fake.interrupts == 3, fake.interrupts          # 2 retries + the fatal attempt
    assert types.count("turn_stalled") == 3, types
    assert any(e["type"] == "turn_stalled" and e.get("fatal") for e in evs), evs
    print("✓ model stall: retries exhausted → ModelStallError (fails fast, no hang)")


# ── Rate-limit resilience (C2) ───────────────────────────────────────────────


class _RateLimitedFakeClient:
    """Ends each turn with a rate-limit error result until the Nth query, which
    produces a normal completion. `is_error` + `api_error_status` mirror the CLI's
    ResultMessage on a 429/503/529 (CLI >= 2.1.110)."""

    def __init__(self, options=None, succeed_on_query=2, status=429):
        self.options = options
        self.queries = []
        self.interrupts = 0
        self._succeed_on = succeed_on_query
        self._status = status
        self._gate = asyncio.Event()
        self._closed = False

    async def connect(self, prompt=None):
        pass

    async def query(self, prompt, session_id="default"):
        self.queries.append(prompt)
        self._gate.set()

    async def interrupt(self):
        self.interrupts += 1

    async def receive_messages(self):
        while not self._closed:
            await self._gate.wait()
            self._gate.clear()
            if len(self.queries) >= self._succeed_on:
                yield AssistantMessage("compiled ok")
                yield ResultMessage()
                self._closed = True
                return
            r = ResultMessage()
            r.is_error = True
            r.api_error_status = self._status
            yield r
            # loop back and wait for the retry query

    async def disconnect(self):
        self._closed = True


async def test_model_rate_limit_backoff_then_completes():
    """C2: a 429 error result backs off + re-issues; the retry completes."""
    fake = _RateLimitedFakeClient(succeed_on_query=2, status=429)
    run, evs, raised = await _run_stall_scenario(
        fake, idle=90, poll=0.03, max_retries=3, rate_base=0.01, rate_cap=0.02, rate_max=5)
    types = [e["type"] for e in evs]
    assert raised is None, raised
    assert fake.queries == ["批 1/10", "批 1/10"], fake.queries
    assert "rate_limited" in types, types
    assert next(e for e in evs if e["type"] == "rate_limited")["status"] == 429
    assert run._last_turn_reply == "compiled ok", run._last_turn_reply
    print("✓ rate limit: 429 backs off + re-issues, then completes (C2)")


async def test_model_rate_limit_exhausts_gracefully():
    """C2: persistent 529 → after the retry budget the turn ends with a clear note
    (run idle), not a crash."""
    fake = _RateLimitedFakeClient(succeed_on_query=999, status=529)
    run, evs, raised = await _run_stall_scenario(
        fake, idle=90, poll=0.03, max_retries=3, rate_base=0.01, rate_cap=0.02, rate_max=2)
    types = [e["type"] for e in evs]
    assert raised is None, raised                       # graceful, not a crash
    assert types.count("rate_limited") == 2, types      # rate_max retries
    assert any(e["type"] == "summary" and "rate-limited" in e.get("text", "") for e in evs), evs
    print("✓ rate limit: exhausted budget ends gracefully with a note, no crash (C2)")


# ── Graceful-shutdown flush (F3) ─────────────────────────────────────────────


async def test_shutdown_flush_syncs_active_runs():
    """F3: on_shutdown final-syncs each active run's unsynced workspace so a pod
    kill (SIGTERM) doesn't lose the last window of on-disk work."""
    saved = compile_box._SHUTDOWN_DRAIN_MAX_S
    compile_box._SHUTDOWN_DRAIN_MAX_S = 0.1
    try:
        with tempfile.TemporaryDirectory() as td:
            wd = Path(td)
            (wd / "candidate").mkdir(parents=True)
            (wd / "candidate" / "01.md").write_text("# page one\n", "utf-8")
            run = compile_box.CompileRun("shut1", td, 1)
            run._sync_sent = {}
            compile_box.RUNS["shut1"] = run
            try:
                await compile_box._flush_on_shutdown(None)
            finally:
                compile_box.RUNS.pop("shut1", None)
            evs = _drain(run)
            sync = [e for e in evs if e["type"] == "syncArtifacts"]
            assert sync, evs
            assert "candidate/01.md" in [a["path"] for a in sync[0]["artifacts"]], sync
    finally:
        compile_box._SHUTDOWN_DRAIN_MAX_S = saved
    print("✓ shutdown flush: final-syncs active runs' unsynced workspace (F3)")


def test_pr382_review_fixes():
    """Review fixes: brief guard + capped/last-marker raw (A/C), atomic writer (B),
    question-id parity vector + intentional dedup (D/E)."""
    good = ("开始生成知识库\n\n我的定调标签(请作为本次编译的 brief):\n"
            "- 给谁看:内部工程师\n- 内容倾向:详尽百科\n请执行。")
    b = compile_box.parse_brief_block(good)
    assert b and b["audience"] == "内部工程师", b
    # A(parse): marker present but no bullet field → None (a bare prose mention is not a brief)
    assert compile_box.parse_brief_block("关于我的定调标签我想补充一句") is None
    assert compile_box.parse_brief_block("我的定调标签") is None
    # C: raw is taken from the LAST marker and capped
    noise = ("我的定调标签 早前顺口提过\n我的定调标签(brief):\n- 给谁看:A\n" + "y" * 9000)
    b2 = compile_box.parse_brief_block(noise)
    assert b2 and b2["audience"] == "A", b2
    assert len(b2["raw"]) == compile_box._BRIEF_RAW_MAX and "早前顺口提过" not in b2["raw"], len(b2["raw"])

    # A(capture): first-wins — a later marker message never clobbers BRIEF.json
    with tempfile.TemporaryDirectory() as td:
        class _R:  # _capture_brief only reads .workdir
            workdir = td
        r = _R()
        assert compile_box._capture_brief(r, good) is True
        first = json.loads((Path(td) / "authoring" / "BRIEF.json").read_text())
        assert compile_box._capture_brief(r, "我的定调标签(brief):\n- 给谁看:别人\n") is False
        assert json.loads((Path(td) / "authoring" / "BRIEF.json").read_text()) == first

    # B: atomic writer round-trips + overwrites + leaves no temp
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "sub" / "x.json"
        compile_box._write_text_atomic(p, '{"a":1}\n')
        assert p.read_text() == '{"a":1}\n'
        compile_box._write_text_atomic(p, '{"a":2}\n')
        assert p.read_text() == '{"a":2}\n' and not list(Path(td).rglob("*.tmp"))

    # D/E: question-id parity vector — MUST equal the frontend's proposal-id.test vector
    def qid(q):
        return compile_box._question_id(compile_box._normalize_question(q))
    assert qid("GPU 有几张?") == "q-4d6d3b41"
    assert qid("gpu有几张。") == "q-4d6d3b41"            # E: case + trailing-punct + space collapse
    assert qid("Hello World") == "q-3b9f5c61"
    assert qid("\ufeffHello World") == "q-3b9f5c61"      # D: BOM stripped identically to the frontend
    assert qid("H100\tvs　A100") == "q-a5a7d897"
    assert qid("AbC?") == "q-1a47e90b"
    print("✓ pr382 review fixes (brief guard/cap/first-wins, atomic write, id parity vector)")


async def main():
    # PK never fires in these wiring tests — a qualifying fixture must not spawn
    # a real ClaudeEngine in the background (test_selfcheck covers PK wiring).
    os.environ["KBC_PK_MODE"] = "off"
    test_install_wiki_snapshot_size_guard()
    await test_workspace_sync()
    await test_run_wrapper_terminal_signals()
    await test_session_driver_conversational()
    await test_conversational_session()
    await test_message_waits_for_connect()
    test_pack_candidates_to_wiki()
    test_pack_candidates_symlink_confinement()
    await test_test_path_escape_guard()
    await test_prompt_packs_locale()
    await test_test_session_driver_readonly()
    await test_open_close_test_session_http()
    await test_test_message_path()
    await test_propose_plan_never_bounces()
    test_apply_session_config()
    test_parse_brief_block()
    test_merge_proposed_questions()
    await test_propose_questions_appends_dedup()
    await test_message_captures_brief()
    await test_incremental_route()
    await test_incremental_integrity_guard()
    await test_incremental_guard_rearms_on_ledger_repair()
    await test_incremental_violation_auto_restored()
    await test_unconverged_files_residual_ticket()
    await test_repair_turn_may_edit_ledger_target_pages()
    await test_incremental_index_deletion_cannot_escape_guard()
    await test_incremental_arm_cleared_when_dispatch_fails()
    await test_noop_repair_turn_reaches_the_gate()
    await test_batch_final_ledger_check_requires_index()
    await test_batch_orchestrator_routing_and_resume()
    await test_batch_orchestrator_review_fixes()
    await test_model_stall_retries_then_completes()
    await test_model_stall_live_stream_not_reaped()
    await test_model_stall_tool_gap_not_reaped()
    await test_model_stall_exhausts_to_error()
    await test_stall_interrupt_deadline_closes_turn()
    await test_run_wrapper_closes_turn_on_driver_crash()
    await test_run_wrapper_cancels_detached_verify_tasks()
    await test_model_rate_limit_backoff_then_completes()
    await test_model_rate_limit_exhausts_gracefully()
    await test_shutdown_flush_syncs_active_runs()
    test_pr382_review_fixes()

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

            r = await client.post("/session/r1", json={
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
            # /authoring IS allowed on a live run (200): the runtime rehydrates the
            # durable workspace / pushes assets into an existing session through it.
            r = await client.post("/authoring", json={
                "run_id": "r1",
                "workdir": td,
                "bundle_base64": base64.b64encode(authoring_bundle).decode(),
            })
            assert r.status == 200, await r.text()

            # /session is idempotent on a live run → no-op attach
            r = await client.post("/session/r1", json={"workdir": td})
            assert r.status == 200 and (await r.json()).get("already_live"), await r.text()

            sse = await client.get("/events/r1")
            events = await read_until(sse, "end")
            types = [e["type"] for e in events]
            # capability-era vocabulary: no parked, no done+bundle payload. A clean
            # session EXIT closes done→end (explicit terminal, so the runtime never
            # guesses from a bare end) — done carries no bundle and follows the turns.
            assert "summary" in types and "turn_done" in types and types[-2:] == ["done", "end"], types
            assert "parked" not in types, types
            done_ev = next(e for e in events if e["type"] == "done")
            assert "bundle" not in done_ev and "artifacts" not in done_ev, done_ev
            turn = next(e for e in events if e["type"] == "turn_done")
            assert turn["text"] == "compiled 1 page", turn
            # the candidate page the driver wrote is synced back as an artifact
            sync = next(e for e in events if e["type"] == "syncArtifacts")
            assert any(a["path"] == "candidate/index.md" for a in sync["artifacts"]), sync

        # unknown run events → 404
        r = await client.get("/events/nope")
        assert r.status == 404, r.status

        print("OK  compile_box protocol smoke (sources / authoring / health / session idempotent / SSE summary+turn_done+syncArtifacts+end / 409 / 404)")
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
