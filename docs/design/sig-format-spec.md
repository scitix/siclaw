# .sig Package Format Specification

**Version:** 1.0
**Date:** 2026-03-18
**Status:** Active

> **Note:** The Zod schemas in `tools/siclaw-sig/src/schema/` are the **source of truth** for field types, validation rules, and forward compatibility behavior. This document is a human-readable reference. If this document and the Zod schemas diverge, the Zod schemas win.

---

## Package Structure

A `.sig` package is a directory containing two files:

```
<component>-<version>.sig/
├── manifest.yaml      # Metadata about the extraction
└── templates.jsonl    # One JSON record per line, each describing a log template
```

---

## manifest.yaml Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema_version` | string | Yes | Format version, currently `"1.0"` |
| `component` | string | Yes | Component name (e.g., `"volcano-scheduler"`) |
| `source_version` | string | Yes | Git tag or version of the source code (e.g., `"v1.8.0"`) |
| `language` | string | Yes | Source language: `go`, `python`, `java`, `rust` |
| `extraction_timestamp` | string | Yes | ISO 8601 UTC timestamp (e.g., `"2026-03-18T10:30:00Z"`) |
| `rules` | string[] | Yes | Rule files used during extraction (e.g., `["go/klog-printf", "go/klog-structured"]`) |
| `stats.total_templates` | number | Yes | Total number of extracted templates |
| `stats.by_level.error` | number | Yes | Count of error-level templates |
| `stats.by_level.warning` | number | Yes | Count of warning-level templates |
| `stats.by_level.info` | number | Yes | Count of info-level templates |
| `stats.by_style.printf` | number | Yes | Count of printf-style templates |
| `stats.by_style.structured` | number | Yes | Count of structured-style templates |
| `stats.extraction_duration_ms` | number | Yes | Extraction wall-clock time in milliseconds |

### manifest.yaml Example

```yaml
schema_version: "1.0"
component: volcano-scheduler
source_version: v1.8.0
language: go
extraction_timestamp: "2026-03-18T10:30:00Z"
rules:
  - go/klog-printf
  - go/klog-structured
  - go/zap-sugar
stats:
  total_templates: 247
  by_level:
    error: 42
    warning: 35
    info: 170
  by_style:
    printf: 189
    structured: 58
  extraction_duration_ms: 3420
```

---

## templates.jsonl Record Schema

Each line in `templates.jsonl` is a self-contained JSON object with the following fields. All fields are present in every record (no optional fields); some fields are **nullable** (value can be `null`).

