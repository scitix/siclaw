# Attachment OCR

Siclaw supports pasted image/PDF understanding by preprocessing attachments in
Portal and forwarding extracted OCR text as evidence to the agent. This is not
an MCP flow.

## Product goal

P0 focuses on text-heavy operational screenshots:

- English terminal screenshots and command output.
- Chinese or bilingual table screenshots.
- Text-heavy PDFs, including scanned or image-based pages.

Monitoring charts are deliberately not the primary target. Prefer dashboard
URLs or metrics tools when exact chart values matter.

## Architecture

```text
browser chat input
  -> Portal chat API
  -> independent OCR backend Service
  -> Portal appends OCR evidence to the user prompt
  -> Runtime/AgentBox receive text only
```

Portal is the attachment boundary because it already owns chat HTTP auth,
request validation, and the browser-facing contract. Runtime and AgentBox stay
focused on agent execution and do not need raw attachment access.

The OCR backend is independently deployed so it can be scaled, tuned, replaced,
or disabled without rebuilding the main agent path. Swapping PaddleOCR for
RapidOCR, DeepSeek-OCR, or a company-managed document service should be a
deployment/configuration change at the OCR service boundary, not a Runtime
change.

## Supported input types

Portal accepts up to four attachments per chat turn:

- PNG
- JPEG
- WebP
- PDF

Each attachment is currently limited to 6 MiB in the browser and roughly 8 MiB
base64 payload size at Portal. Other text file types such as YAML, XML, JSON,
CSV, and logs are intentionally out of scope for this path; users can paste
those as text more reliably.

## OCR backend contract

Portal calls:

```text
POST ${SICLAW_OCR_BACKEND_URL}
```

with `x-request-id` when Portal originates the request. External callers can
also pass `request_id` in the JSON body.

with:

```json
{
  "request_id": "optional-caller-request-id",
  "input": "terminal.png",
  "kind_hint": "terminal",
  "language_hint": "auto",
  "expected_output": "siclaw_screenshot_evidence_v1",
  "source": {
    "type": "file_base64",
    "filename": "terminal.png",
    "mime_type": "image/png",
    "data": "..."
  }
}
```

The backend returns OCR evidence:

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

Portal appends this to the prompt with system framing so the agent treats the
OCR as evidence and mentions uncertainty when the backend reports warnings.

OCR backend logs are metadata-only for auditability and debugging:

```text
request_id status status_code kind mime route elapsed_ms size
```

They intentionally do not include raw image/PDF bytes or extracted OCR text.
Image/PDF bytes are request-scoped; the standalone path does not persist raw
attachments for chat-history replay. Model caches, when enabled, store only
PaddleOCR/PaddleX model artifacts.

The OCR service is safe to reuse from another API gateway as long as that system
uses the same `/parse` contract. For example, Sicore can call a shared OCR
service from its siclaw proxy layer, or point to an externally managed service
with the same request/response shape, then forward only text evidence to
Siclaw. Sicore-specific proxy code should live in Sicore, not in this Siclaw
standalone OCR change.

## Deployment

The Helm chart supports three deployment profiles:

- Full standalone Siclaw: Runtime + Portal + OCR. This is the default profile.
- Standalone Siclaw without OCR: Runtime + Portal only, using
  `helm/siclaw/values-no-ocr.yaml`.
- OCR-only addon: OCR Deployment + Service only, using
  `helm/siclaw/values-ocr-only.yaml`. This is intended for external callers
  such as Sicore's Siclaw proxy.

The chart creates the OCR Deployment and Service whenever:

```yaml
ocr:
  enabled: true
  maxConcurrency: 1
  hardTimeoutMs: 150000
  maxPdfPages: 10
  maxImagePixels: 50000000
```

Portal receives:

```text
SICLAW_OCR_BACKEND_URL=http://<release>-ocr-backend:8088/parse
SICLAW_OCR_TIMEOUT_MS=120000
SICLAW_OCR_MAX_EVIDENCE_TEXT_CHARS=32768
SICLAW_OCR_MAX_TOTAL_EVIDENCE_TEXT_CHARS=65536
```

When `ocr.enabled=false` and `ocr.externalUrl` is empty, Portal treats OCR as
unavailable. Attachment sends remain recoverable and include an OCR-unavailable
evidence note instead of calling a missing backend.

To use an external or replacement service:

```yaml
ocr:
  enabled: false
  externalUrl: "http://ocr.example.svc:8088/parse"
```

