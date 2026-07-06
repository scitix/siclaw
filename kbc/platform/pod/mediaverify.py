"""Blind image transcription + mechanical claim comparison (图像复核 v2).

Replaces the prompt-only re-verification pass. Two live failures (2026-07-06/07)
proved the old shape — "re-open the image WITH the page's claims in context" —
is a confirmation check, not a check: any claim with a shadow in the image
passes ("87-96%" exists — in the MEM column; "H20" exists — in a different
screenshot). De-anchor by splitting perceive from judge:

  transcribe  (vision, fresh session, sees ONLY the image, never the page)
              → structured facts, cached per image content hash
  compare     (text-only, sees page text + transcripts, NEVER the image)
              → findings in two kinds:
                不一致       — the page contradicts the transcript (misread)
                超出转写范围 — the page cites this image for a claim the image
                              cannot support (hidden inference wearing a
                              source tag — the H20 case)

Deterministic code owns orchestration, caching and the repair prompt; models
only ever transcribe or compare. Engine-neutral: depends on
engine.ReadonlyAgentEngine only (same seam as redblue.py).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import selfcheck
from redblue import _agent_json  # JSON call + one lenient retry, shared shape

TRANSCRIPTS_PATH = "authoring/MEDIA_TRANSCRIPTS.json"
_TRANSCRIPT_CHAR_CAP = 6000  # per image, persisted


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _transcribe_model() -> str:
    return _env("KBC_MV_TRANSCRIBE_MODEL", "claude-sonnet-4-6")


def _compare_model() -> str:
    return _env("KBC_MV_COMPARE_MODEL", "claude-opus-4-6")


TRANSCRIBE_SYSTEM = """你是图像转写员。你只看眼前这一张图,把图里**可见**的信息转写成结构化 JSON。
铁则:图里没有的信息一个字都不要写(不要推断、不要补全、不要联想);读不清的值标 "不可读";
表格/监控截图的每个数值必须挂在它的列名下;柱状图/折线图必须先写出图例(颜色→系列)与坐标轴,
再逐柱/逐点转写,每个值标它属于哪个系列;N/A 或离线的行照原样记录。"""

TRANSCRIBE_USER = """用 Read 打开这张图并转写:{img}

只输出合法 JSON(不要其他文字),结构:
{{"chart_type": "表格/柱状图/折线图/界面截图/流程图/其他",
  "title_or_header": "图内可见的标题或表头,没有则 null",
  "legend": {{"系列名": "颜色描述", ...}} 或 null,
  "axes": "坐标轴含义与单位,没有则 null",
  "facts": [{{"label": "行/列/系列定位", "value": "可见值"}}, ...],
  "illegible": ["读不清的部分", ...],
  "notes": "其他可见要点(仍然只写图里有的)"}}"""

COMPARE_SYSTEM = """你是知识库图像断言的【比对员】。你看不到图片本身——只有另一位转写员产出的
结构化转写(它是图内可见信息的完整清单)和引用了该图的知识页正文。
你的任务:逐条核对页面里标注来源为这些图片的断言,只报两类问题:
- 不一致:断言与转写的值/归属冲突(如把显存列的数值写成利用率、把 P0 系列写成 P1);
- 超出转写范围:断言挂着该图的来源标注,但转写里根本没有能支撑它的信息
  (典型:图里没有型号名,页面却说"型号是 X"并引用该图——这是把推断伪装成带源事实)。
与转写一致的断言不要报;页面引用其他非图片来源的内容不归你管;拿不准算不算的,倾向于报出来让人裁。"""

COMPARE_USER = """知识页:{page}
页面全文:
--------
{page_text}
--------

该页引用的图片转写(转写员只看图产出,是图内可见信息的完整清单):
{transcripts_json}

只输出合法 JSON(不要其他文字):
{{"findings": [{{"image": "图片相对路径", "claim": "页面里的原断言(摘录)",
   "kind": "不一致" 或 "超出转写范围",
   "expected": "转写里的对应事实;超出范围时写「转写中无此信息」",
   "fix": "一句话修法(改成什么值 / 降级⚠️存疑+落工单 / 改挂正确来源)"}}]}}
