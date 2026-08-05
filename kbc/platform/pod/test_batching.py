"""Unit tests for the deterministic half of batch mode (batching.py).

House convention: self-runner script (python test_batching.py), pytest-free —
each test gets a fresh tmp dir from the main() harness.
"""

from __future__ import annotations

import contextlib
import json
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


def _mk_text(tmp_path: Path, files: dict[str, str]) -> Path:
    raw = tmp_path / "raw"
    for rel, text in files.items():
        p = raw / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return raw


_HIER_FIXTURE_ENV = {
    "KBC_HIERARCHICAL_BATCH_BUDGET_BYTES": str(1024 * 1024),
    "KBC_HIERARCHICAL_TEXT_BUDGET_BYTES": str(128 * 1024),
    "KBC_HIERARCHICAL_TEXT_SLICE_BYTES": str(64 * 1024),
    "KBC_HIERARCHICAL_IMAGE_COST_BYTES": str(128 * 1024),
}


@contextlib.contextmanager
def _pinned_hier_env():
    """Same intent as _hier_env, for the structural tests that take no
    monkeypatch (they are also driven by the self-runner at the bottom of this
    file). They assert SHAPE — an oversized anchor is sliced, slices stay solo
    and ordered, a large anchor is not replayed into every chunk — against
    fixtures sized for the old budgets. Pin the budgets rather than inflate
    every fixture to megabytes; what the production numbers should be is
    asserted by the context-budget tests."""
    previous = {k: os.environ.get(k) for k in _HIER_FIXTURE_ENV}
    os.environ.update(_HIER_FIXTURE_ENV)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_every_text_format_can_be_sliced_not_only_markdown(tmp_path):
    """An oversized .csv/.txt used to be unsliceable, so it became one solo
    batch pointing at the whole file — a context blow-out, not a slow compile.
    Line-bounded slicing needs nothing format-specific: how much fits in one
    session is a capacity fact, and capacity facts are all this planner
    decides. What the source IS, and what page it deserves, is the model's
    call once it can see it."""
    big = "".join(f"{i},tenant-{i % 9},硬件故障,op-{i % 6},排队等待资源已协调回收\n"
                  for i in range(20_000))
    raw = _mk_text(tmp_path, {"data/tickets.csv": big})
    assert (raw / "data/tickets.csv").stat().st_size > bt.hierarchical_text_budget_bytes()
    inv = bt.scan_sources(raw)
    item = next(i for i in inv if i["path"] == "data/tickets.csv")
    assert len(item.get("text_slices") or []) > 1, "non-Markdown text must slice"


def test_partial_slices_are_still_rejected_for_ordinary_documents(tmp_path):
    """Every line of an oversized source must reach some session. A plan that
    stops short of the last line is incomplete, and there is no longer any
    exemption from that — nothing in this planner may decide the model has
    seen enough."""
    body = "".join(f"operational note line {i:05d}\n" for i in range(40_000))
    raw = _mk_text(tmp_path, {"ops/manual.md": body})
    inv = bt.scan_sources(raw)
    item = next(i for i in inv if i["path"] == "ops/manual.md")
    batches = bt.pack_hierarchical_batches(inv)
    plan = bt.build_plan(inv, batches, planner="hierarchical-code")
    assert bt.validate_plan(plan, inv) == []
    truncated = bt.build_plan(
        inv, [dict(b) for b in batches], planner="hierarchical-code")
    last = [b for b in truncated["batches"] if b.get("source_ranges")][-1]
    last["source_ranges"] = {"ops/manual.md": dict(last["source_ranges"]["ops/manual.md"])}
    last["source_ranges"]["ops/manual.md"]["end_line"] -= 1
    assert any("cover all" in e for e in bt.validate_plan(truncated, inv))


def test_context_budget_defaults_leave_room_for_the_working_set(tmp_path):
    """The numbers themselves, in one place. A batch spends its slice PLUS a
    working set (system prompt, BRIEF, INTENT, index, the pages it appends to,
    every accumulated tool result). The agreed SAFE ceiling for one session is
    750K of a 1M window, so at ~3 bytes/token for this corpus the slice should
    sit near a third of the window — leaving the rest for the working set.

    The band moved up from 120-220K when the old 512KB budget was found to be
    costly rather than cautious: a smaller budget pushes more families into the
    splitting paths, and splitting a family is what killed two live compiles.
    Context is the cheap resource; stability is the expensive one."""
    slice_tokens = bt.DEFAULT_HIERARCHICAL_TEXT_SLICE_BYTES / 3
    assert 280_000 <= slice_tokens <= 450_000, slice_tokens
    assert slice_tokens < 750_000, "must stay under the agreed safe ceiling"
    # Same question, same answer: a file is sliced only when it truly does not
    # fit one session.
    assert (bt.DEFAULT_HIERARCHICAL_TEXT_SLICE_BYTES
            == bt.DEFAULT_HIERARCHICAL_TEXT_BUDGET_BYTES)
    # An image is ~1.5-2.5K vision tokens. Pricing it like a document is what
    # produced batches of nothing but screenshots.
    assert bt._image_cost() <= 12 * 1024
    assert bt._image_cost() <= bt._hierarchical_image_cost() <= 4 * bt._image_cost()


