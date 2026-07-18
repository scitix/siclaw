"""Batch planning for large-corpus compiles (DESIGN-kb-batch-compile-2026-07-05).

Pure, engine-neutral, stdlib-only — the deterministic half of batch mode. The
orchestrator (compile_box) calls: scan → should_batch → pack (code baseline) →
optionally accept a model-proposed regrouping IF validate_plan passes, else the
baseline stands. Budgets are enforced by THIS code; the model never gets to
overfill a session.

Design invariants:
- Small KBs never enter batch mode (threshold gate) — their compile path is
  byte-identical to today. Medium KBs retain the original flat batch planner.
- Only very large corpora enter hierarchical mode. Sibling ``*.assets`` files
  stay with their Markdown anchor, and an oversized family repeats only that
  anchor as read-only context while accounting each source exactly once.
- Every raw source lands in exactly one batch (coverage is validated, and the
  final full-corpus SELFCHECK proves no batch dropped anything).
- A single file larger than the budget still gets its own batch (we never split
  a file; the page that compiles it needs the whole file anyway).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

DEFAULT_BATCH_THRESHOLD_BYTES = 400 * 1024
DEFAULT_BATCH_BUDGET_BYTES = 200 * 1024
DEFAULT_HIERARCHICAL_THRESHOLD_BYTES = 8 * 1024 * 1024
DEFAULT_HIERARCHICAL_BATCH_BUDGET_BYTES = 1024 * 1024
DEFAULT_HIERARCHICAL_TEXT_BUDGET_BYTES = 400 * 1024
DEFAULT_REDUCTION_BUDGET_BYTES = 512 * 1024

# ── effective-size weighting ─────────────────────────────────────────────────
# Raw bytes are a terrible proxy for context cost on non-text sources: a 168KB
# jpg costs the model roughly as much as a few KB of text (one vision block),
# and a PDF costs per PAGE, not per byte. Packing by raw bytes turned a 465KB-
# text corpus with 6MB of screenshots into 28 batches — 26 of them one image
# each. All knobs env-tunable; everything downstream (threshold, budget,
# oversized-solo) uses the EFFECTIVE size.
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
TEXT_EXTS = {".md", ".txt", ".tsv", ".csv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".html", ".rst"}


def _image_cost() -> int:
    return int(os.environ.get("KBC_BATCH_IMAGE_COST_BYTES", str(30 * 1024)))


def _hierarchical_image_cost() -> int:
    """High-resolution page renders accumulate vision tokens across a long
    map session. Keep the established flat-planner estimate for medium corpora,
    but use a conservative cost in the very-large hierarchical path."""
    return int(os.environ.get(
        "KBC_HIERARCHICAL_IMAGE_COST_BYTES", str(64 * 1024)))


def _pdf_page_cost() -> int:
    return int(os.environ.get("KBC_BATCH_PDF_PAGE_COST_BYTES", str(8 * 1024)))


def _binary_weight() -> float:
    return float(os.environ.get("KBC_BATCH_BINARY_WEIGHT", "0.3"))


_PDF_PAGE_RE = re.compile(rb"/Type\s*/Page(?![s/])")


def pdf_page_count(path: Path) -> int | None:
    """Cheap page estimate: count /Type /Page object markers (excluding /Pages
    tree nodes) in a single pass. Works for most non-encrypted PDFs; None when
    nothing is found (e.g. fully compressed object streams) so the caller can
    fall back to a byte heuristic."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    n = len(_PDF_PAGE_RE.findall(data))
    return n or None


def effective_bytes(path: Path, size: int) -> int:
    """Context-cost estimate for one source (see module docstring)."""
    ext = path.suffix.lower()
    if ext in TEXT_EXTS:
        return size
    if ext in IMAGE_EXTS:
        return _image_cost()
    if ext == ".pdf":
        pages = pdf_page_count(path)
        if pages is not None:
            return pages * _pdf_page_cost()
        return max(30 * 1024, min(int(size * 0.1), 400 * 1024))
    return int(size * _binary_weight())

