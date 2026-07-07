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
        _mk(base, "raw/snapshot-a/pic.png")            # binary ext → not a text source
        _mk(base, "raw/.hidden/x.md")                  # hidden dir → skipped
        _mk(base, "raw/media/MANIFEST.tsv")            # text file in media dir → counted
        inv = selfcheck.source_inventory(td)
        assert inv == ["media/MANIFEST.tsv", "snapshot-a/one.md"], inv
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
        # bare.md lacks provenance; p1 has a broken wikilink; index is exempt
        assert kinds == ["broken_wikilink", "no_provenance"], kinds

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
        _mk(base, "candidate/index.md", "---\ntype: index\n---\nidx")
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
    test_parse_compiled_from()
    test_parse_compiled_from_inline()
    test_inventory_and_exclusions()
    test_matches_segment_aware()
    test_noop_exclusion_warning()
    test_coverage_and_lint()
    test_state_key()
    test_candidate_tree_hash_unreadable()
    test_pack_hash_is_relposix_sorted()
    test_content_hash_shared_formula()
    asyncio.run(test_wiring())
    print("ALL OK  test_selfcheck")


if __name__ == "__main__":
    main()
