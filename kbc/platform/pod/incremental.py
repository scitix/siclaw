"""KB 增量重编 — box 侧确定性核心(DESIGN-kb-incremental-recompile-v2-2026-07-07).

现状 "请增量重编" 路由到全量批量重排(非增量)。本模块把它变成真增量的
box 半边:给定消费方机器算出的**变更源集**(added/modified/deleted),用
`sources[].resource`(= 官方 dependency index 的反向)**确定性反查受影响页**,拼出模型
只需消费的 `CHANGESET.json`,并提供收尾的**越界改动护栏**(未授权页字节不变)。

引擎中立:纯 filesystem + stdlib,复用 selfcheck 的 sources[].resource 解析。谁能编由
消费方的单飞锁裁(管控面);本模块只回答 "怎么增量编"(执行面)。

分工(见设计 §2):
  - 消费方 → 算 changed_sources(它有指纹基线 + 上次 raw 内容)+ 每个 modified 的 unified diff。
  - 本模块  → 反查 affected_pages、拼 CHANGESET、算护栏。
  - 模型    → 读 CHANGESET,按三类外科手术式改受影响页 + index,其余别碰。
"""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
from pathlib import Path

from selfcheck import (
    _is_en,
    candidate_pages,
    code_component,
    code_repository_roots,
    knowledge_type,
)

# 消费方 → box(管控面把机器算的变更交给执行面):变更源集 + 每个 modified 的 unified
# diff + 基线/快照指纹。box 读它、富集 affected_pages,再落下面的 CHANGESET(给模型)。
RAW_CHANGES_PATH = "authoring/RAW_CHANGES.json"
# box → 模型:富集后的完整 changeset(模型这一轮只消费这个)。
CHANGESET_PATH = "authoring/CHANGESET.json"
# 模型 → box:模型把 added 源并入了哪些现存页(供越界护栏放行,否则并入会被误判越界)。
# 用一个文件而非新 SDK 工具——模型写文件是它本来就会的动作,零协议扩张。
ADDED_TARGETS_PATH = "authoring/ADDED_TARGETS.json"

# CHANGESET is synced as one workspace artifact. Keep the default aligned with
# compile_box.MAX_SYNC_FILE_BYTES; deployments may lower the dedicated budget or
# the shared workspace cap. The serialized file (including indentation/newline)
# must fit, not just the sum of diff strings.
DEFAULT_CHANGESET_MAX_BYTES = 1024 * 1024

# index.md 是路由页(OKF 保留名),不由某个源"直接"决定,单独按 index_touched 处理;
# 它是护栏的合法可改页之一(页集变了要刷新它),永远不算 unaffected。
INDEX_PAGE = "index.md"


class ChangesetScopeTooLarge(ValueError):
    """Authoritative incremental scope cannot fit the durable artifact cap."""


# ── 反查:变更源 → 受影响页(sources[].resource 反向 = dependency index)──────────────
def _norm_source(path: str) -> str:
    """Normalize a source path to its canonical raw-relative posix form:
    posix separators, `./`/`//` collapsed (posixpath.normpath), and one leading
    `raw/` or `drop/` segment stripped — mirroring selfcheck's sources[].resource
    entry normalization, so both sides of a lookup land in the same namespace."""
    p = posixpath.normpath(path.replace("\\", "/")).lstrip("/")
    head, _, rest = p.partition("/")
    return rest if rest and head in ("raw", "drop") else p


def _pages_citing(pages: dict[str, dict], sources: set[str]) -> set[str]:
    """Candidate pages whose sources[].resource cites any source in `sources`.

    Matching guarantee: **full-path only**, after normalizing BOTH sides with
    `_norm_source` — never by basename. The normalization preserves the
    original leniency for prefix-form mismatches between the two sides
    (`raw/x/y.md` vs `x/y.md` refer to the same source), but cross-directory
    same-basename sources (`snap/config.md` vs `vendor/config.md`) stay
    distinct: a change to one can neither pull the other's pages into
    affected_pages nor authorize edits to them, so the post-turn byte-freeze
    guard keeps flagging genuine out-of-scope drift."""
    if not sources:
        return set()
    norm_sources = {_norm_source(s) for s in sources}
    hit: set[str] = set()
    for rel, page in pages.items():
        if rel == INDEX_PAGE or "error" in page:
            continue
        if {_norm_source(c) for c in page.get("sources", [])} & norm_sources:
            hit.add(rel)
    return hit