BATCH_PLAN_PATH = "authoring/BATCH_PLAN.json"
SOURCES_INVENTORY_PATH = "authoring/SOURCES_INVENTORY.json"


def batch_threshold_bytes() -> int:
    return int(os.environ.get("KBC_BATCH_THRESHOLD_BYTES", str(DEFAULT_BATCH_THRESHOLD_BYTES)))


def batch_budget_bytes() -> int:
    return int(os.environ.get("KBC_BATCH_BUDGET_BYTES", str(DEFAULT_BATCH_BUDGET_BYTES)))


def hierarchical_threshold_bytes() -> int:
    return int(os.environ.get(
        "KBC_HIERARCHICAL_THRESHOLD_BYTES", str(DEFAULT_HIERARCHICAL_THRESHOLD_BYTES)))


def hierarchical_batch_budget_bytes() -> int:
    return int(os.environ.get(
        "KBC_HIERARCHICAL_BATCH_BUDGET_BYTES",
        str(DEFAULT_HIERARCHICAL_BATCH_BUDGET_BYTES)))


def hierarchical_text_budget_bytes() -> int:
    return int(os.environ.get(
        "KBC_HIERARCHICAL_TEXT_BUDGET_BYTES",
        str(DEFAULT_HIERARCHICAL_TEXT_BUDGET_BYTES)))


def reduction_budget_bytes() -> int:
    return int(os.environ.get(
        "KBC_REDUCTION_BUDGET_BYTES", str(DEFAULT_REDUCTION_BUDGET_BYTES)))


def scan_sources(raw_dir: Path) -> list[dict[str, Any]]:
    """Inventory of raw sources: repo-relative path + size, sorted for stable
    plans. Hidden files and empty files are skipped (they carry no compile
    content; the installer never writes them, but a defensive skip is cheap).
    Symlinks are skipped and every path is realpath-confined to raw/ — the
    bundle installer already rejects link members, but this scan must not be
    the weaker of the two paths (same hardening as the S1 snapshot pinner)."""
    items: list[dict[str, Any]] = []
    if not raw_dir.is_dir():
        return items
    root = raw_dir.resolve()
    for p in sorted(raw_dir.rglob("*")):
        if p.is_symlink() or not p.is_file():
            continue
        try:
            p.resolve().relative_to(root)
        except (OSError, ValueError):
            continue  # escapes raw/ via a linked parent — not ours to inventory
        if any(part.startswith(".") for part in p.relative_to(raw_dir).parts):
            continue
        size = p.stat().st_size
        if size == 0:
            continue
        items.append({
            "path": str(p.relative_to(raw_dir)),
            "bytes": size,
            "effective": effective_bytes(p, size),
        })
    return items


def corpus_bytes(inventory: list[dict[str, Any]]) -> int:
    return sum(int(i["bytes"]) for i in inventory)


def _eff(item: dict[str, Any]) -> int:
    return int(item.get("effective", item["bytes"]))


def _hierarchical_eff(item: dict[str, Any]) -> int:
    if Path(str(item["path"])).suffix.lower() in IMAGE_EXTS:
        return max(_eff(item), _hierarchical_image_cost())
    return _eff(item)


def _text_eff(item: dict[str, Any]) -> int:
    return int(item["bytes"]) if Path(str(item["path"])).suffix.lower() in TEXT_EXTS else 0


def corpus_effective_bytes(inventory: list[dict[str, Any]]) -> int:
    return sum(_eff(i) for i in inventory)


def should_batch(inventory: list[dict[str, Any]], threshold: int | None = None) -> bool:
    return corpus_effective_bytes(inventory) > (threshold if threshold is not None else batch_threshold_bytes())


