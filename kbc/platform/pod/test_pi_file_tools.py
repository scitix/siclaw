"""File-tool parity at the existing KBC source and snapshot boundaries."""

import base64
from pathlib import Path

import pytest

import compile_box
from pi_file_tools import FileTools, MAX_FILE_BYTES, MAX_OUTPUT_BYTES


def files(root, *, scope=None, pages=None, allowed=None):
    return FileTools(str(root), allowed or ["Read", "Write", "Edit", "Glob", "Grep"],
                     compile_box._make_compile_path_guard(root, raw_scope=scope, pdf_page_ranges=pages))


async def test_unicode_atomic_write_edit_and_bounded_read(tmp_path):
    tools = files(tmp_path)
    text = "排查故障并继续编译" * 10000
    await tools.write({"file_path": "candidate/page.md", "content": text})
    page = tmp_path / "candidate/page.md"
    assert page.read_text() == text
    with pytest.raises(ValueError, match="unique match"):
        await tools.edit({"file_path": str(page), "old_string": "故障", "new_string": "错误"})
    assert page.read_text() == text
    await tools.edit({"file_path": str(page), "old_string": "故障", "new_string": "错误", "replace_all": True})
    assert page.read_text() == text.replace("故障", "错误")
    result = (await tools.read({"file_path": str(page)}))["content"][0]["text"]
    assert "truncated" in result and "\ufffd" not in result
    assert len(result.encode()) < MAX_OUTPUT_BYTES + 200
    assert sorted(path.name for path in page.parent.iterdir()) == ["page.md"]


async def test_frozen_raw_scope_and_symlink_cannot_be_bypassed(tmp_path):
    root = tmp_path / "work"
    (root / "raw").mkdir(parents=True)
    (root / "candidate").mkdir()
    (root / "raw/assigned.md").write_text("assigned evidence")
    (root / "raw/unassigned.md").write_text("unassigned evidence")
    (root / "candidate/page.md").write_text("candidate evidence")
    (tmp_path / "outside.md").write_text("outside evidence")
    (root / "escape.md").symlink_to(tmp_path / "outside.md")
    tools = files(root, scope={"account": ["assigned.md"], "deny_read": [], "consult": False})
    for path in ["raw/unassigned.md", "escape.md", "../outside.md"]:
        with pytest.raises(PermissionError):
            await tools.read({"file_path": path})
    with pytest.raises(PermissionError):
        await tools.write({"file_path": "raw/assigned.md", "content": "corrupt"})
    with pytest.raises(PermissionError):
        await tools.grep({"pattern": "evidence", "path": ".", "output_mode": "content"})
    result = await tools.grep({"pattern": "evidence", "path": "raw/assigned.md", "output_mode": "content"})
    assert "assigned evidence" in result["content"][0]["text"]
    assert (root / "raw/assigned.md").read_text() == "assigned evidence"


async def test_consult_search_keeps_corpus_access_without_reading_denied_original(tmp_path):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw/large.md").write_text("corpus-only-marker")
    tools = files(tmp_path, scope={"account": [], "deny_read": ["large.md"], "consult": True})
    with pytest.raises(PermissionError):
        await tools.read({"file_path": "raw/large.md"})
    result = await tools.grep({"pattern": "corpus-only-marker", "path": ".", "output_mode": "content"})
    assert "corpus-only-marker" in result["content"][0]["text"]


async def test_snapshot_search_checks_each_descendant(tmp_path):
    from engine import _make_multiroot_guard

    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "visible.md").write_text("visible-evidence")
    (tmp_path / "authoring.md").write_text("private-authoring")
    (snapshot / "escape.md").symlink_to(tmp_path / "authoring.md")
    tools = FileTools(str(snapshot), ["Read", "Glob", "Grep"], _make_multiroot_guard([snapshot]))
    found = (await tools.grep({"pattern": ".", "output_mode": "content"}))["content"][0]["text"]
    assert "visible-evidence" in found and "private-authoring" not in found
    with pytest.raises(PermissionError):
        await tools.write({"file_path": "visible.md", "content": "changed"})


@pytest.mark.parametrize("filter_args", [{"glob": "*.md"}, {"type": "markdown"}])
async def test_grep_filters_files_before_consuming_output_budget(tmp_path, filter_args):
    (tmp_path / "notes.txt").write_text("marker ignored\n" * 5000)
    (tmp_path / "page.md").write_text("marker relevant")
    tools = files(tmp_path)
    args = {"pattern": "marker", "output_mode": "content", **filter_args}
    result = (await tools.grep(args))["content"][0]["text"]
    assert "marker relevant" in result and "marker ignored" not in result
    assert (await tools.grep({**args, "path": "notes.txt"}))["content"][0]["text"] == "No matches."


def pdf_fixture(path: Path):
    """Three actual PDF pages, without adding a PDF library to production."""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>"]
    for number in range(1, 4):
        stream = f"BT /F1 20 Tf 30 150 Td (PAGE-{number}-EVIDENCE) Tj ET".encode()
        objects.extend([
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 9 0 R >> >> /Contents {number * 2 + 2} 0 R >>".encode(),
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        ])
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    data, offsets = bytearray(b"%PDF-1.4\n"), [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(data)
    data.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    data.extend(b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:]))
    data.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    path.write_bytes(data)


async def test_pdf_page_slice_preserves_text_and_images(tmp_path):
    (tmp_path / "raw").mkdir()
    pdf_fixture(tmp_path / "raw/manual.pdf")
    tools = files(tmp_path, pages={"manual.pdf": {"start_page": 2, "end_page": 2}})
    with pytest.raises(PermissionError):
        await tools.read({"file_path": "raw/manual.pdf", "pages": "1-3"})
    result = await tools.read({"file_path": "raw/manual.pdf", "pages": "2-2"})
    text = result["content"][0]["text"]
    assert "PAGE-2-EVIDENCE" in text and "PAGE-1-EVIDENCE" not in text and "PAGE-3-EVIDENCE" not in text
    images = [part for part in result["content"] if part["type"] == "image"]
    assert len(images) == 1 and base64.b64decode(images[0]["data"]).startswith(b"\x89PNG")


async def test_large_pdf_can_read_its_bounded_assigned_page(tmp_path):
    (tmp_path / "raw").mkdir()
    pdf = tmp_path / "raw/manual.pdf"
    pdf_fixture(pdf)
    # A legal large ignored stream before xref gives the parser normal PDF
    # structure while exercising a source larger than the text-read budget.
    data = pdf.read_bytes()
    xref_offset = int(data.rsplit(b"startxref\n", 1)[1].splitlines()[0])
    padding = b"%" + b" " * MAX_FILE_BYTES + b"\n"
    data = data[:xref_offset] + padding + data[xref_offset:]
    data = data.replace(f"startxref\n{xref_offset}\n".encode(), f"startxref\n{xref_offset + len(padding)}\n".encode())
    pdf.write_bytes(data)
    tools = files(tmp_path, pages={"manual.pdf": {"start_page": 2, "end_page": 2}})
    result = await tools.read({"file_path": "raw/manual.pdf", "pages": "2-2"})
    assert "PAGE-2-EVIDENCE" in result["content"][0]["text"]
    assert sum(part["type"] == "image" for part in result["content"]) == 1
