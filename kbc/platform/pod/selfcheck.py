"""Layer-1 compile self-check: deterministic coverage ledger + structural lint.

Design: improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §8.1.
The completion criterion moves from "the model says it's done" to "code can
verify it": every raw text source must be either cited by a candidate page's
`compiled_from` frontmatter, or explicitly excluded (with a reason) in
`authoring/EXCLUSIONS.json`. Anything else is *unaccounted* — the exact
silent-miss failure mode observed in the 2026-07-03 one-shot compile study.

Engine-neutral by construction: pure filesystem analysis plus safe YAML
parsing, with no Agent-SDK imports. Any compile driver (Claude SDK today, other
engines later) calls `run_layer1()` at its own turn boundary and pushes the
returned repair prompt through its own message seam.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import posixpath
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote

import yaml

# Text sources vs binary media. BOTH are ledger-accountable (2026-07-06): the
# batch-vs-oneshot A/B showed silent media drops are the single worst coverage
# failure (29/33 images dropped by the one-shot compile), and a text-only
# ledger pushed agents to mark image-digest pages `derived: true` — zero
# machine-checkable provenance exactly where fidelity risk is highest.
# compiled_from is the agent's declaration either way; the ledger only checks
# that the declaration is total.
TEXT_SOURCE_EXTS = {".md", ".txt", ".tsv", ".csv", ".json", ".jsonl", ".yaml", ".yml"}
IMAGE_SOURCE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
MEDIA_SOURCE_EXTS = IMAGE_SOURCE_EXTS | {".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx"}
KNOWN_SOURCE_EXTS = TEXT_SOURCE_EXTS | MEDIA_SOURCE_EXTS

# Media ASSETS (coverage v2, DESIGN-kb-asset-provenance-2026-07-22 §4.1): images
# that live under an `assets/` directory (or the legacy `*.assets/` export form).
# They are DOCUMENT ATTACHMENTS, not first-class sources — a media asset embedded
# in the body of an accounted document is auto-accounted against that document
# (see is_media_asset / asset_attribution_edges / coverage), so cf no longer needs
# a token per image and the exclusion ledger no longer needs a row per image.
# Superset of IMAGE_SOURCE_EXTS by .tiff; kept EXACT and byte-for-byte in sync
# with the sicore ledger mirror via the shared fixture.
MEDIA_ASSET_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tiff"}

EXCLUSIONS_PATH = "authoring/EXCLUSIONS.json"
SELFCHECK_PATH = "authoring/SELFCHECK.json"

# TEST_ROLE = the standing identity of a read-only knowledge CONSUMER over a
# pinned wiki snapshot. Single-sourced in the locale prompt packs
# (prompts/<locale>/test_role.md) — the SAME text the user-facing test session
# (compile_box.test_session_driver) uses, so the red-blue blue team measures the
# wiki exactly as a real consumer reads it and the two copies can't drift.
# Defaults to zh: the PK/calibration pipeline is not yet locale-threaded and its
# calibration corpora are Chinese. Mirrors the real siclaw consumer (siclaw
# src/core/prompt.ts "Domain Knowledge — LLM Wiki"): Read only, no search, start
# at index.md, read whole pages, follow standard Markdown links while tolerating
# legacy [[links]]. Max fidelity: do NOT tell it it's being tested.
def _pack_test_role(locale: str = "zh") -> str:
    fp = Path(__file__).resolve().parent / "prompts" / locale / "test_role.md"
    return fp.read_text(encoding="utf-8").rstrip("\n")


TEST_ROLE = _pack_test_role()

# Cap the unaccounted list embedded in a repair prompt — a pathological corpus
# must not blow up the injected message.
_REPAIR_LIST_CAP = 40


def source_inventory(workdir: str) -> list[str]:
    """All source files under {workdir}/raw — text AND media — as sorted posix
    paths relative to raw/. Hidden files/dirs (dot-prefixed) are skipped.
    Every file must end up cited by some page's compiled_from or explicitly
    excluded; unknown binary blobs are the agent's to exclude with a reason."""
    raw = Path(workdir) / "raw"
    if not raw.is_dir():
        return []
    out = []
    for f in raw.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(raw)
        if any(part.startswith(".") for part in rel.parts):
            continue
        out.append(rel.as_posix())
    return sorted(out)


def is_media_asset(rel: str) -> bool:
    """A raw source is a media ASSET — a document attachment, auto-accountable in
    coverage v2 — when some path SEGMENT is `assets` (or the legacy `*.assets`
    export form) AND its extension is a known image type (case-insensitive).

    Deliberately NARROW: sheet placeholders at `assets/sheets/*.md` and every
    other `.md`/`.json` are content files (their extension is not an image type),
    so they stay first-class sources that must be cited or excluded. Auto-attaching
    a sheet placeholder would launder 'the table data was never compiled' into
    'covered' — the exact fail-open §4.1 forbids."""
    ext = posixpath.splitext(rel)[1].lower()
    if ext not in MEDIA_ASSET_EXTS:
        return False
    # Segment match is case-INSENSITIVE, matching the sicore ledger mirror (an
    # `Assets/` dir counts too); the platform always writes lowercase `assets/`,
    # so this only matters for hand-authored trees, but the two repos must agree.
    return any(seg.lower() == "assets" or seg.lower().endswith(".assets")
               for seg in rel.split("/"))


def _strip_source_prefix(entry: str) -> str:
    """Drop a leading raw/ or drop/ so a path compares against the raw-relative
    inventory. Applied to BOTH compiled_from entries and exclusion patterns, so
    the two namespaces line up (a `raw/live.csv` exclusion matches inventory
    `live.csv`, matching how the adjacent compiled_from field accepts the prefix)."""
    for prefix in ("raw/", "drop/"):
        if entry.startswith(prefix):
            return entry[len(prefix):]
    return entry


def _norm_source_entry(raw: str) -> str:
    """One compiled_from list entry → a raw-relative source path. Tolerates
    `"<hash8> · <path>"`, surrounding quotes, and a raw/ or drop/ prefix.
    Canonicalized with posixpath.normpath, the same way intra-wiki link targets
    are resolved: an un-normalized citation (`./live.csv`, `sub/../x.md`) used
    to double-report as unaccounted AND dangling — cosmetic while dangling was
    display-only, a permanent convergence wedge once it gates `closed` (review
    finding: the model would get contradictory repair orders forever)."""
    entry = raw.strip().strip("\"'").strip()
    if "·" in entry:
        entry = entry.rsplit("·", 1)[1].strip()
    entry = _strip_source_prefix(entry.strip("\"'").strip())
    if not entry:
        return entry
    entry = posixpath.normpath(entry)
    return "" if entry == "." else entry


def parse_compiled_from(md_text: str) -> tuple[list[str], bool, bool]:
    """Parse a candidate page's frontmatter.

    Returns (source_paths, derived, has_compiled_from). `compiled_from` is read
    in BOTH the block form (`compiled_from:` then `- item` lines) and the inline
    flow form (`compiled_from: [a.md, "b.md"]`) — the inline form previously
    parsed to zero sources and triggered a spurious repair on a cited page.
    Tolerated entry forms:
      - "<hash8> · <path>"   (provenance with fingerprint)
      - "<path>" / '<path>' / <path>
    A leading raw/ or drop/ prefix is stripped so paths compare against the
    raw-relative inventory.
    """
    lines = md_text.splitlines()
    if not lines or lines[0].strip() != "---":
        return [], False, False
    sources: list[str] = []
    derived = False
    has_key = False
    in_list = False
    for line in lines[1:]:
        stripped = line.strip()
        if stripped in ("---", "..."):
            break
        if re.match(r"^[A-Za-z_][A-Za-z0-9_-]*\s*:", line):  # top-level key
            in_list = False
            key = line.split(":", 1)[0].strip()
            rest = line.split(":", 1)[1].strip()
            if key == "compiled_from":
                has_key = True
                if rest.startswith("["):
                    # inline flow list on one line: compiled_from: [raw/a.md, "b.md"]
                    inner = rest[1:-1] if rest.endswith("]") else rest[1:]
                    for item in inner.split(","):
                        entry = _norm_source_entry(item)
                        if entry:
                            sources.append(entry)
                else:
                    # block form (`compiled_from:` alone) opens the list; inline
                    # `compiled_from: []` is handled above (rest == "[]")
                    in_list = rest == ""
            elif key == "derived":
                derived = rest.lower() in ("true", "yes")
            continue
        if in_list:
            m = re.match(r"^\s*-\s*(.+?)\s*$", line)
            if m:
                entry = _norm_source_entry(m.group(1))
                if entry:
                    sources.append(entry)
            elif stripped:
                in_list = False
    return sources, derived, has_key


def candidate_pages(workdir: str) -> dict[str, dict]:
    """Parse every candidate/**/*.md page's provenance. Keyed by path relative
    to candidate/ (posix). Unreadable pages are reported as parse errors, not
    skipped silently."""
    cand = Path(workdir) / "candidate"
    pages: dict[str, dict] = {}
    if not cand.is_dir():
        return pages
    for f in sorted(cand.rglob("*.md")):
        rel = f.relative_to(cand).as_posix()
        try:
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            pages[rel] = {"sources": [], "derived": False, "has_compiled_from": False,
                          "error": f"unreadable: {e}"}
            continue
        sources, derived, has_key = parse_compiled_from(text)
        try:
            raw_bytes = f.stat().st_size
        except OSError:
            raw_bytes = len(text.encode("utf-8"))
        # bytes = ON-DISK size, matching the sync gate's f.stat().st_size — the
        # decoded text under-measures CRLF pages (read_text translates newlines),
        # so an encode()-based lint could pass a page the sync then skips (review).
        pages[rel] = {"sources": sources, "derived": derived,
                      "has_compiled_from": has_key, "text": text, "bytes": raw_bytes}
    return pages


def load_exclusions(workdir: str) -> tuple[list[dict], list[str]]:
    """Read authoring/EXCLUSIONS.json → (entries, errors). Missing file is fine
    (no exclusions declared yet). Malformed content is an error the lint
    surfaces — a broken exclusion list must not silently exclude nothing."""
    path = Path(workdir) / EXCLUSIONS_PATH
    if not path.is_file():
        return [], []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        return [], [f"{EXCLUSIONS_PATH} unreadable/invalid JSON: {e}"]
    if not isinstance(data, list):
        return [], [f"{EXCLUSIONS_PATH} must be a JSON array"]
    entries, errors = [], []
    for i, item in enumerate(data):
        if not isinstance(item, dict) or not item.get("pattern") or not item.get("reason"):
            errors.append(f"{EXCLUSIONS_PATH}[{i}] needs {{pattern, reason}}")
            continue
        entries.append({"pattern": str(item["pattern"]), "reason": str(item["reason"])})
    return entries, errors