def test_a_section_placeholder_never_costs_its_own_session(tmp_path):
    """Observed live: a 19-byte page holding one heading was planned as batch
    1 of 140 and spent a whole model session — pod spawned, ten turns — to read
    it and exclude it.

    The cause is ordering, not size. A section's own page and the directory
    named after it interleave in path order (`X-2d66.md` sorts before `X/…`),
    so the placeholder opened a batch, the very next family sat under a
    different top-level directory, and the section-coherence rule flushed it
    alone. Coherence is worth a flush; it is not worth one per placeholder, and
    a batch this far below budget has no coherence to protect yet."""
    files = {}
    for i in range(1, 8):
        files[f"{i}-Section-{i:08x}.md"] = 19          # the section's own page
        for j in range(3):
            files[f"{i}-Section/doc{j}.md"] = 40_000   # its contents
    raw = _mk(tmp_path, files)
    inventory = bt.scan_sources(raw)

    for pack in (bt.pack_hierarchical_batches, bt.pack_batches):
        batches = pack(inventory)
        solo_scraps = [
            b for b in batches if len(b["sources"]) == 1 and b["bytes"] < 1_000
        ]
        assert not solo_scraps, f"{pack.__name__} still spends a session on: {solo_scraps}"
        # Coherence still holds where it costs something: a full batch is not
        # allowed to swallow the next section just because ordering interleaves.
        flat = [p for b in batches for p in b["sources"]]
        assert sorted(flat) == sorted(i["path"] for i in inventory), "every source exactly once"


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


def test_hierarchical_family_links_exact_original_attachment_and_sidecar(tmp_path):
    raw = _mk(
        tmp_path,
        {
            "gpu/14-manual (pdf附件).md": 100,
            "gpu/14-manual (pdf附件).assets/page-001.jpg": 1_000,
            "_attachments/gpu/manual.pdf": 1_000,
            "_attachments/gpu/manual.pdf.md": 100,
            "_attachments/other/manual.pdf": 1_000,
        },
    )
    families = bt.source_families(bt.scan_sources(raw))
    linked = next(
        family for family in families
        if family[0]["path"] == "gpu/14-manual (pdf附件).md"
    )
    assert [item["path"] for item in linked] == [
        "gpu/14-manual (pdf附件).md",
        "_attachments/gpu/manual.pdf",
        "_attachments/gpu/manual.pdf.md",
        "gpu/14-manual (pdf附件).assets/page-001.jpg",
    ]
    assert any(
        [item["path"] for item in family] == ["_attachments/other/manual.pdf"]
        for family in families
    )


def test_hierarchical_family_does_not_guess_ambiguous_attachment_anchor(tmp_path):
    raw = _mk(
        tmp_path,
        {
            "gpu/14-manual (pdf附件).md": 100,
            "gpu/manual (pdf附件).md": 100,
            "_attachments/gpu/manual.pdf": 1_000,
        },
    )
    families = bt.source_families(bt.scan_sources(raw))
    assert any(
        [item["path"] for item in family] == ["_attachments/gpu/manual.pdf"]
        for family in families
    )


def test_office_original_rides_with_its_render_and_that_render_s_images(tmp_path):
    """The binary an Office source arrives as cannot be read; the platform
    installs a readable `<name>.pptx.md` beside it, and the deck's pictures hang
    off THAT under `<name>.pptx.assets/`. Keyed independently, the binary formed
    a family of one and could be planned into a different batch than the render
    — a whole session handed a file with nothing in it, which a live run spent
    rediscovering what the previous batch had already compiled."""
    raw = _mk(
        tmp_path,
        {
            "1-Roadmap/GPU架构.pptx": 4_000,
            "1-Roadmap/GPU架构.pptx.md": 900,
            "1-Roadmap/GPU架构.pptx.assets/s1.png": 500,
            "1-Roadmap/GPU架构.pptx.assets/s2.png": 500,
        },
    )
    families = bt.source_families(bt.scan_sources(raw))
    assert len(families) == 1, [[i["path"] for i in f] for f in families]
    assert sorted(item["path"] for item in families[0]) == [
        "1-Roadmap/GPU架构.pptx",
        "1-Roadmap/GPU架构.pptx.assets/s1.png",
        "1-Roadmap/GPU架构.pptx.assets/s2.png",
        "1-Roadmap/GPU架构.pptx.md",
    ]
    # The readable render anchors the family, never the binary.
    assert families[0][0]["path"] == "1-Roadmap/GPU架构.pptx.md"


def test_office_attachment_pair_joins_the_document_that_embeds_it(tmp_path):
    """When the Office file is an ATTACHMENT the two halves are keyed by
    different rules — the original is owned by the document embedding it, the
    render by nobody — so neither can simply adopt the other's anchor. Both must
    land in the embedding document's family."""
    raw = _mk(
        tmp_path,
        {
            "notes.md": 300,
            "assets/bom.xlsx": 2_000,
            "assets/bom.xlsx.md": 700,
        },
    )
    families = bt.source_families(
        bt.scan_sources(raw), attachment_edges={"notes.md": ["assets/bom.xlsx"]})
    assert len(families) == 1, [[i["path"] for i in f] for f in families]
    assert families[0][0]["path"] == "notes.md"
    assert sorted(item["path"] for item in families[0]) == [
        "assets/bom.xlsx", "assets/bom.xlsx.md", "notes.md"]