def should_hierarchical(
    inventory: list[dict[str, Any]], threshold: int | None = None
) -> bool:
    """The second routing gate. Keeping it separate from ``should_batch`` is
    intentional: changing the large-corpus strategy must not move the existing
    small/single-session or medium/flat-batch boundaries."""
    limit = threshold if threshold is not None else hierarchical_threshold_bytes()
    return corpus_effective_bytes(inventory) > limit


def _top_dir(path: str) -> str:
    head, sep, _ = path.partition("/")
    return head if sep else ""


def pack_batches(inventory: list[dict[str, Any]], budget: int | None = None) -> list[dict[str, Any]]:
    """Deterministic baseline: group by top-level directory (natural topical
    grouping in practice), greedy-pack in path order within the budget. A batch
    never mixes top-level directories unless a directory itself is tiny —
    deliberate: cross-dir mixing buys packing efficiency but costs topical
    coherence, and coherence is the goal function (效果好/细节覆盖).

    Exception to the budget: one file > budget forms its own batch whole."""
    b = budget if budget is not None else batch_budget_bytes()
    batches: list[dict[str, Any]] = []
    cur: list[dict[str, Any]] = []
    cur_bytes = 0
    cur_dir: str | None = None

    def flush() -> None:
        nonlocal cur, cur_bytes
        if cur:
            batches.append(
                {
                    "id": f"b{len(batches) + 1:02d}",
                    "sources": [i["path"] for i in cur],
                    "bytes": cur_bytes,
                    "status": "pending",
                }
            )
            cur = []
            cur_bytes = 0

    for item in inventory:
        d = _top_dir(item["path"])
        size = _eff(item)
        if cur and (cur_dir != d or cur_bytes + size > b):
            flush()
        cur_dir = d
        cur.append(item)
        cur_bytes += size
        if cur_bytes > b:
            # single oversized file (it was alone: anything before it flushed)
            flush()
    flush()
    return batches


def _asset_anchor(path: str, known: set[str]) -> str | None:
    """Return the Markdown source owning a file below ``<name>.assets/``.

    Feishu/Docx exports use this layout consistently. The anchor is recognized
    only when the corresponding ``<name>.md`` is actually in the inventory, so
    an unrelated directory whose name happens to end in ``.assets`` is never
    invented as context.
    """
    parts = path.split("/")
    for idx, part in enumerate(parts[:-1]):
        if not part.endswith(".assets"):
            continue
        anchor = "/".join(parts[:idx] + [part[:-len(".assets")] + ".md"])
        if anchor in known:
            return anchor
    return None


