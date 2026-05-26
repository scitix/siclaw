# Siclaw OCR backend

Independent PaddleOCR HTTP service used by Portal attachment preprocessing.
This is the product OCR path for pasted images and PDFs; it does not require an
MCP server or MCP environment variables.

P0 scope:

- English terminal screenshots.
- Chinese/bilingual table screenshots.
- Text-heavy image or PDF attachments.

The goal is reliable text evidence extraction for the agent, not full visual
reasoning. Monitoring dashboards should still be handled through dashboard URLs
or metrics tools when exact values matter.

## Contract

`POST /parse` with JSON. Callers can pass `x-request-id` as a header or
`request_id` in the JSON body for log correlation:

```json
{
  "request_id": "optional-caller-request-id",
  "input": "terminal.png",
  "kind_hint": "terminal",
  "language_hint": "auto",
  "source": {
    "type": "file_base64",
    "filename": "terminal.png",
    "mime_type": "image/png",
    "data": "..."
  }
}
```

Response:

```json
{
  "kind": "terminal",
  "language": "en",
  "route": "text",
  "text": "recognized text",
  "confidence": 0.91,
  "blocks": [{ "type": "ocr_text", "text": "..." }],
  "tables": [],
  "warnings": []
}
```

Health checks:

- `GET /healthz`
- `GET /health`

## Routing

Default routing is plain `PaddleOCR` text extraction for every image/PDF. This
keeps latency and dependency risk lower than document-structure parsing.

`PPStructureV3` can be enabled for experiments:

```bash
export SICLAW_OCR_ENABLE_STRUCTURE=1
```

Keep it disabled for the default Portal path until table reconstruction is both
stable and faster on the target cluster.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Useful environment variables:

```bash
export PADDLEOCR_BACKEND_HOST=0.0.0.0
export PADDLEOCR_BACKEND_PORT=8088
export PADDLEOCR_DEVICE=cpu
export PADDLEOCR_PRELOAD=1
export PADDLEOCR_MAX_REQUEST_BYTES=10485760
export SICLAW_OCR_MAX_CONCURRENCY=1
export SICLAW_OCR_HARD_TIMEOUT_MS=150000
export SICLAW_OCR_MAX_PDF_PAGES=10
export SICLAW_OCR_MAX_IMAGE_PIXELS=50000000
```

The service disables Paddle's MKLDNN/oneDNN path by default because PP-OCRv5 CPU
inference can fail with oneDNN attribute-conversion errors on some nodes.
`SICLAW_OCR_MAX_CONCURRENCY` is a per-Pod admitted in-flight request guard.
PaddleOCR prediction remains serialized inside each backend process; when all
slots are busy, the service returns HTTP 503 with `Retry-After: 1` instead of
letting OCR inference saturate the Pod CPU.
`SICLAW_OCR_HARD_TIMEOUT_MS` is a process-level watchdog for pathological OCR
hangs. If one request exceeds this window, the backend logs metadata only and
exits so Kubernetes can restart a clean container. Set it to `0` only for local
debugging. Keep `SICLAW_OCR_MAX_CONCURRENCY=1` while the hard watchdog is
enabled; scale with more OCR replicas instead of multiple in-flight requests in
one process.
`SICLAW_OCR_MAX_PDF_PAGES` caps PDF inputs before PaddleOCR runs. The default
is 10 pages; larger PDFs are truncated to the first 10 pages and the response
includes a warning. Set it to `0` to disable the page cap.
`SICLAW_OCR_MAX_IMAGE_PIXELS` caps decoded image size before OCR runs. The
default is 50 million pixels; set it to `0` to disable the decoded-pixel cap.

Siclaw's Helm chart defaults to PaddleOCR's mobile CPU profile:

```bash
export PADDLEOCR_TEXT_DETECTION_MODEL_NAME=PP-OCRv5_mobile_det
export PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME=PP-OCRv5_mobile_rec
```

The mobile profile is much faster on terminal screenshots and simple PDFs. For
a quality-first server profile, leave both variables unset.

## Build

Build from the repository root:

```bash
docker buildx build \
  --platform linux/amd64 \
  -f Dockerfile.ocr \
  -t registry-cn-shanghai.siflow.cn/k8s/siclaw-ocr:<tag> \
  --push \
  .
```

The Dockerfile defaults `PIP_INDEX_URL` to the Tsinghua PyPI mirror. Override it
with `--build-arg PIP_INDEX_URL=https://pypi.org/simple` if that is better for
your network.

## Deploy

The Helm chart creates an independent OCR Deployment and Service when
`ocr.enabled=true`. Portal receives the service URL through
`SICLAW_OCR_BACKEND_URL` when Portal is enabled.

For an OCR-only addon release, use:

```yaml
runtime:
  enabled: false
portal:
  enabled: false
ocr:
  enabled: true
```

The repository includes `helm/siclaw/values-ocr-only.yaml` for this profile.

The chart uses a `startupProbe` for slow first-time model loading and mounts
emptyDir caches at `/root/.paddlex` and `/root/.paddleocr` by default. These
caches store PaddleOCR model artifacts only; user uploads and extracted OCR text
are request-scoped and are not written there.

For an external or replacement OCR service, set:

```yaml
ocr:
  enabled: false
  externalUrl: "http://your-ocr-service:8088/parse"
```

Portal and Runtime do not need to change when the OCR implementation is swapped.
External systems can reuse the same service contract by calling `/parse`
directly, or by configuring their Siclaw-facing layer to use the same
`externalUrl` style boundary.

Request logs are intentionally metadata-only. Successful and failed `/parse`
requests include `request_id`, `status`, `status_code`, `kind`, `mime`,
`route`, `elapsed_ms`, and request size; raw OCR input and extracted text are
not logged.

## Known limits

- It extracts OCR text; it does not provide general image understanding.
- Exact table structure is best-effort unless `SICLAW_OCR_ENABLE_STRUCTURE=1`.
- PDFs are capped to the first `SICLAW_OCR_MAX_PDF_PAGES` pages by default so
  long papers do not monopolize OCR workers. Upload a smaller excerpt when
  later pages matter.
- Decoded image pixels are capped by `SICLAW_OCR_MAX_IMAGE_PIXELS`, which
  prevents small compressed images from expanding into very large rasters.
- The Helm chart can render an optional NetworkPolicy for the OCR service.
  Enable `ocr.networkPolicy.enabled=true` and add `ocr.networkPolicy.ingressFrom`
  entries for shared OCR deployments. Without a NetworkPolicy, any in-cluster
  Pod that can reach the ClusterIP can call `/parse`.
- Low-resolution, skewed, or cropped screenshots may return incomplete text or
  warnings. The agent should treat OCR evidence as evidence, not ground truth.