def test_hierarchical_keeps_an_oversized_family_whole(tmp_path):
    """This test used to assert the opposite — that an oversized family is
    CHUNKED, with the anchor repeated as context. That behaviour was removed,
    and the reason belongs here so nobody restores it.

    Chunking is only safe while every chunk can carry the anchor. When it
    cannot (the anchor shed to stay inside budget, or an attachment too large
    to co-batch with anything), a chunk holds an attachment with no reachable
    document, which validate_plan rejects — and _plan_batches used to raise,
    killing the entire compile. That happened twice on live corpora: once with
    a 9MB PDF, patched with a conditional, and again with a 54MB deck, which
    proved a conditional cannot hold an invariant the structure violates.

    So the rule is now the one pack_batches always used: a family never splits.
    Oversized means its own batch, whole. More batches and a slower run are the
    price, and per the platform's stated priorities that price is nothing next
    to a compile that cannot start."""
    with _pinned_hier_env():
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
        # Hierarchical images cost 128KB here, so 140KB cannot hold the family:
        # the old planner made three chunks out of it.
        budget = 140 * 1024
        batches = bt.pack_hierarchical_batches(inv, budget=budget)
        assert len(batches) == 1, batches
        assert batches[0]["sources"][0] == "gpu/guide.md"
        flat_sources = [p for b in batches for p in b["sources"]]
        assert sorted(flat_sources) == sorted(i["path"] for i in inv)
        plan = bt.build_plan(inv, batches, planner="hierarchical-code", budget=budget)
        assert plan["mode"] == "hierarchical" and plan["phase"] == "map"
        # And the whole-family batch validates despite exceeding the budget —
        # it has no smaller legal form.
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


def test_a_large_anchor_and_its_images_ride_in_one_batch(tmp_path):
    """Formerly `..._large_anchor_is_not_replayed_into_every_image_chunk`: it
    asserted the family was chunked and that a large anchor was NOT repeated as
    context in later chunks (replaying it would itself overflow).

    That whole concern disappears with "a family never splits" — there are no
    later chunks to replay into. The anchor and its images occupy one batch, the
    anchor is read once, and no context repetition is needed or emitted. What
    the old test protected (never burn the same 120KB anchor N times) is now
    true by construction rather than by a size condition."""
    with _pinned_hier_env():
        files = {"gpu/manual.md": 120 * 1024}
        files.update({f"gpu/manual.assets/page-{i:03d}.jpg": 1_000 for i in range(20)})
        raw = _mk(tmp_path, files)
        inv = bt.scan_sources(raw)
        batches = bt.pack_hierarchical_batches(inv, budget=1024 * 1024)
        manual_batches = [b for b in batches if any("manual" in p for p in b["sources"])]
        assert len(manual_batches) == 1, manual_batches
        assert "gpu/manual.md" in manual_batches[0]["sources"]
        # The anchor is a source here, never duplicated as read-only context.
        assert manual_batches[0]["context_sources"] == []


def test_hierarchical_oversized_text_anchor_is_sliced_before_image_chunks(tmp_path):
    with _pinned_hier_env():
        raw = _mk(
            tmp_path,
            {f"gpu/manual.assets/page-{i:03d}.jpg": 1_000 for i in range(13)},
        )
        manual = raw / "gpu/manual.md"
        manual.parent.mkdir(parents=True, exist_ok=True)
        manual.write_text("".join(f"line {i:05d}\n" for i in range(18_000)))
        inv = bt.scan_sources(raw)
        batches = bt.pack_hierarchical_batches(inv)
        slice_batches = [b for b in batches if b.get("source_ranges")]
        assert len(slice_batches) >= 3
        assert all(b["sources"] == ["gpu/manual.md"] for b in slice_batches)
        assert all(b["text_bytes"] <= 64 * 1024 for b in slice_batches)
        assert all(b["defer_accounting"] for b in slice_batches[:-1])
        assert slice_batches[-1]["defer_accounting"] is False
        assert all("gpu/manual.md" not in b["context_sources"] for b in batches)
        assert max(sum(p.endswith(".jpg") for p in b["sources"]) for b in batches) <= 8
        plan = bt.build_plan(inv, batches, planner="hierarchical-code")
        assert plan["version"] == 3
        assert bt.validate_plan(
            plan, inv, budget=1024 * 1024, text_budget=128 * 1024) == []

        broken = bt.build_plan(
            inv, [dict(batch) for batch in batches], planner="hierarchical-code")
        first_range = next(b for b in broken["batches"] if b.get("source_ranges"))
        first_range["source_ranges"] = {
            "gpu/manual.md": dict(first_range["source_ranges"]["gpu/manual.md"])
        }
        first_range["source_ranges"]["gpu/manual.md"]["end_line"] -= 1
        errors = bt.validate_plan(
            broken, inv, budget=1024 * 1024, text_budget=128 * 1024)
        assert any("not contiguous" in error for error in errors), errors


def test_hierarchical_pdf_is_split_into_contiguous_read_page_ranges(tmp_path):
    raw = _mk(tmp_path, {})
    pdf = raw / "docs/manual.pdf"
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF-1.7 /Type /Pages " + b"/Type /Page 1 " * 45)
    inv = bt.scan_sources(raw)
    item = inv[0]
    assert item["page_count"] == 45
    assert len(item["pdf_slices"]) == 3
    batches = bt.pack_hierarchical_batches(inv)
    ranges = [batch["source_page_ranges"]["docs/manual.pdf"] for batch in batches]
    assert [(r["start_page"], r["end_page"]) for r in ranges] == [
        (1, 20), (21, 40), (41, 45)]
    assert [batch["defer_accounting"] for batch in batches] == [True, True, False]
    plan = bt.build_plan(inv, batches, planner="hierarchical-code")
    assert plan["version"] == 4
    assert bt.validate_plan(plan, inv) == []

    broken = bt.build_plan(
        inv, [dict(batch) for batch in batches], planner="hierarchical-code")
    middle = broken["batches"][1]
    middle["source_page_ranges"] = {
        "docs/manual.pdf": dict(middle["source_page_ranges"]["docs/manual.pdf"])
    }
    middle["source_page_ranges"]["docs/manual.pdf"]["start_page"] = 22
    errors = bt.validate_plan(broken, inv)
    assert any("not contiguous" in error for error in errors), errors


