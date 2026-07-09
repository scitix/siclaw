"""Tests for the Layer-1 compile self-check (selfcheck.py + compile_box wiring).

Pure-function tests need only stdlib; the wiring test imports compile_box
(claude-agent-sdk required, same as test_compile_box.py). Run:
    python test_selfcheck.py
"""

import asyncio
import hashlib
import json
import os
import tempfile
from pathlib import Path

import selfcheck


def _mk(base: Path, rel: str, text: str = "x"):
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


PAGE_FULL = """---
type: 主题
compiled_from:
  - "85b3e13a · snapshot-a/one.md"
  - snapshot-a/two.md
  - 'raw/snapshot-b/three.txt'
---
正文 [[other]] 和 [链接](other.md)
"""

PAGE_DERIVED = """---
type: glossary
derived: true
---
综合页,无直接 raw 来源。
"""

PAGE_BARE = """---
type: 主题
---
没有 compiled_from 的页。
"""


def test_parse_compiled_from():
    src, derived, has = selfcheck.parse_compiled_from(PAGE_FULL)
    assert src == ["snapshot-a/one.md", "snapshot-a/two.md", "snapshot-b/three.txt"], src
    assert not derived and has
    src, derived, has = selfcheck.parse_compiled_from(PAGE_DERIVED)
    assert src == [] and derived and not has
    src, derived, has = selfcheck.parse_compiled_from(PAGE_BARE)
    assert src == [] and not derived and not has
    src, _, has = selfcheck.parse_compiled_from("---\ncompiled_from: []\n---\nx")
    assert src == [] and has
    src, _, has = selfcheck.parse_compiled_from("no frontmatter at all")
    assert src == [] and not has
    print("OK  parse_compiled_from (hash·path / plain / quoted / raw-prefix / derived / inline-empty)")


def test_inventory_and_exclusions():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snapshot-a/one.md")
        _mk(base, "raw/snapshot-a/pic.png")            # media → ALSO ledger-accountable
        _mk(base, "raw/.hidden/x.md")                  # hidden dir → skipped
        _mk(base, "raw/media/MANIFEST.tsv")            # text file in media dir → counted
        inv = selfcheck.source_inventory(td)
        assert inv == ["media/MANIFEST.tsv", "snapshot-a/one.md", "snapshot-a/pic.png"], inv
        assert selfcheck.source_inventory(td + "/nope") == []

        # exclusions: missing file → none; malformed → error; glob + dir-prefix forms
        assert selfcheck.load_exclusions(td) == ([], [])
        _mk(base, "authoring/EXCLUSIONS.json", "not json")
        entries, errs = selfcheck.load_exclusions(td)
        assert entries == [] and errs, (entries, errs)
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "media/", "reason": "媒体元文件"},
                        {"pattern": "snapshot-*/TICKET_*", "reason": "周报"},
                        {"bad": "entry"}]))
        entries, errs = selfcheck.load_exclusions(td)
        assert len(entries) == 2 and len(errs) == 1, (entries, errs)
        assert selfcheck._matches("media/MANIFEST.tsv", "media/")
        assert selfcheck._matches("snapshot-1/TICKET_x.md", "snapshot-*/TICKET_*")
        assert not selfcheck._matches("snapshot-1/one.md", "media/")
    print("OK  source_inventory + load_exclusions (text-only / hidden / glob / dir-prefix / malformed)")


def test_coverage_and_lint():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snapshot-a/one.md")
        _mk(base, "raw/snapshot-a/two.md")
        _mk(base, "raw/snapshot-a/ticket.md")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p1](p1.md)")
        _mk(base, "candidate/p1.md",
            "---\ncompiled_from:\n  - snapshot-a/one.md\n  - snapshot-a/ghost.md\n---\n[[nope]]")
        _mk(base, "candidate/bare.md", PAGE_BARE)
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "snapshot-a/ticket.md", "reason": "工单周报"}]))
        report = selfcheck.run_layer1(td)
        cov = report["coverage"]
        assert cov["total_sources"] == 3 and cov["excluded"] == 1, cov
        assert cov["unaccounted"] == ["snapshot-a/two.md"], cov
        assert cov["dangling_citations"] == ["snapshot-a/ghost.md"], cov
        assert not cov["closed"]
        kinds = sorted(v["kind"] for v in report["lint"]["violations"])
        # bare.md lacks provenance AND is unreachable from index; p1 has a
        # broken wikilink; index is exempt
        assert kinds == ["broken_wikilink", "no_provenance", "orphan"], kinds

        # repair prompt names the concrete gaps — locale-threaded, platform default = en
        report["state"] = "repairing"
        prompt = selfcheck.build_repair_prompt(report)  # default locale → en
        assert "snapshot-a/two.md" in prompt and "ghost.md" in prompt and "EXCLUSIONS.json" in prompt
        assert "Unaccounted raw source files" in prompt  # English by default
        zh_prompt = selfcheck.build_repair_prompt(report, "zh")
        assert "snapshot-a/two.md" in zh_prompt and "未入账" in zh_prompt
        assert "unaccounted" in selfcheck.narration(report, "en")
        assert "未入账" in selfcheck.narration(report, "zh")

        # close the ledger: cite two.md from bare.md (also fixes its provenance) + fix link
        _mk(base, "candidate/bare.md", "---\ncompiled_from:\n  - snapshot-a/two.md\n---\nok")
        _mk(base, "candidate/p1.md", "---\ncompiled_from:\n  - snapshot-a/one.md\n---\n[[bare]]")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report
        report["state"] = "passed"
        assert "closed" in selfcheck.narration(report)  # default locale → en
        assert "闭合" in selfcheck.narration(report, "zh")
    print("OK  coverage + lint + repair prompt (unaccounted / dangling / exempt index / close / locale)")