def _changed_managed_sources(changed_sources: dict) -> set[str]:
    return {
        str(source)
        for kind in ("modified", "deleted")
        for source in changed_sources.get(kind, [])
        if isinstance(source, str) and source
    }


def _page_indexes(
    pages: dict[str, dict], *, code_profile: bool,
    repository_roots: tuple[str, ...] = (),
) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """Build dependency and component reverse indexes once per operation."""
    source_pages: dict[str, set[str]] = {}
    component_pages: dict[str, set[str]] = {}
    for rel, page in pages.items():
        if rel == INDEX_PAGE or "error" in page:
            continue
        normalized_sources = {
            _norm_source(source)
            for source in page.get("sources", [])
            if isinstance(source, str) and source
        }
        for source in normalized_sources:
            source_pages.setdefault(source, set()).add(rel)
            if code_profile:
                component_pages.setdefault(
                    code_component(source, repository_roots), set()).add(rel)
    return source_pages, component_pages


def _pages_for_sources(
    workdir: str,
    pages: dict[str, dict],
    sources: set[str],
    *,
    code_profile: bool | None = None,
    source_pages: dict[str, set[str]] | None = None,
    component_pages: dict[str, set[str]] | None = None,
    repository_roots: tuple[str, ...] = (),
) -> set[str]:
    """Resolve exact dependency edges, widened to the component for code KBs.

    Architecture pages intentionally cite representative evidence rather than
    every source file. A changed sibling in the same component must therefore
    re-open pages that cite any member of that component; document KBs retain
    byte-for-byte exact-path behavior.
    """
    normalized_sources = {_norm_source(source) for source in sources}
    if source_pages is None:
        exact = _pages_citing(pages, normalized_sources)
    else:
        exact = {
            page
            for source in normalized_sources
            for page in source_pages.get(source, set())
        }
    if code_profile is None:
        code_profile = knowledge_type(workdir) == "code"
    if not code_profile or not normalized_sources:
        return exact
    changed_components = {
        code_component(source, repository_roots) for source in normalized_sources
    }
    if component_pages is not None:
        return exact | {
            page
            for component in changed_components
            for page in component_pages.get(component, set())
        }
    hit = set(exact)
    for rel, page in pages.items():
        if rel == INDEX_PAGE or "error" in page:
            continue
        page_components = {
            code_component(_norm_source(source), repository_roots)
            for source in page.get("sources", [])
        }
        if page_components & changed_components:
            hit.add(rel)
    return hit


def _resolve_affected_pages(
    workdir: str,
    pages: dict[str, dict],
    changed_sources: dict,
    *,
    code_profile: bool | None = None,
    source_pages: dict[str, set[str]] | None = None,
    component_pages: dict[str, set[str]] | None = None,
    repository_roots: tuple[str, ...] = (),
) -> tuple[list[str], list[str]]:
    all_pages = {rel for rel in pages if rel != INDEX_PAGE and "error" not in pages[rel]}
    touched = _changed_managed_sources(changed_sources)
    affected = _pages_for_sources(
        workdir,
        pages,
        touched,
        code_profile=code_profile,
        source_pages=source_pages,
        component_pages=component_pages,
        repository_roots=repository_roots,
    )
    return sorted(affected), sorted(all_pages - affected)


def resolve_affected_pages(workdir: str, changed_sources: dict) -> tuple[list[str], list[str]]:
    """(affected_pages, unaffected_pages)。

    affected = 引用了 **modified 或 deleted** 源的现存页(它们必须被更新/清理)。
    **added 源不在此** —— 它们还没有归属页(是"新料待安家",不是"某现存页被牵连"),
    由模型按官方 cascading-ingest 规则安置,单独在 CHANGESET 里列出。

    unaffected = 其余所有现存候选页(index 除外)。收尾护栏据此保证"其余不动"。
    """
    touched = _changed_managed_sources(changed_sources)
    pages = candidate_pages(workdir, additional_managed_sources=touched)
    code_profile = knowledge_type(workdir) == "code"
    repository_roots = code_repository_roots(workdir) if code_profile else ()
    source_pages, component_pages = _page_indexes(
        pages, code_profile=code_profile, repository_roots=repository_roots)
    return _resolve_affected_pages(
        workdir,
        pages,
        changed_sources,
        code_profile=code_profile,
        source_pages=source_pages,
        component_pages=component_pages,
        repository_roots=repository_roots,
    )


