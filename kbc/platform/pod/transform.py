#!/usr/bin/env python3
"""transform — render PDF sources to per-page PNGs at source-install time.

Engine-neutral multimodal leveler (DESIGN-kb-box-codex-engine §7): Claude reads
PDFs natively, codex does not — rendering each page to an image puts every
engine on the same footing (mid-compile the agent reads the page image with its
own image tool). Output sits NEXT TO the source as `<file>.pages/page-NNN.png`:

  raw/ops/handbook.pdf
  raw/ops/handbook.pdf.pages/page-001.png …

`.png` is not a TEXT_SOURCE_EXT, so the coverage ledger (selfcheck.py) is
unaffected — renders are derived views, never sources to account for.

Gated by KBC_RENDER_PDF_PAGES=1 (set in the codex image; the claude image
leaves it off → zero behavior change). pypdfium2 missing while the flag is on
is a broken image build → fail loudly. A single corrupt PDF only skips itself
(reported in the /sources response), never blocks the rest of the corpus.
"""
import os
from pathlib import Path


def render_enabled() -> bool:
    return os.environ.get("KBC_RENDER_PDF_PAGES") == "1"


def render_pdf_pages(raw_dir: str | Path) -> dict:
    """Render every PDF under raw_dir. Returns a summary for the /sources
    response: {"pdf_pages_rendered": int, "pdf_render_errors": [str, ...]}."""
    import pypdfium2 as pdfium  # image-build dependency; import only when enabled

    max_pages = int(os.environ.get("KBC_RENDER_PDF_MAX_PAGES", "200"))
    scale = float(os.environ.get("KBC_RENDER_PDF_SCALE", "2.0"))
    rendered = 0
    errors: list[str] = []
    root = Path(raw_dir)
    for pdf_path in sorted(root.rglob("*.pdf")):
        if not pdf_path.is_file():
            continue
        out_dir = pdf_path.parent / (pdf_path.name + ".pages")
        try:
            doc = pdfium.PdfDocument(pdf_path)
            try:
                n = min(len(doc), max_pages)
                out_dir.mkdir(parents=True, exist_ok=True)
                for i in range(n):
                    page = doc[i]
                    bitmap = page.render(scale=scale)
                    bitmap.to_pil().save(out_dir / f"page-{i + 1:03d}.png")
                    rendered += 1
                if len(doc) > max_pages:
                    errors.append(f"{pdf_path.relative_to(root)}: {len(doc)} pages, rendered first {max_pages} "
                                  f"(KBC_RENDER_PDF_MAX_PAGES)")
            finally:
                doc.close()
        except Exception as e:
            errors.append(f"{pdf_path.relative_to(root)}: {e!r}")
    return {"pdf_pages_rendered": rendered, "pdf_render_errors": errors}