def test_media_ledger_and_new_lint():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/chart.png")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p1](p1.md)")
        # body cites the image but compiled_from omits it → body_source_uncited;
        # the image itself is unaccounted (media is in the ledger now)
        _mk(base, "candidate/p1.md",
            "---\ntitle: 监控\ncompiled_from:\n  - s/a.md\n---\n利用率 94%。(source: chart.png)")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["unaccounted"] == ["s/chart.png"], report["coverage"]
        kinds = sorted(v["kind"] for v in report["lint"]["violations"])
        assert kinds == ["body_source_uncited"], kinds
        # (来源: 内部访谈) / locators must NOT false-positive
        assert selfcheck._body_source_files("x (来源: 内部访谈) y (source: g.md, §3)") == ["g.md"]

        # register the image → ledger closes, lint clean, dangling stays empty
        _mk(base, "candidate/p1.md",
            "---\ntitle: 监控\ncompiled_from:\n  - s/a.md\n  - s/chart.png\n---\n利用率 94%。(source: chart.png)")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report
        assert report["coverage"]["dangling_citations"] == [], report["coverage"]

        # dup candidates: same normalized title / heavy source overlap
        _mk(base, "raw/s/b.md")
        _mk(base, "candidate/p2.md",
            "---\ntitle: 监控\ncompiled_from:\n  - s/b.md\n---\n[p1](p1.md)")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p1](p1.md) [p2](p2.md)")
        report = selfcheck.run_layer1(td)
        dups = report["dup_candidates"]
        assert len(dups) == 1 and sorted(dups[0]["pages"]) == ["p1.md", "p2.md"], dups
        assert dups[0]["reason"] == "标题相同", dups
    print("OK  media ledger + body_source_uncited + orphan-free close + dup_candidates")