# ── 拼 CHANGESET(模型只消费,affected_pages 代码反查而非模型报)────────────────
def build_changeset(
    workdir: str,
    changed_sources: dict,
    *,
    diffs: dict[str, str] | None = None,
    summary: dict | None = None,
    baseline_fingerprint: str | None = None,
    snapshot_fingerprint: str | None = None,
) -> dict:
    """组装 CHANGESET.json 内容(调用方负责落盘 + 同步)。

    `diffs`: {源路径: 统一diff字符串},由消费方对每个 modified 源产出(旧→新);
    added/deleted 无 diff(added 是全新内容、deleted 只需移除)。缺省空 —— 无 diff
    时降级为"重读该源",仍是范围化的(只是没有 +/− 精度)。
    """
    diffs = diffs or {}
    # Per-source diff cap: an oversized diff degrades to "" (= the documented
    # "re-read the source" fallback — still scoped, just without +/− precision).
    # Uncapped diffs could push CHANGESET.json past the 1MB sync cap, where a
    # mid-round respawn could no longer rehydrate the round from the store
    # (RAW_CHANGES is consumed at materialization) — review finding.
    diff_cap = int(os.environ.get("KBC_MAX_DIFF_BYTES", str(64 * 1024)))
    supplied_diff_paths = {
        p for p, d in diffs.items()
        if isinstance(p, str) and isinstance(d, str) and d
    }
    diffs = {
        p: (d if len(d.encode("utf-8")) <= diff_cap else "")
        for p, d in diffs.items()
        if isinstance(p, str) and isinstance(d, str)
    }
    touched = _changed_managed_sources(changed_sources)
    pages = candidate_pages(workdir, additional_managed_sources=touched)
    added = list(changed_sources.get("added", []))
    modified = list(changed_sources.get("modified", []))
    deleted = list(changed_sources.get("deleted", []))
    code_profile = knowledge_type(workdir) == "code"
    repository_roots = code_repository_roots(workdir) if code_profile else ()
    source_pages, component_pages = _page_indexes(
        pages, code_profile=code_profile, repository_roots=repository_roots)
    affected, unaffected = _resolve_affected_pages(
        workdir,
        pages,
        changed_sources,
        code_profile=code_profile,
        source_pages=source_pages,
        component_pages=component_pages,
        repository_roots=repository_roots,
    )

    def pages_for(src: str) -> list[str]:
        return sorted(_pages_for_sources(
            workdir,
            pages,
            {src},
            code_profile=code_profile,
            source_pages=source_pages,
            component_pages=component_pages,
            repository_roots=repository_roots,
        ))

    changeset = {
        "version": 1,
        "baseline_fingerprint": baseline_fingerprint,   # 上次收敛的整区指纹(审计)
        "snapshot_fingerprint": snapshot_fingerprint,   # 本轮快照的整区指纹
        # 全新料:没有归属页,模型按 target_hint 级联编入相关页或建新页;coverage 护栏兜底。
        "added": [{
            "path": p,
            "content_ref": p,
            "target_hint": code_component(p, repository_roots) if code_profile else "",
        } for p in added],
        # 改动料:给受影响页 + 统一 diff(+/−),模型只改动到的那几处,不重写整页。
        "modified": [{"path": p, "affected_pages": pages_for(p), "diff": ""} for p in modified],
        # 删除料:从受影响页移除其内容/引用;页空则删页(index_touched)。
        "deleted": [{"path": p, "affected_pages": pages_for(p)} for p in deleted],
        "affected_pages": affected,          # 三类合并去重(modified+deleted 命中的现存页)
        "unaffected_pages": unaffected,      # 收尾护栏比对用
        "unaffected_pages_count": len(unaffected),
        "index_touched": bool(added or deleted),   # 页集可能变 → 需刷新 index.md
    }
    _fit_changeset_optional_payload(
        changeset, diffs, summary, supplied_diff_paths=supplied_diff_paths)
    return changeset


def _changeset_max_bytes() -> int:
    sync_value = int(os.environ.get("KBC_MAX_SYNC_FILE_BYTES", str(DEFAULT_CHANGESET_MAX_BYTES)))
    dedicated_raw = os.environ.get("KBC_MAX_CHANGESET_BYTES")
    dedicated_value = int(dedicated_raw) if dedicated_raw is not None else sync_value
    if sync_value <= 0 or dedicated_value <= 0:
        raise ValueError("CHANGESET and workspace sync byte limits must be positive")
    # A dedicated budget may reserve less space, but can never relax the actual
    # workspace transport limit that persists CHANGESET.json.
    return min(sync_value, dedicated_value)