def _seg_glob(pat_parts: list[str], tgt_parts: list[str]) -> bool:
    """Segment-aware glob: `*` / `?` match WITHIN one path segment (never cross
    `/`); a whole `**` segment matches zero or more segments. Prevents `notes/*`
    from silently swallowing `notes/sub/secret.md` (the over-exclusion false-PASS)."""
    if not pat_parts:
        return not tgt_parts
    head = pat_parts[0]
    if head == "**":
        return any(_seg_glob(pat_parts[1:], tgt_parts[i:]) for i in range(len(tgt_parts) + 1))
    if not tgt_parts:
        return False
    if fnmatch.fnmatch(tgt_parts[0], head):
        return _seg_glob(pat_parts[1:], tgt_parts[1:])
    return False


def _matches(path: str, pattern: str) -> bool:
    """Does a raw-relative inventory `path` match an exclusion `pattern`? The
    pattern is normalized to the raw-relative namespace (a raw/ or drop/ prefix is
    stripped, matching how compiled_from entries are normalized), and globbing is
    SEGMENT-AWARE — `*` never crosses `/`. Use a trailing `/` (dir-prefix) or `**`
    to exclude a whole subtree; `notes/*` excludes only the files directly under
    notes/."""
    pattern = _strip_source_prefix(pattern)
    if pattern.endswith("/"):  # directory prefix form: the whole subtree
        return path.startswith(pattern)
    return _seg_glob(pattern.split("/"), path.split("/"))


_MD_LINK_RE = re.compile(r"\]\(\s*(<[^>\n]+>|[^)\n]+)\)")
_WIKI_LINK_RE = re.compile(r"\[\[([^\]|#]+)")
# HTML <img src="..."> (single OR double quotes) — 07-21 lesson: a feishu doc
# embedded 120 table images as HTML <img>, invisible to a markdown-only scan.
_HTML_IMG_SRC_RE = re.compile(r"<img\b[^>]*?\bsrc\s*=\s*(\"[^\"]*\"|'[^']*')", re.IGNORECASE)
_BODY_SOURCE_START_RE = re.compile(
    r"(?P<open>[（(])\s*(?:source|src|源|来源)\s*[:：]\s*", re.IGNORECASE,
)
_SOURCE_LOCATOR_PATTERN = (
    r"(?:§\s*[\w.-]+|(?:p(?:ages?)?|pp?)\.?\s*\d+"
    r"(?:(?:\s*[-–]\s*|\s*,\s*)\d+)*|"
    r"lines?\s*\d+(?:\s*[-–]\s*\d+)?|第?\s*\d+\s*(?:页|行|节))"
)
_SOURCE_FILE_END_RE = re.compile(
    r"\.(?:" + "|".join(sorted(e[1:] for e in KNOWN_SOURCE_EXTS))
    + r")(?:`)?(?=(?:\s*(?:[,，;；、]|$)|\s+"
    + _SOURCE_LOCATOR_PATTERN + r"\s*(?:[,，;；、]|$)))",
    re.IGNORECASE,
)
_SOURCE_LOCATOR_RE = re.compile(_SOURCE_LOCATOR_PATTERN, re.IGNORECASE)
_SOURCE_LOCATOR_PREFIX_RE = re.compile(
    r"\s+" + _SOURCE_LOCATOR_PATTERN + r"(?=\s*(?:[,，;；、]|$))",
    re.IGNORECASE,
)
_SOURCE_SEPARATOR_RE = re.compile(r"\s*[,，;；、]\s*")
# OKF reserved routing pages: never provenance-required, never orphans. The
# names are reserved at EVERY level of the bundle hierarchy, not just its root.
_RESERVED_PAGE_NAMES = {"index.md", "log.md"}


def _is_reserved_page(rel: str) -> bool:
    return Path(rel).name in _RESERVED_PAGE_NAMES


def parse_okf_frontmatter(md_text: str) -> tuple[dict | None, str, str | None]:
    """Parse an OKF YAML frontmatter block with a real YAML parser.

    Returns (mapping-or-None, body, error-or-None). A missing block is distinct
    from an invalid block so the repair prompt can tell the compiler exactly
    what to fix. `yaml.safe_load` is deliberate: candidate metadata is tenant
    authored input and must never construct arbitrary Python objects.
    """
    lines = md_text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, md_text, "missing YAML frontmatter at the start of the file"
    end = next((i for i, line in enumerate(lines[1:], start=1)
                if line.strip() in ("---", "...")), None)
    if end is None:
        return None, md_text, "YAML frontmatter has no closing delimiter"
    raw = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1:])
    try:
        value = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        problem = getattr(e, "problem", None) or str(e).splitlines()[0]
        return None, body, f"invalid YAML frontmatter: {problem}"
    if not isinstance(value, dict):
        return None, body, "YAML frontmatter must be a mapping"
    return value, body, None


def _mask_span(text: str) -> str:
    """Blank markdown code while preserving newlines and character offsets."""
    return "".join("\n" if ch == "\n" else " " for ch in text)


def _markdown_prose(md_text: str) -> str:
    """Markdown text with YAML frontmatter, fenced code, and code spans masked.

    Link lint operates on rendered prose, not raw source. A raw ``[[`` scan
    rejects ordinary Bash conditionals and example links inside fenced/inline
    code, both of which OKF explicitly permits. This deliberately implements
    the code constructs the compiler emits without adding another production
    markdown dependency.
    """
    # Mask valid frontmatter instead of dropping it. Keeping the returned text
    # byte-for-byte aligned with ``md_text`` lets deterministic repair code use
    # match offsets safely while preserving the existing rendered-prose lint
    # semantics. Malformed/absent frontmatter remains prose, as before.
    body_start = 0
    lines = md_text.splitlines(keepends=True)
    if lines and lines[0].strip() == "---":
        offset = len(lines[0])
        for line in lines[1:]:
            offset += len(line)
            if line.strip() in ("---", "..."):
                body_start = offset
                break
    body = md_text[body_start:]

    # Fenced blocks: CommonMark allows up to three leading spaces and either a
    # backtick or tilde fence. A closing fence uses the same character and is at
    # least as long as the opener.
    masked_lines: list[str] = []
    fence_char: str | None = None
    fence_len = 0
    for line in body.splitlines(keepends=True):
        raw = line.rstrip("\r\n")
        if fence_char is not None:
            close = re.match(r"^[ ]{0,3}([`~]+)[ \t]*$", raw)
            masked_lines.append(_mask_span(line))
            if close and close.group(1)[0] == fence_char and len(close.group(1)) >= fence_len:
                fence_char = None
                fence_len = 0
            continue
        opened = re.match(r"^[ ]{0,3}(`{3,}|~{3,})(?:[^\r\n]*)$", raw)
        if opened:
            fence_char = opened.group(1)[0]
            fence_len = len(opened.group(1))
            masked_lines.append(_mask_span(line))
        else:
            masked_lines.append(line)

    # Inline code spans can use any backtick-run length and may cross lines.
    # Pair only equal-length runs; an unmatched run remains literal markdown.
    text = "".join(masked_lines)
    chars = list(text)
    pos = 0
    while True:
        start = text.find("`", pos)
        if start < 0:
            break
        end_run = start
        while end_run < len(text) and text[end_run] == "`":
            end_run += 1
        ticks = end_run - start
        close = end_run
        found = -1
        while True:
            close = text.find("`", close)
            if close < 0:
                break
            close_end = close
            while close_end < len(text) and text[close_end] == "`":
                close_end += 1
            if close_end - close == ticks:
                found = close_end
                break
            close = close_end
        if found < 0:
            pos = end_run
            continue
        for i in range(start, found):
            if chars[i] != "\n":
                chars[i] = " "
        pos = found
    return _mask_span(md_text[:body_start]) + "".join(chars)


def _okf_index_violations(rel: str, text: str, concept_pages: set[str]) -> list[dict]:
    """Validate the reserved OKF index shape for a v0.1 bundle.

    OKF permits an optional version declaration only on the bundle-root index;
    when present here it must target v0.1. Siclaw's producer profile separately
    requires the declaration and file-relative links on newly authored output.
    """
    violations: list[dict] = []
    fm, body, error = parse_okf_frontmatter(text)
    if rel == "index.md":
        if error and text.splitlines() and text.splitlines()[0].strip() == "---":
            violations.append({"page": rel, "kind": "okf_index_frontmatter",
                               "detail": f"根 index.md 的 YAML frontmatter 无效: {error}"})
            body = text
        elif not error and (set(fm or {}) != {"okf_version"}
              or not isinstance((fm or {}).get("okf_version"), str)
              or (fm or {}).get("okf_version") != "0.1"):
            violations.append({"page": rel, "kind": "okf_index_frontmatter",
                               "detail": "根 index.md frontmatter 必须且只能包含 okf_version: \"0.1\""})
        elif error:
            # OKF makes index.md optional and its root version declaration MAY;
            # Siclaw's producer profile below requires that declaration.
            body = text
    else:
        # A nested index has no frontmatter. A malformed block is still a block,
        # so detect the delimiter directly instead of treating its parse error as
        # equivalent to correctly absent frontmatter.
        if text.splitlines() and text.splitlines()[0].strip() == "---":
            violations.append({"page": rel, "kind": "okf_index_frontmatter",
                               "detail": "子目录 index.md 按 OKF 不能包含 frontmatter"})
        body = text

    if not re.search(r"(?m)^#{1,6}\s+\S", body):
        violations.append({"page": rel, "kind": "okf_index_structure",
                           "detail": "index.md 至少需要一个 Markdown 分组标题"})
    entries = re.findall(r"(?m)^\s*[-*]\s+\[[^\]]+\]\(([^)]+)\)(?:\s+-\s+.+)?\s*$", body)
    if concept_pages and not entries:
        violations.append({"page": rel, "kind": "okf_index_structure",
                           "detail": "index.md 必须用列表形式的标准 Markdown 链接枚举知识页"})
    return violations


