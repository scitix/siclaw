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

# Files considered "sources that need accounting". Binary media (images etc.)
# is out of scope for the ledger — pages digest media narratively; only text
# can be mechanically attributed.
TEXT_SOURCE_EXTS = {".md", ".txt", ".tsv", ".csv", ".json", ".jsonl", ".yaml", ".yml"}

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
    """All text source files under {workdir}/raw, as sorted posix paths
    relative to raw/. Hidden files/dirs (dot-prefixed) are skipped."""
    raw = Path(workdir) / "raw"
    if not raw.is_dir():
        return []
    out = []
    for f in raw.rglob("*"):
        if not f.is_file() or f.suffix.lower() not in TEXT_SOURCE_EXTS:
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
    `"<hash8> · <path>"`, surrounding quotes, and a raw/ or drop/ prefix."""
    entry = raw.strip().strip("\"'").strip()
    if "·" in entry:
        entry = entry.rsplit("·", 1)[1].strip()
    return _strip_source_prefix(entry.strip("\"'").strip())


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


def lint_candidate(pages: dict[str, dict], exclusion_errors: list[str]) -> dict:
    """Structural lint over the candidate tree: provenance presence, intra-wiki
    link resolution, plus exclusion-file errors. index.md is a routing page and
    exempt from the provenance requirement."""
    violations: list[dict] = []
    names = set(pages.keys())
    for rel, page in pages.items():
        if "error" in page:
            violations.append({"page": rel, "kind": "unreadable", "detail": page["error"]})
            continue
        if rel != "index.md" and not page["has_compiled_from"] and not page["derived"]:
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
    for err in exclusion_errors:
        violations.append({"page": EXCLUSIONS_PATH, "kind": "exclusions_invalid", "detail": err})
    return {"ok": not violations, "violations": violations}


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
        "closed": not unaccounted,
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
    """Compute the full Layer-1 report (coverage + lint). Pure except reading
    the previous SELFCHECK to carry the Layer-2 `pk` section forward — an L1
    re-check must never wipe red-blue results."""
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
        "pk": previous.get("pk"),  # Layer-2 results survive L1 re-checks
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
            "逐个二选一:① 补编 — 把该源内容编进相应 candidate 页(新增或并入),并在该页 frontmatter "
            "的 compiled_from 登记该源路径;② 显式排除 — 确属不该编的(元文件/活数据/时效性强等),"
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
