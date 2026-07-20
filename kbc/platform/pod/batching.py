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
- Raw provenance remains one source identity. Oversized Markdown and PDF work
  is segmented into bounded line/page batches; other oversized files keep the
  historical one-file batch behavior.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path
from typing import Any

DEFAULT_BATCH_THRESHOLD_BYTES = 400 * 1024
DEFAULT_BATCH_BUDGET_BYTES = 200 * 1024
DEFAULT_HIERARCHICAL_THRESHOLD_BYTES = 8 * 1024 * 1024
DEFAULT_HIERARCHICAL_BATCH_BUDGET_BYTES = 1024 * 1024
DEFAULT_HIERARCHICAL_TEXT_BUDGET_BYTES = 128 * 1024
DEFAULT_HIERARCHICAL_TEXT_SLICE_BYTES = 64 * 1024
DEFAULT_HIERARCHICAL_PDF_SLICE_PAGES = 20
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
        "KBC_HIERARCHICAL_IMAGE_COST_BYTES", str(128 * 1024)))


def _hierarchical_context_anchor_max_bytes() -> int:
    """A large rendered document is useful in the first family chunk, but
    replaying it beside every later image chunk burns the same context over and
    over. Later chunks can use the Candidate produced by the first chunk."""
    return int(os.environ.get(
        "KBC_HIERARCHICAL_CONTEXT_ANCHOR_MAX_BYTES", str(96 * 1024)))


def _hierarchical_text_slice_bytes() -> int:
    return max(1, int(os.environ.get(
        "KBC_HIERARCHICAL_TEXT_SLICE_BYTES",
        str(DEFAULT_HIERARCHICAL_TEXT_SLICE_BYTES))))


def hierarchical_pdf_slice_pages() -> int:
    """Claude Code's Read tool accepts at most 20 PDF pages per call. Keep the
    planner limit configurable downwards for tighter deployments, but never
    let configuration exceed the provider's hard limit or create a zero-width
    slice."""
    return min(DEFAULT_HIERARCHICAL_PDF_SLICE_PAGES, max(1, int(os.environ.get(
        "KBC_HIERARCHICAL_PDF_SLICE_PAGES",
        str(DEFAULT_HIERARCHICAL_PDF_SLICE_PAGES)))))


def _text_slices(path: Path, size: int) -> tuple[int, list[dict[str, int]]] | None:
    """Line-bounded chunks for a Markdown source that cannot safely fit one
    hierarchical model turn. The Raw file remains the provenance identity;
    these ranges only bound what each internal map session may read."""
    if path.suffix.lower() != ".md" or size <= hierarchical_text_budget_bytes():
        return None
    lines = path.read_bytes().splitlines(keepends=True)
    if not lines:
        return None
    target = min(_hierarchical_text_slice_bytes(), hierarchical_text_budget_bytes())
    slices: list[dict[str, int]] = []
    start = 0
    while start < len(lines):
        end = start
        total = 0
        while end < len(lines) and (total + len(lines[end]) <= target or end == start):
            total += len(lines[end])
            end += 1
        slices.append({
            "start_line": start + 1,
            "end_line": end,
            "bytes": total,
        })
        start = end
    return len(lines), slices


def _pdf_slices(page_count: int) -> list[dict[str, int]] | None:
    """Contiguous Read-tool page ranges for a PDF that is too large for one
    bounded model turn. The original PDF remains the sole provenance identity;
    page ranges are internal execution metadata."""
    limit = hierarchical_pdf_slice_pages()
    if page_count <= limit:
        return None
    count = (page_count + limit - 1) // limit
    return [
        {
            "start_page": start,
            "end_page": min(page_count, start + limit - 1),
            "part": index,
            "parts": count,
        }
        for index, start in enumerate(range(1, page_count + 1, limit), start=1)
    ]


def _pdf_page_cost() -> int:
    return int(os.environ.get("KBC_BATCH_PDF_PAGE_COST_BYTES", str(8 * 1024)))


def _binary_weight() -> float:
    return float(os.environ.get("KBC_BATCH_BINARY_WEIGHT", "0.3"))


_PDF_PAGE_RE = re.compile(rb"/Type\s*/Page(?![s/])")
_PDFINFO_PAGES_RE = re.compile(r"^Pages:\s*([0-9]+)\s*$", re.MULTILINE)


