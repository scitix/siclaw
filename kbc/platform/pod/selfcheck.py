"""Layer-1 compile self-check: deterministic coverage ledger + structural lint.

Design: improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §8.1.
The completion criterion moves from "the model says it's done" to "code can
verify it": every raw text source must be either cited by a candidate page's
OKF v0.2 `sources[].resource` frontmatter, or explicitly excluded (with a reason) in
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
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote

import yaml

from source_kinds import (
    IMAGE_SOURCE_EXTS,
    KNOWN_SOURCE_EXTS,
    MEDIA_SOURCE_EXTS,
    TEXT_SOURCE_BASENAMES,
    TEXT_SOURCE_EXTS,
    TEXT_SOURCE_PREFIXES,
    is_managed_source_path,
)

# Text sources vs binary media. BOTH are ledger-accountable (2026-07-06): the
# batch-vs-oneshot A/B showed silent media drops are the single worst coverage
# failure (29/33 images dropped by the one-shot compile), and a text-only
# ledger pushed agents to mark image-digest pages `derived: true` — zero
# machine-checkable provenance exactly where fidelity risk is highest.
# sources[].resource is the agent's declaration either way; the ledger only checks
# that the declaration is total.
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
CODE_SOURCES_MANIFEST = "CODE_SOURCES.json"

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
    paths relative to raw/. Arbitrary hidden files/dirs are skipped; selected
    repository-control paths such as .github and .gitlab-ci.yml are preserved.
    Every file must end up cited by some page's sources[].resource or explicitly
    excluded; unknown binary blobs are the agent's to exclude with a reason."""
    raw = Path(workdir) / "raw"
    if not raw.is_dir():
        return []
    out = []
    code_profile = knowledge_type(workdir) == "code"
    for f in raw.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(raw)
        if not is_managed_source_path(rel):
            continue
        rel_posix = rel.as_posix()
        # The platform-validated multi-repository manifest is control metadata:
        # it tells the compiler how to interpret the source tree, but it is not
        # itself a knowledge claim that needs a page citation or exclusion row.
        if code_profile and rel_posix == CODE_SOURCES_MANIFEST:
            continue
        out.append(rel_posix)
    return sorted(out)


_CODE_COMPONENT_CONTAINERS = {
    "api", "apis", "charts", "cmd", "config", "controllers", "deploy",
    "deployment", "helm", "internal", "manifests", "operator", "operators",
    "pkg", "plugins",
}
def knowledge_type(workdir: str) -> str:
    """Return the durable compile profile written by the control plane.

    Missing, legacy, or malformed BRIEF records remain document libraries. This
    fail-closed default is important during rolling upgrades: only an explicit
    typed command may relax per-file accounting to component accounting.
    """
    path = Path(workdir) / "authoring" / "BRIEF.json"
    try:
        brief = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return "document"
    return "code" if isinstance(brief, dict) and brief.get("knowledge_type") == "code" else "document"


def code_component(source: str) -> str:
    """Map one raw-relative path to a stable architecture component key.

    Code KBs deliberately account at module/component granularity rather than
    pretending every generated helper and test fixture deserves a Wiki claim.
    Familiar multi-component containers keep one child segment (``cmd/foo``,
    ``internal/controller``); other trees use their top-level directory. Root
    Root build/module descriptors each keep their own filename component so a
    change to README.md cannot authorize edits to a page backed by go.mod.
    Generated and vendored roots remain ordinary auditable components; only an
    explicit exclusion ledger entry may remove source evidence from coverage.
    """
    normalized = _strip_source_prefix(posixpath.normpath(source.replace("\\", "/")).lstrip("/"))
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts:
        return "."
    if len(parts) == 1:
        return parts[0]
    root = parts[0].lower()
    if root in _CODE_COMPONENT_CONTAINERS and len(parts) >= 3:
        return "/".join(parts[:2])
    return parts[0]


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
    return has_assets_segment(rel)


def has_assets_segment(rel: str) -> bool:
    """True when some path SEGMENT is an export attachment directory — `assets`
    (what the platform writes today) or the legacy `<name>.assets` form.

    Extension-agnostic on purpose: `is_media_asset` narrows to images for the
    COVERAGE question ('may this be auto-attached?'), while batch planning asks
    a different question ('does this file belong beside a document?') and must
    also keep `assets/sheets/*.md` placeholders with the doc that embeds them."""
    return any(seg.lower() == "assets" or seg.lower().endswith(".assets")
               for seg in rel.split("/"))


def _strip_source_prefix(entry: str) -> str:
    """Drop a leading raw/ or drop/ so a path compares against the raw-relative
    inventory. Applied to BOTH OKF source resources and exclusion patterns, so
    the two namespaces line up (a `raw/live.csv` exclusion matches inventory
    `live.csv`, matching how the adjacent sources field accepts the prefix)."""
    for prefix in ("raw/", "drop/"):
        if entry.startswith(prefix):
            return entry[len(prefix):]
    return entry


def _norm_source_entry(raw: str) -> str:
    """One OKF ``sources[].resource`` value → a raw-relative source path.

    Siclaw's v0.2 producer profile uses concrete raw paths here, not the old
    fingerprint-prefixed scalar dialect. A leading raw/ or drop/ prefix is
    accepted because both resolve to the same materialized Raw namespace.
    Canonicalized with posixpath.normpath, the same way intra-wiki link targets
    are resolved: an un-normalized citation (`./live.csv`, `sub/../x.md`) used
    to double-report as unaccounted AND dangling — cosmetic while dangling was
    display-only, a permanent convergence wedge once it gates `closed` (review
    finding: the model would get contradictory repair orders forever)."""
    entry = posixpath.normpath(raw.strip().replace("\\", "/"))
    entry = _strip_source_prefix(entry)
    if not entry:
        return entry
    entry = posixpath.normpath(entry)
    return "" if entry == "." else entry


def _explicit_managed_source(resource: str) -> bool:
    value = posixpath.normpath(resource.strip().replace("\\", "/"))
    return value.startswith(("raw/", "drop/"))


def _explicit_external_source(resource: str) -> bool:
    """True for OKF resources that cannot name Siclaw's managed Raw tree.

    OKF v0.2 intentionally permits URLs, package-relative paths, references,
    and arbitrary scope descriptors. Only ``raw/`` / ``drop/`` is an explicit
    managed-source namespace. Bare values remain a legacy compatibility case
    when (and only when) they exactly match the current Raw inventory.
    """
    value = posixpath.normpath(resource.strip().replace("\\", "/"))
    lowered = value.lower()
    return (
        "://" in value
        or lowered.startswith(("mailto:", "urn:", "doi:"))
        or value.startswith(("/", "../"))
        or lowered.startswith("references/")
    )


def parse_okf_sources(
    md_text: str,
    managed_sources: set[str] | None = None,
) -> tuple[list[str], bool, bool]:
    """Return normalized raw paths from OKF v0.2 ``sources[].resource``.

    The format is intentionally strict because this is a clean v0.2 producer
    contract, not a legacy reader: ``sources`` is a YAML sequence of mappings
    and every row names a non-empty string ``resource``. Shape errors are
    reported by ``okf_v02_violations``; this helper simply returns no cited path
    for malformed rows so coverage can never fail open.
    """
    fm, _, error = parse_okf_frontmatter(md_text)
    if error or fm is None:
        return [], False, False
    has_key = "sources" in fm
    derived = fm.get("derived") is True
    resources: list[str] = []
    raw_sources = fm.get("sources")
    if isinstance(raw_sources, list):
        for item in raw_sources:
            if not isinstance(item, dict):
                continue
            resource = item.get("resource")
            if not isinstance(resource, str):
                continue
            if _explicit_managed_source(resource):
                entry = _norm_source_entry(resource)
                if entry:
                    resources.append(entry)
                continue
            if _explicit_external_source(resource):
                continue
            # Clean v0.2 packages use an explicit managed namespace. Preserve
            # the old bare-path dialect only when it exactly identifies a Raw
            # inventory entry; every other value is an OKF scope descriptor.
            if managed_sources is not None:
                entry = _norm_source_entry(resource)
                if entry in managed_sources:
                    resources.append(entry)
    return resources, derived, has_key