def test_charset_corruption_detection():
    """U+FFFD (the lossy-UTF-8-decode marker) anywhere in a page — path OR body
    prose — must block state=passed. Body-prose corruption is INVISIBLE to the
    coverage ledger (it only diffs paths), so this lint is the only guard against
    silently shipping a \ufffd in published text (siflow-test 2026-07-07: 需/础/成 got
    mangled to 3× U+FFFD by an upstream stream chunk-boundary split)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p1](p1.md)")
        # U+FFFD in BODY prose only — paths are clean, so coverage closes.
        _mk(base, "candidate/p1.md",
            "---\ntitle: t\ncompiled_from:\n  - s/a.md\n---\n基\ufffd设施层说明。(source: a.md)")
        report = selfcheck.run_layer1(td)
        # The ledger alone would ship it: coverage is closed (corruption is prose).
        assert report["coverage"]["closed"], report["coverage"]
        # The lint catches it → not ok → compile_box cannot set state=passed.
        viols = [v for v in report["lint"]["violations"] if v["kind"] == "charset_corruption"]
        assert len(viols) == 1 and viols[0]["page"] == "p1.md", report["lint"]
        assert "第6行" in viols[0]["detail"], viols[0]["detail"]
        assert not report["lint"]["ok"]
        # It is surfaced to the model in the bounded repair turn.
        assert "charset_corruption" in selfcheck.build_repair_prompt(report)
        # A corrupted PATH is caught too (redundant with coverage's dangling, but
        # with actionable "restore from raw" guidance instead of "fix the path").
        _mk(base, "candidate/p1.md",
            "---\ntitle: t\ncompiled_from:\n  - s/\ufffd.md\n---\nclean body。(source: a.md)")
        report = selfcheck.run_layer1(td)
        assert any(v["kind"] == "charset_corruption" for v in report["lint"]["violations"])
        # Clean page → no charset violation, ledger closes, lint ok.
        _mk(base, "candidate/p1.md",
            "---\ntitle: t\ncompiled_from:\n  - s/a.md\n---\n基础设施层说明。(source: a.md)")
        report = selfcheck.run_layer1(td)
        assert all(v["kind"] != "charset_corruption" for v in report["lint"]["violations"])
        assert report["lint"]["ok"] and report["coverage"]["closed"], report
    print("OK  charset_corruption (U+FFFD) detection — path + body, blocks passed")


def test_media_verify_helpers():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/chart.png")
        _mk(base, "raw/s/other.png")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p1](p1.md) [t](text-only.md)")
        # compiled_from full path + body basename citation both resolve
        _mk(base, "candidate/p1.md",
            "---\ncompiled_from:\n  - s/a.md\n  - s/chart.png\n---\n94%。(source: other.png)")
        _mk(base, "candidate/text-only.md", "---\ncompiled_from:\n  - s/a.md\n---\nx")
        citing = selfcheck.media_citing_pages(td)
        assert citing == {"p1.md": ["s/chart.png", "s/other.png"]}, citing

        pending = selfcheck.pending_media_verification(td)
        assert list(pending) == ["p1.md"]

        selfcheck.mark_media_verified(td, list(pending))
        assert selfcheck.pending_media_verification(td) == {}
        # run_layer1 must carry media_verify forward (not wipe it)
        report = selfcheck.run_layer1(td)
        assert report["media_verify"]["verified_pages"] == ["p1.md"], report["media_verify"]
        selfcheck.write_selfcheck(td, report)
        assert selfcheck.pending_media_verification(td) == {}
    print("OK  media_citing_pages + pending/mark idempotency + carry-forward")


def test_cap_media_pending():
    pend = {"a.md": ["i1", "i2"], "b.md": ["i3"], "c.md": ["i4", "i5", "i6"]}
    c = selfcheck.cap_media_pending(pend, 3)
    assert c == {"a.md": ["i1", "i2"], "b.md": ["i3"]}, c
    # an oversized single page is still included alone (progress guaranteed)
    c2 = selfcheck.cap_media_pending({"z.md": ["1", "2", "3", "4"]}, 2)
    assert list(c2) == ["z.md"]
    print("OK  cap_media_pending (whole pages / oversized-single)")


def test_dangling_alone_blocks_closed():
    """L1: closed = consistent in BOTH directions. A lone dangling citation (all
    sources accounted, lint clean) used to sail through settle as display-only
    owner homework on the publish page — it must gate the repair loop instead."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snap/one.md")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p1](p1.md)")
        _mk(base, "candidate/p1.md",
            "---\ncompiled_from:\n  - snap/one.md\n  - snap/deleted-long-ago.md\n---\n正文。")
        cov = selfcheck.run_layer1(td)["coverage"]
        assert cov["unaccounted"] == [] and cov["dangling_citations"] == ["snap/deleted-long-ago.md"], cov
        assert not cov["closed"], "a dangling citation alone must keep the ledger open"
        # narration names the dangling count so a dangling-only repair round is explained
        report = {"coverage": cov, "lint": {"ok": True, "violations": []}, "state": "repairing"}
        assert "悬空引用" in selfcheck.narration(report, "zh")
        assert "dangling" in selfcheck.narration(report, "en")
        # fix the citation → closed
        _mk(base, "candidate/p1.md", "---\ncompiled_from:\n  - snap/one.md\n---\n正文。")
        cov2 = selfcheck.run_layer1(td)["coverage"]
        assert cov2["closed"], cov2
        print("OK  dangling alone blocks closed (bidirectional ledger) + narration names it")


