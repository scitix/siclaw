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


async def main():
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
