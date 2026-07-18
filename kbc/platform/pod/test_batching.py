"""Unit tests for the deterministic half of batch mode (batching.py).

House convention: self-runner script (python test_batching.py), pytest-free —
each test gets a fresh tmp dir from the main() harness.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import batching as bt


def _mk(tmp_path: Path, files: dict[str, int]) -> Path:
    raw = tmp_path / "raw"
    for rel, size in files.items():
        p = raw / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * size)
    return raw


def test_scan_skips_hidden_and_empty(tmp_path):
    raw = _mk(tmp_path, {"a.md": 10, ".hidden/b.md": 10, "c/.dot.md": 10, "empty.md": 0})
    inv = bt.scan_sources(raw)
    assert [i["path"] for i in inv] == ["a.md"]


def test_threshold_gate_small_kb_never_batches(tmp_path):
    raw = _mk(tmp_path, {"a.md": 100 * 1024, "b.md": 200 * 1024})
    inv = bt.scan_sources(raw)
    assert bt.should_batch(inv, threshold=400 * 1024) is False
    assert bt.should_batch(inv, threshold=250 * 1024) is True


def test_tiered_gate_keeps_small_and_medium_routes_stable(tmp_path):
    raw = _mk(tmp_path, {"a.md": 500 * 1024})
    inv = bt.scan_sources(raw)
    assert bt.should_batch(inv, threshold=400 * 1024) is True
    assert bt.should_hierarchical(inv, threshold=8 * 1024 * 1024) is False
    huge = _mk(tmp_path / "huge", {"a.md": 9 * 1024 * 1024})
    huge_inv = bt.scan_sources(huge)
    assert bt.should_hierarchical(huge_inv, threshold=8 * 1024 * 1024) is True


def test_pack_groups_by_top_dir_and_budget(tmp_path):
    raw = _mk(
        tmp_path,
        {
            "sdk/a.md": 90,
            "sdk/b.md": 90,
            "sdk/c.md": 90,
            "ops/d.md": 50,
            "root.md": 10,
        },
    )
    inv = bt.scan_sources(raw)
    batches = bt.pack_batches(inv, budget=200)
    # ops/, root(""), sdk/ in sorted path order; sdk splits at the budget.
    by_sources = [b["sources"] for b in batches]
    assert ["ops/d.md"] in by_sources
    assert ["root.md"] in by_sources
    sdk_batches = [b for b in by_sources if b and b[0].startswith("sdk/")]
    assert len(sdk_batches) == 2  # 90+90 then 90
    flat = [p for b in by_sources for p in b]
    assert sorted(flat) == sorted(i["path"] for i in inv)  # exactly once


def test_pack_oversized_single_file_gets_own_batch(tmp_path):
    raw = _mk(tmp_path, {"big/x.md": 500, "big/y.md": 50})
    inv = bt.scan_sources(raw)
    batches = bt.pack_batches(inv, budget=200)
    assert batches[0]["sources"] == ["big/x.md"]
    assert batches[1]["sources"] == ["big/y.md"]


def test_hierarchical_pack_keeps_document_assets_together(tmp_path):
    raw = _mk(
        tmp_path,
        {
            "gpu/guide.md": 100,
            "gpu/guide.assets/a.png": 1_000,
            "gpu/guide.assets/b.png": 1_000,
            "gpu/other.md": 50,
            "ops/runbook.md": 50,
        },
    )
    inv = bt.scan_sources(raw)
    batches = bt.pack_hierarchical_batches(inv, budget=300_000)
    gpu = next(b for b in batches if "gpu/guide.md" in b["sources"])
    assert set(gpu["sources"]) >= {
        "gpu/guide.md", "gpu/guide.assets/a.png", "gpu/guide.assets/b.png"}
    assert bt.validate_plan(
        bt.build_plan(inv, batches, planner="hierarchical-code", budget=300_000),
        inv,
        budget=300_000,
    ) == []


def test_hierarchical_pack_splits_oversized_family_with_anchor_context(tmp_path):
    raw = _mk(
        tmp_path,
        {
            "gpu/guide.md": 10,
            "gpu/guide.assets/a.png": 1_000,
            "gpu/guide.assets/b.png": 1_000,
            "gpu/guide.assets/c.png": 1_000,
        },
    )
    inv = bt.scan_sources(raw)
    # Hierarchical images cost 128KB, so a 140KB budget forces one/chunk while
    # still leaving room to repeat the tiny Markdown anchor as context.
    budget = 140 * 1024
    batches = bt.pack_hierarchical_batches(inv, budget=budget)
    assert len(batches) == 3, batches
    assert batches[0]["sources"][0] == "gpu/guide.md"
    assert all(b["context_sources"] == ["gpu/guide.md"] for b in batches[1:])
    flat_sources = [p for b in batches for p in b["sources"]]
    assert sorted(flat_sources) == sorted(i["path"] for i in inv)
    plan = bt.build_plan(inv, batches, planner="hierarchical-code", budget=budget)
    assert plan["mode"] == "hierarchical" and plan["phase"] == "map"
    assert bt.validate_plan(plan, inv, budget=budget) == []


def test_validate_hierarchical_context_is_known_and_budgeted(tmp_path):
    raw = _mk(tmp_path, {"guide.md": 100, "guide.assets/a.png": 1_000})
    inv = bt.scan_sources(raw)
    unknown = {"batches": [{
        "id": "h001", "sources": ["guide.md", "guide.assets/a.png"],
        "context_sources": ["ghost.md"],
    }]}
    assert any("unknown context source" in e for e in bt.validate_plan(unknown, inv, budget=100_000))
    duplicate = {"batches": [{
        "id": "h001", "sources": ["guide.md", "guide.assets/a.png"],
        "context_sources": ["guide.md"],
    }]}
    assert any("also repeated as context" in e for e in bt.validate_plan(duplicate, inv, budget=100_000))


def test_hierarchical_text_cap_preserves_session_context_safety(tmp_path):
    raw = _mk(tmp_path, {"docs/a.md": 300 * 1024, "docs/b.md": 300 * 1024})
    inv = bt.scan_sources(raw)
    batches = bt.pack_hierarchical_batches(
        inv, budget=1024 * 1024, text_budget=400 * 1024)
    assert len(batches) == 2, batches
    plan = bt.build_plan(
        inv, batches, planner="hierarchical-code", budget=1024 * 1024,
        text_budget=400 * 1024)
    assert bt.validate_plan(
        plan, inv, budget=1024 * 1024, text_budget=400 * 1024) == []


def test_hierarchical_large_anchor_is_not_replayed_into_every_image_chunk(tmp_path):
    files = {"gpu/manual.md": 120 * 1024}
    files.update({f"gpu/manual.assets/page-{i:03d}.jpg": 1_000 for i in range(20)})
    raw = _mk(tmp_path, files)
    inv = bt.scan_sources(raw)
    batches = bt.pack_hierarchical_batches(inv, budget=1024 * 1024)
    manual_batches = [b for b in batches if any("manual" in p for p in b["sources"])]
    assert "gpu/manual.md" in manual_batches[0]["sources"]
    assert len(manual_batches) > 1
    assert all(b["context_sources"] == [] for b in manual_batches[1:])


def test_hierarchical_image_cost_is_conservative_without_moving_flat_boundaries(tmp_path):
    previous = os.environ.get("KBC_HIERARCHICAL_IMAGE_COST_BYTES")
    os.environ["KBC_HIERARCHICAL_IMAGE_COST_BYTES"] = str(128 * 1024)
    try:
        files = {"guide.md": 100 * 1024}
        files.update({f"guide.assets/page-{i:03d}.jpg": 1_000 for i in range(30)})
        raw = _mk(tmp_path, files)
        inv = bt.scan_sources(raw)
        # The medium/flat route keeps its established 30KB estimate.
        image = next(i for i in inv if i["path"].endswith("page-000.jpg"))
        assert image["effective"] == 30 * 1024
        batches = bt.pack_hierarchical_batches(inv, budget=1024 * 1024)
        image_counts = [sum(p.endswith(".jpg") for p in b["sources"]) for b in batches]
        assert max(image_counts) <= 8, image_counts
        plan = bt.build_plan(
            inv, batches, planner="hierarchical-code", budget=1024 * 1024)
        assert bt.validate_plan(plan, inv, budget=1024 * 1024) == []
    finally:
        if previous is None:
            os.environ.pop("KBC_HIERARCHICAL_IMAGE_COST_BYTES", None)
        else:
            os.environ["KBC_HIERARCHICAL_IMAGE_COST_BYTES"] = previous


def test_validate_plan_accepts_code_baseline(tmp_path):
    raw = _mk(tmp_path, {"a/one.md": 100, "b/two.md": 100})
    inv = bt.scan_sources(raw)
    plan = bt.build_plan(inv, bt.pack_batches(inv, budget=150), planner="code", budget=150)
    assert bt.validate_plan(plan, inv, budget=150) == []


def test_validate_plan_rejects_missing_duplicate_unknown_overflow(tmp_path):
    raw = _mk(tmp_path, {"a.md": 100, "b.md": 100, "c.md": 100})
    inv = bt.scan_sources(raw)
    plan = {
        "batches": [
            {"id": "b01", "sources": ["a.md", "b.md", "b.md"]},          # dup
            {"id": "b02", "sources": ["ghost.md"]},                        # unknown
            # c.md missing entirely
        ]
    }
    errors = bt.validate_plan(plan, inv, budget=150)
    text = "\n".join(errors)
    assert "appears in" in text and "unknown source ghost.md" in text and "not covered: c.md" in text
    # multi-file overflow rejected; single oversized file allowed
    over = {"batches": [{"id": "b01", "sources": ["a.md", "b.md", "c.md"]}]}
    assert any("exceeds budget" in e for e in bt.validate_plan(over, inv, budget=150))
    solo = {"batches": [{"id": "b01", "sources": ["a.md"]}, {"id": "b02", "sources": ["b.md"]}, {"id": "b03", "sources": ["c.md"]}]}
    assert bt.validate_plan(solo, inv, budget=50) == []


def test_normalize_model_plan_and_progress(tmp_path):
    raw = _mk(tmp_path, {"a.md": 10, "b.md": 10})
    inv = bt.scan_sources(raw)
    norm = bt.normalize_model_plan({"batches": [{"sources": ["a.md"]}, {"id": "late", "sources": ["b.md"]}]})
    assert norm and [b["id"] for b in norm["batches"]] == ["b01", "late"]
    plan = bt.build_plan(inv, norm["batches"], planner="model")
    assert len(bt.pending_batches(plan)) == 2
    bt.stamp_done(plan, "b01")
    assert [b["id"] for b in bt.pending_batches(plan)] == ["late"]
    assert bt.normalize_model_plan({"batches": "nope"}) is None
    assert bt.normalize_model_plan([1, 2]) is None


def test_section_reductions_group_only_unambiguous_multi_page_sections(tmp_path):
    pages = {
        "gpu/a.md": {"sources": ["gpu/a.md"], "bytes": 100},
        "gpu/b.md": {"sources": ["gpu/b.md"], "bytes": 100},
        "ops/a.md": {"sources": ["ops/a.md"], "bytes": 100},
        "mixed.md": {"sources": ["gpu/c.md", "ops/c.md"], "bytes": 100},
        "derived.md": {"sources": [], "bytes": 100},
        "index.md": {"sources": [], "bytes": 100},
    }
    reductions = bt.pack_section_reductions(pages, budget=500)
    assert len(reductions) == 1, reductions
    assert reductions[0]["section"] == "gpu"
    assert reductions[0]["pages"] == ["gpu/a.md", "gpu/b.md"]
    plan = {"reductions": reductions}
    assert len(bt.pending_reductions(plan)) == 1
    bt.stamp_reduction_done(plan, reductions[0]["id"])
    assert bt.pending_reductions(plan) == []


def test_effective_weights_images_pdf_binary(tmp_path: Path):
    raw = _mk(tmp_path, {"a.md": 1000})
    img = raw / "media" / "shot.png"
    img.parent.mkdir(parents=True, exist_ok=True)
    img.write_bytes(b"p" * 170_000)
    # synthetic pdf: 5 page markers + a /Pages tree node that must NOT count
    pdf = raw / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4 /Type /Pages " + b"/Type /Page 1 " * 5 + b"x" * 500_000)
    other = raw / "blob.bin"
    other.write_bytes(b"z" * 100_000)
    inv = {i["path"]: i for i in bt.scan_sources(raw)}
    assert inv["a.md"]["effective"] == 1000
    assert inv["media/shot.png"]["effective"] == 30 * 1024          # flat image cost
    assert inv["doc.pdf"]["effective"] == 5 * 8 * 1024              # pages x page-cost
    assert inv["blob.bin"]["effective"] == int(100_000 * 0.3)
    print("effective:", {k: v["effective"] for k, v in inv.items()})


def test_pack_uses_effective_not_raw_bytes(tmp_path: Path):
    # 10 images x 170KB raw = 1.7MB raw, but 10 x 30KB effective = 300KB →
    # fits in TWO 200KB batches instead of ten solo batches.
    files = {f"media/s{i:02d}.png": 170_000 for i in range(10)}
    raw = _mk(tmp_path, files)
    inv = bt.scan_sources(raw)
    batches = bt.pack_batches(inv, budget=200 * 1024)
    assert len(batches) == 2, [b["sources"] for b in batches]
    # threshold also weighted: 300KB effective < 400KB default → no batching
    assert bt.should_batch(inv, threshold=400 * 1024) is False


def test_pdf_fallback_when_no_markers(tmp_path: Path):
    raw = _mk(tmp_path, {"a.md": 10})
    pdf = raw / "opaque.pdf"
    pdf.write_bytes(b"%PDF-1.7 compressed-object-streams " + b"q" * 2_000_000)
    inv = {i["path"]: i for i in bt.scan_sources(raw)}
    eff = inv["opaque.pdf"]["effective"]
    assert 30 * 1024 <= eff <= 400 * 1024  # clamped byte heuristic


def test_plan_fragmentation_guard(tmp_path: Path):
    base = [{"id": f"b{i:02d}", "sources": [f"s{i}"]} for i in range(14)]
    ok_model = [{"id": f"m{i:02d}", "sources": [f"s{i}"]} for i in range(16)]      # 14→16: fine
    frag_model = [{"id": f"m{i:02d}", "sources": [f"s{i}"]} for i in range(25)]    # 14→25: rejected
    assert bt.plan_too_fragmented(ok_model, base) is False
    assert bt.plan_too_fragmented(frag_model, base) is True
    tiny_base = [{"id": "b01", "sources": ["a"]}, {"id": "b02", "sources": ["b"]}]
    assert bt.plan_too_fragmented([{}, {}, {}, {}], tiny_base) is False  # +2 allowance for tiny plans
    assert bt.plan_too_fragmented([{}, {}, {}, {}, {}], tiny_base) is True


def test_validate_plan_rejects_duplicate_and_empty_batch_ids(tmp_path: Path):
    """Review fix: stamp_done marks EVERY batch with the matching id, so a plan
    with twin ids would stamp both on the first completion and silently never
    run the second. validate_plan must reject it up front."""
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "a.md").write_bytes(b"x" * 10)
    (raw / "b.md").write_bytes(b"y" * 10)
    inv = bt.scan_sources(raw)
    dup = {"batches": [{"id": "b01", "sources": ["a.md"]}, {"id": "b01", "sources": ["b.md"]}]}
    errs = bt.validate_plan(dup, inv, budget=100)
    assert any("duplicate batch id" in e for e in errs), errs
    empty = {"batches": [{"id": " ", "sources": ["a.md"]}, {"sources": ["b.md"]}]}
    errs = bt.validate_plan(empty, inv, budget=100)
    assert sum("empty or missing id" in e for e in errs) == 2, errs


def test_scan_confines_symlinks(tmp_path: Path):
    """Review fix (defense-in-depth): a symlink under raw/ pointing outside must
    not be inventoried — same realpath confinement as the snapshot pinner."""
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "real.md").write_bytes(b"x" * 10)
    outside = tmp_path / "outside.md"
    outside.write_bytes(b"secret" * 10)
    (raw / "leak.md").symlink_to(outside)          # file symlink → skipped
    (raw / "dir").symlink_to(tmp_path / "raw2", target_is_directory=True)
    (tmp_path / "raw2").mkdir()
    (tmp_path / "raw2" / "esc.md").write_bytes(b"z" * 10)  # via dir symlink → confined away
    paths = [i["path"] for i in bt.scan_sources(raw)]
    assert paths == ["real.md"], paths


def test_prune_missing_sources(tmp_path: Path):
    """Review fix: on resume, sources deleted from raw/ are dropped from PENDING
    batches (a batch left empty is stamped done); done batches stay untouched."""
    plan = {"batches": [
        {"id": "b01", "sources": ["gone.md", "kept.md"]},
        {"id": "b02", "sources": ["all-gone.md"]},
        {"id": "b03", "sources": ["done-gone.md"], "status": "done"},
    ]}
    dropped = bt.prune_missing_sources(plan, {"kept.md"})
    assert sorted(dropped) == ["all-gone.md", "gone.md"], dropped
    assert plan["batches"][0]["sources"] == ["kept.md"]
    assert plan["batches"][1]["status"] == "done" and plan["batches"][1]["sources"] == []
    assert plan["batches"][2]["sources"] == ["done-gone.md"]  # history, not instructions
    assert [b["id"] for b in bt.pending_batches(plan)] == ["b01"]


def main():
    tests = [
        test_scan_skips_hidden_and_empty,
        test_threshold_gate_small_kb_never_batches,
        test_tiered_gate_keeps_small_and_medium_routes_stable,
        test_pack_groups_by_top_dir_and_budget,
        test_pack_oversized_single_file_gets_own_batch,
        test_hierarchical_pack_keeps_document_assets_together,
        test_hierarchical_pack_splits_oversized_family_with_anchor_context,
        test_validate_hierarchical_context_is_known_and_budgeted,
        test_hierarchical_text_cap_preserves_session_context_safety,
        test_hierarchical_large_anchor_is_not_replayed_into_every_image_chunk,
        test_hierarchical_image_cost_is_conservative_without_moving_flat_boundaries,
        test_validate_plan_accepts_code_baseline,
        test_validate_plan_rejects_missing_duplicate_unknown_overflow,
        test_validate_plan_rejects_duplicate_and_empty_batch_ids,
        test_scan_confines_symlinks,
        test_prune_missing_sources,
        test_normalize_model_plan_and_progress,
        test_section_reductions_group_only_unambiguous_multi_page_sections,
        test_effective_weights_images_pdf_binary,
        test_pack_uses_effective_not_raw_bytes,
        test_pdf_fallback_when_no_markers,
        test_plan_fragmentation_guard,
    ]
    for fn in tests:
        with tempfile.TemporaryDirectory() as td:
            fn(Path(td))
        print(f"\u2713 {fn.__name__}")
    print("ALL OK  test_batching")


if __name__ == "__main__":
    main()