def candidate_pages(
    workdir: str,
    additional_managed_sources: set[str] | None = None,
) -> dict[str, dict]:
    """Parse every candidate/**/*.md page's provenance. Keyed by path relative
    to candidate/ (posix). Unreadable pages are reported as parse errors, not
    skipped silently."""
    cand = Path(workdir) / "candidate"
    pages: dict[str, dict] = {}
    if not cand.is_dir():
        return pages
    managed_sources = set(source_inventory(workdir))
    # A deleted Raw source is absent from today's inventory by definition, but
    # incremental dependency lookup still has to recognize legacy bare-path
    # citations to it. Callers that hold an authoritative change set may extend
    # the compatibility inventory narrowly; arbitrary external OKF resources
    # remain outside Siclaw's managed Raw namespace.
    if additional_managed_sources:
        managed_sources.update(
            entry
            for raw in additional_managed_sources
            if (entry := _norm_source_entry(raw))
        )
    for f in sorted(cand.rglob("*.md")):
        rel = f.relative_to(cand).as_posix()
        try:
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            pages[rel] = {"sources": [], "derived": False, "has_sources": False,
                          "error": f"unreadable: {e}"}
            continue
        sources, derived, has_key = parse_okf_sources(text, managed_sources)
        try:
            raw_bytes = f.stat().st_size
        except OSError:
            raw_bytes = len(text.encode("utf-8"))
        # bytes = ON-DISK size, matching the sync gate's f.stat().st_size — the
        # decoded text under-measures CRLF pages (read_text translates newlines),
        # so an encode()-based lint could pass a page the sync then skips (review).
        pages[rel] = {"sources": sources, "derived": derived,
                      "has_sources": has_key, "text": text, "bytes": raw_bytes}
    return pages


def _strip_trailing_commas(text: str) -> str:
    """Drop STRUCTURAL trailing commas — a comma whose next non-whitespace
    character is ``}`` or ``]`` AND that sits OUTSIDE any JSON string.

    String-aware by construction (the old regex `,\\s*(?=[}\\]])` was not): a
    comma inside a value like a pattern ``"a,].md"`` or a reason
    ``"literal ,} marker"`` is preserved — only the structural slip a model
    hand-editing the ledger keeps making is removed. Walks the text tracking
    in-string / escape state; the closing-container lookahead reads the original
    (unmodified) tail, so whitespace and brackets after the comma are exact."""
    out: list[str] = []
    in_string = False
    escape = False
    n = len(text)
    for i, ch in enumerate(text):
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            continue
        if ch == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "}]":
                continue  # structural trailing comma → drop
            out.append(ch)
            continue
        out.append(ch)
    return "".join(out)


def _parse_exclusions_tolerant(text: str):
    """Strict JSON parse with ONE mechanical fallback: stripping structural
    trailing commas (`},]` / `,}`), the exact slip a model hand-editing the
    ledger keeps making. Returns (data, repaired) or (None, False) when even the
    repaired text does not parse — anything beyond this one deterministic fix is a
    real corruption a human/model must look at, not something to guess at."""
    try:
        return json.loads(text), False
    except json.JSONDecodeError:
        pass
    try:
        return json.loads(_strip_trailing_commas(text)), True
    except json.JSONDecodeError:
        return None, False