def _okf_log_violations(rel: str, text: str) -> list[dict]:
    violations: list[dict] = []
    if text.splitlines() and text.splitlines()[0].strip() == "---":
        violations.append({"page": rel, "kind": "okf_log_frontmatter",
                           "detail": "log.md 按 OKF 不能包含 frontmatter"})
    prose = _markdown_prose(text)
    date_matches = list(re.finditer(r"(?m)^##\s+(\d{4}-\d{2}-\d{2})\s*$", prose))
    dates = [m.group(1) for m in date_matches]
    valid_dates: list[str] = []
    for date in dates:
        try:
            datetime.strptime(date, "%Y-%m-%d")
            valid_dates.append(date)
        except ValueError:
            pass
    if not re.search(r"(?m)^#\s+\S", prose) or not dates or len(valid_dates) != len(dates):
        violations.append({"page": rel, "kind": "okf_log_structure",
                           "detail": "log.md 需要标题和合法的 ## YYYY-MM-DD 日期分组"})
    elif valid_dates != sorted(valid_dates, reverse=True):
        violations.append({"page": rel, "kind": "okf_log_structure",
                           "detail": "log.md 日期分组必须按从新到旧排列"})
    empty_groups = []
    for i, match in enumerate(date_matches):
        end = date_matches[i + 1].start() if i + 1 < len(date_matches) else len(prose)
        if not re.search(r"(?m)^\s*[-*]\s+\S.*$", prose[match.end():end]):
            empty_groups.append(match.group(1))
    if empty_groups:
        violations.append({"page": rel, "kind": "okf_log_structure",
                           "detail": f"log.md 每个日期分组都必须包含列表形式的更新记录: {', '.join(empty_groups)}"})
    return violations


def okf_v01_violations(pages: dict[str, dict]) -> list[dict]:
    """Mandatory OKF v0.1 conformance checks only."""
    violations: list[dict] = []
    concept_pages = {rel for rel in pages if not _is_reserved_page(rel)}
    for rel, page in pages.items():
        if "error" in page:
            continue  # the existing unreadable violation is more specific
        text = page.get("text", "")
        name = Path(rel).name
        if name == "index.md":
            violations.extend(_okf_index_violations(rel, text, concept_pages))
            continue
        if name == "log.md":
            violations.extend(_okf_log_violations(rel, text))
            continue
        fm, _, error = parse_okf_frontmatter(text)
        if error:
            violations.append({"page": rel, "kind": "okf_frontmatter",
                               "detail": error})
            continue
        type_value = (fm or {}).get("type")
        if not isinstance(type_value, str) or not type_value.strip():
            violations.append({"page": rel, "kind": "okf_type",
                               "detail": "OKF concept frontmatter requires a non-empty string type"})

    return violations


def siclaw_portable_output_violations(pages: dict[str, dict]) -> list[dict]:
    """Siclaw producer preferences beyond OKF's mandatory conformance rules."""
    violations: list[dict] = []
    for rel, page in pages.items():
        if "error" in page:
            continue
        text = page.get("text", "")
        prose = _markdown_prose(text)
        if _WIKI_LINK_RE.search(prose):
            violations.append({"page": rel, "kind": "siclaw_profile_wikilink",
                               "detail": "Siclaw 新产出使用文件相对的标准 Markdown 链接，不要使用 [[wikilink]]"})
        if any(target.startswith("/") for target in _markdown_link_targets(prose)):
            violations.append({"page": rel, "kind": "siclaw_profile_bundle_link",
                               "detail": "OKF 允许 / 开头的 bundle 链接，但 Siclaw 新产出使用文件相对链接以便跨浏览器查看"})
        if (rel == "index.md"
                and (not text.splitlines() or text.splitlines()[0].strip() != "---")):
            violations.append({"page": rel, "kind": "siclaw_profile_version_declaration",
                               "detail": "Siclaw 根 index.md 必须声明 okf_version: \"0.1\""})
    return violations


def format_policy_violations(pages: dict[str, dict]) -> list[dict]:
    """All OKF-core and Siclaw-profile violations for authoring enforcement."""
    return okf_v01_violations(pages) + siclaw_portable_output_violations(pages)


def format_violation_keys(pages: dict[str, dict]) -> list[list[str]]:
    """JSON-safe baseline keys used to grandfather untouched legacy pages."""
    return [list(key) for key in sorted({(v["page"], v["kind"])
                                         for v in format_policy_violations(pages)})]


def filter_incremental_format_violations(
    violations: list[dict], baseline_keys: list[list[str]], changed_pages: set[str],
) -> tuple[list[dict], list[dict]]:
    """Separate blocking violations from inherited legacy format debt.

    Only a violation that already existed at incremental kickoff AND belongs to
    a page unchanged this round is grandfathered. New violations and violations
    on pages that actually changed remain hard failures; merely authorizing a
    page must not turn an unrelated incremental edit into a format migration.
    """
    baseline = {(str(item[0]), str(item[1])) for item in baseline_keys
                if isinstance(item, (list, tuple)) and len(item) == 2}
    blocking: list[dict] = []
    inherited: list[dict] = []
    for violation in violations:
        key = (str(violation.get("page", "")), str(violation.get("kind", "")))
        if key in baseline and key[0] not in changed_pages:
            inherited.append(violation)
        else:
            blocking.append(violation)
    return blocking, inherited


def _strip_frontmatter(text: str) -> str:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() in ("---", "..."):
            return "\n".join(lines[i + 1:])
    return text


def _markdown_link_targets(text: str) -> list[str]:
    """Markdown ``.md`` destinations normalized for filesystem comparison.

    CommonMark angle destinations, URL-encoded spaces, and the tolerant raw
    form emitted by existing agents all refer to the same candidate path.
    """
    targets: list[str] = []
    for captured in _MD_LINK_RE.findall(text):
        destination = captured.strip()
        if destination.startswith("<") and destination.endswith(">"):
            destination = destination[1:-1].strip()
        else:
            # Keep compatibility with the optional Markdown link-title form.
            titled = re.fullmatch(
                r"(.+?\.md(?:#[^\s\"']*)?)\s+(?:\"[^\"]*\"|'[^']*')",
                destination,
                re.IGNORECASE,
            )
            if titled:
                destination = titled.group(1)
        destination = unquote(destination).split("#", 1)[0].strip()
        if destination.lower().endswith(".md"):
            targets.append(destination)
    return targets


def _strip_fragment_query(target: str) -> str:
    """Drop a URL ``#fragment`` / ``?query`` from the STILL-ENCODED target, before
    percent-decoding — so an encoded ``%23``/``%3F`` that is part of a real
    filename survives while an actual fragment/query delimiter is removed. Order
    matches the sicore ledger's parser (strip angle → truncate #/? → unescape) so
    the two repos derive byte-identical edges."""
    return target.split("#", 1)[0].split("?", 1)[0]


def document_link_targets(md_text: str) -> list[str]:
    """Every link/image destination in one document's prose — the building block
    of the doc→asset attribution edge (coverage v2, §4.2). Covers markdown
    ``![](...)`` and ``[](...)`` plus HTML ``<img src=...>`` (single- OR
    double-quoted). Angle brackets are unwrapped and an optional link title
    stripped; then the ``#fragment``/``?query`` is truncated and the result is
    URL-decoded once (``%20`` → space). Code fences/spans are masked so a path
    inside example code is not mistaken for a real embed."""
    targets: list[str] = []
    prose = _markdown_prose(md_text)
    for captured in _MD_LINK_RE.findall(prose):
        destination = captured.strip()
        if destination.startswith("<") and destination.endswith(">"):
            destination = destination[1:-1].strip()
        else:
            titled = re.fullmatch(r"(.+?)\s+(?:\"[^\"]*\"|'[^']*')", destination)
            if titled:
                destination = titled.group(1).strip()
        destination = unquote(_strip_fragment_query(destination)).strip()
        if destination:
            targets.append(destination)
    for captured in _HTML_IMG_SRC_RE.findall(prose):
        destination = unquote(_strip_fragment_query(captured[1:-1])).strip()
        if destination:
            targets.append(destination)
    return targets


def asset_attribution_edges(
    workdir: str, sources: list[str] | None = None,
) -> dict[str, list[str]]:
    """Map each raw ``.md`` document to the media assets it embeds in its body.

    For every document ``d`` under ``raw/``, resolve each body link/img target
    relative to ``d``'s directory (``posixpath.normpath``, URL-decoded); an edge
    ``d→a`` is recorded only when ``a`` is a media asset present in the raw
    inventory. A target that resolves to nothing — or to a non-media file —
    yields no edge and never errors: the raw tree is the single source of truth
    for what embeds what, so the box (local files) and the server (sync-time
    refs) derive the SAME edges. Values are sorted for determinism."""
    sources = source_inventory(workdir) if sources is None else sources
    media = {s for s in sources if is_media_asset(s)}
    raw = Path(workdir) / "raw"
    edges: dict[str, list[str]] = {}
    for doc in sources:
        if not doc.lower().endswith(".md"):
            continue
        try:
            text = (raw / doc).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        base = posixpath.dirname(doc)
        hits: set[str] = set()
        for target in document_link_targets(text):
            if target.startswith(("http://", "https://", "//", "/")):
                continue
            resolved = posixpath.normpath(posixpath.join(base, target))
            if resolved in media:
                hits.add(resolved)
        if hits:
            edges[doc] = sorted(hits)
    return edges


def _body_source_payload_spans(text: str) -> list[tuple[int, int, str]]:
    """Extract source payloads and exact source-text offsets outside code."""
    payloads: list[tuple[int, int, str]] = []
    prose = _markdown_prose(text)
    for match in _BODY_SOURCE_START_RE.finditer(prose):
        stack = [")" if match.group("open") == "(" else "）"]
        for pos, char in enumerate(prose[match.end():match.end() + 301], start=match.end()):
            if char == "(":
                stack.append(")")
            elif char == "（":
                stack.append("）")
            elif char == stack[-1]:
                stack.pop()
                if not stack:
                    payloads.append((match.end(), pos, text[match.end():pos]))
                    break
    return payloads


def _body_source_payloads(text: str) -> list[str]:
    """Extract source-marker payloads while preserving nested filename pairs."""
    return [payload for _, _, payload in _body_source_payload_spans(text)]