| Field | Type | Required | Nullable | Description |
|-------|------|----------|----------|-------------|
| `id` | string | Yes | No | Content hash identifier (see [ID Generation](#id-generation)) |
| `component` | string | Yes | No | Component name (matches manifest `component`) |
| `version` | string | Yes | No | Source version (matches manifest `source_version`) |
| `file` | string | Yes | No | Source file path relative to repo root |
| `line` | number | Yes | No | Line number of the log call in source |
| `function` | string | Yes | No | Function name containing the log call |
| `level` | string | Yes | No | Log level: `error`, `warning`, `info`, `debug`, `trace`, or `fatal` |
| `template` | string | Yes | No | The format string or message string from the log call |
| `style` | string | Yes | No | `printf` or `structured` (see [Style and Confidence](#style-and-confidence)) |
| `confidence` | string | Yes | No | `exact`, `high`, or `medium` (see [Style and Confidence](#style-and-confidence)) |
| `regex` | string | Yes | Yes | Regex pattern for matching log output. `null` for structured style |
| `keywords` | string[] | Yes | No | Static keywords extracted from the template, stopwords filtered |
| `context.package` | string | Yes | No | Go/Python/Java/Rust package name |
| `context.function` | string | Yes | No | Full function signature |
| `context.source_lines` | string[] | Yes | No | 2-5 source lines around the log call |
| `context.line_range` | [number, number] | Yes | No | Start and end line of the context window |
| `error_conditions` | string[] | Yes | Yes | Trigger conditions (v2, tree-sitter analysis). `null` in v1 |
| `related_logs` | string[] | Yes | Yes | Related log call IDs (v2, tree-sitter analysis). `null` in v1 |

---

## Style and Confidence

### Style

The `style` field describes the log call pattern, not the programming language.

- **`printf`**: The log call uses a format string with placeholders (`%s`, `%d`, `%v`, `{}`, etc.). A regex pattern can be generated from the format string. Examples: `klog.Infof()`, `zap.Sugar.Errorf()`, `logging.error()`, `logger.error("msg {}", arg)`.

- **`structured`**: The log call uses a fixed message string plus key-value pairs. There is no format string, so no regex can be generated. Examples: `klog.InfoS()`, `logr.Info()`.

### Confidence

The `confidence` field indicates the reliability of the `regex` pattern, set at extraction time.

- **`exact`**: All placeholders map to unambiguous regex patterns (e.g., `%s` -> `\S+`, `%d` -> `-?\d+`). The regex is reliable for precise matching.

- **`high`**: A regex exists but contains `.*` substitutions from ambiguous placeholders (e.g., `%v` in Go, which can print anything). The regex may over-match.

- **`medium`**: No reliable regex can be generated. Use `keywords` only for matching. Applies to structured-style log calls or templates containing only `%v` placeholders.

### Combinations

| Style | Confidence | regex | Matching Strategy |
|-------|------------|-------|-------------------|
| printf | exact | non-null, precise | Regex match (L1) |
| printf | high | non-null, contains `.*` | Regex match (L1) with possible false positives |
| printf | medium | null | Keyword intersection only (L2) |
| structured | medium | null | Keyword intersection only (L2) |

---

## ID Generation

The `id` field is a content-addressed hash computed as:

```
SHA-256( file + "\0" + line + "\0" + template )
```

Truncated to the first **12 hexadecimal characters** (48 bits).

Properties:

- **Deterministic**: The same `(file, line, template)` triple always produces the same ID, regardless of extraction timestamp or machine.
- **Collision-resistant**: 48 bits gives a collision probability of approximately 1 in 281 trillion for any single pair. For a corpus of 100,000 templates, the birthday-problem collision probability is approximately 1.8 x 10^-5 (negligible).
- **Null-byte separator**: The `\0` separator prevents concatenation ambiguity (e.g., `file="a", line=12` vs `file="a1", line=2` produce different inputs).
- **Cross-version diffing**: Because the ID is content-based, comparing `.sig` packages across source versions reveals which templates were added, removed, or moved.

---

## Forward Compatibility

The `.sig` format is designed for forward compatibility:

1. **Unknown fields are ignored**: The Zod schemas use `.strip()`, which silently removes unrecognized fields during parsing. A v1.0 parser can read v1.1 records without error.

2. **New optional fields use defaults**: New fields added in future versions use `.optional().default()` in the Zod schema, so older data (missing the field) parses without error and receives a sensible default.

3. **`schema_version` is informational**: The `schema_version` field in `manifest.yaml` is primarily for logging, debugging, and human reference. It is not used for hard version gating during parsing.

4. **Breaking changes are rare**: Only truly breaking changes (field renames, semantic redefinitions) would require rejecting older data. The intent is to never need this in practice.

---

## Example Records

The following 4 examples show complete JSONL records as they would appear in `templates.jsonl` (one per line). Each record contains all 17 fields with realistic values.

### Example 1: Go klog printf (exact confidence)

Source: `klog.Errorf("failed to connect to %s:%d", host, port)`

```json
{"id":"0f560029495d","component":"volcano-scheduler","version":"v1.8.0","file":"pkg/scheduler/scheduler.go","line":142,"function":"connectToAPIServer","level":"error","template":"failed to connect to %s:%d","style":"printf","confidence":"exact","regex":"^failed to connect to \\\\S+:-?\\\\d+$","keywords":["failed","connect"],"context":{"package":"scheduler","function":"func (s *Scheduler) connectToAPIServer(host string, port int) error","source_lines":["func (s *Scheduler) connectToAPIServer(host string, port int) error {","    conn, err := net.DialTimeout(\"tcp\", fmt.Sprintf(\"%s:%d\", host, port), 5*time.Second)","    if err != nil {","        klog.Errorf(\"failed to connect to %s:%d\", host, port)","        return fmt.Errorf(\"api server connection failed: %w\", err)"],"line_range":[139,143]},"error_conditions":null,"related_logs":null}
```

### Example 2: Go klog structured (medium confidence)

Source: `klog.InfoS("Pod status changed", "pod", podName, "status", status)`

```json
{"id":"6c857560acc4","component":"volcano-scheduler","version":"v1.8.0","file":"pkg/controller/pod_controller.go","line":287,"function":"syncPod","level":"info","template":"Pod status changed","style":"structured","confidence":"medium","regex":null,"keywords":["Pod","status","changed"],"context":{"package":"controller","function":"func (c *PodController) syncPod(key string) error","source_lines":["    newStatus := pod.Status.Phase","    if oldStatus != newStatus {","        klog.InfoS(\"Pod status changed\", \"pod\", podName, \"status\", status)","        c.recorder.Eventf(pod, corev1.EventTypeNormal, \"StatusChanged\", \"Pod %s status: %s\", podName, newStatus)"],"line_range":[284,289]},"error_conditions":null,"related_logs":null}
```

### Example 3: Go klog printf with %v (high confidence)

Source: `klog.Errorf("unexpected error: %v", err)`

```json
{"id":"8a6c9b8fbe11","component":"volcano-scheduler","version":"v1.8.0","file":"pkg/scheduler/scheduler.go","line":198,"function":"processNextWorkItem","level":"error","template":"unexpected error: %v","style":"printf","confidence":"high","regex":"^unexpected error: .*$","keywords":["unexpected","error"],"context":{"package":"scheduler","function":"func (s *Scheduler) processNextWorkItem() bool","source_lines":["    err := s.syncHandler(key)","    if err != nil {","        klog.Errorf(\"unexpected error: %v\", err)","        s.queue.AddRateLimited(key)","        return true"],"line_range":[195,199]},"error_conditions":null,"related_logs":null}
```

### Example 4: Go zap Sugar printf (exact confidence)

Source: `sugar.Infof("processing request %s for user %s", reqId, userId)`

```json
{"id":"79488622e91c","component":"volcano-scheduler","version":"v1.8.0","file":"pkg/gateway/handler.go","line":63,"function":"handleRequest","level":"info","template":"processing request %s for user %s","style":"printf","confidence":"exact","regex":"^processing request \\\\S+ for user \\\\S+$","keywords":["processing","request","user"],"context":{"package":"gateway","function":"func (h *Handler) handleRequest(w http.ResponseWriter, r *http.Request)","source_lines":["func (h *Handler) handleRequest(w http.ResponseWriter, r *http.Request) {","    reqId := r.Header.Get(\"X-Request-ID\")","    userId := r.Context().Value(userKey).(string)","    sugar.Infof(\"processing request %s for user %s\", reqId, userId)"],"line_range":[60,63]},"error_conditions":null,"related_logs":null}
```
