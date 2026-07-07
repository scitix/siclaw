"""office_ingest — pre-render binary office sources to markdown the agent can Read.

The served box receives raw/ as ORIGINAL bytes. The agent's Read tool (and the
model) handle pdf / images / plain text natively, but zip-based office formats
(.pptx / .xlsx / .docx) are opaque binary. At raw-install time this renders each
into a sibling `<name>.md` (e.g. deck.pptx -> deck.pptx.md) so the agent reads
clean markdown; the ORIGINAL file is left in place for provenance.

Deliberately lightweight per-format extraction (python-pptx / openpyxl /
python-docx) — no OCR / vision. Images inside a deck stay native for the
compile-stage model. Imports are lazy so this module stays importable without
the optional deps (e.g. a dep-less unit host); an actual conversion needs them
installed — they are baked into the box image.
"""
from __future__ import annotations

from pathlib import Path

OFFICE_EXTS = (".pptx", ".xlsx", ".docx")


def _table(rows: list[list[str]]) -> list[str]:
    """Render a row matrix as a GitHub markdown table (first row = header)."""
    if not rows:
        return []
    width = len(rows[0])

    def cells(r: list[str]) -> str:
        r = (r + [""] * width)[:width]  # pad/truncate to header width → valid table
        return "| " + " | ".join(c.replace("\n", " ").replace("|", "\\|").strip() for c in r) + " |"

    return [cells(rows[0]), "| " + " | ".join("---" for _ in range(width)) + " |"] + [cells(r) for r in rows[1:]]


def pptx_to_md(path: Path) -> str:
    from pptx import Presentation

    out: list[str] = []
    for i, slide in enumerate(Presentation(str(path)).slides, 1):
        out.append(f"## Slide {i}")
        for shape in slide.shapes:
            if shape.has_table:
                out += _table([[c.text.strip() for c in row.cells] for row in shape.table.rows])
            elif shape.has_text_frame and shape.text_frame.text.strip():
                out.append(shape.text_frame.text.strip())
    return "\n".join(out).strip() + "\n"


def xlsx_to_md(path: Path) -> str:
    from openpyxl import load_workbook

    out: list[str] = []
    wb = load_workbook(str(path), data_only=True, read_only=True)
    try:
        for ws in wb.worksheets:
            out.append(f"## Sheet: {ws.title}")
            rows = [["" if c is None else str(c) for c in row] for row in ws.iter_rows(values_only=True)]
            out += _table([r for r in rows if any(c.strip() for c in r)])  # drop fully-blank rows
    finally:
        wb.close()
    return "\n".join(out).strip() + "\n"


def docx_to_md(path: Path) -> str:
    from docx import Document

    doc = Document(str(path))
    out: list[str] = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = para.style.name or ""
        if style == "Title":
            out.append("# " + text)
        elif style.startswith("Heading"):
            tail = style.split()[-1]
            out.append("#" * min(int(tail) if tail.isdigit() else 2, 6) + " " + text)
        else:
            out.append(text)
    for tbl in doc.tables:
        out += _table([[c.text.strip() for c in row.cells] for row in tbl.rows])
    return "\n".join(out).strip() + "\n"


_CONVERTERS = {".pptx": pptx_to_md, ".xlsx": xlsx_to_md, ".docx": docx_to_md}


def convert_file(path: Path) -> str | None:
    """Render one office file to markdown, or None if it is not an office format."""
    fn = _CONVERTERS.get(path.suffix.lower())
    return fn(path) if fn else None


def convert_tree(root: str) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Walk `root`, render each .pptx/.xlsx/.docx to a sibling `<name>.md`.

    Returns (converted, errors): converted = [(src_rel, md_rel)], errors =
    [(src_rel, message)]. Per-file fail-open — a corrupt file is recorded and
    skipped, never aborts the batch: the original stays, and one bad deck must
    not sink a whole KB install. Idempotent: an existing `<name>.md` is left
    untouched (a re-install of the same bundle is a no-op)."""
    r = Path(root)
    converted: list[tuple[str, str]] = []
    errors: list[tuple[str, str]] = []
    if not r.is_dir():
        return converted, errors
    for f in sorted(r.rglob("*")):
        if not f.is_file() or f.suffix.lower() not in OFFICE_EXTS:
            continue
        rel = f.relative_to(r).as_posix()
        dest = f.with_name(f.name + ".md")  # deck.pptx -> deck.pptx.md
        if dest.exists():
            continue
        try:
            md = convert_file(f)
        except Exception as e:  # any parser failure is per-file non-fatal (fail-open boundary)
            errors.append((rel, repr(e)))
            continue
        if not md:
            continue
        try:
            dest.write_text(md, encoding="utf-8")
        except OSError as e:
            errors.append((rel, repr(e)))
            continue
        converted.append((rel, dest.relative_to(r).as_posix()))
    return converted, errors
