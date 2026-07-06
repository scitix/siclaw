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
import posixpath
import re
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
# calibration corpora are Chinese. Mirrors the real siclaw consumer (siclaw_main
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


def parse_compiled_from(md_text: str) -> tuple[list[str], bool, bool]:
    """Parse a candidate page's frontmatter.

    Returns (source_paths, derived, has_compiled_from). Tolerated entry forms:
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
                # block form (`compiled_from:` alone) opens the list; inline
                # `compiled_from: []` means key present with zero entries
                in_list = rest == ""
            elif key == "derived":
                derived = rest.lower() in ("true", "yes")
            continue
        if in_list:
            m = re.match(r"^\s*-\s*(.+?)\s*$", line)
            if m:
                entry = m.group(1).strip().strip("\"'").strip()
                if "·" in entry:
                    entry = entry.rsplit("·", 1)[1].strip()
                for prefix in ("raw/", "drop/"):
                    if entry.startswith(prefix):
                        entry = entry[len(prefix):]
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


def _matches(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):  # directory prefix form
        return path.startswith(pattern)
    return fnmatch.fnmatch(path, pattern)


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
    excluded = {s for s in sources if any(_matches(s, e["pattern"]) for e in exclusions)}
    unaccounted = sorted(source_set - cited - excluded)
    dangling = sorted(cited - source_set)
    return {
        "total_sources": len(sources),
        "cited": len(cited & source_set),
        "excluded": len(excluded),
        "unaccounted": unaccounted,
        "dangling_citations": dangling,
        "closed": not unaccounted,
    }


def candidate_tree_hash(workdir: str) -> str | None:
    """Content hash of candidate/**/*.md|.json (mirrors _pack_candidates_to_wiki's
    scheme) — the self-check idempotency key. None when there is no candidate tree."""
    cand = Path(workdir) / "candidate"
    if not cand.is_dir():
        return None
    h = hashlib.sha256()
    count = 0
    for f in sorted(cand.rglob("*")):
        if not f.is_file() or f.suffix not in (".md", ".json"):
            continue
        rel = f.relative_to(cand).as_posix()
        h.update(rel.encode()); h.update(b"\0"); h.update(f.read_bytes()); h.update(b"\0")
        count += 1
    return h.hexdigest() if count else None


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


def pack_candidates_to_wiki(workdir: str, dest: Path) -> tuple[str, int]:
    """Pin the current draft: copy {workdir}/candidate/*.md|.json into
    {dest}/.siclaw/knowledge/ with the `candidate/` prefix stripped
    (candidate/index.md → index.md), mirroring sicore's
    buildPublishBundleFromCandidates so a consumer reads BYTE-IDENTICALLY to
    what a publish would serve. Shared by user test sessions (compile_box) and
    the red-blue blue team (redblue.py). Returns (sha256 over sorted
    relpath+content, page_count). Raises FileNotFoundError if there are no
    candidate pages or no root index.md."""
    candidate = Path(workdir) / "candidate"
    kdir = dest / ".siclaw" / "knowledge"
    kdir.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    count = 0
    has_index = False
    for f in sorted(candidate.rglob("*")) if candidate.is_dir() else []:
        if not f.is_file() or f.suffix not in (".md", ".json"):
            continue
        rel = f.relative_to(candidate)
        if ".." in rel.parts:
            continue
        rel_posix = rel.as_posix()
        data = f.read_bytes()
        out = kdir / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        h.update(rel_posix.encode()); h.update(b"\0"); h.update(data); h.update(b"\0")
        count += 1
        if rel_posix == "index.md":
            has_index = True
    if count == 0:
        raise FileNotFoundError("no candidate pages to test yet — ask the authoring agent to generate pages first")
    if not has_index:
        raise FileNotFoundError("draft is missing candidate/index.md — cannot test without a root index page")
    return h.hexdigest(), count


def narration(report: dict) -> str:
    """One status line for the summary event stream (the only thing users see)."""
    cov, lint = report["coverage"], report["lint"]
    if report["state"] == "passed":
        return (f"自检(账本):闭合 ✓ — {cov['cited']} 源已编 / {cov['excluded']} 显式排除"
                f" / 共 {cov['total_sources']};lint 通过")
    parts = []
    if cov["unaccounted"]:
        parts.append(f"{len(cov['unaccounted'])} 个源文件未入账")
    if not lint["ok"]:
        parts.append(f"{len(lint['violations'])} 处 lint 问题")
    tail = "已请求回修" if report["state"] == "repairing" else "回修额度用尽,余项待负责人处理"
    return "自检(账本):" + "、".join(parts) + " — " + tail


def build_repair_prompt(report: dict) -> str:
    """The bounded repair turn injected by the driver. Speaks the BOX_ROLE
    contract language; lists concrete gaps, never vague exhortations."""
    cov, lint = report["coverage"], report["lint"]
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


def mark_media_verified(workdir: str, pages: list[str]) -> None:
    """Single write-point for the media_verify section (read-modify-write like
    update_pk_section, so L1 fields are never clobbered)."""
    report = read_selfcheck(workdir) or {"version": 1, "coverage": None, "lint": None, "state": None}
    mv = report.get("media_verify") or {}
    mv["verified_pages"] = sorted(set(mv.get("verified_pages") or []) | set(pages))
    mv["at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    report["media_verify"] = mv
    write_selfcheck(workdir, report)


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
