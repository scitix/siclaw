"""Tests for the Layer-1 compile self-check (selfcheck.py + compile_box wiring).

Pure-function tests need only stdlib; the wiring test imports compile_box
(claude-agent-sdk required, same as test_compile_box.py). Run:
    python test_selfcheck.py
"""

import asyncio
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

        # repair prompt names the concrete gaps
        report["state"] = "repairing"
        prompt = selfcheck.build_repair_prompt(report)
        assert "snapshot-a/two.md" in prompt and "ghost.md" in prompt and "EXCLUSIONS.json" in prompt
        assert "未入账" in selfcheck.narration(report)

        # close the ledger: cite two.md from bare.md (also fixes its provenance) + fix link
        _mk(base, "candidate/bare.md", "---\ncompiled_from:\n  - snapshot-a/two.md\n---\nok")
        _mk(base, "candidate/p1.md", "---\ncompiled_from:\n  - snapshot-a/one.md\n---\n[[bare]]")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report
        report["state"] = "passed"
        assert "闭合" in selfcheck.narration(report)
    print("OK  coverage + lint + repair prompt (unaccounted / dangling / exempt index / close)")


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
        prompt = selfcheck.build_media_verify_prompt(pending)
        assert "raw/s/chart.png" in prompt and "图像复核" in prompt

        selfcheck.mark_media_verified(td, list(pending))
        assert selfcheck.pending_media_verification(td) == {}
        # run_layer1 must carry media_verify forward (not wipe it)
        report = selfcheck.run_layer1(td)
        assert report["media_verify"]["verified_pages"] == ["p1.md"], report["media_verify"]
        selfcheck.write_selfcheck(td, report)
        assert selfcheck.pending_media_verification(td) == {}
    print("OK  media_citing_pages + pending/mark idempotency + carry-forward")


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
    from compile_box import _post_turn_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/chart.png")
        run = _FakeRun(td)
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md)")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - s/a.md\n  - s/chart.png\n---\nx")
        assert await _post_turn_selfcheck(run) is None       # ledger closes → passed
        msg = await _post_turn_media_verify(run)
        assert msg and "p.md" in msg and "chart.png" in msg, msg
        assert await _post_turn_media_verify(run) is None    # one-shot per page
        # a NEW image-citing page later re-arms the pass for that page only
        _mk(base, "candidate/q.md", "---\ncompiled_from:\n  - s/chart.png\n---\ny")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[p](p.md) [q](q.md)")
        assert await _post_turn_selfcheck(run) is None       # still closed
        msg = await _post_turn_media_verify(run)
        assert msg and "q.md" in msg and "- p.md" not in msg, msg
    print("OK  media-verify wiring (settled-draft gate / one-shot / new-page re-arm)")


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
            assert run.injected and "红蓝队" in run.injected[-1] and "补" in run.injected[-1]
            detail = json.loads((base / "authoring/PK_RESULT.json").read_text())
            assert len(detail["answers"]["q1"]["answer"]) == 4000  # persisted truncated

            assert compile_box._pk_due(run) == "retest"
            await compile_box._run_pk_flow(run, "retest")
            pk = json.loads((base / "authoring/SELFCHECK.json").read_text())["pk"]
            # merged scoreboard: 2 passes from the full round + 1 resolved retest
            assert pk["state"] == "passed" and pk["rounds_used"] == 1, pk
            assert pk["questions"] == 3 and pk["gate_pass"] == 3 and pk["pass_rate"] == 1.0, pk
            assert compile_box._pk_due(run) is None  # tree hash stamped → idempotent
        finally:
            rb.run_pk = orig
            os.environ["KBC_PK_MODE"] = "off"
    print("OK  pk wiring (gating / repairing+inject / targeted retest merge / idempotent)")


def main():
    os.environ["KBC_L1_REPAIR_ROUNDS"] = "1"
    os.environ.setdefault("KBC_PK_MODE", "off")  # PK never fires in unrelated wiring tests
    test_parse_compiled_from()
    test_inventory_and_exclusions()
    test_coverage_and_lint()
    test_media_ledger_and_new_lint()
    test_media_verify_helpers()
    test_state_key()
    asyncio.run(test_wiring())
    asyncio.run(test_media_verify_wiring())
    asyncio.run(test_pk_wiring())
    print("ALL OK  test_selfcheck")


if __name__ == "__main__":
    main()
