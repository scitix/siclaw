"""Batch planning for large-corpus compiles (DESIGN-kb-batch-compile-2026-07-05).

Pure, engine-neutral, stdlib-only — the deterministic half of batch mode. The
orchestrator (compile_box) calls: scan → should_batch → pack (code baseline) →
optionally accept a model-proposed regrouping IF validate_plan passes, else the
baseline stands. Budgets are enforced by THIS code; the model never gets to
overfill a session.

Design invariants:
- Small/medium KBs never enter batch mode (threshold gate) — their compile path
  is byte-identical to today.
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


def scan_sources(raw_dir: Path) -> list[dict[str, Any]]:
    """Inventory of raw sources: repo-relative path + size, sorted for stable
    plans. Hidden files and empty files are skipped (they carry no compile
    content; the installer never writes them, but a defensive skip is cheap)."""
    items: list[dict[str, Any]] = []
    if not raw_dir.is_dir():
        return items
    for p in sorted(raw_dir.rglob("*")):
        if not p.is_file():
            continue
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


def corpus_effective_bytes(inventory: list[dict[str, Any]]) -> int:
    return sum(_eff(i) for i in inventory)


def should_batch(inventory: list[dict[str, Any]], threshold: int | None = None) -> bool:
    return corpus_effective_bytes(inventory) > (threshold if threshold is not None else batch_threshold_bytes())


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


def build_plan(
    inventory: list[dict[str, Any]],
    batches: list[dict[str, Any]],
    planner: str,
    threshold: int | None = None,
    budget: int | None = None,
) -> dict[str, Any]:
    return {
        "version": 1,
        "planner": planner,
        "threshold": threshold if threshold is not None else batch_threshold_bytes(),
        "budget": budget if budget is not None else batch_budget_bytes(),
        "total_bytes": corpus_bytes(inventory),
        "total_effective_bytes": corpus_effective_bytes(inventory),
        "batches": batches,
    }


def validate_plan(
    plan: dict[str, Any], inventory: list[dict[str, Any]], budget: int | None = None
) -> list[str]:
    """Errors for a (possibly model-proposed) plan. Empty list = valid.
    Rules: every inventory source in exactly one batch, no unknown sources,
    every batch within budget unless it is a single oversized file."""
    b = budget if budget is not None else batch_budget_bytes()
    errors: list[str] = []
    sizes = {i["path"]: _eff(i) for i in inventory}
    seen: dict[str, str] = {}
    batches = plan.get("batches")
    if not isinstance(batches, list) or not batches:
        return ["plan has no batches"]
    for batch in batches:
        sources = batch.get("sources")
        bid = str(batch.get("id", "?"))
        if not isinstance(sources, list) or not sources:
            errors.append(f"batch {bid}: empty or missing sources")
            continue
        total = 0
        for path in sources:
            if path not in sizes:
                errors.append(f"batch {bid}: unknown source {path}")
                continue
            if path in seen:
                errors.append(f"source {path} appears in {seen[path]} and {bid}")
            seen[path] = bid
            total += sizes[path]
        if total > b and len(sources) > 1:
            errors.append(f"batch {bid}: {total} bytes exceeds budget {b}")
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


def stamp_done(plan: dict[str, Any], batch_id: str) -> dict[str, Any]:
    for b in plan.get("batches", []):
        if b.get("id") == batch_id:
            b["status"] = "done"
    return plan


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def plan_too_fragmented(model_batches: list[dict[str, Any]], baseline_batches: list[dict[str, Any]]) -> bool:
    """Fragmentation guard: the model planner's value is TOPICAL regrouping, not
    finer slicing. A plan much more fragmented than the deterministic baseline
    (seen in the wild: raw-bytes thinking → one lonely image per batch) wastes a
    whole fresh session per sliver. Allow modest growth for topical splits."""
    return len(model_batches) > max(int(len(baseline_batches) * 1.5), len(baseline_batches) + 2)