def test_file_residual_ticket():
    """L2: budget spent with residuals → CODE files ONE ticket in the owner's
    queue (model schema, stable content-fingerprint id). Dedupes on repeat,
    preserves the model's tickets, refuses to clobber an unreadable ledger."""
    report = {
        "coverage": {"unaccounted": ["snap/two.md"], "dangling_citations": []},
        "lint": {"ok": False, "violations": [{"page": "p1.md", "kind": "orphan", "detail": "unreachable"}]},
        "incremental": {"out_of_scope_pages": ["c.md"]},
        "state": "unconverged",
    }
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "authoring/CONTRADICTIONS.json",
            json.dumps([{"id": "model-1", "title": "既有工单", "status": "open"}]))
        assert selfcheck.file_residual_ticket(td, report, "zh") is True
        tickets = json.loads((base / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8"))
        assert len(tickets) == 2 and tickets[0]["id"] == "model-1"  # model ticket preserved
        t = tickets[1]
        assert t["id"].startswith("selfcheck-residual-") and t["status"] == "open" and t["answer"] is None
        assert "未入账源: snap/two.md" in t["sources"][0]["quote"]
        assert sorted(t["affected_pages"]) == ["c.md", "p1.md"]
        assert t["options"] and t["current_value"]
        # same residuals again → dedupe, no second ticket
        assert selfcheck.file_residual_ticket(td, report, "zh") is False
        assert len(json.loads((base / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8"))) == 2
        # different residuals → a fresh ticket (new fingerprint)
        report2 = {"coverage": {"unaccounted": [], "dangling_citations": ["snap/ghost.md"]},
                   "lint": {"ok": True, "violations": []}, "state": "unconverged"}
        assert selfcheck.file_residual_ticket(td, report2, "en") is True
        assert len(json.loads((base / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8"))) == 3
    with tempfile.TemporaryDirectory() as td:
        # nothing residual → no ticket
        clean = {"coverage": {"unaccounted": [], "dangling_citations": []},
                 "lint": {"ok": True, "violations": []}}
        assert selfcheck.file_residual_ticket(td, clean) is False
        assert not (Path(td) / "authoring/CONTRADICTIONS.json").exists()
    with tempfile.TemporaryDirectory() as td:
        # unreadable ledger → bail rather than clobber the model's tickets
        _mk(Path(td), "authoring/CONTRADICTIONS.json", "{oops")
        assert selfcheck.file_residual_ticket(td, report) is False
        assert (Path(td) / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8") == "{oops"
    print("OK  file_residual_ticket (files/dedupes/preserves/bails, fingerprint id)")


def test_ledger_repair_pages():
    """Interlock: the pages a ledger/lint repair legitimately edits — the byte
    guard must authorize exactly these on the repair turn, or the mechanical
    restore reverts the repair itself (live 07-09: 4 charset fixes + 1 orphan
    deletion all undone → unconverged)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[a](a.md) [c](c.md)")
        _mk(base, "candidate/a.md", "---\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        _mk(base, "candidate/c.md", "---\ncompiled_from:\n  - snap/ghost.md\n---\n正文c。")
        report = {
            "coverage": {"dangling_citations": ["snap/ghost.md"]},
            "lint": {"ok": False, "violations": [
                {"page": "b.md", "kind": "charset_corruption", "detail": "…"},
                {"page": selfcheck.EXCLUSIONS_PATH, "kind": "exclusions_invalid", "detail": "…"},
            ]},
        }
        pages = selfcheck.ledger_repair_pages(td, report)
        # lint page in; EXCLUSIONS pseudo-page out; dangling-citing page resolved
        assert pages == ["b.md", "c.md"], pages
        # clean report → nothing to widen
        assert selfcheck.ledger_repair_pages(td, {"coverage": {}, "lint": {"ok": True, "violations": []}}) == []
        print("OK  ledger_repair_pages (lint pages + dangling-citing pages, pseudo-entries excluded)")


def test_state_key():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        assert selfcheck.state_key(td) is None  # no candidate tree yet
        _mk(base, "candidate/index.md", "i")
        k1 = selfcheck.state_key(td)
        _mk(base, "candidate/p.md", "p")
        k2 = selfcheck.state_key(td)
        assert k1 and k2 and k1 != k2
        # exclusions-only change MUST rotate the key (repair may only add exclusions)
        _mk(base, "authoring/EXCLUSIONS.json", "[]")
        k3 = selfcheck.state_key(td)
        assert k3 != k2
    print("OK  state_key (None / candidate change / exclusions-only change)")


class _FakeRun:
    """Just the attrs _post_turn_selfcheck touches: the engine-neutral surface."""
    def __init__(self, workdir):
        self.workdir = workdir
        self._selfcheck_key = None
        self._l1_repairs_used = 0
        self.summaries: list[str] = []
        self.injected: list[str] = []

    async def emit(self, ev):
        if ev.get("type") == "summary":
            self.summaries.append(ev["text"])

    async def inject_user_message(self, text):
        self.injected.append(text)


async def test_wiring():
    from compile_box import _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/b.md")
        run = _FakeRun(td)

        # no candidate yet → no-op
        assert await _post_turn_selfcheck(run) is None

        # index exists, b.md unaccounted → repairing + repair prompt returned
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md)")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n---\nx")
        msg = await _post_turn_selfcheck(run)
        assert msg and "s/b.md" in msg, msg
        assert run._l1_repairs_used == 1
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
        assert sc["state"] == "repairing" and sc["coverage"]["unaccounted"] == ["s/b.md"], sc

        # same state again (idempotency key unchanged) → no re-check, no double-inject
        assert await _post_turn_selfcheck(run) is None

        # agent repairs by EXCLUSIONS ONLY (no candidate edit) → re-check fires → passed
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "s/b.md", "reason": "活数据"}]))
        assert await _post_turn_selfcheck(run) is None
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
        assert sc["state"] == "passed", sc
        assert run._l1_repairs_used == 0  # budget resets on close

        # budget exhaustion: reopen the gap twice without fixing → unconverged, no injection
        _mk(base, "raw/s/c.md")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n---\nx2")  # rotate key
        assert await _post_turn_selfcheck(run) is not None      # round 1 → repairing
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n---\nx3")  # agent "fixed" nothing
        assert await _post_turn_selfcheck(run) is None          # budget spent → unconverged
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
        assert sc["state"] == "unconverged", sc
    print("OK  wiring (trigger gating / repair inject / exclusions-only reopen / budget → unconverged)")


async def test_media_verify_wiring():
    """Blind-verify wiring (v2): settled-draft gate, ≤max-images chunking with
    the remainder rolling to the next trigger, findings → repair injection,
    clean chunk → no injection, all-verified → PK unblocked."""
    import compile_box
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "raw/s/i2.png")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md) [q](q.md)")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        _mk(base, "candidate/q.md", "---\ncompiled_from:\n  - s/i2.png\n---\ny")
        run = _FakeRun(td)

        calls: list[dict] = []

        async def fake_verify(engine, workdir, pending, progress=None, locale=None):
            calls.append(dict(pending))
            done = sorted(pending)  # every page in the chunk verifies to completion
            if len(calls) == 1:  # first chunk: one confirmed misread (still a COMPLETED verification)
                return {"findings": [{"page": "p.md", "image": "s/i1.png", "kind": "不一致",
                                      "claim": "GPU-Util 94%", "expected": "GPU-Util 0%(94% 是 MEM 条)",
                                      "fix": "改为 0%"}],
                        "errors": [], "images": 1, "cache_hits": 0,
                        "completed_pages": done, "failed_pages": []}
            return {"findings": [], "errors": [], "images": 1, "cache_hits": 1,
                    "completed_pages": done, "failed_pages": []}

        os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"] = "1"
        os.environ["KBC_PK_MODE"] = "auto"  # so the PK-yields assertion is meaningful
        orig = mv.run_blind_verify
        mv.run_blind_verify = fake_verify
        try:
            # not settled yet → no start (selfcheck hasn't run/passed)
            assert not _maybe_start_media_verify(run)
            assert await _post_turn_selfcheck(run) is None  # ledger closes → passed
            assert _maybe_start_media_verify(run)           # chunk 1 (p.md, cap 1 image)
            await run._media_task
            assert calls[0] == {"p.md": ["s/i1.png"]}, calls
            assert run.injected and "[System self-check · image verification]" in run.injected[-1] and "94% 是 MEM 条" in run.injected[-1]
            assert compile_box._pk_due(run) is None         # q.md still pending → PK waits
            assert _maybe_start_media_verify(run)           # remainder rolls: chunk 2 (q.md)
            await run._media_task
            assert calls[1] == {"q.md": ["s/i2.png"]}, calls
            assert len(run.injected) == 1                   # clean chunk → no injection
            assert not _maybe_start_media_verify(run)       # all verified → done
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"]
            os.environ["KBC_PK_MODE"] = "off"
    print("OK  blind media-verify wiring (gate / chunk+roll / findings→repair / PK yields)")




async def test_media_failed_pages_retry_then_exhaust():
    """Review fix: verified marks land only AFTER a completed verification.
    A failed page retries on later triggers, bounded by KBC_MEDIA_VERIFY_ATTEMPTS,
    then ships with a VISIBLE exhausted flag — never a silent false-pass."""
    import compile_box
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md)")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        run = _FakeRun(td)

        async def failing_verify(engine, workdir, pending, progress=None, locale=None):
            return {"findings": [], "errors": ["transcription failed s/i1.png: boom"],
                    "images": 1, "cache_hits": 0,
                    "completed_pages": [], "failed_pages": sorted(pending)}

        os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"] = "2"
        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = failing_verify
        try:
            assert await _post_turn_selfcheck(run) is None      # ledger passes → settled draft
            assert _maybe_start_media_verify(run)               # attempt 1
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert "p.md" not in (mvsec.get("verified_pages") or []), mvsec  # NOT falsely passed
            assert mvsec["attempts"]["p.md"] == 1, mvsec
            run._media_task = None
            assert _maybe_start_media_verify(run)               # attempt 2 (retry, not skipped)
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert mvsec["attempts"]["p.md"] == 2, mvsec
            assert "p.md" in mvsec["verified_pages"] and "p.md" in mvsec["exhausted"], mvsec
            run._media_task = None
            assert not _maybe_start_media_verify(run)           # budget spent → no more retries
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"]
    print("OK  media failed pages retry then exhaust (visible flag, no silent false-pass)")


async def test_media_attempt_count_resets_on_success():
    """Round-4 review fix: a page that fails once then completes verification
    must have its attempt count cleared — a stale residue would push a later
    re-entry to 'exhausted' after fewer real failures than the budget implies."""
    import compile_box
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md)")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        run = _FakeRun(td)
        calls = [0]

        async def flaky_verify(engine, workdir, pending, progress=None, locale=None):
            calls[0] += 1
            if calls[0] == 1:  # first attempt: transcription failure
                return {"findings": [], "errors": ["transcription failed s/i1.png: flaky"],
                        "images": 1, "cache_hits": 0,
                        "completed_pages": [], "failed_pages": sorted(pending)}
            return {"findings": [], "errors": [], "images": 1, "cache_hits": 0,
                    "completed_pages": sorted(pending), "failed_pages": []}

        os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"] = "3"
        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = flaky_verify
        try:
            assert await _post_turn_selfcheck(run) is None
            assert _maybe_start_media_verify(run)           # attempt 1 → fails
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc["media_verify"]["attempts"]["p.md"] == 1, sc["media_verify"]
            run._media_task = None
            assert _maybe_start_media_verify(run)           # attempt 2 → succeeds
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert "p.md" in mvsec["verified_pages"] and "p.md" not in (mvsec.get("exhausted") or []), mvsec
            assert "p.md" not in (mvsec.get("attempts") or {}), mvsec  # count cleared on success
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"]
    print("OK  media attempt count resets on successful verification")


async def test_pk_failed_state_settles_converge():
    """Review fix: run_pk is fail-open and RETURNS state=failed — both that and
    an outright raise must still terminalize converge_phase (it used to wedge
    at 'verifying', locking the frontend test-step gate forever)."""
    import compile_box
    import redblue as rb

    for scenario in ("returns_failed", "raises"):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            _mk(base, "raw/s/a.md")
            _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md)")
            _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n---\nx")
            run = _FakeRun(td)
            os.environ["KBC_PK_MODE"] = "off"
            assert await compile_box._post_turn_selfcheck(run) is None

            async def fake_failed(engine, **kw):
                return ({"state": "failed", "error": "pk infra down", "questions": 0}, {})

            async def fake_raises(engine, **kw):
                raise RuntimeError("pk infra down")

            orig = rb.run_pk
            rb.run_pk = fake_failed if scenario == "returns_failed" else fake_raises
            os.environ["KBC_PK_MODE"] = "auto"
            try:
                await compile_box._run_pk_flow(run, "full")
            finally:
                rb.run_pk = orig
                os.environ["KBC_PK_MODE"] = "off"
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc["pk"]["state"] == "failed", (scenario, sc["pk"])
            assert sc.get("converge_phase") == "settled", (scenario, sc.get("converge_phase"))
    print("OK  pk failed/raise still settles converge_phase (no verifying wedge)")



async def test_pk_wiring():
    """S2 red-blue wiring: due-gating → full pass → repairing + repair inject →
    targeted retest → merged final scoreboard → idempotent (tree hash stamped)."""
    import compile_box
    import redblue as rb

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md)")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n---\nx")
        run = _FakeRun(td)
        os.environ["KBC_PK_MODE"] = "off"
        assert await compile_box._post_turn_selfcheck(run) is None  # ledger passes
        assert compile_box._pk_due(run) is None                     # mode off
        os.environ["KBC_PK_MODE"] = "auto"
        assert compile_box._pk_due(run) == "full"

        async def fake_run_pk(engine, **kw):
            if kw.get("questions_override"):
                assert [q["id"] for q in kw["questions_override"]] == ["q1"]
                return ({"state": "passed", "questions": 1, "graded": 1, "gate_pass": 1,
                         "pass_rate": 1.0, "failures": [], "wall_secs": 1},
                        {"questions": kw["questions_override"], "answers": {}, "verdicts": {}})
            return ({"state": "unconverged", "questions": 3, "graded": 3, "gate_pass": 2,
                     "pass_rate": 0.667, "wall_secs": 1,
                     "failures": [{"id": "q1", "question": "问", "score": "错",
                                   "category": "覆盖", "page": "p.md", "fix": "补"}]},
                    {"questions": [{"id": "q1", "question": "问"}, {"id": "q2", "question": "b"},
                                   {"id": "q3", "question": "c"}],
                     "answers": {"q1": {"answer": "长" * 9000}}, "verdicts": {}})

        orig = rb.run_pk
        rb.run_pk = fake_run_pk
        try:
            await compile_box._run_pk_flow(run, "full")
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc["pk"]["state"] == "repairing" and sc["pk"]["rounds_used"] == 0, sc["pk"]
            # converge phase = revising (verify found issues → a repair was injected)
            assert sc["converge_phase"] == "revising", sc.get("converge_phase")
            assert run.injected and "[System self-check · red-blue PK]" in run.injected[-1] and "补" in run.injected[-1]
            detail = json.loads((base / "authoring/PK_RESULT.json").read_text())
            assert len(detail["answers"]["q1"]["answer"]) == 4000  # persisted truncated

            assert compile_box._pk_due(run) == "retest"
            await compile_box._run_pk_flow(run, "retest")
            scc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            pk = scc["pk"]
            # merged scoreboard: 2 passes from the full round + 1 resolved retest
            assert pk["state"] == "passed" and pk["rounds_used"] == 1, pk
            assert pk["questions"] == 3 and pk["gate_pass"] == 3 and pk["pass_rate"] == 1.0, pk
            # converged → phase settles to "settled" (the draft is stable + testable)
            assert scc["converge_phase"] == "settled", scc.get("converge_phase")
            assert compile_box._pk_due(run) is None  # tree hash stamped → idempotent
        finally:
            rb.run_pk = orig
            os.environ["KBC_PK_MODE"] = "off"
    print("OK  pk wiring (gating / repairing+inject / targeted retest merge / idempotent / converge phase)")


async def test_seam_settles_when_nothing_pending():
    """The turn seam sets converge_phase='settled' when no ledger repair, no media,
    no PK is pending — so converge_phase is AUTHORITATIVE even with verify OFF, and
    the frontend gates the test step on 'settled' with no config lookup."""
    import compile_box
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md)")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n---\nx")

        class _R:  # just what _emit_message touches
            workdir = td
            _selfcheck_key = None
            _l1_repairs_used = 0
            _turn_text = ["编好了"]
            _sync_sent = None
            _suppress_turn_done = False
            async def emit(self, ev):
                pass
            async def inject_user_message(self, t):
                pass

        class ResultMessage:  # type(msg).__name__ drives the seam
            pass

        os.environ["KBC_PK_MODE"] = "off"        # verify OFF (both layers)
        os.environ["KBC_MEDIA_VERIFY"] = "off"
        try:
            await compile_box._emit_message(_R(), ResultMessage())
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc.get("converge_phase") == "settled", sc.get("converge_phase")
        finally:
            os.environ["KBC_PK_MODE"] = "off"
            os.environ.pop("KBC_MEDIA_VERIFY", None)
    print("OK  seam settles converge_phase when nothing pending (verify-off authoritative)")


def test_converge_phase_helper():
    """set_converge_phase: writes the durable authoritative signal (verifying/
    revising/settled), preserves the L1 coverage section, ignores junk phases."""
    import selfcheck
    with tempfile.TemporaryDirectory() as td:
        _mk(Path(td), "raw/s/a.md")
        _mk(Path(td), "candidate/index.md", "---\ntype: index\n---\ni")
        _mk(Path(td), "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n---\nx")
        selfcheck.write_selfcheck(td, selfcheck.run_layer1(td))  # L1 first
        selfcheck.set_converge_phase(td, "verifying")
        sc = json.loads((Path(td) / "authoring/SELFCHECK.json").read_text())
        assert sc["converge_phase"] == "verifying" and sc["coverage"]["closed"], sc  # L1 preserved
        selfcheck.set_converge_phase(td, "settled")
        assert json.loads((Path(td) / "authoring/SELFCHECK.json").read_text())["converge_phase"] == "settled"
        selfcheck.set_converge_phase(td, "bogus")  # invalid → no-op, phase unchanged
        assert json.loads((Path(td) / "authoring/SELFCHECK.json").read_text())["converge_phase"] == "settled"
    print("OK  set_converge_phase (durable signal, L1 preserved, junk ignored)")


def test_pack_hash_is_relposix_sorted():
    """pack_candidates_to_wiki must hash in rel_posix-STRING order so a draft
    pinned here and a published bundle installed by compile_box._install_wiki_snapshot
    yield the SAME snapshot_hash for byte-identical content (the question ×
    snapshot grading key is comparable across sources). Uses a nested tree where
    Path-sort and string-sort diverge (dir `a/` vs files `a.md`/`a-x.md`)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        files = {"index.md": "i", "a.md": "A", "a-x.md": "X", "a/b.md": "B"}
        for rel, txt in files.items():
            _mk(base, f"candidate/{rel}", txt)
        h, n = selfcheck.pack_candidates_to_wiki(str(base), base / "snap")
        assert n == 4, n
        # canonical hash = entries sorted by rel_posix string (same formula as
        # _install_wiki_snapshot), NOT filesystem Path order
        want = hashlib.sha256()
        for rp, txt in sorted(files.items()):
            want.update(rp.encode()); want.update(b"\0"); want.update(txt.encode()); want.update(b"\0")
        assert h == want.hexdigest(), "pack hash must be rel_posix-string ordered (draft/published comparability)"
    print("OK  pack hash is rel_posix-sorted (draft/published snapshot comparability, nested-tree safe)")


def test_parse_compiled_from_inline():
    """Fix D: an inline flow list must parse to sources (previously → [] → spurious repair)."""
    src, _, has = selfcheck.parse_compiled_from('---\ncompiled_from: [raw/a.md, "b.md"]\n---\nx')
    assert has and src == ["a.md", "b.md"], src
    src, _, has = selfcheck.parse_compiled_from("---\ncompiled_from: [snapshot/x.md]\n---\ny")
    assert has and src == ["snapshot/x.md"], src
    src, _, has = selfcheck.parse_compiled_from("---\ncompiled_from: []\n---\nz")  # still empty-but-present
    assert has and src == [], src
    print("OK  parse_compiled_from inline flow list (fix D)")


def test_matches_segment_aware():
    """Fix B: `*` never crosses `/`; raw/ prefix on the exclusion side is normalized."""
    assert selfcheck._matches("notes/a.md", "notes/*")
    assert not selfcheck._matches("notes/sub/secret.md", "notes/*")  # over-exclusion false-PASS closed
    assert selfcheck._matches("notes/sub/secret.md", "notes/**")     # ** crosses segments
    assert selfcheck._matches("notes/sub/secret.md", "notes/")       # dir-prefix = whole subtree
    assert selfcheck._matches("live.csv", "raw/live.csv")            # prefix-mismatch false-GAP closed
    assert selfcheck._matches("d/live.csv", "drop/d/live.csv")
    print("OK  _matches segment-aware + prefix-normalized (fix B)")


def test_noop_exclusion_warning():
    """Fix B#3: an exclusion matching no source is surfaced as a warning (not blocking)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/a.md"); _mk(base, "candidate/index.md", "---\ntype: index\n---\ni")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - a.md\n---\nx")
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "nope/*.md", "reason": "typo, matches nothing"}]))
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["noop_exclusions"] == ["nope/*.md"], report["coverage"]
        assert report["coverage"]["closed"]  # non-blocking: still closed
        assert "no source" in selfcheck.narration({**report, "state": "passed"}, "en")
    print("OK  no-op exclusion surfaced, non-blocking (fix B#3)")


def test_candidate_tree_hash_unreadable():
    """Fix C: a perm-denied candidate file must not crash state_key (runs before fail-open)."""
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        print("OK  candidate_tree_hash unreadable (skipped as root)"); return
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "candidate/index.md", "i")
        bad = base / "candidate" / "denied.md"; bad.write_text("x"); bad.chmod(0)
        try:
            assert selfcheck.state_key(td) is not None  # must NOT raise
        finally:
            bad.chmod(0o644)  # let tempdir cleanup succeed
    print("OK  candidate_tree_hash tolerates a perm-denied file (fix C)")


def test_content_hash_shared_formula():
    """Design: pack / tree / canonical must agree for byte-identical content (nested)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        files = {"index.md": "i", "a.md": "A", "a/b.md": "B"}  # nested: Path- vs string-sort diverge
        for rel, txt in files.items():
            _mk(base, f"candidate/{rel}", txt)
        h_pack, _ = selfcheck.pack_candidates_to_wiki(str(base), base / "snap")
        h_tree = selfcheck.candidate_tree_hash(str(base))
        want = selfcheck.content_hash([(rel, txt.encode()) for rel, txt in files.items()])
        assert h_pack == want == h_tree, (h_pack, h_tree, want)
    print("OK  content_hash: pack == tree == canonical (single shared formula)")


def main():
    os.environ["KBC_L1_REPAIR_ROUNDS"] = "1"
    os.environ.setdefault("KBC_PK_MODE", "off")  # PK never fires in unrelated wiring tests
    test_parse_compiled_from()
    test_parse_compiled_from_inline()
    test_inventory_and_exclusions()
    test_matches_segment_aware()
    test_noop_exclusion_warning()
    test_coverage_and_lint()
    test_media_ledger_and_new_lint()
    test_media_verify_helpers()
    test_cap_media_pending()
    test_dangling_alone_blocks_closed()
    test_file_residual_ticket()
    test_ledger_repair_pages()
    test_state_key()
    test_candidate_tree_hash_unreadable()
    test_pack_hash_is_relposix_sorted()
    test_content_hash_shared_formula()
    asyncio.run(test_wiring())
    asyncio.run(test_media_verify_wiring())
    asyncio.run(test_media_failed_pages_retry_then_exhaust())
    asyncio.run(test_media_attempt_count_resets_on_success())
    asyncio.run(test_pk_failed_state_settles_converge())
    asyncio.run(test_pk_wiring())
    asyncio.run(test_seam_settles_when_nothing_pending())
    test_converge_phase_helper()
    print("ALL OK  test_selfcheck")


if __name__ == "__main__":
    main()
