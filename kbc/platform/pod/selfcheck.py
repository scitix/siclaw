"""Layer-1 compile self-check: deterministic coverage ledger + structural lint.

Design: improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §8.1.
The completion criterion moves from "the model says it's done" to "code can
verify it": every raw text source must be either cited by a candidate page's
`compiled_from` frontmatter, or explicitly excluded (with a reason) in
`authoring/EXCLUSIONS.json`. Anything else is *unaccounted* — the exact
silent-miss failure mode observed in the 2026-07-03 one-shot compile study.

Engine-neutral by construction: pure filesystem analysis, stdlib only, no
Agent-SDK imports. Any compile driver (Claude SDK today, other engines later)
calls `run_layer1()` at its own turn boundary and pushes the returned repair
prompt through its own message seam.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import posixpath
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

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
# at index.md, whole pages, follow [[links]]. Max fidelity: do NOT tell it it's
# being tested.
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
        pages[rel] = {"sources": sources, "derived": derived,
                      "has_compiled_from": has_key, "text": text}
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


_MD_LINK_RE = re.compile(r"\]\(([^)#\s]+\.md)(?:#[^)]*)?\)")
_WIKI_LINK_RE = re.compile(r"\[\[([^\]|#]+)")
# Body-level provenance mentions: (source: X) / (源:X) / (来源:X). The capture
# is then mined for filename-looking tokens so locators ("§3", "p.12") and
# prose sources ("内部访谈") never false-positive.
_BODY_SOURCE_RE = re.compile(r"[（(]\s*(?:source|src|源|来源)\s*[:：]\s*([^）)]{1,300})[）)]", re.IGNORECASE)
_FILENAME_RE = re.compile(
    r"[^\s,;、；()（）'\"`]+\.(?:" + "|".join(sorted(e[1:] for e in KNOWN_SOURCE_EXTS)) + r")\b",
    re.IGNORECASE,
)
# OKF reserved routing pages: never provenance-required, never orphans.
_RESERVED_PAGES = {"index.md", "log.md"}


def _strip_frontmatter(text: str) -> str:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() in ("---", "..."):
            return "\n".join(lines[i + 1:])
    return text


def _body_source_files(text: str) -> list[str]:
    """Filenames cited in the body via (source:/源:/来源: …), raw//drop/ prefix
    and `<hash8> · ` decoration stripped."""
    found: list[str] = []
    for captured in _BODY_SOURCE_RE.findall(_strip_frontmatter(text)):
        for token in _FILENAME_RE.findall(captured):
            entry = token.strip()
            if "·" in entry:
                entry = entry.rsplit("·", 1)[1].strip()
            for prefix in ("raw/", "drop/"):
                if entry.startswith(prefix):
                    entry = entry[len(prefix):]
            if entry and entry not in found:
                found.append(entry)
    return found


def _out_links(rel: str, text: str, names: set[str]) -> set[str]:
    """Resolved intra-wiki edges out of one page (md links + wikilinks)."""
    base = Path(rel).parent
    out: set[str] = set()
    for target in _MD_LINK_RE.findall(text):
        if target.startswith(("http://", "https://", "/")):
            continue
        resolved = posixpath.normpath((base / target).as_posix())
        if resolved in names:
            out.add(resolved)
        elif target in names:
            out.add(target)
    for target in _WIKI_LINK_RE.findall(text):
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
    return sorted(names - reachable - _RESERVED_PAGES)


def lint_candidate(pages: dict[str, dict], exclusion_errors: list[str]) -> dict:
    """Structural lint over the candidate tree: provenance presence, intra-wiki
    link resolution, index reachability (orphans), body-citation hygiene, plus
    exclusion-file errors. index.md is a routing page and exempt from the
    provenance requirement."""
    violations: list[dict] = []
    names = set(pages.keys())
    for rel, page in pages.items():
        if "error" in page:
            violations.append({"page": rel, "kind": "unreadable", "detail": page["error"]})
            continue
        if rel not in _RESERVED_PAGES and not page["has_compiled_from"] and not page["derived"]:
            violations.append({"page": rel, "kind": "no_provenance",
                               "detail": "frontmatter 缺 compiled_from(纯综合页请标 derived: true)"})
        text = page.get("text", "")
        base = Path(rel).parent
        for target in _MD_LINK_RE.findall(text):
            if target.startswith(("http://", "https://", "/")):
                continue
            resolved = posixpath.normpath((base / target).as_posix())
            if resolved not in names and target not in names:
                violations.append({"page": rel, "kind": "broken_link", "detail": target})
        for target in _WIKI_LINK_RE.findall(text):
            t = target.strip()
            if t and f"{t}.md" not in names and t not in names:
                violations.append({"page": rel, "kind": "broken_wikilink", "detail": t})
        # Body cites (source: X.ext) → that file must be in THIS page's
        # compiled_from (basename match tolerated: bodies usually cite the
        # basename, compiled_from carries the raw-relative path).
        cf_full = set(page["sources"])
        cf_names = {posixpath.basename(s) for s in cf_full}
        for f in _body_source_files(text):
            if f in cf_full or posixpath.basename(f) in cf_names:
                continue
            violations.append({"page": rel, "kind": "body_source_uncited",
                               "detail": f"正文引用 (source: {f}) 但该文件不在本页 compiled_from——补登记或修正引用"})
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
        if rel in _RESERVED_PAGES or "error" in page:
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
    """The ledger: raw inventory − compiled_from union − exclusions = unaccounted."""
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
    unaccounted = sorted(source_set - cited - excluded)
    dangling = sorted(cited - source_set)
    return {
        "total_sources": len(sources),
        "cited": len(cited & source_set),
        "excluded": len(excluded),
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
    return {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "candidate_tree_hash": candidate_tree_hash(workdir),
        "coverage": cov,
        "lint": {"ok": lint["ok"], "violations": lint["violations"]},
        "dup_candidates": dup_candidates(pages),
        "pk": previous.get("pk"),  # Layer-2 results survive L1 re-checks
        "media_verify": previous.get("media_verify"),
    }


def write_selfcheck(workdir: str, report: dict) -> None:
    path = Path(workdir) / SELFCHECK_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
    warn = ""
    if noop:
        warn = (f" ⚠ {len(noop)} exclusion(s) match no source — likely a typo" if en
                else f" ⚠ {len(noop)} 条排除未命中任何源——疑似写错")
    if en:
        if report["state"] == "passed":
            return (f"Self-check (ledger): closed ✓ — {cov['cited']} sources compiled"
                    f" / {cov['excluded']} explicitly excluded / {cov['total_sources']} total; lint passed") + warn
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
                f" / 共 {cov['total_sources']};lint 通过") + warn
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
    """candidate page → sorted raw-relative image paths it digests, gathered
    from compiled_from entries AND body (source: …) citations. Basename match
    tolerated for body citations (bodies usually cite the bare filename)."""
    raw_images = [p for p in source_inventory(workdir)
                  if posixpath.splitext(p)[1].lower() in IMAGE_SOURCE_EXTS]
    by_basename: dict[str, list[str]] = {}
    for p in raw_images:
        by_basename.setdefault(posixpath.basename(p), []).append(p)
    raw_set = set(raw_images)
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
        if hits:
            out[rel] = sorted(hits)
    return out


def pending_media_verification(workdir: str) -> dict[str, list[str]]:
    """Image-citing pages minus the ones SELFCHECK.json records as verified."""
    citing = media_citing_pages(workdir)
    sc = read_selfcheck(workdir) or {}
    done = set((sc.get("media_verify") or {}).get("verified_pages") or [])
    return {p: imgs for p, imgs in citing.items() if p not in done}


def mark_media_verified(workdir: str, pages: list[str], exhausted: bool = False) -> None:
    """Single write-point for the media_verify section (read-modify-write like
    update_pk_section, so L1 fields are never clobbered). exhausted=True records
    the pages ALSO in media_verify.exhausted — verification kept failing past
    the attempt budget, so they ship unverified but VISIBLY flagged (fail-open
    must never read as a clean pass)."""
    report = read_selfcheck(workdir) or {"version": 1, "coverage": None, "lint": None, "state": None}
    mv = report.get("media_verify") or {}
    mv["verified_pages"] = sorted(set(mv.get("verified_pages") or []) | set(pages))
    if exhausted:
        mv["exhausted"] = sorted(set(mv.get("exhausted") or []) | set(pages))
    elif mv.get("attempts"):
        # A COMPLETED verification clears the page's retry count: a stale
        # residue would otherwise push a later re-entry (page re-cited after a
        # recompile) to "exhausted" after fewer real failures than the budget
        # implies — and the map stays bounded. Exhausted pages keep their count
        # as forensics (they are marked verified and never re-enter pending).
        for p in pages:
            mv["attempts"].pop(p, None)
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
    attempts = mv.get("attempts") or {}
    for p in pages:
        attempts[p] = int(attempts.get(p, 0)) + 1
    mv["attempts"] = attempts
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
