"""Unit tests for the deterministic half of batch mode (batching.py).

House convention: self-runner script (python test_batching.py), pytest-free —
each test gets a fresh tmp dir from the main() harness.
"""

from __future__ import annotations

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


def main():
    tests = [
        test_scan_skips_hidden_and_empty,
        test_threshold_gate_small_kb_never_batches,
        test_pack_groups_by_top_dir_and_budget,
        test_pack_oversized_single_file_gets_own_batch,
        test_validate_plan_accepts_code_baseline,
        test_validate_plan_rejects_missing_duplicate_unknown_overflow,
        test_normalize_model_plan_and_progress,
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
