"""Tests for the box-side incremental core (incremental.py). Pure stdlib. Run:
    python test_incremental.py
"""

import json
import tempfile
from pathlib import Path

import incremental


def _mk(base: Path, rel: str, text: str = "x"):
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _page(sources: list[str]) -> str:
    cf = "\n".join(f"  - {s}" for s in sources)
    return f"---\ntitle: t\ncompiled_from:\n{cf}\n---\n正文。"


def _kb(base: Path):
    # 4 pages citing distinct raw sources; index routes them.
    _mk(base, "candidate/index.md", "---\ntype: index\n---\n[a](a.md) [b](b.md) [c](c.md)")
    _mk(base, "candidate/a.md", _page(["snap/one.md", "snap/two.md"]))
    _mk(base, "candidate/b.md", _page(["snap/three.md"]))
    _mk(base, "candidate/c.md", _page(["snap/four.md"]))


def test_resolve_affected_pages():
    with tempfile.TemporaryDirectory() as td:
        _kb(Path(td))
        # modified two.md → only page a cites it; deleted three.md → page b.
        aff, un = incremental.resolve_affected_pages(
            td, {"added": [], "modified": ["snap/two.md"], "deleted": ["snap/three.md"]})
        assert aff == ["a.md", "b.md"], aff
        assert un == ["c.md"], un                      # index excluded from both
        # basename tolerance: compiled_from carries raw-relative, changeset a bare name
        aff2, _ = incremental.resolve_affected_pages(td, {"modified": ["four.md"]})
        assert aff2 == ["c.md"], aff2
        # added-only round → no existing page is "affected"
        aff3, un3 = incremental.resolve_affected_pages(td, {"added": ["snap/new.md"]})
        assert aff3 == [] and un3 == ["a.md", "b.md", "c.md"], (aff3, un3)
        print("OK  resolve_affected_pages (modified+deleted→pages, added≠affected, basename, index excluded)")


def test_build_changeset():
    with tempfile.TemporaryDirectory() as td:
        _kb(Path(td))
        cs = incremental.build_changeset(
            td,
            {"added": ["snap/new.md"], "modified": ["snap/one.md"], "deleted": ["snap/four.md"]},
            diffs={"snap/one.md": "- old fact\n+ new fact"},
            baseline_fingerprint="BASE", snapshot_fingerprint="SNAP",
        )
        assert cs["baseline_fingerprint"] == "BASE" and cs["snapshot_fingerprint"] == "SNAP"
        # modified carries its affected page + the unified diff
        assert cs["modified"] == [{"path": "snap/one.md", "affected_pages": ["a.md"], "diff": "- old fact\n+ new fact"}]
        # deleted carries its affected page; added has no affected page (needs a home)
        assert cs["deleted"] == [{"path": "snap/four.md", "affected_pages": ["c.md"]}]
        assert cs["added"] == [{"path": "snap/new.md", "content_ref": "snap/new.md", "target_hint": ""}]
        # affected = union(modified,deleted)-cited; unaffected = the rest; index touched (added/deleted)
        assert cs["affected_pages"] == ["a.md", "c.md"] and cs["unaffected_pages"] == ["b.md"], cs
        assert cs["index_touched"] is True
        # pure-modified round → index NOT touched (page set unchanged)
        cs2 = incremental.build_changeset(td, {"modified": ["snap/one.md"]})
        assert cs2["index_touched"] is False and cs2["modified"][0]["diff"] == ""  # no diff supplied → degrade
        print("OK  build_changeset (3 categories, diff passthrough, affected/unaffected, index_touched)")


def test_integrity_guard():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _kb(base)
        before = incremental.page_hashes(td)
        # model legitimately edits a.md (affected) + index; leaves b/c untouched → no violation
        _mk(base, "candidate/a.md", _page(["snap/one.md", "snap/two.md"]) + "\n新事实。")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\n[a](a.md) [b](b.md) [c](c.md) edited")
        after = incremental.page_hashes(td)
        assert incremental.changed_pages(before, after) == {"a.md": "modified", "index.md": "modified"}
        assert incremental.integrity_violations(before, after, {"a.md"}) == []       # index auto-allowed
        # now the model ALSO drifts into c.md (unaffected, not authorized) → violation
        _mk(base, "candidate/c.md", _page(["snap/four.md"]) + "\n擅自改动。")
        after2 = incremental.page_hashes(td)
        assert incremental.integrity_violations(before, after2, {"a.md"}) == ["c.md"], "must flag out-of-scope edit"
        # added-target: if c.md is a declared home for an added source, it's authorized → no violation
        assert incremental.integrity_violations(before, after2, {"a.md", "c.md"}) == []
        # deleting an unauthorized page is also a violation
        (base / "candidate/b.md").unlink()
        after3 = incremental.page_hashes(td)
        assert "b.md" in incremental.integrity_violations(before, after3, {"a.md", "c.md"})
        # a NEWLY CREATED page (added source → new page) is NOT a violation, even
        # undeclared — the guard only protects existing pages from modify/delete;
        # coverage + orphan lint gate spurious new pages.
        _mk(base, "candidate/brand-new.md", _page(["snap/five.md"]) + "\n新页。")
        after4 = incremental.page_hashes(td)
        assert "brand-new.md" not in incremental.integrity_violations(before, after4, {"a.md"}), \
            "a newly created page must not be flagged as out-of-scope"
        print("OK  integrity guard (affected+index allowed, out-of-scope edit/delete flagged, created page allowed, added-target honored)")