def load_exclusions(workdir: str) -> tuple[list[dict], list[str]]:
    """Read authoring/EXCLUSIONS.json → (entries, errors). Missing file is fine
    (no exclusions declared yet). A trailing-comma slip is tolerated on READ so
    one hand-edit typo cannot blank the whole ledger (2026-07-24 live incident:
    every previously excluded source went "unaccounted" at once) — but it still
    surfaces as an error so the lint/repair loop gets the file fixed on disk.
    Anything less mechanical stays a hard parse error."""
    path = Path(workdir) / EXCLUSIONS_PATH
    if not path.is_file():
        return [], []
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return [], [f"{EXCLUSIONS_PATH} unreadable: {e}"]
    data, repaired = _parse_exclusions_tolerant(raw)
    if data is None:
        return [], [f"{EXCLUSIONS_PATH} unreadable/invalid JSON"]
    errors_prefix = (
        [f"{EXCLUSIONS_PATH} has a trailing-comma JSON slip (tolerated for accounting; please fix the file)"]
        if repaired else []
    )
    if not isinstance(data, list):
        return [], errors_prefix + [f"{EXCLUSIONS_PATH} must be a JSON array"]
    entries, errors = [], list(errors_prefix)
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
    stripped, matching how sources[].resource values are normalized), and globbing is
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
_SPECIAL_SOURCE_NAME_PATTERN = (
    r"(?:^|/)"
    r"(?:"
    + "|".join(sorted(re.escape(name) for name in TEXT_SOURCE_BASENAMES))
    + r"|(?:"
    + "|".join(sorted(re.escape(prefix) for prefix in TEXT_SOURCE_PREFIXES))
    + r")(?:\.[A-Za-z0-9_.-]+)?"
    r")"
)
_SOURCE_FILE_END_RE = re.compile(
    r"(?:\.(?:" + "|".join(sorted(e[1:] for e in KNOWN_SOURCE_EXTS))
    + r")|" + _SPECIAL_SOURCE_NAME_PATTERN
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


def _is_frontmatter_start(line: str) -> bool:
    """A document marker must begin at column zero; trailing spaces are OK."""
    return re.fullmatch(r"---[ \t]*", line.rstrip("\r\n")) is not None


def _is_frontmatter_end(line: str) -> bool:
    """Recognize only top-level document markers, never block-scalar content."""
    return re.fullmatch(r"(?:---|\.\.\.)[ \t]*", line.rstrip("\r\n")) is not None


def parse_okf_frontmatter(md_text: str) -> tuple[dict | None, str, str | None]:
    """Parse an OKF YAML frontmatter block with a real YAML parser.

    Returns (mapping-or-None, body, error-or-None). A missing block is distinct
    from an invalid block so the repair prompt can tell the compiler exactly
    what to fix. `yaml.safe_load` is deliberate: candidate metadata is tenant
    authored input and must never construct arbitrary Python objects.
    """
    lines = md_text.splitlines()
    if not lines or not _is_frontmatter_start(lines[0]):
        return None, md_text, "missing YAML frontmatter at the start of the file"
    end = next((i for i, line in enumerate(lines[1:], start=1)
                if _is_frontmatter_end(line)), None)
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
    if lines and _is_frontmatter_start(lines[0]):
        offset = len(lines[0])
        for line in lines[1:]:
            offset += len(line)
            if _is_frontmatter_end(line):
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
    """Validate the reserved OKF index shape for a v0.2 bundle.

    OKF permits an optional version declaration only on the bundle-root index;
    when present here it must target v0.2. Siclaw's producer profile separately
    requires the declaration and file-relative links on newly authored output.
    """
    violations: list[dict] = []
    fm, body, error = parse_okf_frontmatter(text)
    if rel == "index.md":
        if error and text.splitlines() and _is_frontmatter_start(text.splitlines()[0]):
            violations.append({"page": rel, "kind": "okf_index_frontmatter",
                               "detail": f"根 index.md 的 YAML frontmatter 无效: {error}"})
            body = text
        elif not error and (set(fm or {}) != {"okf_version"}
              or not isinstance((fm or {}).get("okf_version"), str)
              or (fm or {}).get("okf_version") != "0.2"):
            violations.append({"page": rel, "kind": "okf_index_frontmatter",
                               "detail": "根 index.md frontmatter 必须且只能包含 okf_version: \"0.2\""})
        elif error:
            # OKF makes index.md optional and its root version declaration MAY;
            # Siclaw's producer profile below requires that declaration.
            body = text
    else:
        # A nested index has no frontmatter. A malformed block is still a block,
        # so detect the delimiter directly instead of treating its parse error as
        # equivalent to correctly absent frontmatter.
        if text.splitlines() and _is_frontmatter_start(text.splitlines()[0]):
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
    if text.splitlines() and _is_frontmatter_start(text.splitlines()[0]):
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


def _valid_okf_actor(value: object) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    actor = value.strip()
    if actor.startswith(("human:", "process:")):
        return len(actor.split(":", 1)[1].strip()) > 0
    producer, sep, version = actor.partition("/")
    return bool(sep and producer.strip() and version.strip())


_RFC3339_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def _valid_iso_datetime(value: object) -> bool:
    if isinstance(value, datetime):
        return value.tzinfo is not None and value.utcoffset() is not None
    if not isinstance(value, str) or not value.strip():
        return False
    raw = value.strip()
    if not _RFC3339_DATETIME_RE.fullmatch(raw):
        return False
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00").replace(",", "."))
        return parsed.tzinfo is not None and parsed.utcoffset() is not None
    except ValueError:
        return False


def _valid_okf_date(value: object) -> bool:
    if isinstance(value, date) and not isinstance(value, datetime):
        return True
    if not isinstance(value, str):
        return False
    try:
        datetime.strptime(value.strip(), "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _valid_usage_window(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    start, end = value.get("from"), value.get("to")
    if not _valid_okf_date(start) or not _valid_okf_date(end):
        return False
    return str(start) <= str(end)


def _valid_nonnegative_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _valid_resource_mapping(value: object, *, receipt: bool = False) -> bool:
    if not isinstance(value, dict):
        return False
    resource = value.get("resource")
    if not isinstance(resource, str) or not resource.strip():
        return False
    if receipt and "receipt" in value:
        fields = value.get("receipt")
        if (not isinstance(fields, list) or not fields
                or any(not isinstance(field, str) or not field.strip() for field in fields)):
            return False
    return True


def _has_inline_computation(body: str) -> bool:
    """Return whether a Computation section contains a complete code fence."""
    headings = list(re.finditer(
        r"(?m)^(#{1,6})[ \t]+Computation(?:[ \t]+#*)?[ \t]*$", body,
    ))
    for heading in headings:
        level = len(heading.group(1))
        end = len(body)
        for following in re.finditer(r"(?m)^(#{1,6})[ \t]+.+$", body[heading.end():]):
            if len(following.group(1)) <= level:
                end = heading.end() + following.start()
                break
        section = body[heading.end():end]
        opened: tuple[str, int] | None = None
        for line in section.splitlines():
            match = re.match(r"^[ \t]{0,3}(`{3,}|~{3,})(.*)$", line)
            if not match:
                continue
            fence = match.group(1)
            marker = fence[0]
            if opened is None:
                opened = (marker, len(fence))
            elif marker == opened[0] and len(fence) >= opened[1] and not match.group(2).strip():
                return True
    return False


def _okf_v02_metadata_violations(rel: str, fm: dict, body: str) -> list[dict]:
    """Validate the optional v0.2 families when a producer emits them."""
    violations: list[dict] = []
    if "sources" in fm:
        raw_sources = fm.get("sources")
        if not isinstance(raw_sources, list):
            violations.append({"page": rel, "kind": "okf_sources",
                               "detail": "OKF v0.2 sources 必须是 mapping 列表"})
        else:
            seen_ids: set[str] = set()
            for i, source in enumerate(raw_sources):
                if not isinstance(source, dict):
                    violations.append({"page": rel, "kind": "okf_sources",
                                       "detail": f"sources[{i}] 必须是 mapping"})
                    continue
                resource = source.get("resource")
                if not isinstance(resource, str) or not resource.strip():
                    violations.append({"page": rel, "kind": "okf_sources",
                                       "detail": f"sources[{i}].resource 必须是非空字符串"})
                source_id = source.get("id")
                if source_id is not None:
                    if not isinstance(source_id, str) or not source_id.strip():
                        violations.append({"page": rel, "kind": "okf_sources",
                                           "detail": f"sources[{i}].id 必须是非空字符串"})
                    elif source_id in seen_ids:
                        violations.append({"page": rel, "kind": "okf_sources",
                                           "detail": f"sources id 重复: {source_id}"})
                    else:
                        seen_ids.add(source_id)
                if ("author" in source and (not isinstance(source.get("author"), str)
                                             or not source.get("author", "").strip())):
                    violations.append({"page": rel, "kind": "okf_sources",
                                       "detail": f"sources[{i}].author 必须是非空字符串"})
                if "usage_count" in source and not _valid_nonnegative_count(source.get("usage_count")):
                    violations.append({"page": rel, "kind": "okf_sources",
                                       "detail": f"sources[{i}].usage_count 必须是非负整数"})
                if "last_modified" in source and not _valid_okf_date(source.get("last_modified")):
                    violations.append({"page": rel, "kind": "okf_sources",
                                       "detail": f"sources[{i}].last_modified 必须是 YYYY-MM-DD"})
                if "usage_window" in source and not _valid_usage_window(source.get("usage_window")):
                    violations.append({"page": rel, "kind": "okf_sources",
                                       "detail": f"sources[{i}].usage_window 必须包含合法且有序的 from/to 日期"})
                if ("usage_count" in source and "usage_window" not in source
                        and "usage_window" not in fm):
                    violations.append({"page": rel, "kind": "okf_sources",
                                       "detail": f"sources[{i}].usage_count 必须由来源级或顶层 usage_window 界定"})

    if "usage_window" in fm and not _valid_usage_window(fm.get("usage_window")):
        violations.append({"page": rel, "kind": "okf_usage_window",
                           "detail": "usage_window 必须包含合法且有序的 YYYY-MM-DD from/to 日期"})

    if "generated" in fm:
        generated = fm.get("generated")
        if not isinstance(generated, dict) or not _valid_okf_actor(generated.get("by")):
            violations.append({"page": rel, "kind": "okf_generated",
                               "detail": "generated.by 必须使用 OKF actor 约定"})
        elif "at" in generated and not _valid_iso_datetime(generated.get("at")):
            violations.append({"page": rel, "kind": "okf_generated",
                               "detail": "generated.at 必须是 RFC 3339 datetime"})

    if "verified" in fm:
        verified = fm.get("verified")
        events = verified if isinstance(verified, list) else [verified]
        if not events or any(not isinstance(event, dict)
                             or not _valid_okf_actor(event.get("by"))
                             or not _valid_iso_datetime(event.get("at"))
                             for event in events):
            violations.append({"page": rel, "kind": "okf_verified",
                               "detail": "verified 必须是含合法 by/at 的 mapping 或 mapping 列表"})

    status = fm.get("status")
    if "status" in fm and status not in ("draft", "stable", "deprecated"):
        violations.append({"page": rel, "kind": "okf_status",
                           "detail": "status 只能是 draft、stable 或 deprecated"})
    if "stale_after" in fm:
        if not _valid_okf_date(fm.get("stale_after")):
            violations.append({"page": rel, "kind": "okf_stale_after",
                               "detail": "stale_after 必须是 YYYY-MM-DD"})
    if fm.get("type") == "Attested Computation":
        runtime = fm.get("runtime")
        if not isinstance(runtime, str) or not runtime.strip():
            violations.append({"page": rel, "kind": "okf_attested_computation",
                               "detail": "Attested Computation 必须声明非空 runtime"})
        if "parameters" in fm:
            parameters = fm.get("parameters")
            if (not isinstance(parameters, list)
                    or any(not isinstance(item, dict)
                           or not isinstance(item.get("name"), str) or not item.get("name", "").strip()
                           or not isinstance(item.get("type"), str) or not item.get("type", "").strip()
                           or not isinstance(item.get("required"), bool)
                           for item in parameters)):
                violations.append({"page": rel, "kind": "okf_attested_computation",
                                   "detail": "parameters 必须是含 name/type/required 的 mapping 列表"})
        computation = fm.get("computation")
        has_path = isinstance(computation, str) and bool(computation.strip())
        if "computation" in fm and not has_path:
            violations.append({"page": rel, "kind": "okf_attested_computation",
                               "detail": "computation 必须是非空路径或 URI"})
        has_inline = _has_inline_computation(body)
        if has_path == has_inline:
            violations.append({"page": rel, "kind": "okf_attested_computation",
                               "detail": "Attested Computation 必须且只能通过 computation 路径或正文 Computation fence 提供计算内容"})
        if "executor" in fm and not _valid_resource_mapping(fm.get("executor"), receipt=True):
            violations.append({"page": rel, "kind": "okf_attested_computation",
                               "detail": "executor 必须包含非空 resource，receipt 如存在须为非空字符串列表"})
        if "attester" in fm and not _valid_resource_mapping(fm.get("attester")):
            violations.append({"page": rel, "kind": "okf_attested_computation",
                               "detail": "attester 必须包含非空 resource"})
    return violations


class ProvenanceStampError(RuntimeError):
    """The runtime cannot update machine provenance without risking user YAML."""


def _yaml_node_ids(node: yaml.Node) -> set[int]:
    found = {id(node)}
    if isinstance(node, yaml.MappingNode):
        for key, value in node.value:
            found.update(_yaml_node_ids(key))
            found.update(_yaml_node_ids(value))
    elif isinstance(node, yaml.SequenceNode):
        for value in node.value:
            found.update(_yaml_node_ids(value))
    return found


def _remove_yaml_spans(text: str, spans: list[tuple[int, int]]) -> str:
    for start, end in sorted(spans, reverse=True):
        text = text[:start] + text[end:]
    return text


def _yaml_terminal_end(node: yaml.Node) -> int:
    """Last concrete token in a node, excluding comments before the next key.

    PyYAML extends a collection node's end mark through inter-key comments. A
    byte-splice based on that mark would delete an owner's comment together
    with the machine-owned value. Descend to scalar tokens instead.
    """
    if isinstance(node, yaml.MappingNode) and node.value:
        return max(_yaml_terminal_end(child) for pair in node.value for child in pair)
    if isinstance(node, yaml.SequenceNode) and node.value:
        return max(_yaml_terminal_end(child) for child in node.value)
    return node.end_mark.index


def siclaw_generated_metadata_text(
    rel: str,
    text: str,
    *,
    created: bool = False,
    now: datetime | None = None,
) -> str | None:
    """Return provenance-stamped bytes without mutating the source file.

    ``None`` means the page cannot be safely stamped and should remain for the
    normal OKF lint to reject or repair. Keeping this transformation pure lets
    workspace sync sanitize an in-flight snapshot without racing the model's
    file writer.
    """
    if _is_reserved_page(rel) or not rel.endswith(".md"):
        return None
    stamp_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    stamp = stamp_time.isoformat(timespec="seconds").replace("+00:00", "Z")
    lines = text.splitlines(keepends=True)
    if not lines or not _is_frontmatter_start(lines[0]):
        return None
    end = next((i for i, line in enumerate(lines[1:], start=1)
                if _is_frontmatter_end(line)), None)
    if end is None:
        return None
    frontmatter = "".join(lines[1:end])
    try:
        fm = yaml.safe_load(frontmatter)
        root = yaml.compose(frontmatter, Loader=yaml.SafeLoader)
    except yaml.YAMLError:
        return None
    if not isinstance(fm, dict) or not isinstance(root, yaml.MappingNode):
        return None
    if root.flow_style:
        raise ProvenanceStampError(
            f"{rel}: top-level flow YAML cannot be provenance-stamped losslessly")

    pairs: list[tuple[str, yaml.Node, yaml.Node]] = []
    seen: set[str] = set()
    for key_node, value_node in root.value:
        key = key_node.value
        if key in seen:
            raise ProvenanceStampError(
                f"{rel}: duplicate top-level YAML key {key!r} is ambiguous")
        seen.add(key)
        pairs.append((key, key_node, value_node))

    remove_keys = {"generated", "verified"}
    add_stable = created and fm.get("status") is None
    if add_stable and "status" in fm:
        remove_keys.add("status")

    # Anchors may live on keys as well as values. Include both halves or
    # removing an anchored machine key can leave an undefined retained alias.
    removed_nodes = [node for key, key_node, value in pairs if key in remove_keys
                     for node in (key_node, value)]
    retained_nodes = [node for key, key_node, value in pairs if key not in remove_keys
                      for node in (key_node, value)]
    removed_ids = set().union(*(_yaml_node_ids(node) for node in removed_nodes)) if removed_nodes else set()
    retained_ids = set().union(*(_yaml_node_ids(node) for node in retained_nodes)) if retained_nodes else set()
    if removed_ids & retained_ids:
        raise ProvenanceStampError(
            f"{rel}: a retained YAML alias depends on machine-owned provenance")

    spans: list[tuple[int, int]] = []
    for key, key_node, value_node in pairs:
        if key not in remove_keys:
            continue
        start = key_node.start_mark.index - key_node.start_mark.column
        finish = max(_yaml_terminal_end(key_node), _yaml_terminal_end(value_node))
        line_end = frontmatter.find("\n", finish)
        if line_end < 0:
            line_end = len(frontmatter)
        # Delete the machine field's final physical line (and an inline comment
        # on that field), but not a following standalone owner comment.
        finish = line_end + (1 if line_end < len(frontmatter) else 0)
        spans.append((start, finish))

    preserved = _remove_yaml_spans(frontmatter, spans)
    newline = "\r\n" if "\r\n" in text else "\n"
    if preserved and not preserved.endswith(("\n", "\r")):
        preserved += newline
    indent = " " * min((key.start_mark.column for _, key, _ in pairs), default=0)
    inserted = []
    if add_stable:
        inserted.append(f"{indent}status: stable{newline}")
    inserted.extend([
        f"{indent}generated:{newline}",
        f"{indent}  by: process:siclaw-kbc{newline}",
        f"{indent}  at: '{stamp}'{newline}",
    ])
    return lines[0] + preserved + "".join(inserted) + lines[end] + "".join(lines[end + 1:])


def stamp_siclaw_generated_metadata(
    workdir: str,
    changed_pages: set[str],
    *,
    new_pages: set[str] | None = None,
    now: datetime | None = None,
) -> list[str]:
    """Deterministically bind changed concept bytes to the Siclaw producer.

    The model cannot be the authority for its own provenance. Every concept it
    creates or changes is re-signed here, and any verification of the previous
    bytes is removed. Unknown frontmatter keys and the Markdown body survive.
    Invalid frontmatter is left untouched for the normal OKF lint to repair.
    """
    candidate = Path(workdir) / "candidate"
    created = new_pages or set()
    pending: list[tuple[Path, str, str]] = []
    for rel in sorted(changed_pages):
        target = candidate / rel
        if not target.is_file():
            continue
        try:
            text = target.read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rewritten = siclaw_generated_metadata_text(
            rel, text, created=rel in created, now=now)
        if rewritten is None or rewritten == text:
            continue
        pending.append((target, rel, rewritten))
    written: list[str] = []
    for target, rel, rewritten in pending:
        _write_text_atomic(target, rewritten)
        written.append(rel)
    return written


def stamp_siclaw_generated_metadata_best_effort(
    workdir: str,
    changed_pages: set[str],
    *,
    new_pages: set[str] | None = None,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, str]]]:
    """Stamp independent pages while reporting lossless-rewrite blockers.

    Filesystem errors still surface. Only deterministic YAML-shape blockers are
    converted into page-scoped repair findings so one malformed page cannot
    poison every batch retry or suppress stamps on unrelated pages.
    """
    written: list[str] = []
    failures: list[dict[str, str]] = []
    created = new_pages or set()
    for rel in sorted(changed_pages):
        try:
            written.extend(stamp_siclaw_generated_metadata(
                workdir,
                {rel},
                new_pages={rel} if rel in created else set(),
                now=now,
            ))
        except ProvenanceStampError as error:
            failures.append({"page": rel, "detail": str(error)})
    return written, failures