def test_hierarchical_pdf_slice_configuration_cannot_exceed_read_limit(tmp_path):
    previous = os.environ.get("KBC_HIERARCHICAL_PDF_SLICE_PAGES")
    try:
        os.environ["KBC_HIERARCHICAL_PDF_SLICE_PAGES"] = "99"
        assert bt.hierarchical_pdf_slice_pages() == 20
        assert [(item["start_page"], item["end_page"]) for item in bt._pdf_slices(41)] == [
            (1, 20), (21, 40), (41, 41),
        ]
        os.environ["KBC_HIERARCHICAL_PDF_SLICE_PAGES"] = "7"
        assert bt.hierarchical_pdf_slice_pages() == 7
    finally:
        if previous is None:
            os.environ.pop("KBC_HIERARCHICAL_PDF_SLICE_PAGES", None)
        else:
            os.environ["KBC_HIERARCHICAL_PDF_SLICE_PAGES"] = previous


def test_linked_original_pdf_ranges_run_before_derived_page_images(tmp_path):
    raw = _mk(
        tmp_path,
        {
            "gpu/14-manual (pdf附件).md": 100,
            "gpu/14-manual (pdf附件).assets/page-001.jpg": 1_000,
        },
    )
    pdf = raw / "_attachments/gpu/manual.pdf"
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF-1.7 /Type /Pages " + b"/Type /Page 1 " * 45)
    inv = bt.scan_sources(raw)
    batches = bt.pack_hierarchical_batches(inv)
    anchor_index = next(
        i for i, batch in enumerate(batches)
        if "gpu/14-manual (pdf附件).md" in batch["sources"])
    pdf_indexes = [i for i, batch in enumerate(batches) if batch.get("source_page_ranges")]
    image_index = next(
        i for i, batch in enumerate(batches)
        if "gpu/14-manual (pdf附件).assets/page-001.jpg" in batch["sources"])
    assert anchor_index < min(pdf_indexes) < max(pdf_indexes) < image_index
    plan = bt.build_plan(inv, batches, planner="hierarchical-code")
    assert bt.validate_plan(plan, inv) == []


def test_hierarchical_image_cost_is_conservative_without_moving_flat_boundaries(tmp_path):
    previous = os.environ.get("KBC_HIERARCHICAL_IMAGE_COST_BYTES")
    os.environ["KBC_HIERARCHICAL_IMAGE_COST_BYTES"] = str(128 * 1024)
    try:
        files = {"guide.md": 100 * 1024}
        files.update({f"guide.assets/page-{i:03d}.jpg": 1_000 for i in range(30)})
        raw = _mk(tmp_path, files)
        inv = bt.scan_sources(raw)
        # The hierarchical override must not leak into the flat estimate.
        image = next(i for i in inv if i["path"].endswith("page-000.jpg"))
        assert image["effective"] == bt._image_cost()
        batches = bt.pack_hierarchical_batches(inv, budget=1024 * 1024)
        # This used to assert at most 8 images per batch — a property of the
        # chunking that no longer exists. Images belong to their document's
        # family, and a family never splits, so all 30 ride with guide.md in one
        # batch. The cost weighting still matters (it decides which families can
        # be COMBINED), which is what the flat-estimate assertion above checks.
        assert len(batches) == 1, batches
        assert sum(p.endswith(".jpg") for p in batches[0]["sources"]) == 30
        assert "guide.md" in batches[0]["sources"]
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
    # What this pins is the ROUTING of cost — image by vision estimate, PDF by
    # pages, binary by weight — not the tuning of any one of them.
    assert inv["media/shot.png"]["effective"] == bt._image_cost()   # flat image cost
    assert inv["doc.pdf"]["effective"] == 5 * 8 * 1024              # pages x page-cost
    assert inv["blob.bin"]["effective"] == int(100_000 * 0.3)
    print("effective:", {k: v["effective"] for k, v in inv.items()})


