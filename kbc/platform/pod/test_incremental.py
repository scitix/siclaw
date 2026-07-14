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
    return f"---\ntype: Topic\ntitle: t\ncompiled_from:\n{cf}\n---\n正文。"


def _kb(base: Path):
    # 4 pages citing distinct raw sources; index routes them.
    _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [a](a.md)\n- [b](b.md)\n- [c](c.md)")
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
        # full-path matching: a bare basename does NOT match snap/four.md (no
        # basename fallback — matching is normalized full paths only)
        aff2, _ = incremental.resolve_affected_pages(td, {"modified": ["four.md"]})
        assert aff2 == [], aff2
        # added-only round → no existing page is "affected"
        aff3, un3 = incremental.resolve_affected_pages(td, {"added": ["snap/new.md"]})
        assert aff3 == [] and un3 == ["a.md", "b.md", "c.md"], (aff3, un3)
        print("OK  resolve_affected_pages (modified+deleted→pages, added≠affected, full-path only, index excluded)")


def test_no_basename_cross_match():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [s](snap-cfg.md)\n- [v](vendor-cfg.md)")
        _mk(base, "candidate/snap-cfg.md", _page(["snap/config.md"]))
        _mk(base, "candidate/vendor-cfg.md", _page(["vendor/config.md"]))
        # same basename, different directory: changing snap/config.md must NOT
        # pull in the page compiled only from vendor/config.md
        cs = incremental.build_changeset(td, {"modified": ["snap/config.md"]})
        assert cs["affected_pages"] == ["snap-cfg.md"], cs["affected_pages"]
        assert cs["unaffected_pages"] == ["vendor-cfg.md"], cs["unaffected_pages"]
        # …and because vendor-cfg.md is NOT authorized, the byte-freeze guard
        # still flags a genuine out-of-scope drift into it
        auth = incremental.authorized_pages(td, cs)
        assert "vendor-cfg.md" not in auth, auth
        before = incremental.page_hashes(td)
        _mk(base, "candidate/vendor-cfg.md", _page(["vendor/config.md"]) + "\n越界改动。")
        after = incremental.page_hashes(td)
        assert incremental.integrity_violations(before, after, auth) == ["vendor-cfg.md"], \
            "guard must flag out-of-scope edit to the same-basename sibling"
        print("OK  no basename cross-match (same-basename dirs isolated; guard still flags drift)")


def test_raw_prefix_normalization():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)\n- [q](q.md)")
        _mk(base, "candidate/p.md", _page(["raw/snap/one.md"]))   # prefixed compiled_from
        _mk(base, "candidate/q.md", _page(["snap/two.md"]))       # unprefixed compiled_from
        # original motivation intact: raw/-prefixed compiled_from ↔ unprefixed changeset
        aff, _ = incremental.resolve_affected_pages(td, {"modified": ["snap/one.md"]})
        assert aff == ["p.md"], aff
        # and the reverse: prefixed changeset ↔ unprefixed compiled_from
        aff2, _ = incremental.resolve_affected_pages(td, {"modified": ["raw/snap/two.md"]})
        assert aff2 == ["q.md"], aff2
        # ./ collapse + drop/ prefix normalize too
        aff3, _ = incremental.resolve_affected_pages(td, {"modified": ["./drop/snap/one.md"]})
        assert aff3 == ["p.md"], aff3
        print("OK  raw/drop prefix normalization (prefixed↔unprefixed full paths still match)")


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
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [a](a.md)\n- [b](b.md)\n- [c](c.md) edited")
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


def test_page_bytes_and_restore():
    """L0: out-of-scope violations are restored BY CODE from the pre-turn byte
    snapshot — modified pages written back, deleted pages recreated, byte-exact.
    A page absent from the snapshot (created out-of-scope / snapshot miss) is
    skipped, left for the repair-prompt fallback."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _kb(base)
        before = incremental.page_hashes(td)
        snap = incremental.page_bytes(td)
        assert set(snap) == set(before)
        assert all(isinstance(v, bytes) for v in snap.values())
        # model drifts: modifies c.md, deletes b.md, creates new.md
        _mk(base, "candidate/c.md", _page(["snap/four.md"]) + "\n擅自改动。")
        (base / "candidate/b.md").unlink()
        _mk(base, "candidate/new.md", _page(["snap/five.md"]) + "\n新页。")
        after = incremental.page_hashes(td)
        violations = incremental.integrity_violations(before, after, {"a.md"})
        assert set(violations) == {"b.md", "c.md"}, violations
        restored = incremental.restore_pages(td, snap, violations + ["new.md"])
        assert set(restored) == {"b.md", "c.md"}, restored  # new.md: no snapshot → skipped
        # byte-exact: the guard judges the restored tree clean
        after2 = incremental.page_hashes(td)
        assert incremental.integrity_violations(before, after2, {"a.md"}) == []
        assert (base / "candidate/b.md").read_bytes() == snap["b.md"]
        assert (base / "candidate/c.md").read_bytes() == snap["c.md"]
        print("OK  page_bytes + restore_pages (modified written back, deleted recreated, created skipped)")


def test_restore_skips_unrestorable_page():
    """Review fix: one unrestorable page (its path became a directory) must not
    abort the rest of the restore — it stays a violation for the repair prompt
    while every other page is still restored."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _kb(base)
        snap = incremental.page_bytes(td)
        # model drifts on b.md and c.md; b.md is then unrestorable (now a dir)
        (base / "candidate/b.md").unlink()
        (base / "candidate/b.md").mkdir()
        _mk(base, "candidate/c.md", _page(["snap/four.md"]) + "\n擅自改动。")
        restored = incremental.restore_pages(td, snap, ["b.md", "c.md"])
        assert restored == ["c.md"], restored  # c.md restored despite b.md failing
        assert (base / "candidate/c.md").read_bytes() == snap["c.md"]
        assert (base / "candidate/b.md").is_dir()  # left for the repair fallback
        print("OK  restore skips unrestorable page, restores the rest")


def test_diff_cap_degrades_oversized_diffs():
    """Batch C: an uncapped per-source diff could push CHANGESET.json past the
    1MB sync cap — absent from the store, a mid-round respawn loses the round.
    Oversized diffs degrade to "" (= the documented re-read-the-source path)."""
    with tempfile.TemporaryDirectory() as td:
        _kb(Path(td))
        big = "+x\n" * 40000  # ~120KB > default 64KB cap
        cs = incremental.build_changeset(
            td, {"modified": ["snap/one.md", "snap/two.md"]},
            diffs={"snap/one.md": big, "snap/two.md": "- old\n+ new"})
        by_path = {m["path"]: m["diff"] for m in cs["modified"]}
        assert by_path["snap/one.md"] == ""          # degraded, not shipped oversized
        assert by_path["snap/two.md"] == "- old\n+ new"  # small diff untouched
    print("OK  oversized per-source diffs degrade to re-read (CHANGESET stays syncable)")


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
    test_no_basename_cross_match()
    test_raw_prefix_normalization()
    test_build_changeset()
    test_integrity_guard()
    test_page_bytes_and_restore()
    test_restore_skips_unrestorable_page()
    test_diff_cap_degrades_oversized_diffs()
    test_protocol_raw_changes_to_changeset()
    test_added_targets_and_authorized()
    test_scoped_directive()
    test_integrity_repair_directive()
    print("\nALL OK  test_incremental")