def okf_v02_violations(pages: dict[str, dict]) -> list[dict]:
    """OKF v0.2 core conformance plus emitted optional-family shape checks."""
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
        fm, body, error = parse_okf_frontmatter(text)
        if error:
            violations.append({"page": rel, "kind": "okf_frontmatter",
                               "detail": error})
            continue
        type_value = (fm or {}).get("type")
        if not isinstance(type_value, str) or not type_value.strip():
            violations.append({"page": rel, "kind": "okf_type",
                               "detail": "OKF concept frontmatter requires a non-empty string type"})
        violations.extend(_okf_v02_metadata_violations(rel, fm or {}, body))

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
                               "detail": "Siclaw 根 index.md 必须声明 okf_version: \"0.2\""})
        if not _is_reserved_page(rel):
            fm, _, error = parse_okf_frontmatter(text)
            if error or fm is None:
                continue
            if "verified" in fm:
                violations.append({"page": rel, "kind": "siclaw_profile_verified",
                                   "detail": "编译 Agent 不得自写 verified；验证事件由确定性系统或人工流程记录"})
    return violations


def format_policy_violations(pages: dict[str, dict]) -> list[dict]:
    """All OKF-core and Siclaw-profile violations for authoring enforcement."""
    return okf_v02_violations(pages) + siclaw_portable_output_violations(pages)


