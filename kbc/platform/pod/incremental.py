"""KB 增量重编 — box 侧确定性核心(DESIGN-kb-incremental-recompile-v2-2026-07-07).

现状 "请增量重编" 路由到全量批量重排(非增量)。本模块把它变成真增量的
box 半边:给定 sicore 机器算出的**变更源集**(added/modified/deleted),用
`compiled_from`(= 官方 dependency index 的反向)**确定性反查受影响页**,拼出模型
只需消费的 `CHANGESET.json`,并提供收尾的**越界改动护栏**(未授权页字节不变)。

引擎中立:纯 filesystem + stdlib,复用 selfcheck 的 compiled_from 解析。谁能编由
sicore 的单飞锁裁(管控面);本模块只回答 "怎么增量编"(执行面)。

分工(见设计 §2):
  - sicore  → 算 changed_sources(它有指纹基线 + 上次 raw 内容)+ 每个 modified 的 unified diff。
  - 本模块  → 反查 affected_pages、拼 CHANGESET、算护栏。
  - 模型    → 读 CHANGESET,按三类外科手术式改受影响页 + index,其余别碰。
"""

from __future__ import annotations

import hashlib
import json
import posixpath
from pathlib import Path

from selfcheck import candidate_pages

# sicore → box(管控面把机器算的变更交给执行面):变更源集 + 每个 modified 的 unified
# diff + 基线/快照指纹。box 读它、富集 affected_pages,再落下面的 CHANGESET(给模型)。
RAW_CHANGES_PATH = "authoring/RAW_CHANGES.json"
# box → 模型:富集后的完整 changeset(模型这一轮只消费这个)。
CHANGESET_PATH = "authoring/CHANGESET.json"
# 模型 → box:模型把 added 源并入了哪些现存页(供越界护栏放行,否则并入会被误判越界)。
# 用一个文件而非新 SDK 工具——模型写文件是它本来就会的动作,零协议扩张。
ADDED_TARGETS_PATH = "authoring/ADDED_TARGETS.json"

# index.md 是路由页(OKF 保留名),不由某个源"直接"决定,单独按 index_touched 处理;
# 它是护栏的合法可改页之一(页集变了要刷新它),永远不算 unaffected。
INDEX_PAGE = "index.md"


# ── 反查:变更源 → 受影响页(compiled_from 反向 = dependency index)──────────────
def _pages_citing(pages: dict[str, dict], sources: set[str]) -> set[str]:
    """compiled_from 命中 `sources` 中任一源的候选页。既比 raw-相对全路径,也比
    basename(compiled_from 带 raw-相对路径,变更源集用同一形式,basename 容错是
    对齐 selfcheck 正文引用的宽松度,防两侧路径前缀写法不一致漏配)。"""
    if not sources:
        return set()
    src_basenames = {posixpath.basename(s) for s in sources}
    hit: set[str] = set()
    for rel, page in pages.items():
        if rel == INDEX_PAGE or "error" in page:
            continue
        cf = set(page.get("sources", []))
        if cf & sources or {posixpath.basename(c) for c in cf} & src_basenames:
            hit.add(rel)
    return hit


def resolve_affected_pages(workdir: str, changed_sources: dict) -> tuple[list[str], list[str]]:
    """(affected_pages, unaffected_pages)。

    affected = 引用了 **modified 或 deleted** 源的现存页(它们必须被更新/清理)。
    **added 源不在此** —— 它们还没有归属页(是"新料待安家",不是"某现存页被牵连"),
    由模型按官方 cascading-ingest 规则安置,单独在 CHANGESET 里列出。

    unaffected = 其余所有现存候选页(index 除外)。收尾护栏据此保证"其余不动"。
    """
    pages = candidate_pages(workdir)
    all_pages = {rel for rel in pages if rel != INDEX_PAGE and "error" not in pages[rel]}
    touched = set(changed_sources.get("modified", [])) | set(changed_sources.get("deleted", []))
    affected = _pages_citing(pages, touched)
    return sorted(affected), sorted(all_pages - affected)