def test_pack_uses_effective_not_raw_bytes(tmp_path: Path):
    # 10 images x 170KB raw = 1.7MB raw. Packed by RAW bytes that is ten solo
    # batches; packed by the vision-token estimate it is 10 x _image_cost(),
    # and the budget — not the file size — decides how they group.
    files = {f"media/s{i:02d}.png": 170_000 for i in range(10)}
    raw = _mk(tmp_path, files)
    inv = bt.scan_sources(raw)
    effective_total = 10 * bt._image_cost()
    assert effective_total < 170_000, "images must not be priced anywhere near raw bytes"
    batches = bt.pack_batches(inv, budget=effective_total // 2)
    assert len(batches) == 2, [b["sources"] for b in batches]
    # threshold also weighted: the effective total stays under the 400KB gate
    assert bt.should_batch(inv, threshold=400 * 1024) is False


def test_shared_assets_dir_keeps_document_and_attachments_together(tmp_path: Path):
    # The layout the platform actually exports: ONE shared `assets/` dir per
    # folder holding opaquely-named files for every sibling document. Path shape
    # says nothing about ownership there — only the embed link does. While only
    # the legacy `<name>.assets/` anchor existed, every image and every embedded
    # sheet became its own family and landed in some unrelated batch (the real
    # GPU corpus spent a whole batch on eight bare screenshots, and separated a
    # document from the spreadsheet it embeds — which that session then could
    # not read at all).
    raw = _mk(tmp_path, {
        "ops/doc-a.md": 10,
        "ops/doc-b.md": 10,
        "ops/assets/img1.png": 10,
        "ops/assets/img2.png": 10,
        "ops/assets/sheets/tbl.md": 10,
    })
    inv = bt.scan_sources(raw)

    # Without edges the legacy anchor never fires → five one-source families.
    assert len(bt.source_families(inv)) == 5

    edges = {"ops/doc-a.md": ["ops/assets/img1.png", "ops/assets/sheets/tbl.md"],
             "ops/doc-b.md": ["ops/assets/img2.png"]}
    families = {f[0]["path"]: [i["path"] for i in f]
                for f in bt.source_families(inv, edges)}
    assert families == {
        "ops/doc-a.md": ["ops/doc-a.md", "ops/assets/img1.png",
                         "ops/assets/sheets/tbl.md"],
        "ops/doc-b.md": ["ops/doc-b.md", "ops/assets/img2.png"],
    }, families

    # A budget that would otherwise cut mid-family still never splits one.
    for batch in bt.pack_batches(inv, budget=1, attachment_edges=edges):
        sources = set(batch["sources"])
        for attachment in ("ops/assets/img1.png", "ops/assets/sheets/tbl.md"):
            if attachment in sources:
                assert "ops/doc-a.md" in sources, batch


def test_validate_plan_rejects_attachment_split_from_its_document(tmp_path: Path):
    # The MODEL planner is the default, so this invariant must hold for a
    # proposed regrouping too, not just for the code baseline.
    raw = _mk(tmp_path, {"ops/doc.md": 10, "ops/assets/img.png": 10})
    inv = bt.scan_sources(raw)
    edges = {"ops/doc.md": ["ops/assets/img.png"]}
    split = {"batches": [
        {"id": "b01", "sources": ["ops/doc.md"], "status": "pending"},
        {"id": "b02", "sources": ["ops/assets/img.png"], "status": "pending"},
    ]}
    errors = bt.validate_plan(split, inv, attachment_edges=edges)
    assert any("separated from the document" in e for e in errors), errors
    assert bt.validate_plan(split, inv) == []          # no edges → no opinion

    together = {"batches": [
        {"id": "b01", "sources": ["ops/doc.md", "ops/assets/img.png"],
         "status": "pending"},
    ]}
    assert bt.validate_plan(together, inv, attachment_edges=edges) == []

    # Reachable as read-only context is equally fine — that is exactly how the
    # hierarchical packer splits an oversized family on purpose.
    contexted = {"batches": [
        {"id": "b01", "sources": ["ops/doc.md"], "status": "pending"},
        {"id": "b02", "sources": ["ops/assets/img.png"],
         "context_sources": ["ops/doc.md"], "status": "pending"},
    ]}
    assert bt.validate_plan(contexted, inv, attachment_edges=edges) == []


def test_attachment_owner_is_deterministic_when_shared(tmp_path: Path):
    del tmp_path
    known = {"a.md", "b.md", "assets/x.png"}
    edges = {"b.md": ["assets/x.png"], "a.md": ["assets/x.png"]}
    assert bt.attachment_owners(edges, known) == {"assets/x.png": "a.md"}
    # Unknown documents/targets are ignored rather than inventing a family.
    assert bt.attachment_owners({"gone.md": ["assets/x.png"]}, known) == {}
    assert bt.attachment_owners(None, known) == {}


def test_pdf_fallback_when_no_markers(tmp_path: Path):
    raw = _mk(tmp_path, {"a.md": 10})
    pdf = raw / "opaque.pdf"
    pdf.write_bytes(b"%PDF-1.7 compressed-object-streams " + b"q" * 2_000_000)
    inv = {i["path"]: i for i in bt.scan_sources(raw)}
    eff = inv["opaque.pdf"]["effective"]
    assert 30 * 1024 <= eff <= 400 * 1024  # clamped byte heuristic


def test_pdfinfo_page_count_parser(tmp_path: Path):
    del tmp_path
    match = bt._PDFINFO_PAGES_RE.search(
        "Title:          GPU Manual\nPages:          112\nEncrypted:      no\n"
    )
    assert match is not None and int(match.group(1)) == 112


def test_pdfinfo_metadata_does_not_move_effective_size_route(tmp_path: Path):
    raw = _mk(tmp_path, {})
    raw.mkdir()
    pdf = raw / "opaque.pdf"
    pdf.write_bytes(b"%PDF-1.7 compressed-object-streams " + b"q" * 2_000_000)
    real_pdfinfo = bt._pdfinfo_page_count
    bt._pdfinfo_page_count = lambda path: 50
    try:
        item = bt.scan_sources(raw)[0]
    finally:
        bt._pdfinfo_page_count = real_pdfinfo
    assert item["page_count"] == 50
    assert len(item["pdf_slices"]) == 3
    # Baseline byte fallback: max(30KB, min(10% of 2MB, 400KB)). If Poppler
    # leaked into routing this would instead be 50 * 8KB.
    assert item["effective"] == int(pdf.stat().st_size * 0.1)


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


def test_validate_plan_rejects_unsafe_batch_ids(tmp_path: Path):
    """R2-6: a batch id flows verbatim into pod-log lifecycle lines, so a
    model-proposed id outside [A-Za-z0-9_-]{1,64} (newline injection / path leak)
    must be rejected at validation → the plan falls back to the safe code
    baseline. The error must not echo the offending value."""
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "a.md").write_bytes(b"x" * 10)
    inv = bt.scan_sources(raw)
    forged = "secret/customer/file.md\nFORGED=1"
    errs = bt.validate_plan({"batches": [{"id": forged, "sources": ["a.md"]}]}, inv, budget=100)
    assert any("must match" in e for e in errs), errs
    assert not any(("FORGED" in e) or ("secret" in e) or ("\n" in e) for e in errs), errs  # value never echoed
    # A safe id passes the id check (the deterministic code baseline uses these).
    assert bt.validate_plan({"batches": [{"id": "b01", "sources": ["a.md"]}]}, inv, budget=100) == []
    # The shared helper mirrors the rule (used by the lifecycle logger).
    assert bt.is_safe_batch_id("h001") and bt.is_safe_batch_id("b_2-x")
    assert not bt.is_safe_batch_id(forged) and not bt.is_safe_batch_id("") and not bt.is_safe_batch_id("x" * 65)

    # R4: Python's `$` also matches BEFORE a final newline, so an anchored
    # re.match blessed "b01\n" — a raw newline mid-log-line splits one lifecycle
    # event across two lines. fullmatch closes it, and validation now judges the
    # id EXACTLY as stored and printed: no .strip() copy, no str() coercion.
    for hostile in ("b01\n", "b01\r\n", " b01 ", "b01\t"):
        assert not bt.is_safe_batch_id(hostile), repr(hostile)
        errs = bt.validate_plan({"batches": [{"id": hostile, "sources": ["a.md"]}]}, inv, budget=100)
        assert any("must match" in e for e in errs), (repr(hostile), errs)
        assert not any(("\n" in e) or ("\r" in e) for e in errs), (repr(hostile), errs)
    for non_string in (5, 5.0, ["b01"], {"id": "b01"}):
        assert not bt.is_safe_batch_id(non_string), repr(non_string)
        errs = bt.validate_plan({"batches": [{"id": non_string, "sources": ["a.md"]}]}, inv, budget=100)
        assert any(("must match" in e) or ("empty or missing id" in e) for e in errs), (repr(non_string), errs)


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