_SOURCE_ALIAS_QUOTES = {
    '"': '"', "'": "'", "`": "`", "“": "”", "‘": "’",
}


def _source_alias_key(value: str) -> str:
    """Conservative comparison key for an incomplete body source label."""
    value = unicodedata.normalize("NFC", value).strip()
    while len(value) >= 2 and value[0] in _SOURCE_ALIAS_QUOTES:
        if value[-1] != _SOURCE_ALIAS_QUOTES[value[0]]:
            break
        value = value[1:-1].strip()
    return value.casefold()


def _source_without_known_extension(value: str) -> str | None:
    lower = value.casefold()
    for ext in sorted(KNOWN_SOURCE_EXTS, key=len, reverse=True):
        if lower.endswith(ext.casefold()):
            return value[:-len(ext)]
    return None


def _source_aliases(source: str) -> set[str]:
    """Exact aliases accepted for a source; no fuzzy title matching."""
    aliases = {source, posixpath.basename(source)}
    for value in tuple(aliases):
        stem = _source_without_known_extension(value)
        if stem:
            aliases.add(stem)
    return {key for value in aliases if (key := _source_alias_key(value))}


def _split_trailing_locator(value: str) -> tuple[str, str]:
    """Separate a supported trailing locator while retaining its whitespace."""
    matches = list(_SOURCE_LOCATOR_PREFIX_RE.finditer(value))
    if matches and matches[-1].end() == len(value):
        match = matches[-1]
        return value[:match.start()], value[match.start():]
    return value, ""


def normalize_body_source_annotations(
    workdir: str,
    allowed_pages: set[str] | None = None,
) -> list[dict[str, str]]:
    """Repair unambiguous missing-extension body citations without a model.

    Only a single malformed payload that exactly matches one unique
    ``compiled_from`` alias is rewritten. Mixed lists, arbitrary prose, and
    duplicate stems remain lint failures for semantic repair. Code fences and
    inline code are masked by ``_body_source_payload_spans``. When supplied,
    ``allowed_pages`` keeps incremental byte-isolation intact.
    """
    candidate = Path(workdir) / "candidate"
    fixes: list[dict[str, str]] = []
    if not candidate.is_dir():
        return fixes
    for path in sorted(candidate.rglob("*.md")):
        rel = path.relative_to(candidate).as_posix()
        if allowed_pages is not None and rel not in allowed_pages:
            continue
        try:
            text = path.read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        sources, _, _ = parse_compiled_from(text)
        if not sources:
            continue
        aliases: dict[str, set[str]] = {}
        for source in sources:
            for alias in _source_aliases(source):
                aliases.setdefault(alias, set()).add(source)
        replacements: list[tuple[int, int, str, str]] = []
        for start, end, payload in _body_source_payload_spans(text):
            found, malformed = _body_source_references(f"(source: {payload})")
            if found or len(malformed) != 1:
                continue
            if malformed[0] != payload.strip(" \t\r\n,，;；、"):
                # The ASCII-wrapped re-parse closed before the span's true end
                # (e.g. an unbalanced ")" inside a full-width marker), so the
                # parsed item covers only a prefix of the span. Rewriting the
                # whole span would silently drop the tail — leave it malformed
                # for semantic repair instead.
                continue
            label, locator = _split_trailing_locator(malformed[0])
            matches = aliases.get(_source_alias_key(label), set())
            if len(matches) != 1:
                continue
            source = next(iter(matches))
            replacement = source + locator
            if replacement == payload:
                continue
            replacements.append((start, end, payload, replacement))
        if not replacements:
            continue
        updated = text
        for start, end, before, after in reversed(replacements):
            updated = updated[:start] + after + updated[end:]
            fixes.append({"rule": "body_source_exact_alias", "page": rel,
                          "from": before, "to": after})
        _write_text_atomic(path, updated)
    fixes.sort(key=lambda item: (item["page"], item["from"], item["to"]))
    return fixes


def _body_source_references(text: str) -> tuple[list[str], list[str]]:
    """Return (source files, malformed source items) from body annotations.

    A known extension terminates each filename; punctuation before that
    extension belongs to the imported filename. This fail-closed rule prevents
    removing ``.md`` from turning a real provenance mismatch into a silent
    green lint. Locator-only items such as ``§3`` and ``p.12`` are accepted
    after a file.
    """
    found: list[str] = []
    malformed: list[str] = []
    for captured in _body_source_payloads(text):
        capture_has_file = False
        capture_has_malformed = False
        cursor = 0
        while match := _SOURCE_FILE_END_RE.search(captured, cursor):
            item = captured[cursor:match.end()].strip(" \t\r\n,，;；、`")
            entry = _norm_source_entry(item)
            if entry and entry not in found:
                found.append(entry)
            capture_has_file = capture_has_file or bool(entry)
            cursor = match.end()

            # A locator belongs to the filename immediately before it, not to
            # the next comma-separated filename. Consume it before advancing
            # the item cursor so ``a.md §3, b.pdf p.5`` yields exactly two
            # source paths while keeping punctuation inside filenames intact.
            locator = _SOURCE_LOCATOR_PREFIX_RE.match(captured, cursor)
            if locator:
                cursor = locator.end()
            separator = _SOURCE_SEPARATOR_RE.match(captured, cursor)
            if separator:
                cursor = separator.end()
        remainder = captured[cursor:].strip(" \t\r\n,，;；、")
        if remainder and not _SOURCE_LOCATOR_RE.fullmatch(remainder):
            if remainder not in malformed:
                malformed.append(remainder)
            capture_has_malformed = True
        if not capture_has_file and not capture_has_malformed:
            item = captured.strip()
            if item and item not in malformed:
                malformed.append(item)
    return found, malformed


def _body_source_files(text: str) -> list[str]:
    """Normalized filenames cited via body ``(source: ...)`` annotations."""
    return _body_source_references(text)[0]


def _out_links(rel: str, text: str, names: set[str]) -> set[str]:
    """Resolved intra-wiki edges out of one page (md links + wikilinks)."""
    base = Path(rel).parent
    out: set[str] = set()
    prose = _markdown_prose(text)
    for target in _markdown_link_targets(prose):
        if target.startswith(("http://", "https://", "/")):
            continue
        resolved = posixpath.normpath((base / target).as_posix())
        if resolved in names:
            out.add(resolved)
        elif target in names:
            out.add(target)
    for target in _WIKI_LINK_RE.findall(prose):
        t = target.strip()
        if f"{t}.md" in names:
            out.add(f"{t}.md")
        elif t in names:
            out.add(t)
    return out


def _orphan_pages(pages: dict[str, dict]) -> list[str]:
    """Pages unreachable from index.md by following links — the exact failure
    the 2026-07-06 A/B caught (css-cluster-operations compiled but never wired
    into the index, invisible to every consumer that starts at index.md)."""
    names = set(pages.keys())
    if "index.md" not in names:
        return []  # index missing is gated elsewhere; no root to walk from
    reachable = {"index.md"}
    frontier = ["index.md"]
    while frontier:
        rel = frontier.pop()
        for target in _out_links(rel, pages[rel].get("text", ""), names):
            if target not in reachable:
                reachable.add(target)
                frontier.append(target)
    return sorted(rel for rel in names - reachable if not _is_reserved_page(rel))


