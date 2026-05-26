import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class RouteTests(unittest.TestCase):
    def test_routes_everything_to_text_when_structure_is_disabled(self) -> None:
        with patch.dict(os.environ, {"SICLAW_OCR_ENABLE_STRUCTURE": "0"}):
            self.assertEqual(server.choose_route("/tmp/receipt.pdf", "pdf"), "text")
            self.assertEqual(server.choose_route("/tmp/terminal.png", "terminal"), "text")

    def test_routes_document_inputs_to_structure_when_enabled(self) -> None:
        with patch.dict(os.environ, {"SICLAW_OCR_ENABLE_STRUCTURE": "1"}):
            self.assertEqual(server.choose_route("/tmp/receipt.pdf", "auto"), "structure")
            self.assertEqual(server.choose_route("/tmp/table.png", "table"), "structure")
            self.assertEqual(server.choose_route("/tmp/terminal.png", "terminal"), "text")


class MarkdownTableTests(unittest.TestCase):
    def test_parses_basic_markdown_table(self) -> None:
        table = server.parse_markdown_table([
            "| Name | CPU | MEM |",
            "| --- | ---: | ---: |",
            "| node-a | 8 | 32Gi |",
            "| node-b | 16 | 64Gi |",
        ])

        self.assertEqual(table, {
            "headers": ["Name", "CPU", "MEM"],
            "rows": [
                ["node-a", "8", "32Gi"],
                ["node-b", "16", "64Gi"],
            ],
            "markdown": "| Name | CPU | MEM |\n| --- | ---: | ---: |\n| node-a | 8 | 32Gi |\n| node-b | 16 | 64Gi |",
        })

    def test_rejects_single_row_table(self) -> None:
        self.assertIsNone(server.parse_markdown_table(["| only | header |"]))


class LanguageTests(unittest.TestCase):
    def test_respects_explicit_language_hint(self) -> None:
        self.assertEqual(server.normalize_language("zh", "plain english"), "zh")
        self.assertEqual(server.normalize_language("en", "中文"), "en")

    def test_detects_language_when_hint_is_auto(self) -> None:
        self.assertEqual(server.normalize_language("auto", "节点状态正常"), "zh")
        self.assertEqual(server.normalize_language("auto", "kubectl get pods"), "en")
        self.assertEqual(server.normalize_language("auto", "12345"), "unknown")


class SafetyHelpersTests(unittest.TestCase):
    def test_safe_log_value_strips_control_characters(self) -> None:
        self.assertEqual(server.safe_log_value("foo\nbar\tbaz"), "foo_bar_baz")

    def test_hard_timeout_ms_can_be_disabled_for_local_debugging(self) -> None:
        with patch.dict(os.environ, {"SICLAW_OCR_HARD_TIMEOUT_MS": "0"}):
            self.assertEqual(server.hard_timeout_ms(), 0)

    def test_max_pdf_pages_defaults_to_ten_and_can_be_disabled(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(server.max_pdf_pages(), 10)
        with patch.dict(os.environ, {"SICLAW_OCR_MAX_PDF_PAGES": "0"}):
            self.assertEqual(server.max_pdf_pages(), 0)

    def test_max_image_pixels_defaults_and_can_be_disabled(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(server.max_image_pixels(), 50_000_000)
        with patch.dict(os.environ, {"SICLAW_OCR_MAX_IMAGE_PIXELS": "0"}):
            self.assertEqual(server.max_image_pixels(), 0)

    def test_prepend_warnings_preserves_backend_warnings(self) -> None:
        result = {"warnings": ["backend warning"]}

        server.prepend_warnings(result, ["pdf warning"])

        self.assertEqual(result["warnings"], ["pdf warning", "backend warning"])

    def test_enforce_pdf_page_limit_writes_limited_pdf(self) -> None:
        class FakeReader:
            def __init__(self, _path: str) -> None:
                self.pages = list(range(12))

        class FakeWriter:
            def __init__(self) -> None:
                self.pages: list[int] = []

            def add_page(self, page: int) -> None:
                self.pages.append(page)

            def write(self, stream) -> None:
                stream.write(("pages:" + ",".join(str(p) for p in self.pages)).encode("utf-8"))

        fake_pypdf = types.ModuleType("pypdf")
        fake_pypdf.PdfReader = FakeReader
        fake_pypdf.PdfWriter = FakeWriter

        with tempfile.TemporaryDirectory() as tmp_dir:
            pdf_path = Path(tmp_dir) / "paper.pdf"
            pdf_path.write_bytes(b"%PDF")
            with patch.dict(os.environ, {"SICLAW_OCR_MAX_PDF_PAGES": "10"}), patch.dict(sys.modules, {"pypdf": fake_pypdf}):
                limited_path, warnings = server.enforce_pdf_page_limit(str(pdf_path), Path(tmp_dir))

            self.assertNotEqual(limited_path, str(pdf_path))
            self.assertEqual(Path(limited_path).read_text(), "pages:0,1,2,3,4,5,6,7,8,9")
            self.assertEqual(len(warnings), 1)
            self.assertIn("PDF has 12 pages", warnings[0])
            self.assertIn("first 10 pages", warnings[0])

    def test_materialize_source_rejects_parent_directory_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            with self.assertRaisesRegex(ValueError, "unsafe filename"):
                server.materialize_source({
                    "source": {
                        "type": "file_base64",
                        "filename": "..",
                        "data": "aGVsbG8=",
                    },
                }, Path(tmp_dir))

    def test_materialize_source_rejects_invalid_base64(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            with self.assertRaisesRegex(ValueError, "invalid base64 data"):
                server.materialize_source({
                    "source": {
                        "type": "file_base64",
                        "filename": "image.png",
                        "data": "not base64 !!!",
                    },
                }, Path(tmp_dir))

    def test_enforce_image_pixel_limit_rejects_large_decoded_image(self) -> None:
        class FakeImageObject:
            size = (100, 100)

            def __enter__(self):
                return self

            def __exit__(self, _exc_type, _exc, _tb) -> None:
                return None

        class FakeImage:
            MAX_IMAGE_PIXELS = None
            DecompressionBombWarning = UserWarning

            @staticmethod
            def open(_path: str) -> FakeImageObject:
                return FakeImageObject()

        fake_pil = types.ModuleType("PIL")
        fake_pil.Image = FakeImage
        fake_pil.UnidentifiedImageError = ValueError

        with tempfile.TemporaryDirectory() as tmp_dir:
            image_path = Path(tmp_dir) / "large.png"
            image_path.write_bytes(b"png")
            with patch.dict(os.environ, {"SICLAW_OCR_MAX_IMAGE_PIXELS": "9999"}), patch.dict(sys.modules, {"PIL": fake_pil}):
                with self.assertRaisesRegex(ValueError, "image is too large"):
                    server.enforce_image_pixel_limit(str(image_path))


if __name__ == "__main__":
    unittest.main()