def okf_import_violations(pages: dict[str, dict]) -> list[dict]:
    """Contract for importing an already-compiled Wiki into Siclaw.

    This is deliberately narrower than the producer profile: imported pages
    may contain legitimate human verification records, wikilinks, or
    bundle-root links. It is also narrower than the authoring lint's body-style
    checks. The import boundary requires the frontmatter contract Sicore can
    persist and inspect, plus an explicit root ``okf_version: "0.2"`` marker.
    Keep this selection aligned with Sicore's ``validateAdoptionOKFStructure``.
    """
    violations = [
        violation for violation in okf_v02_violations(pages)
        if violation.get("kind") not in {"okf_index_structure", "okf_log_structure"}
    ]
    violations.extend(
        violation for violation in siclaw_portable_output_violations(pages)
        if violation.get("kind") == "siclaw_profile_version_declaration"
    )
    return violations


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
    if not lines or not _is_frontmatter_start(lines[0]):
        return text
    for i, line in enumerate(lines[1:], start=1):
        if _is_frontmatter_end(line):
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
        # Keep compatibility with the optional Markdown link-title form.
        titled = re.fullmatch(
            r"(.+?\.md(?:#[^\s\"']*)?)\s+(?:\"[^\"]*\"|'[^']*')",
            destination,
            re.IGNORECASE,
        )
        if titled:
            destination = titled.group(1)
        # After the title strip so a quoted title is never mistaken for the
        # angle destination's trailing fragment (same ordering + rationale as
        # document_link_targets — an anchored `<...>#sec` link must not keep
        # its brackets and get misreported as an orphaned page).
        destination = _unwrap_angle_destination(destination)
        destination = unquote(destination).split("#", 1)[0].strip()
        if destination.lower().endswith(".md"):
            targets.append(destination)
    return targets


def _unwrap_angle_destination(destination: str) -> str:
    """Unwrap a CommonMark angle-bracketed destination, tolerating a trailing
    ``#fragment``/``?query`` OUTSIDE the closing bracket (``<a b.png>#fig1``):
    the remainder is re-appended so the ordinary #/? truncation removes it.
    Previously the wrapper was only stripped when the destination *ended* in
    ``>``, so an anchored angle link kept its brackets and lost its edge — a
    good compile was wrongly failed (review finding). Runs AFTER the title
    strip (a quoted title is not a fragment) and BEFORE #/? truncation. Mirrors
    the sicore ledger's unwrapAngleDestination; change only in lockstep."""
    if destination.startswith("<"):
        close = destination.find(">")
        if close != -1:
            return destination[1:close].strip() + destination[close + 1:].strip()
    return destination


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
        titled = re.fullmatch(r"(.+?)\s+(?:\"[^\"]*\"|'[^']*')", destination)
        if titled:
            destination = titled.group(1).strip()
        destination = _unwrap_angle_destination(destination)
        destination = unquote(_strip_fragment_query(destination)).strip()
        if destination:
            targets.append(destination)
    for captured in _HTML_IMG_SRC_RE.findall(prose):
        destination = unquote(_strip_fragment_query(captured[1:-1])).strip()
        if destination:
            targets.append(destination)
    return targets


# An Office source lands in raw/ TWICE: the original bytes, and the readable
# `<name>.md` the compile box pre-renders beside it at install time. They are
# one source in two forms, not two sources — but only media assets had an
# attribution rule, so the rendering fell through to "must be cited or
# excluded" while the prompt tells the compiler to cite the ORIGINAL. A real
# run hit exactly that: the page cited `X.xlsx`, the ledger reported `X.xlsx.md`
# unaccounted, and the session spent a whole extra round rewriting its
# sources[].resource to the derived path — obeying the ledger by disobeying the
# prompt. Neither the check nor the prompt was wrong; the pair had no rule.
OFFICE_RENDER_EXTS = (".pptx", ".xlsx", ".docx")


def office_render_pairs(sources: list[str]) -> list[tuple[str, str]]:
    """(original, rendered) for every Office source whose sibling render is
    also in the inventory. Both directions matter downstream: whichever form a
    page cites, the other is the same source and is accounted with it."""
    present = set(sources)
    pairs = []
    for source in sources:
        if source.lower().endswith(OFFICE_RENDER_EXTS) and source + ".md" in present:
            pairs.append((source, source + ".md"))
    return sorted(pairs)


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


def document_attachment_edges(
    workdir: str, sources: list[str] | None = None,
) -> dict[str, list[str]]:
    """Map each raw ``.md`` document to EVERY attachment it embeds — images and
    non-image attachment files alike (notably `assets/sheets/*.md` placeholders
    holding an embedded spreadsheet's data).

    This is the batch planner's document-family input. It deliberately differs
    from ``asset_attribution_edges``:

    - that one answers a COVERAGE question and is narrowed to images, because
      auto-attaching a sheet placeholder would launder 'never compiled' into
      'covered' (§4.1). Widening it would be a fail-open regression.
    - this one answers a CO-LOCATION question — 'which files must be readable
      in the same batch as this document?' Splitting a document from its
      embedded spreadsheet costs real information (the batch that got the doc
      cannot read the table; the batch that got the table has no context), so
      here every embedded attachment counts.

    Only targets that live under an `assets` segment are edges: a plain relative
    link to a SIBLING DOCUMENT is cross-referencing, not attachment, and must not
    drag unrelated documents into one family."""
    sources = source_inventory(workdir) if sources is None else sources
    attachments = {s for s in sources if has_assets_segment(s)}
    raw = Path(workdir) / "raw"
    edges: dict[str, list[str]] = {}
    for doc in sources:
        if not doc.lower().endswith(".md") or doc in attachments:
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
            if resolved in attachments:
                hits.add(resolved)
        if hits:
            edges[doc] = sorted(hits)
    return edges


def orphan_media_assets(workdir: str, sources: list[str] | None = None) -> list[str]:
    """Media assets embedded by NO raw document — standalone wiki file nodes and
    other sync residue with no text home. Coverage v2 deliberately refuses to
    auto-attach them (a human must still see them), so without an exclusion row
    they stay unaccounted forever; the batch train pre-excludes them with a
    machine reason instead of demanding the model account for a bare image.

    An asset a candidate page cites DIRECTLY in its sources list is NOT an
    orphan: coverage v1 compatibility counts a directly-cited asset as accounted
    (see coverage()), so pre-excluding and pruning it at plan time would drop a
    source the ledger already accepts. Subtract both the document-embed edges and
    every asset a current candidate page cites."""
    sources = source_inventory(workdir) if sources is None else sources
    media = {s for s in sources if is_media_asset(s)}
    if not media:
        return []
    embedded: set[str] = set()
    for targets in asset_attribution_edges(workdir, sources).values():
        embedded.update(targets)
    cited: set[str] = set()
    for page in candidate_pages(workdir).values():
        cited.update(page.get("sources") or [])
    return sorted(media - embedded - cited)