def source_families(inventory: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group every source into one deterministic document family.

    A family is an anchor Markdown file plus all media below its sibling
    ``*.assets`` directory. Everything else is a one-source family. Returning
    inventory records (rather than just paths) keeps this function pure and
    lets the packer enforce effective-byte budgets without rescanning disk.
    """
    by_path = {str(i["path"]): i for i in inventory}
    known = set(by_path)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in inventory:
        path = str(item["path"])
        key = _asset_anchor(path, known) or path
        grouped.setdefault(key, []).append(item)
    families: list[list[dict[str, Any]]] = []
    for key in sorted(grouped):
        items = grouped[key]
        # Put the anchor first, then stable path order for its assets.
        items.sort(key=lambda i: (str(i["path"]) != key, str(i["path"])))
        families.append(items)
    return families


def pack_hierarchical_batches(
    inventory: list[dict[str, Any]], budget: int | None = None,
    text_budget: int | None = None,
) -> list[dict[str, Any]]:
    """Pack very large corpora without separating a document from its media.

    Small families are greedily combined inside the same top-level section.
    Oversized families are split across batches; later chunks may re-read the
    Markdown anchor through ``context_sources``. Context is charged to every
    chunk's budget but is not counted again by the coverage ledger.
    """
    limit = budget if budget is not None else hierarchical_batch_budget_bytes()
    text_limit = text_budget if text_budget is not None else hierarchical_text_budget_bytes()
    result: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    current_bytes = 0
    current_text_bytes = 0
    current_dir: str | None = None

    def append_batch(
        sources: list[dict[str, Any]], context: list[dict[str, Any]] | None = None
    ) -> None:
        context = context or []
        result.append({
            "id": f"h{len(result) + 1:03d}",
            "sources": [str(i["path"]) for i in sources],
            "context_sources": [str(i["path"]) for i in context],
            "bytes": sum(_hierarchical_eff(i) for i in sources + context),
            "text_bytes": sum(_text_eff(i) for i in sources + context),
            "status": "pending",
        })

    def flush() -> None:
        nonlocal current, current_bytes, current_text_bytes
        if current:
            append_batch(current)
            current = []
            current_bytes = 0
            current_text_bytes = 0

    for family in source_families(inventory):
        family_bytes = sum(_hierarchical_eff(i) for i in family)
        family_text_bytes = sum(_text_eff(i) for i in family)
        section = _top_dir(str(family[0]["path"]))
        if family_bytes <= limit and family_text_bytes <= text_limit:
            if current and (
                current_dir != section
                or current_bytes + family_bytes > limit
                or current_text_bytes + family_text_bytes > text_limit
            ):
                flush()
            current_dir = section
            current.extend(family)
            current_bytes += family_bytes
            current_text_bytes += family_text_bytes
            continue

        flush()
        anchor = family[0] if str(family[0]["path"]).lower().endswith(".md") else None
        remaining = family[:]
        if anchor is not None:
            # The anchor itself is accounted once, in the first chunk.
            first = [remaining.pop(0)]
            first_bytes = _hierarchical_eff(first[0])
            first_text_bytes = _text_eff(first[0])
            while (
                remaining
                and first_bytes + _hierarchical_eff(remaining[0]) <= limit
                and first_text_bytes + _text_eff(remaining[0]) <= text_limit
            ):
                item = remaining.pop(0)
                first.append(item)
                first_bytes += _hierarchical_eff(item)
                first_text_bytes += _text_eff(item)
            append_batch(first)

        # Re-reading an oversized anchor on every chunk would itself overflow
        # the context. In that rare case the chunks remain independent.
        context = [anchor] if (
            anchor is not None and _hierarchical_eff(anchor) < limit and _text_eff(anchor) < text_limit
        ) else []
        context_bytes = sum(_hierarchical_eff(i) for i in context)
        context_text_bytes = sum(_text_eff(i) for i in context)
        while remaining:
            batch_context = context
            if context and (
                context_bytes + _hierarchical_eff(remaining[0]) > limit
                or context_text_bytes + _text_eff(remaining[0]) > text_limit
            ):
                # A single oversized asset/file is allowed as a solo batch; do
                # not turn it into an invalid multi-source batch by repeating
                # the anchor beside it.
                batch_context = []
            chunk: list[dict[str, Any]] = []
            chunk_bytes = sum(_hierarchical_eff(i) for i in batch_context)
            chunk_text_bytes = sum(_text_eff(i) for i in batch_context)
            while remaining and (
                (
                    chunk_bytes + _hierarchical_eff(remaining[0]) <= limit
                    and chunk_text_bytes + _text_eff(remaining[0]) <= text_limit
                )
                or not chunk
            ):
                item = remaining.pop(0)
                chunk.append(item)
                chunk_bytes += _hierarchical_eff(item)
                chunk_text_bytes += _text_eff(item)
            append_batch(chunk, batch_context)
    flush()
    return result


def build_plan(
    inventory: list[dict[str, Any]],
    batches: list[dict[str, Any]],
    planner: str,
    threshold: int | None = None,
    budget: int | None = None,
    text_budget: int | None = None,
) -> dict[str, Any]:
    mode = "hierarchical" if planner == "hierarchical-code" else "flat"
    return {
        "version": 2 if mode == "hierarchical" else 1,
        "planner": planner,
        "mode": mode,
        "phase": "map",
        "threshold": (
            threshold if threshold is not None
            else hierarchical_threshold_bytes() if mode == "hierarchical"
            else batch_threshold_bytes()
        ),
        "budget": budget if budget is not None else batch_budget_bytes(),
        "text_budget": (
            text_budget if text_budget is not None
            else hierarchical_text_budget_bytes() if mode == "hierarchical"
            else None
        ),
        "total_bytes": corpus_bytes(inventory),
        "total_effective_bytes": corpus_effective_bytes(inventory),
        "batches": batches,
    }


def validate_plan(
    plan: dict[str, Any], inventory: list[dict[str, Any]], budget: int | None = None,
    text_budget: int | None = None,
) -> list[str]:
    """Errors for a (possibly model-proposed) plan. Empty list = valid.
    Rules: every inventory source in exactly one batch, no unknown sources,
    every batch within budget unless it is a single oversized file. Optional
    context sources may repeat across batches but are read-only and still count
    toward the per-session budget."""
    b = budget if budget is not None else batch_budget_bytes()
    errors: list[str] = []
    effective = _hierarchical_eff if plan.get("mode") == "hierarchical" else _eff
    sizes = {i["path"]: effective(i) for i in inventory}
    text_sizes = {i["path"]: _text_eff(i) for i in inventory}
    seen: dict[str, str] = {}
    seen_ids: set[str] = set()
    batches = plan.get("batches")
    if not isinstance(batches, list) or not batches:
        return ["plan has no batches"]
    for batch in batches:
        sources = batch.get("sources")
        bid = str(batch.get("id", "?"))
        # Batch ids must be unique and non-empty: stamp_done marks EVERY batch
        # with the matching id, so a duplicate would get stamped alongside its
        # twin and silently never run.
        if not str(batch.get("id") or "").strip():
            errors.append("batch with empty or missing id")
        elif bid in seen_ids:
            errors.append(f"duplicate batch id {bid}")
        seen_ids.add(bid)
        if not isinstance(sources, list) or not sources:
            errors.append(f"batch {bid}: empty or missing sources")
            continue
        context = batch.get("context_sources", [])
        if not isinstance(context, list):
            errors.append(f"batch {bid}: context_sources must be a list")
            context = []
        total = 0
        text_total = 0
        for path in sources:
            if path not in sizes:
                errors.append(f"batch {bid}: unknown source {path}")
                continue
            if path in seen:
                errors.append(f"source {path} appears in {seen[path]} and {bid}")
            seen[path] = bid
            total += sizes[path]
            text_total += text_sizes[path]
        for path in context:
            if path not in sizes:
                errors.append(f"batch {bid}: unknown context source {path}")
                continue
            if path in sources:
                errors.append(f"batch {bid}: source {path} is also repeated as context")
                continue
            total += sizes[path]
            text_total += text_sizes[path]
        if total > b and len(sources) + len(context) > 1:
            errors.append(f"batch {bid}: {total} bytes exceeds budget {b}")
        if (
            text_budget is not None
            and text_total > text_budget
            and len(sources) + len(context) > 1
        ):
            errors.append(
                f"batch {bid}: {text_total} text bytes exceeds text budget {text_budget}")
    missing = [p for p in sizes if p not in seen]
    if missing:
        errors.append(f"sources not covered: {', '.join(sorted(missing)[:5])}" + ("…" if len(missing) > 5 else ""))
    return errors


def normalize_model_plan(raw: Any) -> dict[str, Any] | None:
    """Tolerant parse of a model-written BATCH_PLAN.json: keep only what the
    contract needs, stamp pending status. None when structurally unusable."""
    if not isinstance(raw, dict) or not isinstance(raw.get("batches"), list):
        return None
    batches: list[dict[str, Any]] = []
    for i, b in enumerate(raw["batches"]):
        if not isinstance(b, dict) or not isinstance(b.get("sources"), list):
            return None
        batches.append(
            {
                "id": str(b.get("id") or f"b{i + 1:02d}"),
                "sources": [str(s) for s in b["sources"]],
                "bytes": 0,
                "status": "pending",
            }
        )
    return {"batches": batches}


def pending_batches(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [b for b in plan.get("batches", []) if b.get("status") != "done"]


def pack_section_reductions(
    pages: dict[str, dict[str, Any]], budget: int | None = None
) -> list[dict[str, Any]]:
    """Build bounded candidate-page reduce groups after hierarchical mapping.

    Pages are assigned to a source top-level section only when their provenance
    points unambiguously to one section. Cross-section and derived pages stay
    for the global final review. Single-page groups need no reduce session.
    """
    limit = budget if budget is not None else reduction_budget_bytes()
    groups: dict[str, list[tuple[str, int]]] = {}
    for path, page in pages.items():
        if Path(path).name in {"index.md", "log.md"}:
            continue
        sections = {_top_dir(str(s)) for s in page.get("sources", [])}
        if len(sections) != 1:
            continue
        section = next(iter(sections))
        groups.setdefault(section, []).append((path, int(page.get("bytes", 0))))

    reductions: list[dict[str, Any]] = []
    for section in sorted(groups):
        entries = sorted(groups[section])
        if len(entries) < 2:
            continue
        current: list[tuple[str, int]] = []
        current_bytes = 0

        def flush() -> None:
            nonlocal current, current_bytes
            if len(current) >= 2:
                reductions.append({
                    "id": f"r{len(reductions) + 1:03d}",
                    "section": section,
                    "pages": [p for p, _ in current],
                    "bytes": current_bytes,
                    "status": "pending",
                })
            current = []
            current_bytes = 0

        for entry in entries:
            if current and current_bytes + entry[1] > limit:
                flush()
            current.append(entry)
            current_bytes += entry[1]
        flush()
    return reductions


def pending_reductions(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [r for r in plan.get("reductions", []) if r.get("status") != "done"]


def stamp_reduction_done(plan: dict[str, Any], reduction_id: str) -> dict[str, Any]:
    for reduction in plan.get("reductions", []):
        if reduction.get("id") == reduction_id:
            reduction["status"] = "done"
    return plan


def stamp_done(plan: dict[str, Any], batch_id: str) -> dict[str, Any]:
    for b in plan.get("batches", []):
        if b.get("id") == batch_id:
            b["status"] = "done"
    return plan


def prune_missing_sources(plan: dict[str, Any], known: set[str]) -> list[str]:
    """Drop sources that no longer exist in raw/ from the PENDING batches of a
    resumed plan (a source deleted between runs would otherwise leave a batch
    directive pointing at a missing file). A pending batch left with no sources
    is stamped done — nothing remains to compile in it. Done batches are left
    untouched (their stamps are history, not instructions). Returns the dropped
    source paths."""
    dropped: list[str] = []
    for b in plan.get("batches", []):
        if b.get("status") == "done":
            continue
        sources = [s for s in b.get("sources", []) if s in known]
        gone = [s for s in b.get("sources", []) if s not in known]
        if gone:
            dropped.extend(gone)
            b["sources"] = sources
            if not sources:
                b["status"] = "done"
        context = [s for s in b.get("context_sources", []) if s in known]
        context_gone = [s for s in b.get("context_sources", []) if s not in known]
        if context_gone:
            dropped.extend(context_gone)
            b["context_sources"] = context
    return dropped


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def plan_too_fragmented(model_batches: list[dict[str, Any]], baseline_batches: list[dict[str, Any]]) -> bool:
    """Fragmentation guard: the model planner's value is TOPICAL regrouping, not
    finer slicing. A plan much more fragmented than the deterministic baseline
    (seen in the wild: raw-bytes thinking → one lonely image per batch) wastes a
    whole fresh session per sliver. Allow modest growth for topical splits."""
    return len(model_batches) > max(int(len(baseline_batches) * 1.5), len(baseline_batches) + 2)
