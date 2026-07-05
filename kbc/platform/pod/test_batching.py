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


def main():
    tests = [
        test_scan_skips_hidden_and_empty,
        test_threshold_gate_small_kb_never_batches,
        test_pack_groups_by_top_dir_and_budget,
        test_pack_oversized_single_file_gets_own_batch,
        test_validate_plan_accepts_code_baseline,
        test_validate_plan_rejects_missing_duplicate_unknown_overflow,
        test_normalize_model_plan_and_progress,
    ]
    for fn in tests:
        with tempfile.TemporaryDirectory() as td:
            fn(Path(td))
        print(f"\u2713 {fn.__name__}")
    print("ALL OK  test_batching")


if __name__ == "__main__":
    main()