没有问题就输出 {{"findings": []}}。"""


def _sha8(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


def load_transcripts(workdir: str) -> dict:
    p = Path(workdir) / TRANSCRIPTS_PATH
    if not p.is_file():
        return {}
    try:
        v = json.loads(p.read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def save_transcripts(workdir: str, cache: dict) -> None:
    p = Path(workdir) / TRANSCRIPTS_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cache, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


async def transcribe_image(engine, workdir: str, img_rel: str, cache: dict) -> dict | None:
    """One blind transcription, cached by image content hash (incremental
    recompiles re-verify for free). None on failure (caller records the error)."""
    img_path = Path(workdir) / "raw" / img_rel
    if not img_path.is_file():
        return None
    sha = _sha8(img_path)
    hit = cache.get(img_rel)
    if hit and hit.get("sha8") == sha and isinstance(hit.get("transcript"), dict):
        return hit["transcript"]
    raw_dir = str(Path(workdir) / "raw")
    data = await _agent_json(
        engine, stage="transcribe", system=TRANSCRIBE_SYSTEM,
        user=TRANSCRIBE_USER.format(img=f"raw/{img_rel}"),
        model=_transcribe_model(), cwd=raw_dir, roots=[raw_dir],
        timeout=float(_env("KBC_MV_TRANSCRIBE_TIMEOUT", "240")))
    if not isinstance(data, dict):
        return None
    if len(json.dumps(data, ensure_ascii=False)) > _TRANSCRIPT_CHAR_CAP:
        data = {"chart_type": data.get("chart_type"), "legend": data.get("legend"),
                "axes": data.get("axes"),
                "facts": (data.get("facts") or [])[:80],
                "notes": "(转写超长已截断)"}
    cache[img_rel] = {"sha8": sha, "transcript": data}
    return data


async def compare_page(engine, tmp_dir: str, page_rel: str, page_text: str,
                       transcripts: dict[str, dict]) -> list[dict]:
    """Text-only comparison — cwd/roots point at an EMPTY dir so the comparer
    cannot open the image (or anything else); everything it may see is inline."""
    data = await _agent_json(
        engine, stage="compare", system=COMPARE_SYSTEM,
        user=COMPARE_USER.format(page=page_rel, page_text=page_text[:24000],
                                 transcripts_json=json.dumps(transcripts, ensure_ascii=False)),
        model=_compare_model(), cwd=tmp_dir, roots=[tmp_dir],
        timeout=float(_env("KBC_MV_COMPARE_TIMEOUT", "300")))
    findings = data.get("findings") if isinstance(data, dict) else None
    out = []
    for f in findings or []:
        if isinstance(f, dict) and f.get("claim"):
            out.append({"page": page_rel, "image": str(f.get("image", "")),
                        "kind": str(f.get("kind", "不一致")),
                        "claim": str(f.get("claim"))[:200],
                        "expected": str(f.get("expected", ""))[:200],
                        "fix": str(f.get("fix", ""))[:200]})
    return out


async def run_blind_verify(engine, workdir: str, pending: dict[str, list[str]],
                           progress=None) -> dict:
    """Transcribe every image in `pending` (cache-aware, concurrent), then
    compare each page against its transcripts. Fail-open per item: a failed
    transcript/compare is recorded in errors, never raises."""
    say = progress or (lambda s: None)
    sem = asyncio.Semaphore(int(_env("KBC_MV_CONCURRENCY", "3")))
    cache = load_transcripts(workdir)
    images = sorted({img for imgs in pending.values() for img in imgs})
    errors: list[str] = []
    transcripts: dict[str, dict] = {}
    hits = 0

    async def _one(img: str):
        nonlocal hits
        pre = img in cache and cache[img].get("transcript")
        async with sem:
            try:
                t = await transcribe_image(engine, workdir, img, cache)
            except Exception as e:
                errors.append(f"转写失败 {img}: {e!r}")
                return
        if t is not None:
            transcripts[img] = t
            if pre and cache[img].get("transcript") is t:
                hits += 1
        else:
            errors.append(f"转写失败 {img}: 无法解析/文件缺失")

    say(f"自检(图像·盲转写):{len(images)} 张图转写中…")
    await asyncio.gather(*(_one(i) for i in images))
    save_transcripts(workdir, cache)

    findings: list[dict] = []
    cand = Path(workdir) / "candidate"
    empty = tempfile.mkdtemp(prefix="kbc-mv-")

    async def _page(page: str, imgs: list[str]):
        ts = {i: transcripts[i] for i in imgs if i in transcripts}
        if not ts:
            return
        try:
            text = (cand / page).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            errors.append(f"读页失败 {page}: {e!r}")
            return
        async with sem:
            try:
                findings.extend(await compare_page(engine, empty, page, text, ts))
            except Exception as e:
                errors.append(f"比对失败 {page}: {e!r}")

    say(f"自检(图像·比对):{len(pending)} 页比对中…")
    await asyncio.gather(*(_page(p, imgs) for p, imgs in pending.items()))
    shutil.rmtree(empty, ignore_errors=True)
    return {"findings": findings, "errors": errors,
            "images": len(images), "cache_hits": hits}


def build_repair_prompt(findings: list[dict]) -> str:
    """The bounded repair turn for blind-verify findings — concrete claims,
    concrete expected values, BOX_ROLE contract language."""
    lines = ["【系统自检 · 图像复核】系统对图片做了独立盲转写并与页面断言机械比对,以下断言与图不符"
             "或超出该图可支持的范围。逐条处理:值错的改成转写值;超出范围的(图里根本没有的信息被"
             "标注成该图来源)——有其他真实来源就改挂正确来源,没有就降级为 ⚠️ 存疑并按矛盾工单流程"
             "落一条工单。只动相关断言,不要重写无关内容:"]
    for f in findings[:40]:
        lines.append(f"- [{f['kind']}] {f['page']} ← raw/{f['image']}\n"
                     f"  断言: {f['claim']}\n  转写: {f['expected']}\n  修法: {f['fix']}")
    if len(findings) > 40:
        lines.append(f"- …等共 {len(findings)} 条(其余见 authoring/SELFCHECK.json)")
    return "\n".join(lines)