def _pdfinfo_page_count(path: Path) -> int | None:
    """Ask Poppler for the authoritative page count when it is installed.

    ``pdfinfo`` and the Read tool's ``pdftoppm`` renderer ship in the same
    ``poppler-utils`` package, so a production compile image either has both or
    falls through to the dependency-free marker estimate below.
    """
    executable = shutil.which("pdfinfo")
    if executable is None:
        return None
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    try:
        result = subprocess.run(
            [executable, str(path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    match = _PDFINFO_PAGES_RE.search(result.stdout)
    if match is None:
        return None
    count = int(match.group(1))
    return count or None


def pdf_page_count(path: Path) -> int | None:
    """Page count for planning: authoritative Poppler metadata first, then a
    cheap /Type /Page marker estimate (excluding /Pages tree nodes). None is
    reserved for unreadable/encrypted inputs where both methods fail, so the
    caller can keep the historical byte heuristic."""
    page_count = _pdfinfo_page_count(path)
    if page_count is not None:
        return page_count
    return _pdf_marker_page_count(path)


def _pdf_marker_page_count(path: Path) -> int | None:
    """Historical dependency-free estimator used by effective-size routing.

    Keep this separate from authoritative Poppler metadata so adding stable
    page slicing cannot move the established small/medium KB thresholds.
    """
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
        pages = _pdf_marker_page_count(path)
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


def scan_sources(
    raw_dir: Path, *, include_pdf_execution_metadata: bool = True,
) -> list[dict[str, Any]]:
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
        # Routing small/ordinary KBs must remain the established cheap scan.
        # Authoritative Poppler metadata is only needed after batch mode has
        # already been selected and the hierarchical planner may split a PDF.
        page_count = (
            pdf_page_count(p)
            if include_pdf_execution_metadata and p.suffix.lower() == ".pdf"
            else None
        )
        item = {
            "path": str(p.relative_to(raw_dir)),
            "bytes": size,
            # Preserve the established small/medium routing signal. Poppler's
            # authoritative page_count below is execution metadata for the
            # hierarchical planner, not a threshold migration.
            "effective": effective_bytes(p, size),
        }
        if page_count is not None:
            item["page_count"] = page_count
            pdf_slices = _pdf_slices(page_count)
            if pdf_slices is not None:
                item["pdf_slices"] = pdf_slices
        sliced = _text_slices(p, size)
        if sliced is not None:
            item["line_count"], item["text_slices"] = sliced
        items.append(item)
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


_ATTACHMENT_EXTS = {"pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"}
_ATTACHMENT_ANCHOR_RE = re.compile(
    r"^(?:[0-9]+-)?(.+?) \((pdf|doc|docx|ppt|pptx|xls|xlsx)附件\)\.md$",
    re.IGNORECASE,
)


def _identity_part(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def _attachment_identity(path: str) -> tuple[str, str, str] | None:
    """Stable identity for an original file (or its exact sibling Markdown)
    below ``_attachments/``. Directory + full stem + real extension must match;
    no fuzzy title matching is allowed."""
    parts = path.split("/")
    if len(parts) < 3 or parts[0] != "_attachments":
        return None
    filename = parts[-1]
    if filename.lower().endswith(".md"):
        filename = filename[:-3]
    stem, dot, ext = filename.rpartition(".")
    if not dot or ext.casefold() not in _ATTACHMENT_EXTS:
        return None
    return (
        _identity_part("/".join(parts[1:-1])),
        _identity_part(stem),
        ext.casefold(),
    )


def _attachment_anchor_identity(path: str) -> tuple[str, str, str] | None:
    parts = path.split("/")
    if len(parts) < 2 or parts[0] == "_attachments":
        return None
    match = _ATTACHMENT_ANCHOR_RE.fullmatch(parts[-1])
    if match is None:
        return None
    return (
        _identity_part("/".join(parts[:-1])),
        _identity_part(match.group(1)),
        match.group(2).casefold(),
    )


def _attachment_anchors(known: set[str]) -> dict[tuple[str, str, str], str]:
    """Return only unambiguous exporter identities. If two anchors normalize
    to the same identity, omit the key so both attachments remain independent
    rather than being silently attached to the wrong document."""
    matches: dict[tuple[str, str, str], list[str]] = {}
    for path in known:
        identity = _attachment_anchor_identity(path)
        if identity is not None:
            matches.setdefault(identity, []).append(path)
    return {
        identity: paths[0]
        for identity, paths in matches.items()
        if len(paths) == 1
    }


def source_families(inventory: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group every source into one deterministic document family.

    A family is an anchor Markdown file plus all media below its sibling
    ``*.assets`` directory, plus an exactly matched original/sidecar below
    ``_attachments/``. Everything else is a one-source family. Returning
    inventory records (rather than just paths) keeps this function pure and
    lets the packer enforce effective-byte budgets without rescanning disk.
    """
    by_path = {str(i["path"]): i for i in inventory}
    known = set(by_path)
    attachment_anchors = _attachment_anchors(known)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in inventory:
        path = str(item["path"])
        attachment_identity = _attachment_identity(path)
        key = (
            _asset_anchor(path, known)
            or (attachment_anchors.get(attachment_identity) if attachment_identity else None)
            or path
        )
        grouped.setdefault(key, []).append(item)
    families: list[list[dict[str, Any]]] = []
    for key in sorted(grouped):
        items = grouped[key]
        # Put the anchor first, then the exact original/sidecar attachment, then
        # derived page images. Lexical order alone is wrong when the section
        # name sorts before ``_attachments`` (the real GPU export does): it
        # would spend vision batches on rendered pages before reading the
        # source PDF that gives those pages stable semantics.
        items.sort(key=lambda i: (
            0 if str(i["path"]) == key
            else 1 if _attachment_identity(str(i["path"])) is not None
            else 2,
            str(i["path"]),
        ))
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

    def append_text_slices(item: dict[str, Any]) -> None:
        slices = item.get("text_slices") or []
        source = str(item["path"])
        source_key = hashlib.sha256(source.encode("utf-8")).hexdigest()[:12]
        count = len(slices)
        for index, text_slice in enumerate(slices, start=1):
            result.append({
                "id": f"h{len(result) + 1:03d}",
                "sources": [source],
                "context_sources": [],
                "source_ranges": {
                    source: {
                        **text_slice,
                        "part": index,
                        "parts": count,
                        "slice_file": f".kbc-batch-slices/{source_key}-p{index:03d}.md",
                    },
                },
                "defer_accounting": index < count,
                "bytes": int(text_slice["bytes"]),
                "text_bytes": int(text_slice["bytes"]),
                "status": "pending",
            })

    def append_pdf_slices(item: dict[str, Any]) -> None:
        slices = item.get("pdf_slices") or []
        source = str(item["path"])
        count = len(slices)
        for index, page_slice in enumerate(slices, start=1):
            pages = int(page_slice["end_page"]) - int(page_slice["start_page"]) + 1
            result.append({
                "id": f"h{len(result) + 1:03d}",
                "sources": [source],
                "context_sources": [],
                "source_page_ranges": {source: dict(page_slice)},
                "defer_accounting": index < count,
                "bytes": pages * _pdf_page_cost(),
                "text_bytes": 0,
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
        has_slices = any(i.get("text_slices") or i.get("pdf_slices") for i in family)
        if not has_slices and family_bytes <= limit and family_text_bytes <= text_limit:
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
        sliced_anchor = anchor if anchor is not None and anchor.get("text_slices") else None
        if sliced_anchor is not None:
            remaining.pop(0)
            append_text_slices(sliced_anchor)
        elif anchor is not None:
            # The anchor itself is accounted once, in the first chunk.
            first = [remaining.pop(0)]
            first_bytes = _hierarchical_eff(first[0])
            first_text_bytes = _text_eff(first[0])
            while (
                remaining
                and not remaining[0].get("text_slices")
                and not remaining[0].get("pdf_slices")
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
            sliced_anchor is None and anchor is not None
            and _hierarchical_eff(anchor) < limit and _text_eff(anchor) < text_limit
            and _text_eff(anchor) <= _hierarchical_context_anchor_max_bytes()
        ) else []
        context_bytes = sum(_hierarchical_eff(i) for i in context)
        context_text_bytes = sum(_text_eff(i) for i in context)
        while remaining:
            if remaining[0].get("text_slices"):
                append_text_slices(remaining.pop(0))
                continue
            if remaining[0].get("pdf_slices"):
                append_pdf_slices(remaining.pop(0))
                continue
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
                    not remaining[0].get("text_slices")
                    and not remaining[0].get("pdf_slices")
                    and chunk_bytes + _hierarchical_eff(remaining[0]) <= limit
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
    has_text_slices = any(batch.get("source_ranges") for batch in batches)
    has_pdf_slices = any(batch.get("source_page_ranges") for batch in batches)
    return {
        "version": (
            4 if mode == "hierarchical" and has_pdf_slices
            else 3 if mode == "hierarchical" and has_text_slices
            else 2 if mode == "hierarchical"
            else 1
        ),
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
    text_budget: int | None = None, pdf_slice_pages: int | None = None,
) -> list[str]:
    """Errors for a (possibly model-proposed) plan. Empty list = valid.
    Rules: every inventory source in exactly one batch, no unknown sources,
    every batch within budget unless it is a single oversized file. Optional
    context sources may repeat across batches but are read-only and still count
    toward the per-session budget."""
    b = budget if budget is not None else batch_budget_bytes()
    errors: list[str] = []
    effective = _hierarchical_eff if plan.get("mode") == "hierarchical" else _eff
    records = {i["path"]: i for i in inventory}
    sizes = {path: effective(item) for path, item in records.items()}
    text_sizes = {path: _text_eff(item) for path, item in records.items()}
    seen: dict[str, str] = {}
    slice_appearances: dict[str, list[dict[str, Any]]] = {}
    page_slice_appearances: dict[str, list[dict[str, Any]]] = {}
    seen_ids: set[str] = set()
    pdf_page_limit = (
        pdf_slice_pages if pdf_slice_pages is not None
        else hierarchical_pdf_slice_pages()
    )
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
        source_ranges = batch.get("source_ranges", {})
        if not isinstance(source_ranges, dict):
            errors.append(f"batch {bid}: source_ranges must be an object")
            source_ranges = {}
        unknown_range_sources = set(source_ranges) - set(sources)
        if unknown_range_sources:
            errors.append(
                f"batch {bid}: source_ranges names unassigned source(s): "
                + ", ".join(sorted(unknown_range_sources)[:3]))
        if source_ranges and (len(sources) != 1 or context):
            errors.append(f"batch {bid}: a text-slice batch must contain one source and no context")
        source_page_ranges = batch.get("source_page_ranges", {})
        if not isinstance(source_page_ranges, dict):
            errors.append(f"batch {bid}: source_page_ranges must be an object")
            source_page_ranges = {}
        unknown_page_range_sources = set(source_page_ranges) - set(sources)
        if unknown_page_range_sources:
            errors.append(
                f"batch {bid}: source_page_ranges names unassigned source(s): "
                + ", ".join(sorted(unknown_page_range_sources)[:3]))
        if source_page_ranges and (len(sources) != 1 or context):
            errors.append(f"batch {bid}: a PDF page-slice batch must contain one source and no context")
        if source_ranges and source_page_ranges:
            errors.append(f"batch {bid}: cannot mix text and PDF source ranges")
        total = 0
        text_total = 0
        for path in sources:
            if path not in sizes:
                errors.append(f"batch {bid}: unknown source {path}")
                continue
            source_range = source_ranges.get(path)
            source_page_range = source_page_ranges.get(path)
            if path in seen:
                if (
                    source_range is None
                    and source_page_range is None
                ) or (
                    source_range is not None and path not in slice_appearances
                ) or (
                    source_page_range is not None and path not in page_slice_appearances
                ):
                    errors.append(f"source {path} appears in {seen[path]} and {bid}")
            else:
                seen[path] = bid
            if source_range is None and source_page_range is None:
                if path in slice_appearances or path in page_slice_appearances:
                    errors.append(f"source {path} mixes sliced and unsliced assignments")
                total += sizes[path]
                text_total += text_sizes[path]
                continue
            if source_range is not None and source_page_range is not None:
                errors.append(f"batch {bid}: source {path} mixes text and PDF ranges")
                continue
            if source_range is not None and not isinstance(source_range, dict):
                errors.append(f"batch {bid}: invalid source range for {path}")
                continue
            if source_range is not None:
                try:
                    parsed_range = {
                        "bid": bid,
                        "start_line": int(source_range["start_line"]),
                        "end_line": int(source_range["end_line"]),
                        "bytes": int(source_range["bytes"]),
                        "part": int(source_range["part"]),
                        "parts": int(source_range["parts"]),
                        "slice_file": str(source_range["slice_file"]),
                        "defer_accounting": bool(batch.get("defer_accounting", False)),
                    }
                except (KeyError, TypeError, ValueError):
                    errors.append(f"batch {bid}: malformed source range for {path}")
                    continue
                if parsed_range["start_line"] < 1 or parsed_range["end_line"] < parsed_range["start_line"]:
                    errors.append(f"batch {bid}: invalid line range for {path}")
                if parsed_range["bytes"] < 1:
                    errors.append(f"batch {bid}: empty text slice for {path}")
                if not parsed_range["slice_file"].startswith(".kbc-batch-slices/"):
                    errors.append(f"batch {bid}: unsafe slice file for {path}")
                slice_appearances.setdefault(path, []).append(parsed_range)
                total += max(0, parsed_range["bytes"])
                text_total += max(0, parsed_range["bytes"])
                continue
            if not isinstance(source_page_range, dict):
                errors.append(f"batch {bid}: invalid PDF page range for {path}")
                continue
            try:
                parsed_page_range = {
                    "bid": bid,
                    "start_page": int(source_page_range["start_page"]),
                    "end_page": int(source_page_range["end_page"]),
                    "part": int(source_page_range["part"]),
                    "parts": int(source_page_range["parts"]),
                    "defer_accounting": bool(batch.get("defer_accounting", False)),
                }
            except (KeyError, TypeError, ValueError):
                errors.append(f"batch {bid}: malformed PDF page range for {path}")
                continue
            page_span = parsed_page_range["end_page"] - parsed_page_range["start_page"] + 1
            if parsed_page_range["start_page"] < 1 or page_span < 1:
                errors.append(f"batch {bid}: invalid PDF page range for {path}")
            if page_span > pdf_page_limit:
                errors.append(
                    f"batch {bid}: PDF page range for {path} exceeds {pdf_page_limit} pages")
            page_slice_appearances.setdefault(path, []).append(parsed_page_range)
            total += max(0, page_span) * _pdf_page_cost()
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
    for path, appearances in slice_appearances.items():
        line_count = int(records.get(path, {}).get("line_count", 0))
        ordered = sorted(appearances, key=lambda item: item["part"])
        declared_parts = {item["parts"] for item in ordered}
        if line_count < 1 or len(declared_parts) != 1 or next(iter(declared_parts), 0) != len(ordered):
            errors.append(f"source {path} has incomplete text-slice metadata")
            continue
        if [item["part"] for item in ordered] != list(range(1, len(ordered) + 1)):
            errors.append(f"source {path} has non-sequential text slices")
        expected_start = 1
        for index, item in enumerate(ordered):
            if item["start_line"] != expected_start:
                errors.append(f"source {path} text slices are not contiguous")
                break
            expected_start = item["end_line"] + 1
            should_defer = index < len(ordered) - 1
            if item["defer_accounting"] != should_defer:
                errors.append(f"source {path} has invalid deferred-accounting boundary")
        if expected_start != line_count + 1:
            errors.append(f"source {path} text slices do not cover all {line_count} lines")
    for path, appearances in page_slice_appearances.items():
        page_count = int(records.get(path, {}).get("page_count", 0))
        ordered = sorted(appearances, key=lambda item: item["part"])
        declared_parts = {item["parts"] for item in ordered}
        if page_count < 1 or len(declared_parts) != 1 or next(iter(declared_parts), 0) != len(ordered):
            errors.append(f"source {path} has incomplete PDF page-slice metadata")
            continue
        if [item["part"] for item in ordered] != list(range(1, len(ordered) + 1)):
            errors.append(f"source {path} has non-sequential PDF page slices")
        expected_start = 1
        for index, item in enumerate(ordered):
            if item["start_page"] != expected_start:
                errors.append(f"source {path} PDF page slices are not contiguous")
                break
            expected_start = item["end_page"] + 1
            should_defer = index < len(ordered) - 1
            if item["defer_accounting"] != should_defer:
                errors.append(f"source {path} has invalid PDF deferred-accounting boundary")
        if expected_start != page_count + 1:
            errors.append(f"source {path} PDF slices do not cover all {page_count} pages")
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
            ranges = b.get("source_ranges")
            if isinstance(ranges, dict):
                for source in gone:
                    ranges.pop(source, None)
            page_ranges = b.get("source_page_ranges")
            if isinstance(page_ranges, dict):
                for source in gone:
                    page_ranges.pop(source, None)
            if not sources:
                b["status"] = "done"
        context = [s for s in b.get("context_sources", []) if s in known]
        context_gone = [s for s in b.get("context_sources", []) if s not in known]
        if context_gone:
            dropped.extend(context_gone)
            b["context_sources"] = context
    return sorted(set(dropped))


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def plan_too_fragmented(model_batches: list[dict[str, Any]], baseline_batches: list[dict[str, Any]]) -> bool:
    """Fragmentation guard: the model planner's value is TOPICAL regrouping, not
    finer slicing. A plan much more fragmented than the deterministic baseline
    (seen in the wild: raw-bytes thinking → one lonely image per batch) wastes a
    whole fresh session per sliver. Allow modest growth for topical splits."""
    return len(model_batches) > max(int(len(baseline_batches) * 1.5), len(baseline_batches) + 2)