class _EnvPatch:
    """Tiny pytest-free subset used by the standalone test runner."""

    def __init__(self):
        self._previous: dict[str, str | None] = {}

    def setenv(self, name: str, value: str) -> None:
        if name not in self._previous:
            self._previous[name] = os.environ.get(name)
        os.environ[name] = value

    def undo(self) -> None:
        for name, previous in self._previous.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous


def main():
    tests = [
        test_every_text_format_can_be_sliced_not_only_markdown,
        test_partial_slices_are_still_rejected_for_ordinary_documents,
        test_context_budget_defaults_leave_room_for_the_working_set,
        test_a_section_placeholder_never_costs_its_own_session,
        test_scan_skips_hidden_and_empty,
        test_threshold_gate_small_kb_never_batches,
        test_tiered_gate_keeps_small_and_medium_routes_stable,
        test_pack_groups_by_top_dir_and_budget,
        test_pack_oversized_single_file_gets_own_batch,
        test_hierarchical_pack_keeps_document_assets_together,
        test_hierarchical_family_links_exact_original_attachment_and_sidecar,
        test_hierarchical_family_does_not_guess_ambiguous_attachment_anchor,
        test_office_original_rides_with_its_render_and_that_render_s_images,
        test_office_attachment_pair_joins_the_document_that_embeds_it,
        test_hierarchical_keeps_an_oversized_family_whole,
        test_validate_hierarchical_context_is_known_and_budgeted,
        test_hierarchical_text_cap_preserves_session_context_safety,
        test_a_large_anchor_and_its_images_ride_in_one_batch,
        test_hierarchical_oversized_text_anchor_is_sliced_before_image_chunks,
        test_hierarchical_pdf_is_split_into_contiguous_read_page_ranges,
        test_hierarchical_pdf_slice_configuration_cannot_exceed_read_limit,
        test_linked_original_pdf_ranges_run_before_derived_page_images,
        test_hierarchical_image_cost_is_conservative_without_moving_flat_boundaries,
        test_validate_plan_accepts_code_baseline,
        test_validate_plan_rejects_missing_duplicate_unknown_overflow,
        test_validate_plan_rejects_duplicate_and_empty_batch_ids,
        test_validate_plan_rejects_unsafe_batch_ids,
        test_scan_confines_symlinks,
        test_prune_missing_sources,
        test_normalize_model_plan_and_progress,
        test_section_reductions_group_only_unambiguous_multi_page_sections,
        test_effective_weights_images_pdf_binary,
        test_pack_uses_effective_not_raw_bytes,
        test_shared_assets_dir_keeps_document_and_attachments_together,
        test_validate_plan_rejects_attachment_split_from_its_document,
        test_attachment_owner_is_deterministic_when_shared,
        test_pdf_fallback_when_no_markers,
        test_pdfinfo_page_count_parser,
        test_pdfinfo_metadata_does_not_move_effective_size_route,
        test_plan_fragmentation_guard,
        test_hierarchical_oversized_pdf_attachment_keeps_anchor,
        test_hierarchical_page_sliced_pdf_attachment_is_reachable,
        test_hierarchical_sliced_sheet_attachment_is_reachable,
        test_hierarchical_sliced_anchor_with_images_is_reachable,
        test_a_family_is_never_split_and_the_plan_always_validates,
        test_the_last_resort_plan_is_valid_by_construction,
        test_without_edges_no_attachment_family_can_form,
    ]
    monkeypatch_tests = {
        test_hierarchical_oversized_pdf_attachment_keeps_anchor,
        test_hierarchical_page_sliced_pdf_attachment_is_reachable,
        test_hierarchical_sliced_sheet_attachment_is_reachable,
        test_hierarchical_sliced_anchor_with_images_is_reachable,
    }
    for fn in tests:
        with tempfile.TemporaryDirectory() as td:
            if fn in monkeypatch_tests:
                monkeypatch = _EnvPatch()
                try:
                    fn(Path(td), monkeypatch)
                finally:
                    monkeypatch.undo()
            else:
                fn(Path(td))
        print(f"\u2713 {fn.__name__}")
    print("ALL OK  test_batching")