def _serialized_changeset_size(changeset: dict) -> int:
    return len((json.dumps(changeset, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _fit_changeset_optional_payload(
    changeset: dict,
    diffs: dict[str, str],
    summary: dict | None,
    *,
    supplied_diff_paths: set[str] | None = None,
) -> None:
    """Fit optional diffs + logical hints under the durable artifact byte cap.

    Execution scope is authoritative and never silently truncated. If the full
    unaffected-page listing alone pushes the base over budget, retain its count
    and omit the redundant names (the byte guard derives authorization from
    affected_pages, not this display-only list). Diffs are then admitted in
    stable path order; omitted diffs retain the documented scoped re-read
    fallback. Logical hints use only the remaining budget and report omissions.
    """
    max_bytes = _changeset_max_bytes()
    if _serialized_changeset_size(changeset) > max_bytes:
        omitted = len(changeset.get("unaffected_pages", []))
        changeset["unaffected_pages"] = []
        if omitted:
            changeset["unaffected_pages_omitted"] = omitted
    if _serialized_changeset_size(changeset) > max_bytes:
        raise ChangesetScopeTooLarge(
            "incremental execution scope exceeds durable CHANGESET byte budget")

    modified_by_path = {
        item.get("path"): item
        for item in changeset.get("modified", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }
    supplied = set(supplied_diff_paths or ()) & set(modified_by_path)
    if supplied:
        # Reserve the marker before optional content is admitted. Otherwise a
        # budget-dropped diff is byte-for-byte indistinguishable from a producer
        # that supplied no diff at all.
        changeset["modified_diffs_omitted"] = len(supplied)
        if _serialized_changeset_size(changeset) > max_bytes:
            raise ChangesetScopeTooLarge(
                "incremental execution scope exceeds durable CHANGESET byte budget")

    compact_summary = _compact_change_summary(summary)
    logical_changes = []
    producer_omitted = 0
    if compact_summary:
        logical_changes = list(compact_summary.pop("logical_changes", []))
        producer_omitted = compact_summary.pop("logical_changes_omitted", 0)
        if producer_omitted:
            compact_summary["logical_changes_omitted"] = producer_omitted
        # Coverage is recomputed after the box's final byte-budget selection.
        compact_summary.pop("modified_with_diffs", None)
        compact_summary.pop("modified_without_diffs", None)
        changeset["change_summary"] = compact_summary

    retained_diffs = 0
    for path in sorted(diffs):
        diff = diffs[path]
        item = modified_by_path.get(path)
        if item is None or not diff:
            continue
        item["diff"] = diff
        if _serialized_changeset_size(changeset) > max_bytes:
            item["diff"] = ""
            continue
        retained_diffs += 1

    if compact_summary is not None:
        compact_summary["modified_with_diffs"] = retained_diffs
        compact_summary["modified_without_diffs"] = max(0, len(modified_by_path) - retained_diffs)
        # The two scalar counters are tiny, but a base exactly at the cap should
        # still sacrifice the last optional diff rather than exceed durability.
        while _serialized_changeset_size(changeset) > max_bytes and retained_diffs:
            for path in sorted(diffs, reverse=True):
                item = modified_by_path.get(path)
                if item is not None and item.get("diff"):
                    item["diff"] = ""
                    retained_diffs -= 1
                    compact_summary["modified_with_diffs"] = retained_diffs
                    compact_summary["modified_without_diffs"] = max(0, len(modified_by_path) - retained_diffs)
                    break
        if _serialized_changeset_size(changeset) > max_bytes:
            changeset.pop("change_summary", None)
            compact_summary = None

    if compact_summary is not None and logical_changes:
        accepted: list[dict] = []
        for change in logical_changes:
            accepted.append(change)
            compact_summary["logical_changes"] = accepted
            compact_summary["logical_changes_omitted"] = producer_omitted + len(logical_changes) - len(accepted)
            if _serialized_changeset_size(changeset) > max_bytes:
                accepted.pop()
                break
        if accepted:
            compact_summary["logical_changes"] = accepted
        else:
            compact_summary.pop("logical_changes", None)
        omitted = producer_omitted + len(logical_changes) - len(accepted)
        if omitted:
            compact_summary["logical_changes_omitted"] = omitted
        else:
            compact_summary.pop("logical_changes_omitted", None)
        if _serialized_changeset_size(changeset) > max_bytes:
            # The omitted counter itself can cross a byte-exact boundary when
            # the pre-hint payload sits at the cap. Logical hints are optional.
            compact_summary.pop("logical_changes", None)
            compact_summary.pop("logical_changes_omitted", None)

    omitted_supplied = max(0, len(supplied) - retained_diffs)
    if omitted_supplied:
        changeset["modified_diffs_omitted"] = omitted_supplied
    else:
        changeset.pop("modified_diffs_omitted", None)

    if _serialized_changeset_size(changeset) > max_bytes:
        raise AssertionError("CHANGESET byte fitting exceeded its durable limit")


def _compact_change_summary(summary: dict | None) -> dict | None:
    """Keep only bounded, model-useful source summary fields from the control plane.

    RAW_CHANGES remains a machine boundary, so an unexpected producer must not
    turn CHANGESET into an unbounded prompt payload. Opaque provider identities
    are intentionally not accepted here; primary paths and change kinds are the
    useful orientation signal for the compiler.
    """
    if not isinstance(summary, dict):
        return None

    out: dict = {}
    for key in (
        "physical_path_operations",
        "effective_path_operations",
        "ignored_canonical_noops",
        "logical_affected_sources",
        "logical_total_sources",
        "logical_changes_omitted",
        "modified_with_diffs",
        "modified_without_diffs",
    ):
        value = summary.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            out[key] = value

    allowed_kinds = {"added", "removed", "path_only", "content", "path_and_content"}
    changes: list[dict] = []
    raw_changes = summary.get("logical_changes")
    if isinstance(raw_changes, list):
        for raw in raw_changes[:100]:
            if not isinstance(raw, dict) or raw.get("change_kind") not in allowed_kinds:
                continue
            item = {"change_kind": raw["change_kind"]}
            for key in ("baseline_primary_path", "current_primary_path"):
                value = raw.get(key)
                if isinstance(value, str) and value:
                    item[key] = value[:1024]
            for key in ("baseline_files", "current_files"):
                value = raw.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    item[key] = value
            changes.append(item)
    if changes:
        out["logical_changes"] = changes
    return out or None


# ── 收尾护栏:未授权页字节不变(把"其余不动"从愿望变保证)────────────────────────
def page_hashes(workdir: str) -> dict[str, str]:
    """每个 candidate/**/*.md 的 sha256(rel → hex)。turn 前后各拍一次做越界检测。"""
    cand = Path(workdir) / "candidate"
    out: dict[str, str] = {}
    if not cand.is_dir():
        return out
    for f in sorted(cand.rglob("*.md")):
        if f.is_file():
            out[f.relative_to(cand).as_posix()] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def page_bytes(workdir: str) -> dict[str, bytes]:
    """每个 candidate/**/*.md 的原始 bytes(rel → bytes)。turn 前拍一次,给越界
    还原用:模型拿着 sha256 还原不出字节(重写永远不逐字节相等),曾让每次越界都
    必然耗尽回修额度落 unconverged;整库 markdown 也就 MB 级,快照换确定性。"""
    cand = Path(workdir) / "candidate"
    out: dict[str, bytes] = {}
    if not cand.is_dir():
        return out
    for f in sorted(cand.rglob("*.md")):
        if f.is_file():
            out[f.relative_to(cand).as_posix()] = f.read_bytes()
    return out


def restore_pages(workdir: str, before_bytes: dict[str, bytes], pages: list[str]) -> list[str]:
    """把越界页机械还原到 turn 前的字节(改动的写回、删掉的重建)。确定性、零模型
    参与 —— 能用代码修的违规不进回修 prompt。turn 前不存在的页(=新建页,不属于
    本护栏;或快照缺失)防御性跳过,留给回修指令兜底。返回实际还原的页。"""
    restored: list[str] = []
    cand = Path(workdir) / "candidate"
    for rel in pages:
        original = before_bytes.get(rel)
        if original is None:
            continue
        target = cand / rel
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(original)
        except OSError as e:
            # One unrestorable page (path became a directory, perm/IO error)
            # must not abort the rest: it stays an unrestored violation and
            # falls to the repair-prompt fallback, while every other page is
            # still restored (review finding: a mid-loop throw used to skip
            # the remaining restores AND the whole ledger pass).
            print(f"[incremental] restore {rel} failed, left for repair: {e!r}")
            continue
        restored.append(rel)
    return restored


def changed_pages(before: dict[str, str], after: dict[str, str]) -> dict[str, str]:
    """turn 前后有差异的页 → 变更类型(created/deleted/modified)。"""
    out: dict[str, str] = {}
    for rel in set(before) | set(after):
        b, a = before.get(rel), after.get(rel)
        if b == a:
            continue
        out[rel] = "created" if b is None else "deleted" if a is None else "modified"
    return out


def integrity_violations(
    before: dict[str, str], after: dict[str, str], editable_pages: set[str] | list[str]
) -> list[str]:
    """本轮实际改动了、但**不在授权可改集**内的页 —— 模型碰了范围外的东西。

    `editable_pages` = 授权可改集,由调用方(compile_box)算:
        affected_pages(modified/deleted 命中的现存页)
        ∪ 模型安置 added 源实际落笔的页(added-target,模型申报)
        ∪ {index.md}(页集变了要刷新)
    只守**现存页**:授权集之外的现存页被**改或删** = 越界(走回修"还原")。**新建页
    不算越界** —— 建新页是合法产出(added 源单独成页、或拆页),由 coverage 账本(源全
    覆盖)+ 孤儿 lint(必须挂进 index)兜底,不该被本护栏误判成"动了不该动的页"。确定
    性、逐字节,不靠模型自觉 —— 和 selfcheck 的 charset 一个路子。
    """
    editable = set(editable_pages) | {INDEX_PAGE}
    return sorted(
        rel
        for rel, kind in changed_pages(before, after).items()
        if kind != "created" and rel not in editable
    )


# ── 协议:消费方输入(RAW_CHANGES)→ box 输出(CHANGESET)──────────────────────
def load_raw_changes(workdir: str) -> dict | None:
    """读消费方写的增量输入 `authoring/RAW_CHANGES.json`。形状(消费方负责写):
        {"added":[路径], "modified":[路径], "deleted":[路径],
         "diffs": {路径: 统一diff}, "summary": {逻辑文档级摘要},
         "baseline_fingerprint":…, "snapshot_fingerprint":…}
    缺失/损坏/结构非法 → None(box 回退全量编译,向后兼容——消费方半边没跟上不崩)。
    """
    path = Path(workdir) / RAW_CHANGES_PATH
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    for k in ("added", "modified", "deleted"):
        if not isinstance(data.get(k, []), list):
            return None
    return data


def has_changes(raw: dict | None) -> bool:
    """真有变更源(空/None → 无,走全量,不走 scoped)。"""
    return bool(raw) and any(raw.get(k) for k in ("added", "modified", "deleted"))


def materialize_changeset(workdir: str) -> dict | None:
    """读 RAW_CHANGES → 富集 affected_pages → 落 `authoring/CHANGESET.json`(模型面)。
    返回 changeset;无有效变更 → None(调用方回退全量编译)。这是 box 侧 scoped 增量
    kickoff 的第一步:把"哪些源变"翻译成"哪些页要改 + 每处 +/− 上下文"。"""
    raw = load_raw_changes(workdir)
    if not has_changes(raw):
        return None
    try:
        cs = build_changeset(
            workdir,
            {"added": raw.get("added", []), "modified": raw.get("modified", []), "deleted": raw.get("deleted", [])},
            diffs=raw.get("diffs"),
            summary=raw.get("summary"),
            baseline_fingerprint=raw.get("baseline_fingerprint"),
            snapshot_fingerprint=raw.get("snapshot_fingerprint"),
        )
    except ChangesetScopeTooLarge:
        # The authoritative source/page scope cannot be truncated. Consume the
        # one-shot routing input and clear any stale scope so the caller takes
        # its documented full-compile fallback instead of retrying a permanent
        # 500 forever.
        (Path(workdir) / RAW_CHANGES_PATH).unlink(missing_ok=True)
        (Path(workdir) / CHANGESET_PATH).unlink(missing_ok=True)
        return None
    (Path(workdir) / CHANGESET_PATH).write_text(
        json.dumps(cs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Consume-once: drop the input so a later turn / box respawn can't re-route on a
    # stale changeset. The enriched CHANGESET.json remains for this turn's repair
    # rounds (they read it, not RAW_CHANGES). the consumer also clears it on baseline
    # advance — this is the box-side belt to that suspenders.
    try:
        (Path(workdir) / RAW_CHANGES_PATH).unlink()
    except OSError:
        pass
    return cs


def load_added_targets(workdir: str) -> list[str]:
    """模型申报的"我把 added 源并入了这些现存页"(authoring/ADDED_TARGETS.json,页名
    数组)。缺失/损坏 → [](护栏就更严,并入会被判越界 → 逼模型申报,fail-safe 方向对)。"""
    path = Path(workdir) / ADDED_TARGETS_PATH
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    return [str(x) for x in data] if isinstance(data, list) else []


def authorized_pages(workdir: str, changeset: dict) -> set[str]:
    """收尾护栏的"授权可改集":affected(modified/deleted 命中页)∪ 模型申报的 added
    落笔页 ∪ index。`integrity_violations` 用它当 editable_pages。"""
    return set(changeset.get("affected_pages", [])) | set(load_added_targets(workdir)) | {INDEX_PAGE}


def build_scoped_directive(changeset: dict, locale: str | None = None) -> str:
    """scoped 增量 turn 的 kickoff 指令。把机器算好的范围 + 三类规则交给模型;细节
    (每处 diff、受影响页)在 authoring/CHANGESET.json 里,让模型先读它。"""
    n_add = len(changeset.get("added", []))
    n_mod = len(changeset.get("modified", []))
    n_del = len(changeset.get("deleted", []))
    summary = changeset.get("change_summary") if isinstance(changeset.get("change_summary"), dict) else None
    if _is_en(locale):
        lines = [
            "[Incremental recompile] This round's changes were computed by code and written to"
            " authoring/CHANGESET.json. **Read it first**, then work strictly within scope:",
            f"· {n_mod} modified source(s) → open each one's affected_pages and **edit only the facts"
            " the diff (+/−) touches — do not rewrite whole pages**; if a diff is empty (not provided),"
            " re-read that source and update the related facts in its affected pages"
            " (still touching only those pages).",
            f"· {n_add} added source(s) → fold each into the most relevant existing page, or create a"
            " new page, per cascading-ingest; **if you merge into an existing page, you must append"
            " that page name to authoring/ADDED_TARGETS.json (a JSON array of page names)** —"
            " otherwise the closing integrity guard will flag it as out of scope.",
            f"· {n_del} deleted source(s) → remove that source's content/references from its"
            " affected_pages; if a page ends up empty, delete it.",
            "· If the page set changes (pages created/deleted) → refresh index.md.",
            # Domain is AI-maintained metadata anchored on the LATEST WHOLE library,
            # not on this round's diff alone and not on a human button. Page edits
            # stay scoped; domain maintenance is a separate obligation that always
            # re-reads the full catalog after those edits (index may have just moved).
            "· **Domain (AI-owned, whole-library anchor):** after the page work above,"
            " maintain authoring/META.json domain for other agents' routing."
            " **First read candidate/index.md in full** (every entry/description) —"
            " that catalog *after this round's edits* is the anchor, never the"
            " CHANGESET alone."
            " (1) **No domain yet → you MUST call report_domain once** with one"
            " sentence naming the field the finished library covers; a library with"
            " content and no domain is incomplete metadata, not a safe default."
            " (2) **Domain already present → re-judge against the full catalog plus"
            " this round's diff** (page-set change is not required). Rewrite via"
            " report_domain if it is empty of meaning, too narrow for the catalog,"
            " claims a capability this diff removed, or would make a router skip"
            " the library for a problem class this round added; same-theme adds,"
            " in-page fact fixes, slightly broad wording, or unsure → leave it."
            " One sentence, not a page list. Do not skip domain maintenance.",
            "· **Do not touch a single byte of any page outside affected_pages (plus your declared"
            " added-target pages and index)** — the closing guard compares per-page sha256 hashes,"
            " and any out-of-scope edit triggers a repair round."
            " (Reading index.md for domain is required; rewriting pages outside"
            " scope is still forbidden.)",
            "· Domain rulings follow constitution.md as usual; file a ticket for any new contradiction"
            " as usual. When done, briefly state which pages you changed and whether domain moved.",
        ]
        if summary:
            lines.insert(
                1,
                f"· Machine summary: {summary.get('logical_affected_sources', 0)} logical source document(s)"
                f" affected; {summary.get('ignored_canonical_noops', 0)} canonical no-op path change(s)"
                " were already removed. Use change_summary.logical_changes to orient by document;"
                f" {summary.get('modified_with_diffs', 0)} modified source(s) have surgical diffs and"
                f" {summary.get('modified_without_diffs', 0)} require a scoped source re-read. Use the"
                " path arrays and diffs below as the exact execution scope.",
            )
        return "\n".join(lines)
    lines = [
        "【增量重编】本轮变更已由代码算好,写在 authoring/CHANGESET.json。**先读它**,只做范围内的事:",
        f"· 改动源 {n_mod} 个 → 打开各自 affected_pages,**按 diff(+/−)只改动到的那几处事实,不重写整页**;"
        "若某条 diff 为空(未提供),就重读该源、对照更新受影响页里相关事实(仍只动这几页)。",
        f"· 新增源 {n_add} 个 → 按 cascading-ingest 编入最相关的现存页或建新页;**若并入某现存页,"
        "必须把该页名追加进 authoring/ADDED_TARGETS.json(页名数组)**,否则收尾护栏会当它越界。",
        f"· 删除源 {n_del} 个 → 从其 affected_pages 移除该源内容/引用;页因此清空则删页。",
        "· 页集若变(建/删页)→ 刷新 index.md。",
        # 领域是 AI 自维护、以「本轮改完后的最新整库」为锚;页编辑仍 scoped,领域维护另义务。
        "· **领域描述(AI 维护,整库锚点):** 上面的页工作做完后,维护 authoring/META.json 的 domain,"
        "给别的智能体做路由用。"
        "**先完整阅读本轮之后的 candidate/index.md**（每一条与 description）——锚点是**最新整库目录**,"
        "绝不是单靠 CHANGESET。"
        " (1) **还没有 domain → 必须调一次 report_domain**,用一句话说清整库领域;"
        "有内容却无领域是未完成元数据,不是安全默认。"
        " (2) **已有 domain → 对照完整目录 + 本轮 diff 再审**（不要求页集先变）。"
        "空泛、相对目录过窄、仍宣称本轮已删能力、或会让路由漏掉本轮新增问题类 → 才 report_domain 重写;"
        "同主题加页、只改事实、略宽、吃不准 → 保持。"
        "一句领域,不要列页。领域维护不许跳过。",
        "· **affected_pages(及你申报的 added 落笔页、index)之外的页,一个字节都别碰** —— 收尾逐页比对 sha256,碰了要回修。"
        "（为 domain **读** index.md 是必须的;改范围外正文仍禁止。）",
        "· 领域裁决照常按 constitution.md;遇新矛盾照走工单。改完简短说动了哪几页、domain 是否变了。",
    ]
    if summary:
        lines.insert(
            1,
            f"· 机器摘要：影响 {summary.get('logical_affected_sources', 0)} 个逻辑源文档，已过滤"
            f" {summary.get('ignored_canonical_noops', 0)} 个 canonical no-op 路径变化。先用"
            f" change_summary.logical_changes 按文档理解意图；{summary.get('modified_with_diffs', 0)} 个"
            f"改动源有外科式 diff，{summary.get('modified_without_diffs', 0)} 个需在限定范围内重读源；"
            "再以路径数组和 diff 作为精确执行范围。",
        )
    return "\n".join(lines)


_VIOLATION_CAP = 20


def build_integrity_repair(violations: list[str], locale: str | None = None) -> str:
    """越界回修指令:本轮改动了授权范围外的页(收尾逐页 sha256 比对发现)。要求模型把
    它们**还原到本轮开始前的内容**,只保留 affected_pages(+ 申报的 added 落笔页 + index)
    的改动。这让"其余不动"从愿望变成有回修闭环的硬约束。"""
    if _is_en(locale):
        shown = ", ".join(violations[:_VIOLATION_CAP])
        more = f" … {len(violations)} pages in total" if len(violations) > _VIOLATION_CAP else ""
        return (
            "[Incremental scope violation] This round you modified pages **outside the authorized"
            " set** (caught by the closing per-page sha256 comparison):\n"
            f"- {shown}{more}\n"
            "These pages were off-limits this round. **Restore each one to its content from before"
            " this round started**, keeping only the changes to CHANGESET.json's affected_pages"
            " (plus the added-target pages you declared in ADDED_TARGETS.json, plus index.md);"
            " do not \"improve\" out-of-scope pages along the way."
        )
    shown = "、".join(violations[:_VIOLATION_CAP])
    more = f" 等共 {len(violations)} 页" if len(violations) > _VIOLATION_CAP else ""
    return (
        "【增量越界】本轮你改动了**授权范围之外**的页(收尾逐页比对 sha256 发现):\n"
        f"- {shown}{more}\n"
        "这些页本轮不该被碰。请把它们**逐页还原到本轮开始前的内容**,只保留 CHANGESET.json 的 "
        "affected_pages(+ 你申报进 ADDED_TARGETS.json 的 added 落笔页 + index.md)那些改动;"
        "别顺手'改进'范围外的页。"
    )