_CREDENTIAL_PATTERNS = (
    ("private key", re.compile(
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?"
        r"-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("OpenAI-compatible API key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("GitHub token", re.compile(r"\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{30,}\b")),
    ("GitHub fine-grained token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("Google API key", re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b")),
    ("bearer token", re.compile(r"\bBearer\s+[A-Za-z0-9_.~+/-]{20,}=*\b", re.IGNORECASE)),
    ("JSON credential value", re.compile(
        r'"(?:api[_-]?key|apikey|token|secret|password|access_key|secret_key)"\s*:\s*"[^"\n]{16,}"',
        re.IGNORECASE)),
    ("environment credential", re.compile(
        r"\b(?:API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|SECRET_KEY|ACCESS_KEY|"
        r"AWS_SECRET_ACCESS_KEY|TOKEN|SECRET_TOKEN|PASSWORD)=\S{16,}",
        re.IGNORECASE)),
)
_CREDENTIAL_PLACEHOLDER_RE = re.compile(
    r"(?:\[REDACTED\]|<[^>]+>|\$\{[^}]+\}|\*{3,}|"
    r"(?:^|[=:\s\"'])(?:example|placeholder|your[-_ ]|dummy|changeme|"
    r"replace[-_ ]me|sample|test)[A-Za-z0-9_.:/+@-]*)",
    re.IGNORECASE,
)


def credential_exposure_violations(rel: str, text: str) -> list[dict]:
    """High-confidence credential-shaped values in one candidate page.

    This is deliberately narrower than external-content redaction: ordinary
    names, phone numbers, IPs, internal URLs, and business prose are untouched.
    Findings report only kind + line, never the matched value, so SELFCHECK and
    the injected repair message cannot become a second secret-leak channel.
    """
    findings: list[tuple[int, int, str]] = []
    claimed_spans: list[tuple[int, int]] = []
    for label, pattern in _CREDENTIAL_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(0)
            if _CREDENTIAL_PLACEHOLDER_RE.search(value):
                continue
            span = match.span()
            if any(span[0] < end and start < span[1] for start, end in claimed_spans):
                continue
            claimed_spans.append(span)
            findings.append((span[0], text.count("\n", 0, span[0]) + 1, label))
    findings.sort()
    return [
        {
            "page": rel,
            "kind": "credential_exposure",
            "detail": (f"possible {label} at line {line}; replace only the secret value "
                       "with [REDACTED] and keep the non-secret context"),
        }
        for _, line, label in findings
    ]


def lint_candidate(pages: dict[str, dict], exclusion_errors: list[str]) -> dict:
    """Structural lint over the candidate tree: provenance presence, intra-wiki
    link resolution, index reachability (orphans), body-citation hygiene, plus
    exclusion-file errors. index.md is a routing page and exempt from the
    provenance requirement."""
    violations: list[dict] = []
    names = set(pages.keys())
    # Same cap as the workspace sync (compile_box.MAX_SYNC_FILE_BYTES): a page
    # crossing it is SILENTLY skipped by the sync — absent (or stale) in the
    # consumer store and therefore in the published version, while every local
    # check stays green (review finding). Making it a lint violation turns the
    # silent divergence into a model-fixable signal — an over-1MB wiki page
    # needs splitting regardless.
    sync_cap = int(os.environ.get("KBC_MAX_SYNC_FILE_BYTES", str(1024 * 1024)))
    for rel, page in pages.items():
        if "error" in page:
            violations.append({"page": rel, "kind": "unreadable", "detail": page["error"]})
            continue
        if not _is_reserved_page(rel) and not page["has_compiled_from"] and not page["derived"]:
            violations.append({"page": rel, "kind": "no_provenance",
                               "detail": "frontmatter 缺 compiled_from(纯综合页请标 derived: true)"})
        text = page.get("text", "")
        violations.extend(credential_exposure_violations(rel, text))
        # Same byte METHOD as the sync gate (stat().st_size), not the decoded
        # text re-encoded: read_text's newline translation under-measures CRLF
        # pages, so a page just over the cap could lint green while the sync
        # silently skips it (review). Fallback covers callers that build the
        # pages dict by hand (tests).
        page_bytes_len = page.get("bytes") or len(text.encode("utf-8"))
        if page_bytes_len > sync_cap:
            violations.append({"page": rel, "kind": "page_too_large",
                               "detail": (f"页面 {page_bytes_len // 1024}KB 超过同步上限"
                                          f"({sync_cap // 1024}KB)——超限页不会被持久化/发布(静默丢失);"
                                          "按主题拆成多页并挂回 index")})
        base = Path(rel).parent
        prose = _markdown_prose(text)
        for target in _markdown_link_targets(prose):
            if target.startswith(("http://", "https://", "/")):
                continue
            resolved = posixpath.normpath((base / target).as_posix())
            if resolved not in names and target not in names:
                violations.append({"page": rel, "kind": "broken_link", "detail": target})
        for target in _WIKI_LINK_RE.findall(prose):
            t = target.strip()
            if t and f"{t}.md" not in names and t not in names:
                violations.append({"page": rel, "kind": "broken_wikilink", "detail": t})
        # Body cites (source: X.ext) → that file must be in THIS page's
        # compiled_from (basename match tolerated: bodies usually cite the
        # basename, compiled_from carries the raw-relative path).
        cf_full = set(page["sources"])
        cf_names = {posixpath.basename(s) for s in cf_full}
        body_sources, malformed_sources = _body_source_references(text)
        for f in body_sources:
            if f in cf_full or posixpath.basename(f) in cf_names:
                continue
            violations.append({"page": rel, "kind": "body_source_uncited",
                               "detail": f"正文引用 (source: {f}) 但该文件不在本页 compiled_from——补登记或修正引用"})
        for item in malformed_sources:
            violations.append({"page": rel, "kind": "body_source_malformed",
                               "detail": (f"正文来源标注无法解析为带扩展名的源文件: (source: {item})"
                                          "——保留与 compiled_from 一致的完整文件名和扩展名")})
        # Charset integrity: U+FFFD (replacement char) is never legitimate KB
        # content — it is the fingerprint of a LOSSY UTF-8 decode (a multibyte
        # char split at a stream chunk boundary upstream, e.g. the model-output
        # SSE through the gateway). It corrupts BOTH paths (the coverage ledger
        # flags those as dangling) AND body prose — and prose corruption is
        # INVISIBLE to the coverage ledger, so before this it shipped silently.
        # Scan the FULL page text (frontmatter + body) so a corrupted draft can
        # never reach state=passed → never settles / publishes with a � in it.
        # Guidance is "restore from raw", not "rewrite": copying the damaged span
        # keeps the damage; deleting the char drops content.
        if "\ufffd" in text:
            bad_lines = [i + 1 for i, ln in enumerate(text.splitlines()) if "\ufffd" in ln]
            shown = "、".join(f"第{n}行" for n in bad_lines[:10])
            more = f" 等共 {len(bad_lines)} 行" if len(bad_lines) > 10 else ""
            violations.append({"page": rel, "kind": "charset_corruption",
                               "detail": (f"含 U+FFFD 替换字符({shown}{more})——这是编码损坏"
                                          "(多字节字符在传输中被截断),不是内容笔误;逐处定位 �,"
                                          "对照 raw 原文判断本应是哪个字并改回,切勿照抄损坏文本、勿删字略过")})
    if pages and "index.md" not in pages:
        # Any tree that reaches lint must have its routing page: the full-compile
        # mid-Execute case (index legitimately not written yet) never gets here
        # (early-return), and an incremental turn started WITH an index — its
        # absence is model damage. Without this rule the orphan walk silently
        # returns [] ("no root") and an index-deleting turn settles green.
        violations.append({"page": "index.md", "kind": "index_missing",
                           "detail": "candidate/index.md 不存在——路由页被删;重建它并把全部页面挂回可达链"})
    for rel in _orphan_pages(pages):
        violations.append({"page": rel, "kind": "orphan",
                           "detail": "从 index.md 无链可达——把它挂进 index 或相应父页;确属废页则删除"})
    for err in exclusion_errors:
        violations.append({"page": EXCLUSIONS_PATH, "kind": "exclusions_invalid", "detail": err})
    violations.extend(format_policy_violations(pages))
    return {"ok": not violations, "violations": violations}


_TITLE_RE = re.compile(r"^title\s*:\s*(.+?)\s*$", re.MULTILINE)
_HEADING_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_TITLE_NOISE_RE = re.compile(r"[\s\W_]+", re.UNICODE)


def _norm_title(text: str) -> str:
    m = _TITLE_RE.search(text) or _HEADING_RE.search(text)
    if not m:
        return ""
    return _TITLE_NOISE_RE.sub("", m.group(1).strip().strip("\"'").lower())


def dup_candidates(pages: dict[str, dict], cap: int = 20) -> list[dict]:
    """Deterministic merge-or-exempt worklist for the cross-batch final pass:
    page pairs with the same (normalized) title, or with heavy compiled_from
    overlap (≥2 shared sources covering ≥50% of the smaller set). A signal for
    the final-review directive and the publish card — NOT a lint violation
    (near-dups can be legitimate, so the model/owner gets the last word)."""
    infos = []
    for rel, page in sorted(pages.items()):
        if _is_reserved_page(rel) or "error" in page:
            continue
        infos.append((rel, _norm_title(page.get("text", "")), set(page["sources"])))
    out: list[dict] = []
    for i in range(len(infos)):
        for j in range(i + 1, len(infos)):
            (a, ta, sa), (b, tb, sb) = infos[i], infos[j]
            shared = sa & sb
            same_title = bool(ta) and ta == tb
            overlap = len(shared) >= 2 and len(shared) / max(1, min(len(sa), len(sb))) >= 0.5
            if same_title or overlap:
                out.append({"pages": [a, b], "shared_sources": len(shared),
                            "reason": "标题相同" if same_title else f"共享 {len(shared)} 个来源"})
            if len(out) >= cap:
                return out
    return out


def coverage(workdir: str, pages: dict[str, dict], exclusions: list[dict]) -> dict:
    """The ledger (coverage v2): raw inventory − compiled_from union − exclusions
    − auto-attached media = unaccounted.

    v2 adds ONE accounting path (monotonic — it can only SHRINK unaccounted, so
    every v1-green library stays green): a media asset (image under `assets/`,
    see is_media_asset) embedded in the body of a document that is ITSELF
    accounted (cited or excluded) is auto-attached to that document and counts as
    accounted. Media assets are the document's attachments, not first-class
    sources — so `compiled_from` no longer needs a token per image and the
    exclusion ledger no longer needs a row per image. Two things deliberately do
    NOT auto-attach: an ORPHAN asset embedded by no accounted document (upload
    residue — it stays unaccounted and must be excluded with a reason, so a human
    still sees it), and `assets/sheets/*.md` placeholders (content files, not
    media — is_media_asset excludes them, so they remain first-class sources). A
    directly-cited asset still counts as cited (v1 compatibility)."""
    sources = source_inventory(workdir)
    source_set = set(sources)
    cited: set[str] = set()
    for page in pages.values():
        cited.update(page["sources"])
    excluded: set[str] = set()
    hit: set[str] = set()  # exclusion patterns that matched ≥1 inventory path
    for s in sources:
        for e in exclusions:
            if _matches(s, e["pattern"]):
                excluded.add(s)
                hit.add(e["pattern"])
    # A pattern that matches nothing is almost always a typo (wrong prefix, wrong
    # glob) — surfaced as a warning so the owner fixes it, but non-blocking (a
    # stale exclusion for an already-removed file shouldn't wedge the gate).
    noop_exclusions = sorted({e["pattern"] for e in exclusions} - hit)
    # v2 auto-attach. Edges come from the raw tree (each document's body image
    # links), so both repos compute the SAME accounting from the SAME frozen
    # source set. `auto` is the NET-NEW set — media assets accounted ONLY via an
    # embedding accounted document (not already cited/excluded); the subtraction
    # below is identical either way, but reporting the net-new set keeps cited /
    # excluded / auto_attached a disjoint, auditable decomposition of accounted.
    media_assets = {s for s in source_set if is_media_asset(s)}
    accounted_docs = cited | excluded
    edges = asset_attribution_edges(workdir, sources)
    auto_edges = sorted(
        (asset, doc)
        for doc, assets in edges.items() if doc in accounted_docs
        for asset in assets
        if asset in media_assets and asset not in cited and asset not in excluded
    )
    auto = {asset for asset, _ in auto_edges}
    unaccounted = sorted(source_set - cited - excluded - auto)
    dangling = sorted(cited - source_set)
    return {
        "total_sources": len(sources),
        "cited": len(cited & source_set),
        "excluded": len(excluded),
        # Auto-attach must be OBSERVABLE, never a silent fail-open (platform
        # architecture audit's largest class): report the count and a capped
        # sample of the accounting edges (asset ← the document that embeds it).
        "auto_attached": len(auto),
        "auto_attached_sample": [{"asset": asset, "via": doc}
                                 for asset, doc in auto_edges[:20]],
        "unaccounted": unaccounted,
        "dangling_citations": dangling,
        "noop_exclusions": noop_exclusions,
        # closed = the ledger is consistent in BOTH directions: every source
        # accounted AND every citation real. dangling used to be display-only —
        # the repair prompt listed the fix, but the gate (ledger_clean) never
        # fired on it, so a lone dangling citation sailed through settle and
        # surfaced as owner homework on the publish page.
        "closed": not unaccounted and not dangling,
    }


def content_hash(pages: list[tuple[str, bytes]]) -> str:
    """THE canonical (rel_posix, bytes) digest, sorted by rel_posix. Single source
    of truth behind the draft snapshot (pack_candidates_to_wiki), the self-check
    idempotency key (candidate_tree_hash), and an installed published bundle
    (compile_box._install_wiki_snapshot) — so byte-identical content yields the
    SAME snapshot_hash across all three and (question × snapshot) grading stays
    comparable across draft and published sources. Do not inline this formula
    anywhere; keep this the only copy so the three can't silently drift."""
    h = hashlib.sha256()
    for rel_posix, data in sorted(pages):
        h.update(rel_posix.encode()); h.update(b"\0"); h.update(data); h.update(b"\0")
    return h.hexdigest()


def candidate_tree_hash(workdir: str) -> str | None:
    """Content hash of candidate/**/*.md|.json (via content_hash) — the self-check
    idempotency key. None when there is no candidate tree."""
    cand = Path(workdir) / "candidate"
    if not cand.is_dir():
        return None
    entries: list[tuple[str, bytes]] = []
    for f in cand.rglob("*"):
        if not f.is_file() or f.suffix not in (".md", ".json"):
            continue
        rel = f.relative_to(cand).as_posix()
        try:
            data = f.read_bytes()
        except OSError:
            # Unreadable (dangling symlink / FIFO / perm-denied). Do NOT raise:
            # state_key runs BEFORE run_layer1's fail-open, so an exception here
            # would silently disable the coverage gate. Include the path with
            # empty bytes so the tree hash still changes when the file appears
            # (rotating the idempotency key → a re-check), and candidate_pages
            # surfaces the real read error as an "unreadable" lint violation.
            data = b""
        entries.append((rel, data))
    if not entries:
        return None
    return content_hash(entries)


def state_key(workdir: str) -> str | None:
    """Idempotency key for the self-check trigger: candidate tree + exclusions
    file. Covers EXCLUSIONS.json explicitly because a repair that only adds
    exclusions (no candidate edits) must still trigger a re-check — otherwise
    the report would stay 'repairing' forever. None = nothing to check yet."""
    tree = candidate_tree_hash(workdir)
    if tree is None:
        return None
    h = hashlib.sha256(tree.encode())
    excl = Path(workdir) / EXCLUSIONS_PATH
    if excl.is_file():
        try:
            h.update(excl.read_bytes())
        except OSError:
            pass
    return h.hexdigest()


def read_selfcheck(workdir: str) -> dict | None:
    path = Path(workdir) / SELFCHECK_PATH
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def run_layer1(workdir: str) -> dict:
    """Compute the full Layer-1 report (coverage + lint + dup candidates). Pure
    except reading the previous SELFCHECK to carry the Layer-2 `pk` and the
    `media_verify` sections forward — an L1 re-check must never wipe red-blue
    results or re-arm an already-run image re-verification."""
    pages = candidate_pages(workdir)
    exclusions, exclusion_errors = load_exclusions(workdir)
    cov = coverage(workdir, pages, exclusions)
    lint = lint_candidate(pages, exclusion_errors)
    previous = read_selfcheck(workdir) or {}
    media_verify = previous.get("media_verify")
    citing_media = media_citing_pages(workdir)
    if media_verify is not None or citing_media:
        media_verify = dict(media_verify or {})
        media_verify["summary"] = media_verification_summary(
            workdir, media_verify=media_verify, citing=citing_media)
    return {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "candidate_tree_hash": candidate_tree_hash(workdir),
        "coverage": cov,
        "lint": {"ok": lint["ok"], "violations": lint["violations"]},
        "dup_candidates": dup_candidates(pages),
        "pk": previous.get("pk"),  # Layer-2 results survive L1 re-checks
        "media_verify": media_verify,
        # The converge signal survives too: _post_turn_selfcheck overwrites the
        # whole file with this report, and dropping the phase left a per-turn
        # window with no converge_phase before the seam re-set it (review).
        "converge_phase": previous.get("converge_phase"),
    }


def write_selfcheck(workdir: str, report: dict) -> None:
    # Atomic (temp + os.replace): SELFCHECK.json is the sole carrier of the
    # converge signal and is written exactly at the turn-end seam — the same
    # SIGTERM/OOM window that motivated the ticket-file fix. A torn write reads
    # back as absent and silently drops state + converge_phase.
    _write_text_atomic(Path(workdir) / SELFCHECK_PATH,
                       json.dumps(report, ensure_ascii=False, indent=2) + "\n")


def update_pk_section(workdir: str, pk: dict) -> None:
    """Single write-point for the Layer-2 `pk` section. Read-modify-write so the
    L1 fields are never clobbered; creates a minimal skeleton when no L1 report
    exists yet (e.g. CLI calibration runs against a bare workdir)."""
    report = read_selfcheck(workdir) or {"version": 1, "coverage": None, "lint": None, "state": None}
    report["pk"] = pk
    report["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_selfcheck(workdir, report)


# The verify converge-phase is the AUTHORITATIVE, DURABLE signal the frontend
# reads to show 校对中/修订中 and gate the test step — instead of run_status,
# which was the root of the "box looks idle yet still working" phantom. Verify
# runs (red-blue/media) are post-turn: without a persisted "in progress" marker
# the frontend only had transient `summary` events (lost on reload). This closes
# that gap. It is PURELY ADDITIVE — a field write, no control-flow change — so it
# cannot affect the never-stuck turn/repair logic.
CONVERGE_PHASES = ("verifying", "revising", "settled")


def set_converge_phase(workdir: str, phase: str) -> None:
    """Write the verify converge phase (verifying → a check is running; revising →
    a check found issues and a repair turn was injected; settled → converged, the
    draft is stable and testable). Read-modify-write; fail-open (a signal write
    must never break the verify flow)."""
    if phase not in CONVERGE_PHASES:
        return
    try:
        report = read_selfcheck(workdir) or {"version": 1, "coverage": None, "lint": None, "state": None}
        report["converge_phase"] = phase
        report["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        write_selfcheck(workdir, report)
    except Exception:
        pass


def pack_candidates_to_wiki(workdir: str, dest: Path) -> tuple[str, int]:
    """Pin the current draft: copy {workdir}/candidate/*.md|.json into
    {dest}/.siclaw/knowledge/ with the `candidate/` prefix stripped
    (candidate/index.md → index.md), mirroring the consumer's
    buildPublishBundleFromCandidates so a consumer reads BYTE-IDENTICALLY to
    what a publish would serve. Shared by user test sessions (compile_box) and
    the red-blue blue team (redblue.py). Returns (sha256 over sorted
    relpath+content, page_count). Raises FileNotFoundError if there are no
    candidate pages or no root index.md."""
    candidate = Path(workdir) / "candidate"
    candidate_real = candidate.resolve()
    kdir = dest / ".siclaw" / "knowledge"
    kdir.mkdir(parents=True, exist_ok=True)
    pages: list[tuple[str, bytes]] = []
    for f in sorted(candidate.rglob("*")) if candidate.is_dir() else []:
        if not f.is_file() or f.suffix not in (".md", ".json"):
            continue
        rel = f.relative_to(candidate)
        if ".." in rel.parts:
            continue
        # Symlink confinement (security): is_file() follows symlinks and rglob can
        # descend a symlinked dir, so a compile session (Write+Bash) could
        # `ln -s /etc/passwd candidate/leak.md` and leak host-file content into the
        # read-only snapshot. Pack only files whose REAL path stays under candidate/
        # — covers both file symlinks and symlinked directories.
        try:
            f.resolve().relative_to(candidate_real)
        except (ValueError, OSError):
            continue
        rel_posix = rel.as_posix()
        data = f.read_bytes()
        out = kdir / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        pages.append((rel_posix, data))
    if not pages:
        raise FileNotFoundError("no candidate pages to test yet — ask the authoring agent to generate pages first")
    if not any(rp == "index.md" for rp, _ in pages):
        raise FileNotFoundError("draft is missing candidate/index.md — cannot test without a root index page")
    # content_hash sorts by rel_posix STRING (not filesystem/Path order), so a
    # draft pinned here and a published bundle installed by _install_wiki_snapshot
    # yield the SAME hash for byte-identical content (they share this one formula).
    return content_hash(pages), len(pages)


def _is_en(locale: str | None) -> bool:
    """Locale gate for user-facing self-check text. The platform default is
    English (compile_box.DEFAULT_LOCALE='en'); a KB is Chinese only when the
    consumer declares locale=zh. Mirrors the box's prompt-pack locale so an
    English KB's self-check narration/repair match its English box_role instead
    of arriving in Chinese."""
    return (locale or "en").lower().startswith("en")


def narration(report: dict, locale: str | None = None) -> str:
    """One status line for the summary event stream (the only thing users see),
    in the run's locale (see _is_en)."""
    cov, lint = report["coverage"], report["lint"]
    en = _is_en(locale)
    noop = cov.get("noop_exclusions") or []
    auto = cov.get("auto_attached") or 0
    warn = ""
    if noop:
        warn = (f" ⚠ {len(noop)} exclusion(s) match no source — likely a typo" if en
                else f" ⚠ {len(noop)} 条排除未命中任何源——疑似写错")
    auto_note = ""
    if auto:
        auto_note = (f"; {auto} media auto-attached" if en
                     else f";{auto} 张媒体自动附属")
    if en:
        if report["state"] == "passed":
            return (f"Self-check (ledger): closed ✓ — {cov['cited']} sources compiled"
                    f" / {cov['excluded']} explicitly excluded / {cov['total_sources']} total"
                    f"{auto_note}; lint passed") + warn
        parts = []
        if cov["unaccounted"]:
            parts.append(f"{len(cov['unaccounted'])} source file(s) unaccounted")
        if cov["dangling_citations"]:
            parts.append(f"{len(cov['dangling_citations'])} dangling citation(s)")
        if not lint["ok"]:
            parts.append(f"{len(lint['violations'])} lint issue(s)")
        tail = "repair requested" if report["state"] == "repairing" else "repair budget spent; remaining items left for the owner"
        return "Self-check (ledger): " + ", ".join(parts) + " — " + tail + warn
    if report["state"] == "passed":
        return (f"自检(账本):闭合 ✓ — {cov['cited']} 源已编 / {cov['excluded']} 显式排除"
                f" / 共 {cov['total_sources']}{auto_note};lint 通过") + warn
    parts = []
    if cov["unaccounted"]:
        parts.append(f"{len(cov['unaccounted'])} 个源文件未入账")
    if cov["dangling_citations"]:
        parts.append(f"{len(cov['dangling_citations'])} 处悬空引用")
    if not lint["ok"]:
        parts.append(f"{len(lint['violations'])} 处 lint 问题")
    tail = "已请求回修" if report["state"] == "repairing" else "回修额度用尽,余项待负责人处理"
    return "自检(账本):" + "、".join(parts) + " — " + tail + warn


def build_repair_prompt(report: dict, locale: str | None = None) -> str:
    """The bounded repair turn injected by the driver, in the run's locale (see
    _is_en). Speaks the BOX_ROLE contract language; lists concrete gaps, never
    vague exhortations."""
    cov, lint = report["coverage"], report["lint"]
    if _is_en(locale):
        lines = ["[System self-check · coverage ledger] This round's mechanical check found the following; "
                 "please address them (do not rewrite unrelated pages because of this):"]
        if cov["unaccounted"]:
            shown = cov["unaccounted"][:_REPAIR_LIST_CAP]
            lines.append(f"\nUnaccounted raw source files ({len(cov['unaccounted'])}):")
            lines += [f"- {p}" for p in shown]
            if len(cov["unaccounted"]) > len(shown):
                lines.append(f"- …{len(cov['unaccounted'])} total (see authoring/SELFCHECK.json for the rest)")
            lines.append(
                "For each, choose one: (1) Compile it — fold the source's content into the relevant candidate "
                "page (new or merged) and register that source path in the page's frontmatter compiled_from; "
                "(2) Explicitly exclude — if it genuinely should not be compiled (meta files / live data / "
                'highly time-sensitive, etc.), add it to authoring/EXCLUSIONS.json (a JSON array of '
                '{"pattern": "path or glob relative to raw", "reason": "one-line reason the owner can understand"}).')
        if cov["dangling_citations"]:
            lines.append(f"\ncompiled_from cites nonexistent sources (dangling, {len(cov['dangling_citations'])}):")
            lines += [f"- {p}" for p in cov["dangling_citations"][:_REPAIR_LIST_CAP]]
            lines.append("Change them to real raw-relative paths.")
        if cov.get("noop_exclusions"):
            lines.append(f"\nExclusion patterns that matched NO source ({len(cov['noop_exclusions'])}) — likely a typo or wrong glob shape:")
            lines += [f"- {p}" for p in cov["noop_exclusions"][:_REPAIR_LIST_CAP]]
            lines.append("Matching is SEGMENT-aware: a bare `logs` matches only a file literally named logs; "
                         "`logs/*` matches only direct children; a whole subtree needs `logs/**` (or the `logs/` prefix form). Fix the pattern.")
        if not lint["ok"]:
            lines.append(f"\nLint issues ({len(lint['violations'])}):")
            lines += [f"- {v['page']}: {v['kind']} — {v['detail']}"
                      for v in lint["violations"][:_REPAIR_LIST_CAP]]
        return "\n".join(lines)
    lines = ["【系统自检 · 覆盖账本】本轮机械核对发现以下问题,请处理(不要因此重写无关页面):"]
    if cov["unaccounted"]:
        shown = cov["unaccounted"][:_REPAIR_LIST_CAP]
        lines.append(f"\n未入账的 raw 源文件({len(cov['unaccounted'])} 个):")
        lines += [f"- {p}" for p in shown]
        if len(cov["unaccounted"]) > len(shown):
            lines.append(f"- …等共 {len(cov['unaccounted'])} 个(其余见 authoring/SELFCHECK.json)")
        lines.append(
            "逐个二选一(图片/PDF 等媒体同样适用):① 补编 — 把该源内容编进相应 candidate 页(新增或并入),"
            "并在该页 frontmatter 的 compiled_from 登记该源路径;② 显式排除 — 确属不该编的(元文件/活数据/时效性强等),"
            '加入 authoring/EXCLUSIONS.json(JSON 数组,元素 {"pattern": "相对 raw 的路径或 glob", '
            '"reason": "一句话理由,让负责人看得懂"}).')
    if cov["dangling_citations"]:
        lines.append(f"\ncompiled_from 引用了不存在的源(悬空引用,{len(cov['dangling_citations'])} 处):")
        lines += [f"- {p}" for p in cov["dangling_citations"][:_REPAIR_LIST_CAP]]
        lines.append("请改成真实的 raw 相对路径。")
    if cov.get("noop_exclusions"):
        lines.append(f"\n没有命中任何源的排除模式({len(cov['noop_exclusions'])} 条)——多半是写错了:")
        lines += [f"- {p}" for p in cov["noop_exclusions"][:_REPAIR_LIST_CAP]]
        lines.append("匹配是按路径段的:裸 `logs` 只匹配名字恰为 logs 的文件;`logs/*` 只匹配直接子级;"
                     "整个子树要写 `logs/**`(或 `logs/` 前缀形式)。请修正模式。")
    if not lint["ok"]:
        lines.append(f"\nlint 问题({len(lint['violations'])} 处):")
        lines += [f"- {v['page']}: {v['kind']} — {v['detail']}"
                  for v in lint["violations"][:_REPAIR_LIST_CAP]]
    return "\n".join(lines)


def ledger_repair_pages(workdir: str, report: dict) -> list[str]:
    """Pages a LEDGER/LINT repair turn legitimately edits — on an incremental
    round the byte-integrity guard must authorize exactly these for the repair
    turn, or its mechanical restore reverts the repair itself and the round can
    never converge (seen live 07-09: a repair fixed 4 charset pages + deleted a
    sourceless orphan, and the re-armed guard restored all 5 → unconverged +
    a residual ticket for work that had in fact been done).

    = lint violation pages (charset/orphan/… name their page) ∪ pages whose
    compiled_from cites a dangling path (they must be edited to fix or drop the
    citation). Unaccounted-source merges are NOT here — the model declares
    those via ADDED_TARGETS.json, which the guard already honors live."""
    pages: set[str] = set()
    lint = report.get("lint") or {}
    for v in lint.get("violations") or []:
        p = v.get("page")
        if p and p != EXCLUSIONS_PATH:
            pages.add(str(p))
    dangling = set((report.get("coverage") or {}).get("dangling_citations") or [])
    if dangling:
        for rel, info in candidate_pages(workdir).items():
            if any(s in dangling for s in info.get("sources") or []):
                pages.add(rel)
    return sorted(pages)


def _write_text_atomic(path: Path, text: str) -> None:
    """Temp file in the same dir + os.replace (mirrors the driver's helper —
    selfcheck cannot import compile_box without a cycle). CONTRADICTIONS.json
    is the SHARED ticket queue: a torn read-modify-write here would drop the
    model's own tickets and wedge every later ticket read (review finding)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text, "utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


# ── L2: budget spent with residuals → a ticket, never owner homework ─────────
# The publish page only DISPLAYS residual state; the owner must never discover
# work there. When the bounded repair loop gives up (state=unconverged), CODE
# files one contradiction ticket — same schema, same queue, same rule/dispatch/
# resolve_ticket loop the model's own tickets ride (box_role.md 「矛盾工单」).

def file_residual_ticket(workdir: str, report: dict, locale: str | None = None) -> bool:
    """Append ONE residual ticket to authoring/CONTRADICTIONS.json, model-free.
    Stable id = fingerprint of the residual list: the same residuals repeatedly
    unconverging never duplicate the ticket; different residuals open a fresh
    one. An existing same-id ticket (open or already ruled) is left untouched.
    Returns whether a ticket was filed."""
    cov = report.get("coverage") or {}
    lint = report.get("lint") or {}
    incr = report.get("incremental") or {}
    # The FULL residual set — both the fingerprint and the quote derive from it.
    # Fingerprinting a truncated view (the old [:10] caps) made two genuinely
    # different residual sets sharing a prefix collide to one ticket id, so the
    # second was silently deduped away (review finding). Only the DISPLAY quote
    # is truncated, below.
    residuals: list[str] = []
    pages: set[str] = set()
    for p in (cov.get("unaccounted") or []):
        residuals.append(f"未入账源: {p}")
    for p in (cov.get("dangling_citations") or []):
        residuals.append(f"悬空引用: {p}")
    for v in (lint.get("violations") or []):
        residuals.append(f"lint {v.get('kind')}: {v.get('page')} — {str(v.get('detail', ''))[:80]}")
        if v.get("page"):
            pages.add(str(v["page"]))
    for p in (incr.get("out_of_scope_pages") or []):
        residuals.append(f"越界未还原: {p}")
        pages.add(str(p))
    if not residuals:
        return False
    digest = hashlib.sha256("\n".join(sorted(residuals)).encode("utf-8")).hexdigest()[:8]
    tid = f"selfcheck-residual-{digest}"
    path = Path(workdir) / "authoring" / "CONTRADICTIONS.json"
    tickets: list = []
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            # Unreadable ledger: bail rather than clobber the model's tickets.
            return False
        if not isinstance(data, list):
            return False
        tickets = data
    if any(isinstance(t, dict) and t.get("id") == tid for t in tickets):
        return False
    en = _is_en(locale)
    tickets.append({
        "id": tid,
        "title": "Self-check residuals" if en else "自检残留待处理",
        "question": ("The automatic self-check repair budget is spent and the items below remain unfixed — how should they be handled?"
                     if en else "自检自动回修额度已用完,以下残留没有修完,要怎么处理?"),
        "sources": [{"doc": "authoring/SELFCHECK.json", "quote": "; ".join(residuals)[:600]}],
        "options": (["Run another repair round", "Accept as-is"] if en else ["再修一轮", "接受现状"]),
        "current_value": "unresolved residuals" if en else "残留未处理",
        "affected_pages": sorted(pages)[:20],
        "status": "open",
        "answer": None,
    })
    _write_text_atomic(path, json.dumps(tickets, ensure_ascii=False, indent=2))
    return True


# ── image re-verification (fresh-eyes numeric check) ─────────────────────────
# Both real fidelity failures in the 2026-07-06 batch-vs-oneshot A/B were image
# numeric misreads (a memory bar transcribed as GPU utilization; P0/P1 bars
# swapped) — and the same-session "auditor hat" re-review cannot catch them,
# because it re-reads the page, not the pixels. So the driver injects ONE
# bounded fresh-context pass over pages that digest images, keyed in
# SELFCHECK.json so it never re-fires for already-verified pages. Scope is
# images only: PDFs read through their text layer and are cheap to get right;
# charts/screenshots are where transcription actually fails.


def media_citing_pages(workdir: str) -> dict[str, list[str]]:
    """candidate page → sorted raw-relative image paths whose numeric fidelity
    this page is responsible for. Three discovery paths, UNIONED:
      1. compiled_from image entries — an image cited directly (legacy pages);
      2. body ``(source: …)`` image citations — basename match tolerated;
      3. attribution-edge reverse lookup — a page that cites a DOCUMENT ``d`` in
         its compiled_from inherits the numeric check of every image ``d``
         embeds in its body.
    Path 3 is what keeps image re-verification alive under coverage v2: agents
    now cite DOCUMENTS (images auto-attach, see coverage/asset_attribution_edges)
    rather than listing images one-by-one, so without it the fresh-eyes numeric
    check would silently stop covering embedded charts — a silent fail-open on the
    exact fidelity risk it exists to catch. Only IMAGE_SOURCE_EXTS images go to
    transcription, so edge assets are intersected with the raw image set (a media
    asset like .tiff is accounted by coverage but not numerically re-read here)."""
    raw_images = [p for p in source_inventory(workdir)
                  if posixpath.splitext(p)[1].lower() in IMAGE_SOURCE_EXTS]
    by_basename: dict[str, list[str]] = {}
    for p in raw_images:
        by_basename.setdefault(posixpath.basename(p), []).append(p)
    raw_set = set(raw_images)
    edges = asset_attribution_edges(workdir)
    out: dict[str, list[str]] = {}
    for rel, page in candidate_pages(workdir).items():
        if "error" in page:
            continue
        hits: set[str] = set()
        for entry in list(page["sources"]) + _body_source_files(page.get("text", "")):
            if posixpath.splitext(entry)[1].lower() not in IMAGE_SOURCE_EXTS:
                continue
            if entry in raw_set:
                hits.add(entry)
            else:
                matches = by_basename.get(posixpath.basename(entry), [])
                if len(matches) == 1:
                    hits.add(matches[0])
        # Path 3: images embedded by a document this page cites in compiled_from.
        for entry in page["sources"]:
            for asset in edges.get(entry, ()):
                if asset in raw_set:
                    hits.add(asset)
        if hits:
            out[rel] = sorted(hits)
    return out


def pending_media_verification(workdir: str) -> dict[str, list[str]]:
    """Image-citing pages whose current page+image fingerprint is not verified.

    Page paths alone are not identities: a repair can edit the same page, and an
    incremental source refresh can replace an image at the same raw path. The
    previous path-only ledger silently skipped both cases. Reports without the
    v2 fingerprint map intentionally re-enter once so they acquire a stable
    content-bound identity on their next verification.
    """
    citing = media_citing_pages(workdir)
    sc = read_selfcheck(workdir) or {}
    fingerprints = (sc.get("media_verify") or {}).get("verified_fingerprints") or {}
    current = media_page_fingerprints(workdir, citing)
    return {p: imgs for p, imgs in citing.items()
            if fingerprints.get(p) != current.get(p)}


def media_page_fingerprints(
    workdir: str, citing: dict[str, list[str]] | None = None,
) -> dict[str, str]:
    """Stable identity for every image-citing candidate page.

    The digest covers the final page bytes, every cited raw-relative image path,
    and each image's bytes. Hash each shared image once per scan so a page edit or
    same-path image replacement deterministically re-arms verification without
    turning a large shared asset into repeated I/O.
    """
    citing = citing if citing is not None else media_citing_pages(workdir)
    root = Path(workdir)
    image_hashes: dict[str, bytes] = {}
    out: dict[str, str] = {}
    for page, images in sorted(citing.items()):
        page_path = root / "candidate" / page
        try:
            page_bytes = page_path.read_bytes()
        except OSError:
            continue
        digest = hashlib.sha256()
        digest.update(page_bytes)
        for image in sorted(images):
            digest.update(b"\0")
            digest.update(image.encode("utf-8"))
            if image not in image_hashes:
                image_path = root / "raw" / image
                try:
                    stat = image_path.stat()
                    image_hashes[image] = _cached_file_digest(
                        str(image_path), stat.st_size, stat.st_mtime_ns,
                        stat.st_ctime_ns, stat.st_ino)
                except OSError:
                    image_hashes[image] = b"missing"
            digest.update(b"\0")
            digest.update(image_hashes[image])
        out[page] = digest.hexdigest()
    return out


@lru_cache(maxsize=8192)
def _cached_file_digest(
    path: str, _size: int, _mtime_ns: int, _ctime_ns: int, _inode: int,
) -> bytes:
    """Stream a file digest and reuse it while the filesystem identity is stable."""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.digest()


def media_verification_summary(
    workdir: str,
    media_verify: dict | None = None,
    citing: dict[str, list[str]] | None = None,
    current: dict[str, str] | None = None,
) -> dict[str, int]:
    """Machine-readable coverage that cannot confuse exhausted with passed."""
    citing = citing if citing is not None else media_citing_pages(workdir)
    media_verify = media_verify if media_verify is not None else (
        (read_selfcheck(workdir) or {}).get("media_verify") or {})
    current = current if current is not None else media_page_fingerprints(workdir, citing)
    verified = media_verify.get("verified_fingerprints") or {}
    exhausted_names = set(media_verify.get("exhausted") or [])
    settled = {p for p, fingerprint in current.items()
               if verified.get(p) == fingerprint}
    exhausted = settled & exhausted_names
    passed = settled - exhausted
    pending = set(citing) - settled
    all_images = {image for images in citing.values() for image in images}
    pending_images = {image for page in pending for image in citing.get(page, [])}
    return {
        "total_pages": len(citing),
        "passed_pages": len(passed),
        "exhausted_pages": len(exhausted),
        "pending_pages": len(pending),
        "total_images": len(all_images),
        "pending_images": len(pending_images),
    }


def mark_media_verified(workdir: str, pages: list[str], exhausted: bool = False) -> None:
    """Single write-point for the media_verify section (read-modify-write like
    update_pk_section, so L1 fields are never clobbered). exhausted=True records
    the pages ALSO in media_verify.exhausted — verification kept failing past
    the attempt budget, so they ship unverified but VISIBLY flagged (fail-open
    must never read as a clean pass)."""
    report = read_selfcheck(workdir) or {"version": 1, "coverage": None, "lint": None, "state": None}
    mv = report.get("media_verify") or {}
    mv["version"] = 2
    citing = media_citing_pages(workdir)
    current = media_page_fingerprints(workdir, citing)
    mv["verified_pages"] = sorted(set(mv.get("verified_pages") or []) | set(pages))
    fingerprints = mv.get("verified_fingerprints") or {}
    for page in pages:
        if page in current:
            fingerprints[page] = current[page]
    mv["verified_fingerprints"] = fingerprints
    if exhausted:
        mv["exhausted"] = sorted(set(mv.get("exhausted") or []) | set(pages))
    else:
        mv["exhausted"] = sorted(set(mv.get("exhausted") or []) - set(pages))
        # A COMPLETED verification clears the page's retry count: a stale
        # residue would otherwise push a later re-entry (page re-cited after a
        # recompile) to "exhausted" after fewer real failures than the budget
        # implies — and the map stays bounded. Exhausted pages keep their count
        # as forensics (they are marked verified and never re-enter pending).
        for p in pages:
            (mv.get("attempts") or {}).pop(p, None)
            (mv.get("attempt_fingerprints") or {}).pop(p, None)
    mv["summary"] = media_verification_summary(
        workdir, media_verify=mv, citing=citing, current=current)
    mv["at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    report["media_verify"] = mv
    write_selfcheck(workdir, report)


def bump_media_attempts(workdir: str, pages: list[str]) -> dict[str, int]:
    """Retry accounting for pages whose verification FAILED (transcription or
    comparison error): read-modify-write media_verify.attempts and return the
    new counts for `pages`. The caller marks a page exhausted once its count
    reaches the budget — bounded retries instead of the old mark-before-verify
    (silent permanent false-pass) or unbounded re-runs."""
    report = read_selfcheck(workdir) or {"version": 1, "coverage": None, "lint": None, "state": None}
    mv = report.get("media_verify") or {}
    mv["version"] = 2
    attempts = mv.get("attempts") or {}
    attempt_fingerprints = mv.get("attempt_fingerprints") or {}
    citing = media_citing_pages(workdir)
    current = media_page_fingerprints(workdir, citing)
    for p in pages:
        if attempt_fingerprints.get(p) != current.get(p):
            attempts[p] = 0
        attempts[p] = int(attempts.get(p, 0)) + 1
        if p in current:
            attempt_fingerprints[p] = current[p]
    mv["attempts"] = attempts
    mv["attempt_fingerprints"] = attempt_fingerprints
    mv["summary"] = media_verification_summary(
        workdir, media_verify=mv, citing=citing, current=current)
    report["media_verify"] = mv
    write_selfcheck(workdir, report)
    return {p: attempts[p] for p in pages}


def cap_media_pending(pending: dict[str, list[str]], max_images: int) -> dict[str, list[str]]:
    """Trim a verify round to whole pages totalling ≤ max_images images. One
    verify session reading 35 images in a row hit the API's image-processing
    limits live (2026-07-06: ~15 images silently unverifiable) — rounds must be
    small; the remainder rolls into the next round naturally (only the pages
    actually included get marked verified). Always includes at least one page."""
    out: dict[str, list[str]] = {}
    n = 0
    for page, imgs in sorted(pending.items()):
        if out and n + len(imgs) > max_images:
            break
        out[page] = imgs
        n += len(imgs)
    return out


# The v1 prompt-based re-verification ("re-open the image and check") was
# superseded 2026-07-07 by blind transcription + text-only comparison in
# mediaverify.py — claim-in-context re-reading is a confirmation check, proven
# twice live (MEM 条→GPU-Util survived it; 跨图 H20 survived it). The
# deterministic halves (media_citing_pages / pending / mark / cap) stay here.