def test_protocol_raw_changes_to_changeset():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _kb(base)
        # absent / malformed / empty → None (box falls back to full compile)
        assert incremental.load_raw_changes(td) is None
        assert incremental.materialize_changeset(td) is None
        _mk(base, "authoring/RAW_CHANGES.json", "{oops")
        assert incremental.load_raw_changes(td) is None
        _mk(base, "authoring/RAW_CHANGES.json", json.dumps({"added": [], "modified": [], "deleted": []}))
        assert incremental.has_changes(incremental.load_raw_changes(td)) is False
        assert incremental.materialize_changeset(td) is None

        # real consumer input → enriched CHANGESET.json written, affected_pages resolved
        _mk(base, "authoring/RAW_CHANGES.json", json.dumps({
            "added": [], "modified": ["snap/two.md"], "deleted": [],
            "diffs": {"snap/two.md": "- old\n+ new"},
            "baseline_fingerprint": "BASE", "snapshot_fingerprint": "SNAP",
        }))
        cs = incremental.materialize_changeset(td)
        assert cs is not None and cs["affected_pages"] == ["a.md"], cs        # box reverse-looked-up
        assert cs["modified"][0]["diff"] == "- old\n+ new"                    # the consumer's diff passed through
        # persisted for the model to read
        written = json.loads((base / "authoring/CHANGESET.json").read_text())
        assert written["affected_pages"] == ["a.md"] and written["snapshot_fingerprint"] == "SNAP"
        print("OK  protocol (RAW_CHANGES → enriched CHANGESET; absent/malformed/empty → None fallback)")


def test_added_targets_and_authorized():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _kb(base)
        cs = incremental.build_changeset(td, {"added": ["snap/new.md"], "modified": ["snap/two.md"]})
        assert cs["affected_pages"] == ["a.md"]
        # no declaration yet → authorized = affected ∪ index (added merge would be flagged)
        assert incremental.authorized_pages(td, cs) == {"a.md", "index.md"}
        # model declares it homed the added source into b.md → b.md now authorized
        _mk(base, "authoring/ADDED_TARGETS.json", json.dumps(["b.md"]))
        assert incremental.authorized_pages(td, cs) == {"a.md", "b.md", "index.md"}
        # malformed declaration → ignored (guard stays strict, fail-safe)
        _mk(base, "authoring/ADDED_TARGETS.json", "{oops")
        assert incremental.authorized_pages(td, cs) == {"a.md", "index.md"}
        print("OK  added-target declaration + authorized_pages (strict when absent/malformed)")


def test_scoped_directive():
    cs = {"added": [1], "modified": [1, 1], "deleted": []}
    d = incremental.build_scoped_directive(cs)                # default locale = English
    assert "CHANGESET.json" in d and "2 modified source(s)" in d and "1 added source(s)" in d
    assert "ADDED_TARGETS.json" in d and "sha256" in d  # declares the two contracts the guard depends on
    print("OK  scoped directive (counts + CHANGESET + added-target + byte-guard mentioned)")


def test_integrity_repair_directive():
    d = incremental.build_integrity_repair(["c.md", "d.md"])  # default locale = English
    assert "Incremental scope violation" in d and "c.md" in d and "d.md" in d
    assert "Restore each one to its content from before" in d and "ADDED_TARGETS.json" in d
    # zh branch: full Chinese variant when the consumer declares locale=zh
    dz = incremental.build_integrity_repair(["c.md"], locale="zh")
    assert "增量越界" in dz and "还原到本轮开始前" in dz and "c.md" in dz
    print("OK  integrity repair directive (names violating pages + restore instruction, en default + zh branch)")


if __name__ == "__main__":
    test_resolve_affected_pages()
    test_build_changeset()
    test_integrity_guard()
    test_protocol_raw_changes_to_changeset()
    test_added_targets_and_authorized()
    test_scoped_directive()
    test_integrity_repair_directive()
    print("\nALL OK  test_incremental")