# ── 拼 CHANGESET(模型只消费,affected_pages 代码反查而非模型报)────────────────
def build_changeset(
    workdir: str,
    changed_sources: dict,
    *,
    diffs: dict[str, str] | None = None,
    baseline_fingerprint: str | None = None,
    snapshot_fingerprint: str | None = None,
) -> dict:
    """组装 CHANGESET.json 内容(调用方负责落盘 + 同步)。

    `diffs`: {源路径: 统一diff字符串},由 sicore 对每个 modified 源产出(旧→新);
    added/deleted 无 diff(added 是全新内容、deleted 只需移除)。缺省空 —— 无 diff
    时降级为"重读该源",仍是范围化的(只是没有 +/− 精度)。
    """
    diffs = diffs or {}
    pages = candidate_pages(workdir)
    added = list(changed_sources.get("added", []))
    modified = list(changed_sources.get("modified", []))
    deleted = list(changed_sources.get("deleted", []))
    affected, unaffected = resolve_affected_pages(workdir, changed_sources)

    def pages_for(src: str) -> list[str]:
        return sorted(_pages_citing(pages, {src}))

    return {
        "version": 1,
        "baseline_fingerprint": baseline_fingerprint,   # 上次收敛的整区指纹(审计)
        "snapshot_fingerprint": snapshot_fingerprint,   # 本轮快照的整区指纹
        # 全新料:没有归属页,模型按 target_hint 级联编入相关页或建新页;coverage 护栏兜底。
        "added": [{"path": p, "content_ref": p, "target_hint": ""} for p in added],
        # 改动料:给受影响页 + 统一 diff(+/−),模型只改动到的那几处,不重写整页。
        "modified": [{"path": p, "affected_pages": pages_for(p), "diff": diffs.get(p, "")} for p in modified],
        # 删除料:从受影响页移除其内容/引用;页空则删页(index_touched)。
        "deleted": [{"path": p, "affected_pages": pages_for(p)} for p in deleted],
        "affected_pages": affected,          # 三类合并去重(modified+deleted 命中的现存页)
        "unaffected_pages": unaffected,      # 收尾护栏比对用
        "index_touched": bool(added or deleted),   # 页集可能变 → 需刷新 index.md
    }


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
    任何在此集合之外发生字节变化(改/新建/删除)的页 = 违规,走回修:"你动了不该动的
    页 X,请还原"。确定性、逐字节,不靠模型自觉 —— 和 selfcheck 的 charset 一个路子。
    """
    editable = set(editable_pages) | {INDEX_PAGE}
    return sorted(rel for rel in changed_pages(before, after) if rel not in editable)


# ── 协议:sicore 输入(RAW_CHANGES)→ box 输出(CHANGESET)──────────────────────
def load_raw_changes(workdir: str) -> dict | None:
    """读 sicore 写的增量输入 `authoring/RAW_CHANGES.json`。形状(sicore 负责写):
        {"added":[路径], "modified":[路径], "deleted":[路径],
         "diffs": {路径: 统一diff}, "baseline_fingerprint":…, "snapshot_fingerprint":…}
    缺失/损坏/结构非法 → None(box 回退全量编译,向后兼容——sicore 半边没跟上不崩)。
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
    cs = build_changeset(
        workdir,
        {"added": raw.get("added", []), "modified": raw.get("modified", []), "deleted": raw.get("deleted", [])},
        diffs=raw.get("diffs"),
        baseline_fingerprint=raw.get("baseline_fingerprint"),
        snapshot_fingerprint=raw.get("snapshot_fingerprint"),
    )
    (Path(workdir) / CHANGESET_PATH).write_text(
        json.dumps(cs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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


def build_scoped_directive(changeset: dict) -> str:
    """scoped 增量 turn 的 kickoff 指令。把机器算好的范围 + 三类规则交给模型;细节
    (每处 diff、受影响页)在 authoring/CHANGESET.json 里,让模型先读它。"""
    n_add = len(changeset.get("added", []))
    n_mod = len(changeset.get("modified", []))
    n_del = len(changeset.get("deleted", []))
    lines = [
        "【增量重编】本轮变更已由代码算好,写在 authoring/CHANGESET.json。**先读它**,只做范围内的事:",
        f"· 改动源 {n_mod} 个 → 打开各自 affected_pages,**按 diff(+/−)只改动到的那几处事实,不重写整页**。",
        f"· 新增源 {n_add} 个 → 按 cascading-ingest 编入最相关的现存页或建新页;**若并入某现存页,"
        "必须把该页名追加进 authoring/ADDED_TARGETS.json(页名数组)**,否则收尾护栏会当它越界。",
        f"· 删除源 {n_del} 个 → 从其 affected_pages 移除该源内容/引用;页因此清空则删页。",
        "· 页集若变(建/删页)→ 刷新 index.md。",
        "· **affected_pages(及你申报的 added 落笔页、index)之外的页,一个字节都别碰** —— 收尾逐页比对 sha256,碰了要回修。",
        "· 领域裁决照常按 constitution.md;遇新矛盾照走工单。改完简短说动了哪几页。",
    ]
    return "\n".join(lines)
