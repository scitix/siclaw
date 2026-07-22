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

Locale: prompts and progress strings render in English by default (locale of
None/'en') and in Chinese for locale='zh'. The finding "kind" values above are
STORED tokens compared downstream — both locales instruct the model to emit
those exact tokens; only build_repair_prompt translates them into display
labels at render time.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import re

from redblue import _agent_json  # JSON call + one lenient retry, shared shape
from selfcheck import _is_en, parse_compiled_from  # locale gate + citation parse

TRANSCRIPTS_PATH = "authoring/MEDIA_TRANSCRIPTS.json"
_TRANSCRIPT_CHAR_CAP = 6000  # per image, persisted


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _transcribe_model() -> str:
    return _env("KBC_MV_TRANSCRIBE_MODEL", "claude-sonnet-4-6")


def _compare_model() -> str:
    return _env("KBC_MV_COMPARE_MODEL", "claude-opus-4-6")


TRANSCRIBE_SYSTEM_EN = """You are an image transcriber. You look at this one image only and transcribe the information **visible** in it into structured JSON.
Iron rules: do not write a single word of information the image does not contain (no inference, no filling in, no free association); mark values you cannot read as "unreadable";
every number in a table or monitoring screenshot must sit under its column header; for bar/line charts, write out the legend (color → series) and the axes first,
then transcribe bar by bar / point by point, tagging each value with its series; record N/A or offline rows exactly as shown."""

TRANSCRIBE_SYSTEM_ZH = """你是图像转写员。你只看眼前这一张图,把图里**可见**的信息转写成结构化 JSON。
铁则:图里没有的信息一个字都不要写(不要推断、不要补全、不要联想);读不清的值标 "不可读";
表格/监控截图的每个数值必须挂在它的列名下;柱状图/折线图必须先写出图例(颜色→系列)与坐标轴,
再逐柱/逐点转写,每个值标它属于哪个系列;N/A 或离线的行照原样记录。"""

TRANSCRIBE_USER_EN = """Open this image with Read and transcribe it: {img}

Output valid JSON only (no other text), structured as:
{{"chart_type": "table/bar chart/line chart/UI screenshot/flow diagram/other",
  "title_or_header": "the title or header visible in the image, else null",
  "legend": {{"series name": "color description", ...}} or null,
  "axes": "axis meanings and units, else null",
  "facts": [{{"label": "row/column/series locator", "value": "visible value"}}, ...],
  "illegible": ["parts you cannot read", ...],
  "notes": "other visible points (still only what the image shows)"}}"""

TRANSCRIBE_USER_ZH = """用 Read 打开这张图并转写:{img}

只输出合法 JSON(不要其他文字),结构:
{{"chart_type": "表格/柱状图/折线图/界面截图/流程图/其他",
  "title_or_header": "图内可见的标题或表头,没有则 null",
  "legend": {{"系列名": "颜色描述", ...}} 或 null,
  "axes": "坐标轴含义与单位,没有则 null",
  "facts": [{{"label": "行/列/系列定位", "value": "可见值"}}, ...],
  "illegible": ["读不清的部分", ...],
  "notes": "其他可见要点(仍然只写图里有的)"}}"""

COMPARE_SYSTEM_EN = """You are the comparer for knowledge-base image claims. You cannot see the images themselves — only the
structured transcripts produced by a separate transcriber (each is the complete inventory of what is visible in its image)
and the body text of the knowledge page that cites those images.
Your job: check every claim on the page whose source annotation names one of these images, and report exactly two kinds of problems:
- "不一致" (inconsistent): the claim conflicts with the transcript's value or attribution (e.g. a memory-column
  number reported as utilization, or a P0 series written up as P1);
- "超出转写范围" (beyond the transcript): the claim carries this image as its source tag, but nothing in the
  transcript can support it (typical: the image shows no model name, yet the page says "the model is X" and cites
  this image — an inference dressed up as a sourced fact).
Do not report claims that agree with the transcript; content citing other, non-image sources is not yours to check;
when unsure whether something qualifies, lean toward reporting it and let a human decide."""