def glob_escape_path(path: str) -> str:
    """Escape a literal path for use as an exclusion pattern. Exclusion patterns
    are segment-aware globs, and human titles legally contain `*`, `?`, `[` —
    without escaping, a machine-written exact-path row could silently swallow
    sibling files (the over-exclusion false-PASS)."""
    return re.sub(r"([*?\[])", r"[\1]", path)


def _valid_exclusion_row(item) -> bool:
    """A row the ledger ACCOUNTS with: a dict carrying both a non-empty pattern
    and a non-empty reason (same acceptance load_exclusions applies). An invalid
    row (e.g. a legacy ``{"pattern": "a.md"}`` with no reason) is skipped by load
    → its source stays unaccounted, so it must NOT shadow a real exclude_source
    call for the same pattern."""
    return bool(
        isinstance(item, dict) and item.get("pattern") and item.get("reason"))


def append_exclusions(workdir: str, entries: list[dict]) -> tuple[list[dict], str | None]:
    """Append machine-written exclusion rows, de-duplicated by pattern. Returns
    (rows actually added, error). A trailing-comma slip is repaired in place
    (model-authored rows preserved verbatim, file rewritten canonical) — the
    model hand-edits this ledger across hundreds of batches, so that typo WILL
    recur. Anything less mechanical leaves the file untouched and reports an
    explicit error: appending to a file we cannot parse risks destroying
    model-authored rows, and a silent no-op here once left batch sources
    neither cited nor excluded.

    De-duplication is against VALID rows only: an invalid legacy row that load
    skips (missing reason) must never make exclude_source(pattern, reason) a
    no-op — that left the pattern unaccounted forever with no path to fix it via
    the tool (the ONLY sanctioned write path). The append lands the valid row;
    the post-turn normalizer then prunes the now-redundant invalid duplicate."""
    path = Path(workdir) / EXCLUSIONS_PATH
    data: list = []
    if path.is_file():
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            return [], f"{EXCLUSIONS_PATH} unreadable: {e}"
        parsed, _ = _parse_exclusions_tolerant(raw)
        if parsed is None:
            return [], f"{EXCLUSIONS_PATH} is corrupted beyond the mechanical trailing-comma repair; machine exclusions were NOT written"
        if not isinstance(parsed, list):
            return [], f"{EXCLUSIONS_PATH} must be a JSON array; machine exclusions were NOT written"
        data = parsed
    have = {str(item["pattern"]) for item in data if _valid_exclusion_row(item)}
    added: list[dict] = []
    for e in entries:
        pattern = str(e.get("pattern") or "")
        reason = str(e.get("reason") or "")
        if not pattern or not reason or pattern in have:
            continue
        have.add(pattern)  # de-duplicate within this call, not just vs the file
        added.append({"pattern": pattern, "reason": reason})
    if not added:
        return [], None
    # Atomic (same-dir temp + os.replace): a kill mid-write must never truncate
    # the whole ledger. Canonical rewrite also heals a tolerated comma slip.
    _write_text_atomic(
        path, json.dumps(data + added, ensure_ascii=False, indent=2) + "\n")
    return added, None


def _read_exclusions_for_write(workdir: str) -> tuple[list | None, str]:
    """Shared read half of every tool-driven ledger mutation → (rows, error).
    Same tolerant parse + same refuse-rather-than-clobber contract as
    append_exclusions: a file we cannot parse is left untouched."""
    path = Path(workdir) / EXCLUSIONS_PATH
    if not path.is_file():
        return [], ""
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return None, f"{EXCLUSIONS_PATH} unreadable: {e}"
    parsed, _ = _parse_exclusions_tolerant(raw)
    if parsed is None:
        return None, f"{EXCLUSIONS_PATH} is corrupted beyond the mechanical trailing-comma repair; the ledger was NOT changed"
    if not isinstance(parsed, list):
        return None, f"{EXCLUSIONS_PATH} must be a JSON array; the ledger was NOT changed"
    return parsed, ""


