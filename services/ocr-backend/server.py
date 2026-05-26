#!/usr/bin/env python3
"""Siclaw attachment OCR backend.

This service intentionally uses only the Python standard library for HTTP so the
production image stays small and easy to replace. Portal sends pasted image/PDF
attachments here and forwards the extracted text evidence to the Siclaw agent.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import tempfile
import threading
import time
import traceback
import uuid
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


OCR_PIPELINE: Any | None = None
STRUCTURE_PIPELINE: Any | None = None
OCR_LOCK = threading.Lock()
STRUCTURE_LOCK = threading.Lock()
REQUEST_SEMAPHORE: threading.BoundedSemaphore | None = None
REQUEST_SEMAPHORE_LOCK = threading.Lock()

# PaddleOCR 3.x CPU inference can select oneDNN/MKLDNN paths that fail for
# PP-OCRv5 on some nodes. Keep the stable Paddle static path unless explicitly
# overridden by the operator.
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")
os.environ.setdefault("FLAGS_use_mkldnn", "0")


def bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    try:
        return int(value)
    except ValueError:
        return int(float(value))


def max_concurrency() -> int:
    return max(1, int_env("SICLAW_OCR_MAX_CONCURRENCY", 1))


def hard_timeout_ms() -> int:
    return max(0, int_env("SICLAW_OCR_HARD_TIMEOUT_MS", 150_000))


def max_pdf_pages() -> int:
    return max(0, int_env("SICLAW_OCR_MAX_PDF_PAGES", 10))


def max_image_pixels() -> int:
    return max(0, int_env("SICLAW_OCR_MAX_IMAGE_PIXELS", 50_000_000))


def request_semaphore() -> threading.BoundedSemaphore:
    global REQUEST_SEMAPHORE
    if REQUEST_SEMAPHORE is None:
        with REQUEST_SEMAPHORE_LOCK:
            if REQUEST_SEMAPHORE is None:
                REQUEST_SEMAPHORE = threading.BoundedSemaphore(max_concurrency())
    return REQUEST_SEMAPHORE


def device() -> str:
    return os.environ.get("PADDLEOCR_DEVICE", "cpu")


def get_ocr_pipeline() -> Any:
    global OCR_PIPELINE
    if OCR_PIPELINE is None:
        with OCR_LOCK:
            if OCR_PIPELINE is None:
                OCR_PIPELINE = build_ocr_pipeline()
    return OCR_PIPELINE


def build_ocr_pipeline() -> Any:
    from paddleocr import PaddleOCR

    kwargs: dict[str, Any] = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "device": device(),
    }
    if bool_env("PADDLEOCR_ENABLE_HPI", False):
        kwargs["enable_hpi"] = True
    if os.environ.get("PADDLEOCR_TEXT_DETECTION_MODEL_NAME"):
        kwargs["text_detection_model_name"] = os.environ["PADDLEOCR_TEXT_DETECTION_MODEL_NAME"]
    if os.environ.get("PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME"):
        kwargs["text_recognition_model_name"] = os.environ["PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME"]
    if os.environ.get("PADDLEOCR_TEXT_DET_LIMIT_SIDE_LEN"):
        kwargs["text_det_limit_side_len"] = int(os.environ["PADDLEOCR_TEXT_DET_LIMIT_SIDE_LEN"])
    if os.environ.get("PADDLEOCR_LANG"):
        kwargs["lang"] = os.environ["PADDLEOCR_LANG"]
    return PaddleOCR(**kwargs)


def structure_enabled() -> bool:
    return bool_env("SICLAW_OCR_ENABLE_STRUCTURE", False)


def get_structure_pipeline() -> Any:
    global STRUCTURE_PIPELINE
    if STRUCTURE_PIPELINE is None:
        with STRUCTURE_LOCK:
            if STRUCTURE_PIPELINE is None:
                from paddleocr import PPStructureV3

                STRUCTURE_PIPELINE = PPStructureV3(device=device())
    return STRUCTURE_PIPELINE


def main() -> None:
    host = os.environ.get("PADDLEOCR_BACKEND_HOST", "127.0.0.1")
    port = int(os.environ.get("PADDLEOCR_BACKEND_PORT", "8088"))
    if os.environ.get("PADDLEOCR_PRELOAD", "1") != "0":
        started = time.perf_counter()
        get_ocr_pipeline()
        print(f"[paddleocr-backend] preloaded text OCR in {elapsed_ms(started)}ms", flush=True)
        if structure_enabled():
            started = time.perf_counter()
            get_structure_pipeline()
            print(f"[paddleocr-backend] preloaded structure OCR in {elapsed_ms(started)}ms", flush=True)
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[paddleocr-backend] listening on http://{host}:{port}", flush=True)
    server.serve_forever()


class Handler(BaseHTTPRequestHandler):
    server_version = "siclaw-paddleocr-backend/0.1"

    def do_GET(self) -> None:
        if self.path in {"/healthz", "/health"}:
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/parse":
            self.send_json(404, {"error": "not found"})
            return

        started = time.perf_counter()
        request_id = request_id_from_headers(self.headers)
        kind_hint = "-"
        mime_type = "-"
        route = "-"
        try:
            size = int(self.headers.get("content-length", "0"))
            max_size = int_env("PADDLEOCR_MAX_REQUEST_BYTES", 10 * 1024 * 1024)
            if size <= 0:
                self.log_parse(request_id, "failed", 400, "-", "-", "-", started)
                self.send_json(400, {"error": "empty request body"}, request_id=request_id)
                return
            if size > max_size:
                self.log_parse(request_id, "failed", 413, "-", "-", "-", started, size=size)
                self.send_json(
                    413,
                    {"error": f"request body too large; limit is {max_size} bytes"},
                    request_id=request_id,
                )
                return
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
            request_id = request_id_from_payload(payload, request_id)
            kind_hint, mime_type = payload_metadata(payload)
            semaphore = request_semaphore()
            if not semaphore.acquire(blocking=False):
                self.log_parse(request_id, "busy", 503, kind_hint, mime_type, "-", started, size=size)
                self.send_json(
                    503,
                    {"error": f"OCR backend is busy; max concurrency is {max_concurrency()}"},
                    request_id=request_id,
                    headers={"Retry-After": "1"},
                )
                return
            watchdog = RequestWatchdog(request_id, kind_hint, mime_type, started)
            try:
                watchdog.arm()
                result = parse_request(payload)
            finally:
                watchdog.cancel()
                semaphore.release()
            route = str(result.get("route") or "-")
            self.log_parse(
                request_id,
                "ok",
                200,
                str(result.get("kind") or kind_hint),
                mime_type,
                route,
                started,
                size=size,
            )
            self.send_json(200, result, request_id=request_id)
        except json.JSONDecodeError as exc:
            self.log_parse(request_id, "failed", 400, kind_hint, mime_type, route, started)
            self.send_json(400, {"error": f"invalid JSON: {exc}"}, request_id=request_id)
        except ValueError as exc:
            self.log_parse(request_id, "failed", 400, kind_hint, mime_type, route, started)
            self.send_json(400, {"error": str(exc)}, request_id=request_id)
        except Exception as exc:  # noqa: BLE001 - return service errors as JSON.
            self.log_parse(request_id, "failed", 500, kind_hint, mime_type, route, started)
            body: dict[str, Any] = {"error": "OCR parse failed"}
            if bool_env("SICLAW_OCR_DEBUG", False):
                body["detail"] = str(exc)
                body["trace"] = traceback.format_exc().splitlines()[-8:]
            self.send_json(
                500,
                body,
                request_id=request_id,
            )
            print(f"[paddleocr-backend] parse failed request_id={request_id}: {exc}", flush=True)
            traceback.print_exc()

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[paddleocr-backend] {self.address_string()} {fmt % args}", flush=True)

    def log_parse(
        self,
        request_id: str,
        status: str,
        status_code: int,
        kind: str,
        mime: str,
        route: str,
        started: float,
        *,
        size: int | None = None,
    ) -> None:
        size_field = f" size={size}" if size is not None else ""
        print(
            "[paddleocr-backend] parse "
            f"request_id={request_id} "
            f"status={status} "
            f"status_code={status_code} "
            f"kind={safe_log_value(kind)} "
            f"mime={safe_log_value(mime)} "
            f"route={safe_log_value(route)} "
            f"elapsed_ms={elapsed_ms(started)}"
            f"{size_field}",
            flush=True,
        )

    def send_json(
        self,
        status: int,
        body: dict[str, Any],
        *,
        request_id: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            if request_id:
                self.send_header("x-request-id", request_id)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except BrokenPipeError:
            print("[paddleocr-backend] client disconnected before response completed", flush=True)


def request_id_from_headers(headers: Any) -> str:
    return normalize_request_id(headers.get("x-request-id"))


def request_id_from_payload(payload: dict[str, Any], fallback: str) -> str:
    return normalize_request_id(payload.get("request_id") or payload.get("requestId") or fallback)


def normalize_request_id(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return safe_log_value(value.strip())[:128]
    return uuid.uuid4().hex


def payload_metadata(payload: dict[str, Any]) -> tuple[str, str]:
    kind_hint = str(payload.get("kind_hint") or "auto")
    source = payload.get("source")
    mime_type = "-"
    if isinstance(source, dict):
        mime_type = str(source.get("mime_type") or source.get("mimeType") or "-")
    return kind_hint, mime_type


def safe_log_value(value: Any) -> str:
    text = str(value or "-").strip() or "-"
    safe = []
    for char in text[:128]:
        if char.isalnum() or char in {"-", "_", ".", "/", ":", "@"}:
            safe.append(char)
        else:
            safe.append("_")
    return "".join(safe) or "-"


class RequestWatchdog:
    def __init__(self, request_id: str, kind: str, mime: str, started: float) -> None:
        self.request_id = request_id
        self.kind = kind
        self.mime = mime
        self.started = started
        self.timeout_ms = hard_timeout_ms()
        self._timer: threading.Timer | None = None

    def arm(self) -> None:
        if self.timeout_ms <= 0:
            return
        self._timer = threading.Timer(self.timeout_ms / 1000, self._expire)
        self._timer.daemon = True
        self._timer.start()

    def cancel(self) -> None:
        if self._timer is not None:
            self._timer.cancel()

    def _expire(self) -> None:
        print(
            "[paddleocr-backend] hard_timeout "
            f"request_id={safe_log_value(self.request_id)} "
            f"kind={safe_log_value(self.kind)} "
            f"mime={safe_log_value(self.mime)} "
            f"timeout_ms={self.timeout_ms} "
            f"elapsed_ms={elapsed_ms(self.started)} "
            "action=exit_process",
            flush=True,
        )
        os._exit(124)


def parse_request(payload: dict[str, Any]) -> dict[str, Any]:
    kind_hint = str(payload.get("kind_hint") or "auto")
    language_hint = str(payload.get("language_hint") or "auto")

    with tempfile.TemporaryDirectory(prefix="siclaw-ocr-") as tmp:
        input_path = materialize_source(payload, Path(tmp))
        input_path, preflight_warnings = preflight_source(input_path, Path(tmp))
        route = choose_route(input_path, kind_hint)
        if route == "text":
            result = parse_with_ocr(input_path, kind_hint, language_hint, Path(tmp))
            result["route"] = "text"
            if kind_hint == "auto":
                result["kind"] = "mixed_ui"
            prepend_warnings(result, preflight_warnings)
            return result
        try:
            result = parse_with_structure(input_path, kind_hint, language_hint, Path(tmp))
            result["route"] = "structure"
            prepend_warnings(result, preflight_warnings)
            return result
        except MemoryError:
            raise
        except Exception as exc:  # noqa: BLE001 - structure OCR is best-effort.
            print(
                "[paddleocr-backend] structure fallback "
                f"kind={safe_log_value(kind_hint)} "
                f"error={safe_log_value(exc)}",
                flush=True,
            )
            result = parse_with_ocr(input_path, kind_hint, language_hint, Path(tmp))
            if kind_hint == "auto":
                result["kind"] = "mixed_ui"
            result["route"] = "structure_fallback_text"
            result.setdefault("warnings", [])
            prepend_warnings(result, [f"Structured OCR failed; fell back to text OCR: {exc}"])
            prepend_warnings(result, preflight_warnings)
            return result


def choose_route(input_path: str, kind_hint: str) -> str:
    if not structure_enabled():
        return "text"
    if kind_hint in {"table", "ticket", "document", "pdf", "monitoring_chart"}:
        return "structure"
    if kind_hint in {"terminal", "log", "screenshot", "mixed_ui"}:
        return "text"
    suffix = Path(input_path).suffix.lower()
    if suffix == ".pdf":
        return "structure"
    return "text"


def materialize_source(payload: dict[str, Any], tmp: Path) -> str:
    source = payload.get("source")
    if not isinstance(source, dict):
        raise ValueError("source must be an object")

    source_type = source.get("type")
    if source_type != "file_base64":
        raise ValueError(f"unsupported source.type: {source_type!r}")

    data = source.get("data")
    filename = str(source.get("filename") or "upload.bin")
    if not isinstance(data, str) or not data:
        raise ValueError("source.data is required")
    safe_name = Path(filename).name or "upload.bin"
    tmp_root = tmp.resolve()
    path = (tmp / safe_name).resolve()
    if path == tmp_root or not path.is_relative_to(tmp_root):
        raise ValueError("unsafe filename")
    try:
        decoded = base64.b64decode(data, validate=True)
    except binascii.Error as exc:
        raise ValueError("invalid base64 data") from exc
    path.write_bytes(decoded)
    return str(path)


def preflight_source(input_path: str, tmp: Path) -> tuple[str, list[str]]:
    input_path, warnings_ = enforce_pdf_page_limit(input_path, tmp)
    warnings_.extend(enforce_image_pixel_limit(input_path))
    return input_path, warnings_


def enforce_pdf_page_limit(input_path: str, tmp: Path) -> tuple[str, list[str]]:
    if Path(input_path).suffix.lower() != ".pdf":
        return input_path, []
    limit = max_pdf_pages()
    if limit <= 0:
        return input_path, []

    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(input_path)
    total_pages = len(reader.pages)
    if total_pages <= limit:
        return input_path, []

    limited_path = tmp / "limited-input.pdf"
    writer = PdfWriter()
    for index in range(limit):
        writer.add_page(reader.pages[index])
    with limited_path.open("wb") as f:
        writer.write(f)

    warning = (
        f"PDF has {total_pages} pages; OCR parsed the first {limit} pages only. "
        "Upload a smaller excerpt if later pages matter."
    )
    return str(limited_path), [warning]


def enforce_image_pixel_limit(input_path: str) -> list[str]:
    if Path(input_path).suffix.lower() == ".pdf":
        return []
    limit = max_image_pixels()
    if limit <= 0:
        return []

    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError:
        print("[paddleocr-backend] image pixel preflight skipped because Pillow is unavailable", flush=True)
        return []

    bomb_exceptions = tuple(
        item
        for item in (
            getattr(Image, "DecompressionBombWarning", None),
            getattr(Image, "DecompressionBombError", None),
        )
        if isinstance(item, type)
    )
    try:
        Image.MAX_IMAGE_PIXELS = limit
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(input_path) as image:
                width, height = image.size
    except UnidentifiedImageError:
        return []
    except bomb_exceptions as exc:
        raise ValueError(f"image is too large; maximum decoded pixels is {limit}") from exc

    pixels = width * height
    if pixels > limit:
        raise ValueError(f"image is too large; maximum decoded pixels is {limit}")
    return []


def prepend_warnings(result: dict[str, Any], warnings: list[str]) -> None:
    if not warnings:
        return
    existing = result.get("warnings")
    if not isinstance(existing, list):
        existing = []
    result["warnings"] = warnings + existing


def parse_with_ocr(input_path: str, kind_hint: str, language_hint: str, tmp: Path) -> dict[str, Any]:
    ocr = get_ocr_pipeline()
    with OCR_LOCK:
        output = ocr.predict(input_path)

    json_records = save_and_load_json(output, tmp)
    texts: list[str] = []
    blocks: list[dict[str, Any]] = []
    scores: list[float] = []

    for record in json_records:
        res = record.get("res", record)
        rec_texts = as_list(res.get("rec_texts"))
        rec_scores = [to_float(v) for v in as_list(res.get("rec_scores"))]
        rec_boxes = as_list(res.get("rec_boxes"))

        for idx, text in enumerate(rec_texts):
            if not isinstance(text, str) or not text.strip():
                continue
            score = rec_scores[idx] if idx < len(rec_scores) else None
            box = rec_boxes[idx] if idx < len(rec_boxes) else None
            texts.append(text)
            block: dict[str, Any] = {"type": "ocr_text", "text": text}
            if score is not None:
                block["confidence"] = score
                scores.append(score)
            if isinstance(box, list):
                block["bbox"] = flatten_numbers(box)
            blocks.append(block)

    return {
        "kind": kind_hint if kind_hint != "auto" else "terminal",
        "language": normalize_language(language_hint, "\n".join(texts)),
        "text": "\n".join(texts),
        "blocks": blocks,
        "tables": [],
        "confidence": average(scores),
        "warnings": warnings_for_text(texts, scores),
    }


def parse_with_structure(input_path: str, kind_hint: str, language_hint: str, tmp: Path) -> dict[str, Any]:
    pipeline = get_structure_pipeline()
    with STRUCTURE_LOCK:
        output = pipeline.predict(input=input_path)

    markdown_pages: list[dict[str, Any]] = []
    for res in output:
        md_info = getattr(res, "markdown", None)
        if isinstance(md_info, dict):
            markdown_pages.append(md_info)

    markdown_text = ""
    if markdown_pages:
        try:
            markdown_text = pipeline.concatenate_markdown_pages(markdown_pages)
        except MemoryError:
            raise
        except Exception as exc:
            print(
                "[paddleocr-backend] markdown concat failed "
                f"error={safe_log_value(exc)}",
                flush=True,
            )
            markdown_text = "\n\n".join(str(page.get("markdown_text", "")) for page in markdown_pages)

    json_records = save_and_load_json(output, tmp)
    text = markdown_text or extract_text_from_records(json_records)
    tables = markdown_tables(text)

    return {
        "kind": kind_hint if kind_hint != "auto" else ("table" if tables else "mixed_ui"),
        "language": normalize_language(language_hint, text),
        "text": text,
        "blocks": [{"type": "ocr_text", "text": text}] if text else [],
        "tables": tables,
        "confidence": confidence_from_records(json_records),
        "warnings": warnings_for_text(text.splitlines(), []),
    }


def save_and_load_json(output: Any, tmp: Path) -> list[dict[str, Any]]:
    out_dir = tmp / "json"
    out_dir.mkdir(parents=True, exist_ok=True)
    for res in output:
        res.save_to_json(save_path=str(out_dir), ensure_ascii=False)

    records: list[dict[str, Any]] = []
    for path in sorted(out_dir.glob("*.json")):
        with path.open("r", encoding="utf-8") as f:
            records.append(json.load(f))
    return records


def extract_text_from_records(records: list[dict[str, Any]]) -> str:
    texts: list[str] = []
    for record in records:
        res = record.get("res", record)
        for text in as_list(res.get("rec_texts")):
            if isinstance(text, str) and text.strip():
                texts.append(text)
    return "\n".join(texts)


def markdown_tables(text: str) -> list[dict[str, Any]]:
    tables: list[dict[str, Any]] = []
    current: list[str] = []
    for line in text.splitlines() + [""]:
        if "|" in line and line.count("|") >= 2:
            current.append(line.strip())
            continue
        if current:
            table = parse_markdown_table(current)
            if table:
                tables.append(table)
            current = []
    return tables


def parse_markdown_table(lines: list[str]) -> dict[str, Any] | None:
    normalized = [line.strip().strip("|") for line in lines if line.strip()]
    rows = [[cell.strip() for cell in line.split("|")] for line in normalized]
    rows = [row for row in rows if not all(set(cell) <= {"-", ":"} for cell in row)]
    if len(rows) < 2:
        return None
    headers = rows[0]
    body = rows[1:]
    return {"headers": headers, "rows": body, "markdown": "\n".join(lines)}


def confidence_from_records(records: list[dict[str, Any]]) -> float | None:
    scores: list[float] = []
    for record in records:
        res = record.get("res", record)
        scores.extend(v for v in (to_float(x) for x in as_list(res.get("rec_scores"))) if v is not None)
    return average(scores)


def warnings_for_text(texts: list[str], scores: list[float]) -> list[str]:
    warnings: list[str] = []
    if not any(t.strip() for t in texts):
        warnings.append("No readable OCR text was extracted.")
    if scores and average(scores) is not None and average(scores) < 0.8:
        warnings.append("Average OCR confidence is below 0.8.")
    return warnings


def normalize_language(language_hint: str, text: str) -> str:
    if language_hint in {"zh", "en"}:
        return language_hint
    if any("\u3400" <= ch <= "\u9fff" for ch in text):
        return "zh"
    if any(("a" <= ch.lower() <= "z") for ch in text):
        return "en"
    return "unknown"


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    try:
        return value.tolist()
    except AttributeError:
        return []


def to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def average(values: list[float]) -> float | None:
    clean = [v for v in values if v is not None]
    if not clean:
        return None
    return round(sum(clean) / len(clean), 4)


def flatten_numbers(value: Any) -> list[float]:
    if isinstance(value, list):
        out: list[float] = []
        for item in value:
            out.extend(flatten_numbers(item))
        return out
    number = to_float(value)
    return [] if number is None else [number]


def elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


if __name__ == "__main__":
    main()