# ── 2026-07-25 regression: attachment families vs slice/budget rules ─────────
#
# A real 878-node compile died at plan time, twice, deterministically: a 9MB
# PDF attachment was packed as an anchor-less solo batch (the oversized-solo
# path shed its context), and validate_plan then rejected its own planner's
# output as "separated from the document that embeds it". The family rule, the
# slice rules, and the solo-budget exemption must be satisfiable TOGETHER on
# every real corpus shape.

def _hier_env(monkeypatch):
    # Shrink budgets so small fixtures exercise the hierarchical machinery.
    # Every knob the machinery reads is pinned, slice size and image cost
    # included: these tests assert STRUCTURE (an anchor stays reachable, slices
    # stay ordered, a large anchor is not replayed) and must not change verdict
    # when a production budget is retuned. The default values are asserted by
    # the context-budget tests instead, which is where numbers belong.
    monkeypatch.setenv("KBC_HIERARCHICAL_THRESHOLD_BYTES", "1")
    monkeypatch.setenv("KBC_HIERARCHICAL_BATCH_BUDGET_BYTES", str(256 * 1024))
    monkeypatch.setenv("KBC_HIERARCHICAL_TEXT_BUDGET_BYTES", str(128 * 1024))
    monkeypatch.setenv("KBC_HIERARCHICAL_TEXT_SLICE_BYTES", str(64 * 1024))
    monkeypatch.setenv("KBC_HIERARCHICAL_IMAGE_COST_BYTES", str(128 * 1024))


def _plan_and_validate(raw, edges):
    inv = bt.scan_sources(raw)
    budget = bt.hierarchical_batch_budget_bytes()
    text_budget = bt.hierarchical_text_budget_bytes()
    batches = bt.pack_hierarchical_batches(
        inv, budget=budget, text_budget=text_budget, attachment_edges=edges)
    plan = bt.build_plan(
        inv, batches, planner="hierarchical-code", budget=budget, text_budget=text_budget)
    errors = bt.validate_plan(
        plan, inv, budget=budget, text_budget=text_budget, attachment_edges=edges)
    return plan, errors


def test_hierarchical_oversized_pdf_attachment_keeps_anchor(tmp_path, monkeypatch):
    _hier_env(monkeypatch)
    raw = _mk(tmp_path, {"inc/report.md": 30_000})
    pdf = raw / "inc/assets/big.pdf"
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF-1.7 /Type /Pages /Type /Page 1 " + b"x" * 400_000)
    edges = {"inc/report.md": ["inc/assets/big.pdf"]}
    plan, errors = _plan_and_validate(raw, edges)
    assert errors == [], errors
    for batch in plan["batches"]:
        if "inc/assets/big.pdf" in batch["sources"]:
            reachable = set(batch["sources"]) | set(batch["context_sources"])
            assert "inc/report.md" in reachable, plan["batches"]


def test_hierarchical_page_sliced_pdf_attachment_is_reachable(tmp_path, monkeypatch):
    _hier_env(monkeypatch)
    raw = _mk(tmp_path, {"inc/report.md": 30_000})
    pdf = raw / "inc/assets/manual.pdf"
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF-1.7 /Type /Pages " + b"/Type /Page 1 " * 45)
    edges = {"inc/report.md": ["inc/assets/manual.pdf"]}
    plan, errors = _plan_and_validate(raw, edges)
    assert errors == [], errors


def test_hierarchical_sliced_sheet_attachment_is_reachable(tmp_path, monkeypatch):
    _hier_env(monkeypatch)
    raw = _mk(tmp_path, {"tix/weekly.md": 20_000})
    sheet = raw / "tix/assets/sheets/dump.md"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_bytes(b"| a | b |\n" * 40_000)  # > text budget -> text slices
    edges = {"tix/weekly.md": ["tix/assets/sheets/dump.md"]}
    plan, errors = _plan_and_validate(raw, edges)
    assert errors == [], errors


def test_hierarchical_sliced_anchor_with_images_is_reachable(tmp_path, monkeypatch):
    _hier_env(monkeypatch)
    raw = _mk(tmp_path, {
        "ops/assets/shot1.png": 50_000,
        "ops/assets/shot2.png": 50_000,
    })
    doc = raw / "ops/learning.md"
    doc.write_bytes(b"line of operational notes\n" * 8_000)  # sliced anchor
    edges = {"ops/learning.md": ["ops/assets/shot1.png", "ops/assets/shot2.png"]}
    plan, errors = _plan_and_validate(raw, edges)
    assert errors == [], errors