def _write_exclusions_canonical(workdir: str, rows: list) -> None:
    """Atomic canonical rewrite (same-dir temp + os.replace): a kill mid-write
    must never truncate the machine-owned ledger."""
    _write_text_atomic(
        Path(workdir) / EXCLUSIONS_PATH,
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n")


REPO_META_PATH = "authoring/META.json"

# Admission ceiling for domain — mirrors compile_box.DOMAIN_MAX_CHARS /
# consumer_domain / agentbox catalog. The write path (report_domain) enforces
# it; the read path must too, because Write can bypass the tool and hand-edit
# META.json, and a multi-line / over-cap domain then inflates every directive
# that quotes it.
DOMAIN_MAX_CHARS = 100


def normalize_domain_line(raw: str | None, *, max_chars: int = DOMAIN_MAX_CHARS) -> str:
    """Collapse whitespace; refuse over-cap by returning empty (no mid-clip)."""
    if not isinstance(raw, str):
        return ""
    one = " ".join(raw.split())
    if not one or len(one) > max_chars:
        return ""
    return one


def write_repo_meta(workdir: str, domain: str) -> None:
    """Persist the library's domain line as a machine-owned artifact.

    Same rule as the exclusion ledger: the model supplies natural language and
    NOTHING else, the format is generated here. The 2026-07-24 mandate exists
    because a hand-authored trailing comma once blanked a ledger and wedged a
    145-batch train, and a field disclosed to every agent that can see this
    library is not the place to relax it.

    Rewritten whole, atomically. This is one value, not an append-only log — a
    later compile that renames the domain is correcting it, not adding to it.
    """
    _write_text_atomic(
        Path(workdir) / REPO_META_PATH,
        json.dumps({"domain": domain}, ensure_ascii=False, indent=2) + "\n")


def read_repo_meta(workdir: str) -> dict:
    """Best-effort read. A missing or unparseable file is an ABSENT domain, not
    an error: the library still compiles, publishes and answers questions
    without one — it is only harder for another agent to find.

    Over-cap or newline-forged values are omitted whole so a hand-written META
    cannot bypass the admission ceiling that report_domain enforces on write.
    """
    fp = Path(workdir) / REPO_META_PATH
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    domain = normalize_domain_line(data.get("domain"))
    return {"domain": domain} if domain else {}


def set_exclusion_reason(workdir: str, pattern: str, reason: str) -> tuple[str, str | None]:
    """Add an exclusion row, or CORRECT the reason of the existing one(s) for the
    same pattern → (status, error) with status in {"added", "updated", "unchanged"}.

    The lifecycle half the tool surface was missing: with append-only semantics a
    wrong reason could only be fixed by hand-editing the ledger, which the standing
    role prompt forbade — a mandate-3 deadlock (a prohibition with no legal path
    forward). Re-calling exclude_source with a better reason now IS the fix.

    Same de-duplication rule as append_exclusions: only VALID rows count as
    present, so a legacy row missing its reason never shadows a real call (the
    post-turn normalizer prunes the redundant invalid duplicate)."""
    data, err = _read_exclusions_for_write(workdir)
    if data is None:
        return "unchanged", err
    hits = [item for item in data
            if _valid_exclusion_row(item) and str(item["pattern"]) == pattern]
    if not hits:
        _write_exclusions_canonical(
            workdir, data + [{"pattern": pattern, "reason": reason}])
        return "added", None
    if all(str(item["reason"]) == reason for item in hits):
        return "unchanged", None
    for item in hits:
        item["reason"] = reason
    _write_exclusions_canonical(workdir, data)
    return "updated", None


def remove_exclusions(workdir: str, patterns: list[str]) -> tuple[int, str | None]:
    """Drop every row whose pattern is EXACTLY one of `patterns` → (rows removed,
    error). Exact string match, never glob evaluation: removing by "what this
    pattern happens to match" would silently take out neighbouring rows.

    The delete half of the ledger lifecycle. Callers pass several spellings of the
    same intent (the glob-escaped exact path AND the verbatim string) so a wrong
    row written by hand — the shape the tools could not previously express — is
    still removable with a tool call instead of another hand edit."""
    wanted = {p for p in patterns if p}
    if not wanted:
        return 0, None
    data, err = _read_exclusions_for_write(workdir)
    if data is None:
        return 0, err
    kept = [item for item in data
            if not (isinstance(item, dict) and item.get("pattern")
                    and str(item["pattern"]) in wanted)]
    removed = len(data) - len(kept)
    if removed:
        _write_exclusions_canonical(workdir, kept)
    return removed, None


def exclusion_patterns(workdir: str) -> list[str]:
    """Every pattern string currently in the ledger, valid rows or not — the
    candidate set a remove-by-pattern close-match hint is drawn from."""
    data, _ = _read_exclusions_for_write(workdir)
    if not data:
        return []
    return [str(item["pattern"]) for item in data
            if isinstance(item, dict) and item.get("pattern")]


def normalize_exclusions_file(workdir: str) -> str | None:
    """Restore the exclusion ledger to canonical form after a model turn.

    The ledger is MACHINE-OWNED, but the escape hatch stays OPEN (stability-first
    mandate): the model is steered to the exclude_source tool, yet may hand-edit
    the file when the tool cannot express a fix. This normalizer is the
    enforcement backstop that makes that safe — every parseable row survives
    verbatim, mechanical slips (trailing commas) are absorbed, a redundant invalid
    duplicate is pruned (see _valid_exclusion_row), and the canonical atomic
    rewrite guarantees a strictly-parseable file at rest after every turn.

    Call sites that make "after every turn" true: compile_box._drive_batch_session's
    finally (every batch map/reduce/final/repair sub-session) and
    compile_box._post_turn_selfcheck's head (every interactive/flat compile turn).
    Returns an error string only when the file is corrupted beyond the mechanical
    repair (left untouched for a human/model to inspect)."""
    path = Path(workdir) / EXCLUSIONS_PATH
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return f"{EXCLUSIONS_PATH} unreadable: {e}"
    data, repaired = _parse_exclusions_tolerant(raw)
    if data is None or not isinstance(data, list):
        return f"{EXCLUSIONS_PATH} is corrupted beyond the mechanical repair"
    # Prune an invalid row (missing reason) ONLY when a valid row already covers
    # its pattern — that invalid duplicate is dead weight load already ignores.
    # An invalid row that is the ONLY row for its pattern is KEPT: pruning it
    # would silently drop the pattern; load surfaces it as an error for a human.
    valid_patterns = {str(item["pattern"]) for item in data if _valid_exclusion_row(item)}
    kept = [
        item for item in data
        if _valid_exclusion_row(item)
        or not (isinstance(item, dict) and item.get("pattern")
                and str(item["pattern"]) in valid_patterns)
    ]
    canonical = json.dumps(kept, ensure_ascii=False, indent=2) + "\n"
    if repaired or raw != canonical:
        # Atomic: a torn write would truncate the machine-owned ledger.
        _write_text_atomic(path, canonical)
    return None


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
    ``sources[].resource`` alias is rewritten. Mixed lists, arbitrary prose, and
    duplicate stems remain lint failures for semantic repair. Code fences and
    inline code are masked by ``_body_source_payload_spans``. When supplied,
    ``allowed_pages`` keeps incremental byte-isolation intact.
    """
    candidate = Path(workdir) / "candidate"
    fixes: list[dict[str, str]] = []
    if not candidate.is_dir():
        return fixes
    managed_sources = set(source_inventory(workdir))
    for path in sorted(candidate.rglob("*.md")):
        rel = path.relative_to(candidate).as_posix()
        if allowed_pages is not None and rel not in allowed_pages:
            continue
        try:
            text = path.read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        sources, _, _ = parse_okf_sources(text, managed_sources)
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
        if not _is_reserved_page(rel) and not page["has_sources"] and not page["derived"]:
            violations.append({"page": rel, "kind": "no_provenance",
                               "detail": "frontmatter 缺 OKF v0.2 sources(纯综合页请标 derived: true)"})
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
        # sources[].resource (basename match tolerated: bodies usually cite the
        # basename, resource carries the raw-relative path).
        cf_full = set(page["sources"])
        cf_names = {posixpath.basename(s) for s in cf_full}
        body_sources, malformed_sources = _body_source_references(text)
        for f in body_sources:
            if f in cf_full or posixpath.basename(f) in cf_names:
                continue
            violations.append({"page": rel, "kind": "body_source_uncited",
                               "detail": f"正文引用 (source: {f}) 但该文件不在本页 sources[].resource——补登记或修正引用"})
        for item in malformed_sources:
            violations.append({"page": rel, "kind": "body_source_malformed",
                               "detail": (f"正文来源标注无法解析为带扩展名的源文件: (source: {item})"
                                          "——保留与 sources[].resource 一致的完整文件名和扩展名")})
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
    page pairs with the same (normalized) title, or with heavy source overlap
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


def detect_over_broad_exclusions(workdir: str, exclusions: list[dict]) -> list[dict]:
    """Exclusion patterns that swallow a large share of the corpus — a `**` bomb
    or an over-broad prefix, almost always a mistake that launders 'never
    compiled' into 'accounted'. Flags any single pattern matching >25% of the raw
    inventory AND >5 sources, sorted by pattern, as [{"pattern", "matched"}].

    DETECTION ONLY (stability-first mandate: never prevention): the caller surfaces
    it loudly in the self-check narration/repair prompt so a human narrows it; it is
    never auto-removed and never blocks the train. Kept OUT of coverage() on purpose
    — coverage is the accounting contract mirrored byte-for-byte by sicore's
    adoption ledger; this is a box-side compile heuristic, not part of that ledger.

    Counts DISTINCT sources per pattern, never row hits: the ledger legitimately
    carries duplicate valid rows (the normalizer prunes only redundant INVALID
    ones), so a legacy or hand-edited file with the same pattern twice used to
    double-count — 3 matched sources of 20 reported as 6, a false over-broad flag
    on a perfectly narrow exclusion."""
    sources = source_inventory(workdir)
    if not sources:
        return []
    matched: dict[str, set[str]] = {}
    for s in sources:
        for e in exclusions:
            if _matches(s, e["pattern"]):
                matched.setdefault(e["pattern"], set()).add(s)
    return [
        {"pattern": p, "matched": len(matched[p])}
        for p in sorted(matched)
        if len(matched[p]) > 5 and len(matched[p]) > 0.25 * len(sources)
    ]


def coverage(workdir: str, pages: dict[str, dict], exclusions: list[dict]) -> dict:
    """The ledger (coverage v2): raw inventory − sources[].resource union − exclusions
    − auto-attached media = unaccounted.

    v2 adds ONE accounting path (monotonic — it can only SHRINK unaccounted, so
    every v1-green library stays green): a media asset (image under `assets/`,
    see is_media_asset) embedded in the body of a document that is ITSELF
    accounted (cited or excluded) is auto-attached to that document and counts as
    accounted. Media assets are the document's attachments, not first-class
    sources — so `sources` no longer needs a row per image and the
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
    # An Office original and its pre-rendered sibling are one source in two
    # forms: accounting either accounts both. Reported as its own bucket for the
    # same reason auto-attach is — an accounting path nobody can see is a
    # fail-open dressed as a pass.
    #
    # This runs BEFORE auto-attach, and that order is load-bearing: the images a
    # deck embeds live under `<name>.pptx.assets/` and are embedded by the
    # RENDER, while the playbook has the model cite the ORIGINAL. Resolve the
    # pair second and the render is not yet an accounted document, so its images
    # auto-attach to nothing and the model is handed a pile of orphans to excuse
    # by hand — which is exactly what it did. One pass suffices and no fixpoint
    # is needed: office_render_pairs only ever matches Office extensions and
    # is_media_asset only ever matches image extensions, so a pair member can
    # never arrive via `auto`.
    render_edges = sorted(
        (partner, owner)
        for original, rendered in office_render_pairs(sources)
        for owner, partner in ((original, rendered), (rendered, original))
        if owner in (cited | excluded) and partner not in (cited | excluded)
    )
    derived = {partner for partner, _ in render_edges}
    media_assets = {s for s in source_set if is_media_asset(s)}
    accounted_docs = cited | excluded | derived
    edges = asset_attribution_edges(workdir, sources)
    auto_edges = sorted(
        (asset, doc)
        for doc, assets in edges.items() if doc in accounted_docs
        for asset in assets
        if asset in media_assets and asset not in cited and asset not in excluded
    )
    auto = {asset for asset, _ in auto_edges}
    accounted = cited | excluded | auto | derived
    unaccounted = sorted(source_set - accounted)
    dangling = sorted(cited - source_set)
    code_fields = {}
    if knowledge_type(workdir) == "code":
        components: dict[str, list[str]] = {}
        for source in sources:
            component = code_component(source)
            # Media remains ordinary provenance when cited, but a repository's
            # screenshots/icons must not manufacture architecture components.
            if is_media_asset(source):
                continue
            components.setdefault(component, []).append(source)

        covered_components: list[str] = []
        excluded_components: list[str] = []
        uncovered_components: list[dict] = []
        representatives: list[str] = []
        for component, members in sorted(components.items()):
            if any(member in cited for member in members):
                covered_components.append(component)
                continue
            if all(member in accounted for member in members):
                excluded_components.append(component)
                continue
            remaining = sorted(member for member in members if member not in accounted)
            representative = remaining[0]
            representatives.append(representative)
            uncovered_components.append({
                "component": component,
                "representative": representative,
                "unaccounted_files": len(remaining),
                "total_files": len(members),
            })
        # The existing repair/batch machinery consumes source paths. Expose one
        # deterministic representative per uncovered component while retaining
        # the full component receipt for owners and tests.
        unaccounted = representatives
        code_fields = {
            "profile": "code",
            "total_components": len(components),
            "covered_components": len(covered_components),
            "excluded_components": len(excluded_components),
            "unaccounted_components": uncovered_components,
            # Kept for response-schema compatibility. Code profile v1 silently
            # dropped generated/vendored roots here; v2 accounts every root and
            # requires explicit EXCLUSIONS.json receipts instead.
            "ignored_sources": 0,
            "ignored_source_sample": [],
        }
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
        "office_renders": len(derived),
        "office_renders_sample": [{"source": partner, "via": owner}
                                  for partner, owner in render_edges[:20]],
        "unaccounted": unaccounted,
        "dangling_citations": dangling,
        "noop_exclusions": noop_exclusions,
        # closed = the ledger is consistent in BOTH directions: every source
        # accounted AND every citation real. dangling used to be display-only —
        # the repair prompt listed the fix, but the gate (ledger_clean) never
        # fired on it, so a lone dangling citation sailed through settle and
        # surfaced as owner homework on the publish page.
        "closed": not unaccounted and not dangling,
        **code_fields,
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
    over_broad = detect_over_broad_exclusions(workdir, exclusions)
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
        # Box-side compile heuristic (NOT part of the coverage accounting
        # contract): over-broad exclusion patterns flagged for a human, never
        # blocking. Report-level so coverage() stays byte-identical to sicore's.
        "over_broad_exclusions": over_broad,
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
    over_broad = report.get("over_broad_exclusions") or []
    auto = cov.get("auto_attached") or 0
    warn = ""
    if noop:
        warn = (f" ⚠ {len(noop)} exclusion(s) match no source — likely a typo" if en
                else f" ⚠ {len(noop)} 条排除未命中任何源——疑似写错")
    if over_broad:
        warn += (f" ⚠ {len(over_broad)} exclusion(s) look over-broad (each matches >25% of sources) — likely a mistake" if en
                 else f" ⚠ {len(over_broad)} 条排除疑似过宽(各命中超 25% 的源)——多半写错了")
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
                "page (new or merged) and register that source path in the page's frontmatter sources[].resource; "
                "(2) Exclude it — if it genuinely should not be compiled (meta files / live data / "
                "highly time-sensitive, etc.), call the exclude_source(path, reason) tool (the preferred, "
                "validated path — call it again with a better reason to CORRECT a row, and use "
                "remove_exclusion(path) to lift one). Directly editing authoring/EXCLUSIONS.json stays "
                "permitted as a last resort when no tool can express the fix, and the system "
                "re-normalizes the ledger after this turn either way.")
        if cov["dangling_citations"]:
            lines.append(f"\nsources[].resource cites nonexistent sources (dangling, {len(cov['dangling_citations'])}):")
            lines += [f"- {p}" for p in cov["dangling_citations"][:_REPAIR_LIST_CAP]]
            lines.append("Change them to real raw-relative paths.")
        if cov.get("noop_exclusions"):
            lines.append(f"\nExclusion patterns that matched NO source ({len(cov['noop_exclusions'])}) — likely a typo or wrong glob shape:")
            lines += [f"- {p}" for p in cov["noop_exclusions"][:_REPAIR_LIST_CAP]]
            lines.append("Matching is SEGMENT-aware: a bare `logs` matches only a file literally named logs; "
                         "`logs/*` matches only direct children; a whole subtree needs `logs/**` (or the `logs/` prefix form). Fix the pattern.")
        if report.get("over_broad_exclusions"):
            over_broad = report["over_broad_exclusions"]
            lines.append(f"\nExclusion patterns that look OVER-BROAD ({len(over_broad)}) — each swallows >25% of the corpus, likely a mistake that launders 'never compiled' into 'accounted':")
            lines += [f"- {ob['pattern']} — matches {ob['matched']} source(s)" for ob in over_broad[:_REPAIR_LIST_CAP]]
            lines.append("If that breadth is truly intended, keep it; otherwise narrow it or split it into per-source exclude_source calls with concrete reasons.")
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
            "并在该页 frontmatter 的 sources[].resource 登记该源路径;② 显式排除 — 确属不该编的(元文件/活数据/时效性强等),"
            "调用 exclude_source(path, reason) 工具(首选的、带校验的正路——同一 path 换新理由再调一次即【更正】该行,"
            "撤销一条豁免用 remove_exclusion(path))。仅当工具无法表达该修改时,才允许直接编辑 "
            "authoring/EXCLUSIONS.json 作为兜底——无论哪种,系统都会在本轮结束后重新规范化该账本。")
    if cov["dangling_citations"]:
        lines.append(f"\nsources[].resource 引用了不存在的源(悬空引用,{len(cov['dangling_citations'])} 处):")
        lines += [f"- {p}" for p in cov["dangling_citations"][:_REPAIR_LIST_CAP]]
        lines.append("请改成真实的 raw 相对路径。")
    if cov.get("noop_exclusions"):
        lines.append(f"\n没有命中任何源的排除模式({len(cov['noop_exclusions'])} 条)——多半是写错了:")
        lines += [f"- {p}" for p in cov["noop_exclusions"][:_REPAIR_LIST_CAP]]
        lines.append("匹配是按路径段的:裸 `logs` 只匹配名字恰为 logs 的文件;`logs/*` 只匹配直接子级;"
                     "整个子树要写 `logs/**`(或 `logs/` 前缀形式)。请修正模式。")
    if report.get("over_broad_exclusions"):
        over_broad = report["over_broad_exclusions"]
        lines.append(f"\n疑似过宽的排除模式({len(over_broad)} 条)——每条吞掉超 25% 的语料,多半是把'从没编过'洗成了'已入账':")
        lines += [f"- {ob['pattern']} — 命中 {ob['matched']} 个源" for ob in over_broad[:_REPAIR_LIST_CAP]]
        lines.append("若这个覆盖面确属有意,保留即可;否则请收窄,或拆成逐源的 exclude_source 调用并各写明理由。")
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
    sources[].resource cites a dangling path (they must be edited to fix or drop the
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
      1. direct sources image entries — an image cited directly;
      2. body ``(source: …)`` image citations — basename match tolerated;
      3. attribution-edge reverse lookup — a page that cites a DOCUMENT ``d`` in
         its sources list inherits the numeric check of every image ``d``
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
        # Path 3: images embedded by a document this page cites in sources.
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