COMPARE_SYSTEM_ZH = """你是知识库图像断言的【比对员】。你看不到图片本身——只有另一位转写员产出的
结构化转写(它是图内可见信息的完整清单)和引用了该图的知识页正文。
你的任务:逐条核对页面里标注来源为这些图片的断言,只报两类问题:
- 不一致:断言与转写的值/归属冲突(如把显存列的数值写成利用率、把 P0 系列写成 P1);
- 超出转写范围:断言挂着该图的来源标注,但转写里根本没有能支撑它的信息
  (典型:图里没有型号名,页面却说"型号是 X"并引用该图——这是把推断伪装成带源事实)。
与转写一致的断言不要报;页面引用其他非图片来源的内容不归你管;拿不准算不算的,倾向于报出来让人裁。"""

COMPARE_USER_EN = """Knowledge page: {page}
Full page text:
--------
{page_text}
--------

Transcripts of the images this page cites (produced by a transcriber who saw only the image — the complete inventory of what is visible):
{transcripts_json}

Output valid JSON only (no other text):
{{"findings": [{{"image": "image path relative to raw", "claim": "the page's original claim (quoted)",
   "kind": set kind to exactly "不一致" (inconsistent) or "超出转写范围" (beyond the transcript),
   "expected": "the matching fact from the transcript; for beyond-the-transcript findings write \\"not in the transcript\\"",
   "fix": "one-line fix (change to the transcribed value / downgrade to ⚠️ uncertain + file a ticket / re-attribute to the correct source)"}}]}}
If there are no problems, output {{"findings": []}}."""

COMPARE_USER_ZH = """知识页:{page}
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


def _transcribe_prompts(locale: str | None) -> tuple[str, str]:
    if _is_en(locale):
        return TRANSCRIBE_SYSTEM_EN, TRANSCRIBE_USER_EN
    return TRANSCRIBE_SYSTEM_ZH, TRANSCRIBE_USER_ZH


def _compare_prompts(locale: str | None) -> tuple[str, str]:
    if _is_en(locale):
        return COMPARE_SYSTEM_EN, COMPARE_USER_EN
    return COMPARE_SYSTEM_ZH, COMPARE_USER_ZH


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


async def transcribe_image(engine, workdir: str, img_rel: str, cache: dict,
                           locale: str | None = None) -> dict | None:
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
    system, user = _transcribe_prompts(locale)
    data = await _agent_json(
        engine, stage="transcribe", system=system,
        user=user.format(img=f"raw/{img_rel}"),
        model=_transcribe_model(), cwd=raw_dir, roots=[raw_dir],
        timeout=float(_env("KBC_MV_TRANSCRIBE_TIMEOUT", "240")))
    if not isinstance(data, dict):
        return None
    if len(json.dumps(data, ensure_ascii=False)) > _TRANSCRIPT_CHAR_CAP:
        data = {"chart_type": data.get("chart_type"), "legend": data.get("legend"),
                "axes": data.get("axes"),
                "facts": (data.get("facts") or [])[:80],
                "notes": ("(transcript truncated — over the length cap)" if _is_en(locale)
                          else "(转写超长已截断)")}
    cache[img_rel] = {"sha8": sha, "transcript": data}
    return data


async def compare_page(engine, tmp_dir: str, page_rel: str, page_text: str,
                       transcripts: dict[str, dict], locale: str | None = None) -> list[dict]:
    """Text-only comparison — cwd/roots point at an EMPTY dir so the comparer
    cannot open the image (or anything else); everything it may see is inline."""
    system, user = _compare_prompts(locale)
    data = await _agent_json(
        engine, stage="compare", system=system,
        user=user.format(page=page_rel, page_text=page_text[:24000],
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


_TEXT_SOURCE_SUFFIXES = (".md", ".txt", ".log", ".json", ".csv")
_CLAIM_NUM_RE = re.compile(r"[+\-]?\d[\d.,]*%?")
_TEXT_SOURCE_READ_CAP = 2 * 1024 * 1024  # per source file


def _distinctive_tokens(claim: str) -> list[str]:
    """Numeric tokens strong enough to identify the claim in a text source.
    Percentages and decimals first (46%, 39.7 — near-unique in practice);
    plain integers only when >=3 digits (13440), never bare '8'/'70'."""
    strong, plain = [], []
    for tok in _CLAIM_NUM_RE.findall(claim):
        core = tok.lstrip("+-").rstrip("%").rstrip(".,")
        if not core:
            continue
        if "%" in tok or "." in core:
            strong.append(tok.lstrip("+-"))
        elif len(core) >= 3:
            plain.append(core)
    return strong or plain


def _co_cited_text(workdir: str, page_text: str) -> str:
    """Concatenated body of the page's co-cited TEXT sources (raw-relative)."""
    sources, _, _ = parse_compiled_from(page_text)
    raw = Path(workdir) / "raw"
    chunks: list[str] = []
    for src in sources:
        if not src.lower().endswith(_TEXT_SOURCE_SUFFIXES):
            continue
        fp = raw / src
        try:
            if fp.is_file():
                chunks.append(fp.read_text(encoding="utf-8", errors="replace")
                              [:_TEXT_SOURCE_READ_CAP])
        except OSError:
            continue
    return "\n".join(chunks)