def test_a_family_is_never_split_and_the_plan_always_validates(tmp_path):
    """The shape that killed two real compiles, with the real numbers.

    A 54MB .pptx attachment embedded by a small Markdown document, plus the
    render and the slide images the Office ingester extracts beside it. The
    family exceeded the hierarchical budget, the packer chunked it, the chunk
    holding the deck lost its anchor, and validate_plan — correctly — said the
    attachment was separated from the document that embeds it. _plan_batches
    then raised, and the box died before compiling a single page.

    Two things this test insists on, because the earlier "reproduction" got
    both wrong and reported a pass:
      * attachment_edges MUST be supplied. Without them nothing owns anything,
        no family forms, and the defect cannot fire — a green run proves only
        that the test was not wired up.
      * the sizes MUST be the real ones. At toy sizes the family fits the
        budget and never reaches the splitting path at all.
    """
    doc = "svc/handbook/01-overview.md"
    deck = "svc/handbook/assets/deck.pptx"
    files = {doc: 30_000, "svc/handbook/02-cli.md": 40_000, deck: 57_255_555}
    files[deck + ".md"] = 200_000
    for i in range(50):                       # what MediaSink extracts from a deck
        files[f"{deck}.assets/img{i:03d}.png"] = 180_000
    for i in range(40):                       # enough corpus to take the hierarchical route
        files[f"docs/section{i:02d}/page.md"] = 120_000

    raw = _mk(tmp_path, files)
    inventory = bt.scan_sources(raw)
    edges = {doc: [deck]}
    assert bt.should_hierarchical(inventory), "corpus must take the hierarchical route"

    budget = bt.hierarchical_batch_budget_bytes()
    text_budget = bt.hierarchical_text_budget_bytes()
    batches = bt.pack_hierarchical_batches(
        inventory, budget=budget, text_budget=text_budget, attachment_edges=edges)
    plan = bt.build_plan(inventory, batches, planner="hierarchical-code",
                         budget=budget, text_budget=text_budget)
    errors = bt.validate_plan(plan, inventory, budget=budget,
                              text_budget=text_budget, attachment_edges=edges)
    assert errors == [], errors

    # …and the invariant itself, stated directly rather than via the validator:
    # every source of that family rides in one batch.
    family = {doc, deck, deck + ".md"} | {
        f"{deck}.assets/img{i:03d}.png" for i in range(50)}
    holders = [b["id"] for b in batches if family & set(b.get("sources") or [])]
    assert len(holders) == 1, f"family split across {holders}"


def test_the_last_resort_plan_is_valid_by_construction(tmp_path):
    """One family per batch is what a validation failure degrades TO, so it has
    to hold up on the same shape that broke the real planner. If this plan can
    ever fail validation, the fallback is not a fallback."""
    doc = "svc/handbook/01-overview.md"
    deck = "svc/handbook/assets/deck.pptx"
    files = {doc: 30_000, deck: 57_255_555, deck + ".md": 200_000}
    for i in range(50):
        files[f"{deck}.assets/img{i:03d}.png"] = 180_000
    for i in range(40):
        files[f"docs/section{i:02d}/page.md"] = 120_000

    raw = _mk(tmp_path, files)
    inventory = bt.scan_sources(raw)
    edges = {doc: [deck]}
    fallback = bt.pack_one_family_per_batch(inventory, attachment_edges=edges)
    plan = bt.build_plan(inventory, fallback, planner="one-family-per-batch",
                         budget=bt.hierarchical_batch_budget_bytes(),
                         text_budget=bt.hierarchical_text_budget_bytes())
    errors = bt.validate_plan(
        plan, inventory,
        budget=bt.hierarchical_batch_budget_bytes(),
        text_budget=bt.hierarchical_text_budget_bytes(),
        attachment_edges=edges)
    assert errors == [], errors
    assert sum(len(b["sources"]) for b in fallback) == len(inventory), "every source lands once"


def test_without_edges_no_attachment_family_can_form(tmp_path):
    """The trap that made a false reproduction look green, stated as a test.

    `source_families` groups an attachment with the document that embeds it via
    `attachment_edges`. On a current-platform export (one shared `assets/` dir)
    the path shape says nothing about ownership, so WITHOUT edges every file is
    its own family — and any test of family behaviour that omits them is
    exercising a code path where the behaviour cannot occur.

    A live investigation lost hours to exactly this: a reproduction of a
    family-splitting bug passed `attachment_edges=None`, formed no family, found
    no defect, and reported a pass. Anyone reading a green edge-free run as
    evidence about families should find this test first.
    """
    raw = _mk(tmp_path, {
        "notes.md": 1_000,
        "assets/deck.pptx": 5_000,
        "assets/diagram.png": 2_000,
    })
    inventory = bt.scan_sources(raw)

    without = bt.source_families(inventory)
    assert len(without) == 3, "no edges → nothing owns anything → three singletons"

    with_edges = bt.source_families(
        inventory, attachment_edges={"notes.md": ["assets/deck.pptx", "assets/diagram.png"]})
    assert len(with_edges) == 1, with_edges
    assert sorted(i["path"] for i in with_edges[0]) == [
        "assets/deck.pptx", "assets/diagram.png", "notes.md"]


if __name__ == "__main__":
    main()