`ocr.maxConcurrency` maps to `SICLAW_OCR_MAX_CONCURRENCY` and limits admitted
in-flight OCR requests per Pod. PaddleOCR inference is still serialized inside
each backend process; this setting is a backpressure guard, not a guarantee of
parallel OCR decoding. If the backend is already at capacity, it returns HTTP
503 with `Retry-After: 1`; Portal keeps the chat recoverable by sending the user
message with an OCR failure note.

Keep `ocr.maxConcurrency=1` while `ocr.hardTimeoutMs` is enabled. The watchdog
restarts the backend process on pathological OCR hangs, so production throughput
should scale with more OCR replicas rather than multiple in-flight requests in
one OCR process.

`ocr.maxEvidenceTextChars` maps to `SICLAW_OCR_MAX_EVIDENCE_TEXT_CHARS` and
caps the OCR text injected into the agent prompt per attachment. When OCR output
exceeds the cap, Portal truncates the injected evidence and adds a warning with
the original character count.

`ocr.maxTotalEvidenceTextChars` maps to
`SICLAW_OCR_MAX_TOTAL_EVIDENCE_TEXT_CHARS` and caps aggregate OCR evidence for
one chat turn. `ocr.maxImagePixels` maps to `SICLAW_OCR_MAX_IMAGE_PIXELS` and
rejects decompression-bomb style image inputs before OCR decoding.

For shared OCR deployments, enable `ocr.networkPolicy.enabled=true` and allow
only the intended caller Pods with `ocr.networkPolicy.ingressFrom`. The OCR
Service is ClusterIP, but without a NetworkPolicy any Pod in the cluster may be
able to call `/parse`.

`ocr.hardTimeoutMs` maps to `SICLAW_OCR_HARD_TIMEOUT_MS`. It is a process-level
watchdog for pathological PaddleOCR hangs: after the window expires, the backend
logs metadata only and exits so Kubernetes can restart a clean container. The
chart also uses `startupProbe` for slow first-time model loading and emptyDir
model caches for container restarts within the same Pod.

`ocr.maxPdfPages` maps to `SICLAW_OCR_MAX_PDF_PAGES`. The OCR backend enforces
this before PaddleOCR runs so an 80-page PDF does not monopolize workers and
delay normal screenshot/table requests. The default is 10 pages. Larger PDFs
are parsed from the first 10 pages only and the OCR response includes a warning;
set it to `0` only when a deployment intentionally accepts full-document OCR
cost.

## Default engine choice

Default backend: PaddleOCR text extraction.

Rationale:

- Works on CPU nodes.
- Good practical coverage for Chinese and English OCR.
- Keeps PDF and screenshot parsing in one service.
- Avoids GPU/model-service dependency before DeepSeek-OCR or a VLM backend is
  available.

`PPStructureV3` is disabled by default and exposed as an experiment through:

```text
SICLAW_OCR_ENABLE_STRUCTURE=1
```

The default route prefers stability and latency over perfect table
reconstruction. Table-like OCR text is usually enough for the language model to
answer operational questions.

The default CPU deployment also disables Paddle's MKLDNN/oneDNN path. On the
current test cluster, enabling that path makes PP-OCRv5 fail fast with a Paddle
attribute-conversion error instead of improving latency.

PaddleOCR's `server` and `mobile` model families are exposed through deployment
environment variables. Siclaw defaults to the mobile profile for the current P0
workflow because pasted evidence is mostly English terminal screenshots, where
mobile was both faster and closer to the original command spacing in the test
fixtures. The mobile profile reduced terminal/table/PDF OCR calls from roughly
14-20 seconds to roughly 4-7 seconds, with similar output on terminal and simple
English PDFs but slightly lower confidence on the Chinese table sample.

```yaml
ocr:
  textDetectionModelName: "PP-OCRv5_mobile_det"
  textRecognitionModelName: "PP-OCRv5_mobile_rec"
```

For a quality-first deployment with more dense Chinese tables or scanned PDFs,
clear both model names to let PaddleOCR choose its server model:

```yaml
ocr:
  textDetectionModelName: ""
  textRecognitionModelName: ""
```

## Failure behavior

Attachment upload should not be rejected merely because OCR may fail. If the OCR
backend errors, times out, or returns no text, Portal still sends the user's
message and includes an OCR failure note. This keeps chat interaction
recoverable and avoids hiding the user's original context.