def suppress_text_backed(workdir: str, page: str, page_text: str,
                         findings: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split compare findings into (kept, suppressed).

    A 超出转写范围 finding says "the cited image cannot support this claim".
    That inference only holds when the image is the claim's SOLE source — but
    curated pages routinely cite whole asset sets as corroboration while the
    figure itself comes from a co-cited text export (live adoption run,
    2026-07-22: "FP4 +46%" flagged although the co-cited markdown states
    "FP4有46%提升" verbatim). When the claim's distinctive numeric tokens are
    found in a co-cited text source, the image is corroboration, not the
    authority — reclassify silently instead of asking the owner.

    不一致 findings are NEVER suppressed: a text-backed claim that contradicts
    what the image actually shows is a genuine cross-source conflict."""
    beyond = [f for f in findings if f.get("kind") == "超出转写范围"]
    if not beyond:
        return findings, []
    text = _co_cited_text(workdir, page_text)
    if not text:
        return findings, []
    kept, suppressed = [], []
    for f in findings:
        if f.get("kind") != "超出转写范围":
            kept.append(f)
            continue
        tokens = _distinctive_tokens(str(f.get("claim") or ""))
        if tokens and any(tok in text for tok in tokens):
            suppressed.append({**f, "page": page,
                               "suppressed_reason": "text_source_backed"})
        else:
            kept.append(f)
    return kept, suppressed


async def run_blind_verify(engine, workdir: str, pending: dict[str, list[str]],
                           progress=None, locale: str | None = None) -> dict:
    """Transcribe every image in `pending` (cache-aware, concurrent), then
    compare each page against its transcripts. Fail-open per item: a failed
    transcript/compare is recorded in errors, never raises."""
    say = progress or (lambda s: None)
    en = _is_en(locale)
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
                t = await transcribe_image(engine, workdir, img, cache, locale=locale)
            except Exception as e:
                errors.append(f"transcription failed {img}: {e!r}" if en
                              else f"转写失败 {img}: {e!r}")
                return
        if t is not None:
            transcripts[img] = t
            if pre and cache[img].get("transcript") is t:
                hits += 1
        else:
            errors.append(f"transcription failed {img}: unparsable output / file missing" if en
                          else f"转写失败 {img}: 无法解析/文件缺失")

    say(f"Self-check (image · blind transcription): transcribing {len(images)} image(s)…" if en
        else f"自检(图像·盲转写):{len(images)} 张图转写中…")
    await asyncio.gather(*(_one(i) for i in images))
    save_transcripts(workdir, cache)

    findings: list[dict] = []
    suppressed_all: list[dict] = []
    completed: list[str] = []
    failed: list[str] = []
    cand = Path(workdir) / "candidate"
    empty = tempfile.mkdtemp(prefix="kbc-mv-")

    async def _page(page: str, imgs: list[str]):
        ts = {i: transcripts[i] for i in imgs if i in transcripts}
        if len(ts) < len(imgs):
            # Partial (or zero) transcripts: comparing against an incomplete
            # inventory would mis-grade BOTH ways — a wrong claim about the
            # missing image has nothing to contradict it (false pass), and a
            # correct claim about it gets flagged beyond-transcript (false
            # fail). Skip the page whole; the caller retries it later.
            missing = len(imgs) - len(ts)
            errors.append(f"page {page}: {missing} image(s) not transcribed — comparison skipped" if en
                          else f"页 {page}: {missing} 张图未转写——本轮不比对")
            failed.append(page)
            return
        try:
            text = (cand / page).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            errors.append(f"failed to read page {page}: {e!r}" if en
                          else f"读页失败 {page}: {e!r}")
            failed.append(page)
            return
        async with sem:
            try:
                raw_findings = await compare_page(engine, empty, page, text, ts, locale=locale)
                kept, suppressed = suppress_text_backed(workdir, page, text, raw_findings)
                findings.extend(kept)
                suppressed_all.extend(suppressed)
            except Exception as e:
                errors.append(f"comparison failed {page}: {e!r}" if en
                              else f"比对失败 {page}: {e!r}")
                failed.append(page)
                return
        completed.append(page)

    say(f"Self-check (image · comparison): comparing {len(pending)} page(s)…" if en
        else f"自检(图像·比对):{len(pending)} 页比对中…")
    await asyncio.gather(*(_page(p, imgs) for p, imgs in pending.items()))
    shutil.rmtree(empty, ignore_errors=True)
    if suppressed_all:
        say(f"Self-check (image · comparison): {len(suppressed_all)} beyond-transcript doubt(s) "
            "auto-resolved — claim verbatim-backed by a co-cited text source (image kept as corroboration)" if en
            else f"自检(图像·比对):{len(suppressed_all)} 条\u201c超出转写范围\u201d疑点因同页文本源逐字背书自动归为佐证,不出卡")
    return {"findings": findings, "errors": errors,
            "images": len(images), "cache_hits": hits,
            "suppressed_text_backed": suppressed_all,
            "completed_pages": sorted(completed), "failed_pages": sorted(failed)}


# Stored finding kinds → English display labels (render-time only; the stored
# values themselves are never translated).
_KIND_LABELS_EN = {"不一致": "inconsistent with the image",
                   "超出转写范围": "beyond what the transcript supports"}


def build_repair_prompt(findings: list[dict], locale: str | None = None) -> str:
    """The bounded repair turn for blind-verify findings — concrete claims,
    concrete expected values, BOX_ROLE contract language. Rendered in the run's
    locale (see _is_en); stored kind tokens are mapped to display labels for en."""
    if _is_en(locale):
        lines = ["[System self-check · image verification] The system blind-transcribed each cited image "
                 "independently and mechanically compared the transcripts against the page claims; the claims "
                 "below contradict the image or go beyond what it can support. Handle each item: if the value "
                 "is wrong, change it to the transcribed value; if it is beyond the transcript (the image simply "
                 "does not contain the information it is cited for) — re-attribute the claim to a real source if "
                 "one exists, otherwise downgrade it to ⚠️ uncertain and file a ticket through the "
                 "contradiction-ticket flow. Touch only the affected claims; do not rewrite unrelated content:"]
        for f in findings[:40]:
            kind = _KIND_LABELS_EN.get(f["kind"], f["kind"])
            lines.append(f"- [{kind}] {f['page']} ← raw/{f['image']}\n"
                         f"  Claim: {f['claim']}\n  Transcript: {f['expected']}\n  Fix: {f['fix']}")
        if len(findings) > 40:
            lines.append(f"- …{len(findings)} total (see authoring/SELFCHECK.json for the rest)")
        return "\n".join(lines)
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
