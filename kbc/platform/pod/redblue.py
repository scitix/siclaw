"""Layer-2 red-blue PK self-check: orchestrator + prompts + calibration CLI.

Deterministic Python drives everything (when to run, how many questions, when
to stop); agents only ever answer inside their asymmetric roles:

  judge  (strong tier, reads raw + wiki snapshot)  — surveys the question
         surface, writes questions with raw-truth expectations, grades answers
         with four-category attribution (覆盖/路由/契约/媒介 =
         coverage/routing/contract/medium).
  blue   (gate tier = production consumer, reads ONLY the pinned wiki
         snapshot; raw is mechanically invisible) — answers as a real
         consumer. Persona = selfcheck.TEST_ROLE, single-sourced.

Engine-neutral: depends on engine.ReadonlyAgentEngine only. The calibration
runner IS this module — `python redblue.py --raw … (--workdir …|--wiki …)`
runs the exact production pipeline offline (S0), so calibration validates the
code that ships.

Design: improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §9.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path

import selfcheck
from selfcheck import _is_en
from engine import ReadonlyAgentEngine, parse_json_lenient

# ── knobs (engine-neutral names; env-overridable, deploy-time) ──

def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, str(default)))


def _blue_model() -> str:
    return os.environ.get("KBC_PK_BLUE_MODEL", "claude-sonnet-4-6")


def _judge_model() -> str:
    return os.environ.get("KBC_PK_JUDGE_MODEL", "claude-opus-4-6")


def _verdict_model() -> str:
    """Grading a blue answer against the INLINED raw-truth rubric (`expected`,
    extracted by the strong judge during the questions stage) is a mechanical
    check, not authoring — the gate tier suffices and is far faster/cheaper than
    the opus authoring judge. Root cause of the 2026-07-07 stall: the verdict was
    an AGENTIC session (raw+wiki roots, max_turns 40) re-reading raw per chunk →
    it looped and hung. De-agentified + gate-tier here. Overridable to the strong
    judge if grading quality ever demands it."""
    return os.environ.get("KBC_PK_VERDICT_MODEL", "claude-sonnet-4-6")


def question_budget(page_count: int) -> int:
    """Scale by KB size — code formula, never model discretion (principle 8).
    Defaults tuned for compile-flow wiring (2026-07-06): 1.0/page capped at 24 —
    the marginal information of question 25+ is low (the A/B graded a whole
    compile on ~20 non-trivial assertions), and 24 questions keeps a full pass
    inside the wall clock (blue is one fresh session PER question)."""
    lo = _env_int("KBC_PK_QUESTIONS_MIN", 8)
    hi = _env_int("KBC_PK_QUESTIONS_MAX", 24)
    per = _env_float("KBC_PK_QUESTIONS_PER_PAGE", 1.0)
    return max(lo, min(hi, int(page_count * per)))


PASS_SCORES = ("对", "正确标未覆盖")
SURVEY_CACHE_NAME = "PK_SURVEY_CACHE.json"


def _t(locale: str | None, en: str, zh: str) -> str:
    """Locale pick for model-facing prompts and human-readable narration. The
    platform default is English (see selfcheck._is_en); Chinese only when the
    consumer declares locale=zh. Stored tokens never go through this."""
    return en if _is_en(locale) else zh


# ── prompts (calibrated offline via the CLI before production wiring; schemas
#    mirror siflow-kb/.claude/workflows/redblue-pk.js, proven on real data).
#    en/zh pairs. STORED TOKENS DON'T FORK: score / failure_category /
#    difficulty / flag / angle values persist to PK_RESULT.json and
#    PK_SURVEY_CACHE.json and are compared in code (PASS_SCORES), so the en
#    variants instruct the model to emit the exact same tokens, glossed in
#    parentheses; only the surrounding prose is translated. ──

JUDGE_ROLE_EN = """You are the JUDGE of a knowledge-base test: you check whether a compiled artifact (an LLM-Wiki) is faithful, complete, and self-sufficient.
You can read two places: the raw corpus (the ground truth) and the wiki snapshot. The blue team — a separate consumer that reads ONLY the wiki and cannot see the raw corpus — does exactly as well as the wiki text itself holds up; its performance measures the wiki, not the blue team's intelligence. Check every judgment against the raw corpus; never rule from impression."""

JUDGE_ROLE_ZH = """你是知识库测试【裁判】,负责检验一份编译产物(LLM-Wiki)是否忠实、完整、自足。
你可以读两处:原始语料(真值)与 wiki 快照。蓝队(另一个只读 wiki、读不到原始语料的消费者)的表现
反映的是 wiki 文字本身站不站得住——不是蓝队聪不聪明。你的一切判断都要回原始语料核对,不凭印象。"""

SURVEY_USER_EN = """Now run a **question-surface survey** (map what can be tested — do not write questions yet).
- Raw corpus (ground truth): {raw_dir}
- Wiki snapshot: {wiki_dir} (start from .siclaw/knowledge/index.md)

Sweep both sides systematically. Suggested partitions to walk one by one (derived from the corpus directory structure and the index topics; split or extend them as you see fit):
{areas}

For each knowledge point worth testing, output:
- knowledge_point: a one-line description
- difficulty: emit the exact token 易 (easy) / 中 (medium) / 难 (hard)
- flag: emit the exact token 常规 (routine: sourced and compiled) / 冲突 (conflict: the sources contradict each other) / WIP (the source leaves it blank) / 边界 (boundary: absent from the source — the KB should honestly answer not-covered)
- angles: suitable question angles; emit the exact tokens, chosen from 直问 (direct) / 场景 (scenario) / 诱导 (leading) / 对比 (comparison) / 边界 (boundary) / 反向 (reverse)
- source_ref: where it lives in raw or the wiki

Cover the high-frequency questions real consumers ask, AND dig out the 冲突/WIP/边界 (conflict/WIP/boundary) hard spots that tell "honestly not covered" apart from "made up".
Output JSON only (no other text): {{"topics": [...]}}"""

SURVEY_USER_ZH = """现在做**出题面调研**(先摸清能测什么,不出题)。
- 原始语料(真值):{raw_dir}
- wiki 快照:{wiki_dir}(从 .siclaw/knowledge/index.md 出发)

系统性遍历两边。建议按这些分区逐一扫过(来自语料目录结构与 index 主题,可自行增补拆细):
{areas}

对每个值得出题的知识点输出:
- knowledge_point: 简述
- difficulty: 易/中/难
- flag: 常规(源有据已编) / 冲突(源自相矛盾) / WIP(源留白) / 边界(源本无,库应诚实答未覆盖)
- angles: 适合的提问角度,从 直问/场景/诱导/对比/边界/反向 中选
- source_ref: raw 或 wiki 出处

既要覆盖高频真实问法,也要挖出 冲突/WIP/边界 这些能区分"诚实未覆盖 vs 脑补"的硬点。
只输出 JSON(不要任何其他文字):{{"topics": [...]}}"""

QUESTIONS_USER_EN = """You are the judge's **question officer**. From the question surface below, write {n} test questions with real teeth.

Question surface (already surveyed):
{topics_json}
{contradictions_block}{media_block}
Requirements:
1. Prioritize knowledge points flagged 难/冲突/WIP/边界 (hard/conflict/WIP/boundary){contradictions_hint};
2. Write **variants** for the key knowledge points (2 questions with different variant_type on the same knowledge_point); pick angles from
   直问 (direct) / 场景 (scenario: "I ran into X, what do I do?") / 诱导 (leading: deliberately wrong premise — "X doesn't support Y, right?") / 对比 (comparison: X vs Y) /
   边界 (boundary: absent from the source — tests honest not-covered) / 反向 (reverse: flatly insist "X definitely supports W, right?") — emit the exact tokens;
3. Write `expected` as the raw ground-truth points: for conflict areas write "must lay out both readings with sources — no single-reading assertion";
   for WIP/boundary write "the KB should honestly answer not-covered — no fabrication".

Each question: {{"id": "q1", "question": ..., "knowledge_point": ..., "variant_type": ...,
"expected": ..., "source_ref": ...}}
Output JSON only (no other text): {{"questions": [...]}}"""

QUESTIONS_USER_ZH = """你是裁判的**出题官**。基于下面的出题面,出 {n} 道**能打**的测试题。

出题面(已调研):
{topics_json}
{contradictions_block}{media_block}
要求:
1. 优先覆盖 难/冲突/WIP/边界 标记的知识点{contradictions_hint};
2. 重点知识点出**变式**(同一 knowledge_point 出 2 道不同 variant_type),角度从
   直问 / 场景(我遇到X怎么办) / 诱导(故意给错前提"X不支持Y吧?") / 对比(X vs Y) /
   边界(源本无,测诚实未覆盖) / 反向(一口咬定"X一定支持W对吧") 中选;
3. expected 写 raw 真值要点:冲突区写"须平铺两口径+出处,不得单口径断言";
   WIP/边界写"库应诚实答未覆盖,不得脑补"。

每题:{{"id": "q1", "question": ..., "knowledge_point": ..., "variant_type": ...,
"expected": ..., "source_ref": ...}}
只输出 JSON(不要任何其他文字):{{"questions": [...]}}"""

# De-agentified verdict (2026-07-07): grade against the INLINED `raw 真值要点`
# already carried on each question — do NOT re-read raw (that agentic loop was
# the stall). No {raw_dir}/{wiki_dir} in the prompt; the qa_block is self-contained.
VERDICT_ROLE_EN = """You are the grader serving the knowledge-base test JUDGE. Grade each blue-team answer strictly against the **raw ground-truth points provided per question**.
Those points were extracted from the raw corpus at question-authoring time and are the ruling basis — grade against them and **do not go back to the raw corpus** (re-reading is slow and unnecessary; this pass only checks answers against the points). The blue team reads ONLY the wiki snapshot and cannot see the raw corpus; how well it answers reflects whether the wiki text itself holds up."""

VERDICT_ROLE_ZH = """你是知识库测试【裁判】的判分员。逐题依据**已给的 raw 真值要点**核对蓝队回答并判分。
真值要点是出题阶段从原始语料萃取的裁决依据——判分以它为准,**不要再去翻阅原始语料**(重读既慢又非必要,
本轮判分只对着要点核对答案)。蓝队只读 wiki 快照、读不到原始语料,它答得好不好反映的是 wiki 文字站不站得住。"""

VERDICT_USER_EN = """Grade every question below. **Rely solely on each question's "raw ground-truth points"** — do not attempt to read any files.

Grading criteria:
- score — emit the exact token:
  对 (correct) / 部分对 (partially correct) / 错 (wrong; includes fabricating where the ground-truth points have nothing, or single-sidedly ruling a conflict area) /
  正确标未覆盖 (correctly flagged not-covered: the points say raw has nothing / WIP / conflict area, and the blue team honestly laid out both readings or plainly said not covered = a good outcome, counts as a pass)
- failure_category — emit the exact token ("无" (none) when nothing failed):
  覆盖 (coverage: the wiki never compiled this content) / 路由 (routing: the wiki has it but the blue team couldn't find it / the index doesn't point there) /
  契约 (contract: fabricated / cited no sources / answered firmly where it should have said not-covered / ruled arbitrarily in a conflict area) / 媒介 (medium: broken link / formatting / misleading wording)
- fix: on failure, the concrete page/route/link to repair; "-" on a pass
- page: the wiki page this content should live on / actually lives on; "-" if unsure
Write reason and fix in English.

Questions, raw ground-truth points, and blue-team answers:
{qa_block}

Output a JSON array only (no other text); per question:
{{"id": "...", "score": "...", "failure_category": "...", "reason": "...", "fix": "...", "page": "..."}}"""

VERDICT_USER_ZH = """请对下面每题判分。**只依据每题给出的「raw 真值要点」**,不要试图读取任何文件。

判分标准:
- score: 对 / 部分对 / 错(含真值要点无据处脑补、矛盾区单口径硬裁) /
  正确标未覆盖(真值要点标明 raw 本无 / WIP / 矛盾区,蓝队诚实平铺或明说未覆盖 = 好结果,算通过)
- failure_category(无失败填"无"):
  覆盖(wiki 没编这个内容) / 路由(wiki 编了但蓝队没找到/index 没指到) /
  契约(脑补/没带源/该说未覆盖却硬答/矛盾区乱裁) / 媒介(链接坏/格式/表达误导)
- fix: 失败时具体修哪页/哪条路由/哪个链接;通过填 "-"
- page: 该题内容应落在/实际落在的 wiki 页名;不确定填 "-"

题目、raw 真值要点与蓝队回答:
{qa_block}

只输出 JSON 数组(不要任何其他文字),每题:
{{"id": "...", "score": "...", "failure_category": "...", "reason": "...", "fix": "...", "page": "..."}}"""


# ── stage helper ──

class PKStageError(RuntimeError):
    def __init__(self, stage: str, detail: str):
        super().__init__(f"{stage}: {detail}")
        self.stage = stage


async def _agent_json(engine: ReadonlyAgentEngine, *, stage: str, system: str, user: str,
                      model: str, cwd: str, roots: list[str], timeout: float,
                      locale: str | None = None):
    """One engine call expected to yield JSON; on parse failure retry ONCE with
    an explicit re-emit instruction (new one-shot session), then fail the stage."""
    last_err = "?"
    for attempt in range(2):
        text = await engine.run_readonly_agent(
            cwd=cwd, system_prompt=system, user_message=user, model=model,
            allowed_read_roots=roots, timeout_secs=timeout)
        try:
            return parse_json_lenient(text)
        except ValueError as e:
            last_err = f"{e}; output head: {text[:200]!r}"
            user = user + _t(
                locale,
                "\n\n(Your previous output could not be parsed as JSON. Answer again and output "
                "**valid JSON only**, with no other text.)",
                "\n\n(你上一次的输出无法解析为 JSON。请重新作答,**只输出合法 JSON**,不带任何其他文字。)")
    raise PKStageError(stage, f"unparseable JSON after retry: {last_err}")


# ── inputs derivation ──

def raw_fingerprint(raw_dir: str) -> str:
    """Cache key for the survey: sorted (relpath, size). Sizes not mtimes —
    workspace rehydration rewrites mtimes; the frozen bundle keeps sizes."""
    root = Path(raw_dir)
    h = hashlib.sha256()
    for f in sorted(root.rglob("*")):
        if f.is_file():
            h.update(f.relative_to(root).as_posix().encode())
            h.update(b"\0"); h.update(str(f.stat().st_size).encode()); h.update(b"\0")
    return h.hexdigest()


def derive_area_seeds(raw_dir: str, wiki_dir: str, cap: int = 24) -> list[str]:
    """Domain-neutral survey partitions: raw top-level entries ∪ wiki index
    link titles. Seeds, not a straitjacket — the judge may split/extend."""
    seeds: list[str] = []
    raw = Path(raw_dir)
    if raw.is_dir():
        seeds += sorted(p.name for p in raw.iterdir() if not p.name.startswith("."))
    index = Path(wiki_dir) / ".siclaw" / "knowledge" / "index.md"
    if index.is_file():
        try:
            seeds += re.findall(r"\[([^\]]{2,40})\]\([^)]+\.md\)", index.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            pass
    seen, out = set(), []
    for s in seeds:
        if s not in seen:
            seen.add(s); out.append(s)
    return out[:cap]


def _load_survey_cache(authoring_dir: str | None, fingerprint: str) -> list | None:
    if not authoring_dir:
        return None
    path = Path(authoring_dir) / SURVEY_CACHE_NAME
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if data.get("fingerprint") == fingerprint and isinstance(data.get("topics"), list):
        return data["topics"]
    return None


def _save_survey_cache(authoring_dir: str | None, fingerprint: str, topics: list) -> None:
    if not authoring_dir:
        return
    path = Path(authoring_dir) / SURVEY_CACHE_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"fingerprint": fingerprint, "topics": topics},
                               ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load_intent(authoring_dir: str | None) -> str:
    """INTENT.md = the owner's declared audience/purpose/scope. Fed to the JUDGE
    only (weighting + scoring yardstick) — never to the blue team, which must
    stay as ignorant as a real consumer."""
    if not authoring_dir:
        return ""
    p = Path(authoring_dir) / "INTENT.md"
    if not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8")[:4000]
    except (OSError, UnicodeDecodeError):
        return ""


def _load_exclusion_entries(authoring_dir: str | None, cap: int = 30) -> list[dict]:
    """Declared exclusions change GRADING semantics: raw content the owner
    deliberately excluded is not a coverage gap — an honest '本库未收录' is a
    pass. Tolerant read; malformed file just means no declared exclusions here
    (Layer 1 already lints the file itself)."""
    if not authoring_dir:
        return []
    p = Path(authoring_dir) / "EXCLUSIONS.json"
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out = [{"pattern": str(e.get("pattern")), "reason": str(e.get("reason", ""))}
           for e in data if isinstance(e, dict) and e.get("pattern")]
    return out[:cap]


def _load_contradictions(authoring_dir: str | None) -> list[dict]:
    if not authoring_dir:
        return []
    path = Path(authoring_dir) / "CONTRADICTIONS.json"
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    return [t for t in data if isinstance(t, dict)] if isinstance(data, list) else []


def _chunks(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def _media_block(media_pages: dict | None, cap: int = 15, locale: str | None = None) -> str:
    """Question-officer hint: wiki pages whose numbers came from chart/screenshot
    transcription — the one failure mode the 2026-07-06 A/B actually caught
    twice. Numeric-verification questions against these pages are the highest-
    value asks a PK round can make."""
    if not media_pages:
        return ""
    lines = [f"- {page} ← {', '.join(imgs)}" for page, imgs in sorted(media_pages.items())[:cap]]
    return _t(
        locale,
        "\nChart-transcribed pages (the numbers on these wiki pages were transcribed from "
        "images/charts — a known high-error surface. Ask numeric-verification questions "
        "against them first; write `expected` with the ground-truth figures from the raw "
        "images):\n" + "\n".join(lines) + "\n",
        "\n图表转写页(这些 wiki 页的数字来自图片/图表转写,是已知的高错风险面——"
        "优先对它们出数值核对题,expected 写 raw 图里的真值要点):\n" + "\n".join(lines) + "\n")


def _summarize(questions: list[dict], verdicts: dict, *, missing_as_failure: bool) -> dict:
    """The decide step, shared by the normal path (a question with no verdict =
    the judge dropped it = failure) and the timeout-salvage path (ungraded
    questions are simply not counted — they were cancelled, not failed)."""
    failures, gate_pass, graded = [], 0, 0
    for q in questions:
        v = verdicts.get(q["id"])
        if v is None and not missing_as_failure:
            continue
        graded += 1
        v = v or {}
        if v.get("score") in PASS_SCORES:
            gate_pass += 1
        else:
            failures.append({
                "id": q["id"], "question": q["question"][:120],
                "score": v.get("score", "无判定"),
                "category": v.get("failure_category", "无判定"),
                "page": v.get("page", "-"), "fix": v.get("fix", "-"),
            })
    return {
        "questions": len(questions), "graded": graded, "gate_pass": gate_pass,
        "pass_rate": round(gate_pass / graded, 3) if graded else 0.0,
        "failures": failures,
    }


def _finalize(questions: list[dict], detail: dict, *, survey_cache_hit: bool,
              blue_m: str, judge_m: str, verdict_m: str, salvaged: bool = False,
              error: str | None = None) -> dict:
    """Build the terminal pk summary with an OBSERVABLE state (root cause of
    "why stuck was invisible": the old path wrote a bare TimeoutError()). Every
    untested question gets a reason (per-item error captured during blue/judge,
    else "judge-dropped"). State:
      unconverged — real wiki failures found (owner must act)
      partial     — some questions untested (timeout/error), rest graded
      passed      — all graded, none failed
    A hard early-stage failure (survey/questions) is handled by the caller."""
    summary = _summarize(questions, detail["verdicts"], missing_as_failure=False)
    ungraded = sorted(q["id"] for q in questions if q["id"] not in detail["verdicts"])
    errors = detail.get("errors", {})
    summary["ungraded_reasons"] = {
        qid: errors.get(qid, {"stage": "judge", "reason": "judge dropped id from JSON"})
        for qid in ungraded
    }
    if salvaged:
        # Interrupted (wall-clock/hard error): incomplete by definition — never
        # claim full coverage, and don't let a found-failure masquerade as the
        # repair-triggering "unconverged" off a run that didn't finish.
        state = "partial"
    elif summary["failures"]:
        state = "unconverged"
    elif ungraded:
        state = "partial"  # 诚实半完成:能判的判了,判不动的诚实亮出来、可续
    else:
        state = "passed"
    summary.update({
        "state": state, "ungraded": ungraded,
        "survey_cache_hit": survey_cache_hit,
        "blue_model": blue_m, "judge_model": judge_m, "verdict_model": verdict_m,
    })
    if salvaged:
        summary["salvaged"] = True
    if error:
        summary["error"] = error
    return summary


# The blue team answers as the REAL consumer (persona = selfcheck.TEST_ROLE),
# which means natural prose ending in a machine-readable `SOURCES: [...]` line —
# NOT a JSON object. Forcing JSON on the consumer persona breaks fidelity AND
# doesn't parse (the two instructions fight). So we ask one natural question at a
# time and parse the consumer's own SOURCES line.
_SOURCES_RE = re.compile(r"SOURCES:\s*(\[[^\]]*\])")
# Both locales, matched lowercased regardless of the run's locale (the blue team
# answers in the QUESTION's language, not necessarily the run's): zh hints plus
# the en test-role phrasing ("this wiki does not cover that") and near variants.
_UNCOVERED_HINTS = ("这个 wiki 里没有", "wiki 里没有", "未覆盖", "没有相关", "查不到", "未收录",
                    "wiki does not cover", "wiki doesn't cover", "not covered", "no coverage")


def _parse_sources(text: str) -> list[str]:
    m = _SOURCES_RE.search(text or "")
    if m:
        try:
            v = json.loads(m.group(1))
            return [str(x) for x in v] if isinstance(v, list) else []
        except json.JSONDecodeError:
            return []
    return []


def _strip_sources(text: str) -> str:
    return _SOURCES_RE.sub("", text or "").strip()


def _said_uncovered(text: str) -> bool:
    t = text or ""
    low = t.lower()  # hints are lowercase; lower() is a no-op on the CJK ones
    if any(h in low for h in _UNCOVERED_HINTS):
        return True
    return "SOURCES:" in t and _parse_sources(t) == []


# ── the pipeline ──

async def run_pk(engine: ReadonlyAgentEngine, *, wiki_dir: str, raw_dir: str,
                 page_count: int, authoring_dir: str | None = None,
                 constitution_path: str | None = None,
                 questions_budget: int | None = None,
                 questions_override: list[dict] | None = None,
                 media_pages: dict | None = None,
                 blue_model: str | None = None, judge_model: str | None = None,
                 progress=None, locale: str | None = None) -> tuple[dict, dict]:
    """Run one PK round. Returns (pk_summary, detail).

    pk_summary is the SELFCHECK.json `pk` section (compact); detail carries
    full questions/answers/verdicts for the CLI / targeted retest.
    `questions_override` skips survey+authoring stages — the targeted-retest
    primitive (§9.3-6): re-test exactly the failed questions after a repair.
    `media_pages` (page → image paths) steers the question officer toward
    numeric-verification questions on chart-transcribed pages.
    `locale` picks the language of every prompt and progress line (None/en =
    English, the platform default; zh = Chinese). Stored tokens (score /
    failure_category / state values) are locale-independent — they never fork.
    Fail-open: any stage error → state=failed with the reason; a WALL-CLOCK
    timeout salvages what already got graded as state=partial (the tokens are
    spent either way — keep the information). Never raises."""
    t0 = time.monotonic()
    en = _is_en(locale)
    blue_m = blue_model or _blue_model()
    judge_m = judge_model or _judge_model()
    verdict_m = _verdict_model()
    say = progress or (lambda s: None)
    chunk_size = _env_int("KBC_PK_CHUNK", 5)
    concurrency = _env_int("KBC_PK_CONCURRENCY", 3)
    judge_roots = [wiki_dir, raw_dir]
    # Blue persona = the locale's test-role pack (single-sourced with the
    # user-facing test session, selfcheck._pack_test_role) — an English KB's
    # consumer reads/answers as an English consumer.
    blue_role = selfcheck._pack_test_role("en" if en else "zh")

    constitution = ""
    if constitution_path and Path(constitution_path).is_file():
        try:
            constitution = Path(constitution_path).read_text(encoding="utf-8")[:8000]
        except (OSError, UnicodeDecodeError):
            constitution = ""
    # Judge context = the owner's CONTRACT artifacts (constitution / INTENT /
    # declared exclusions) — never the compiler's narrative (PLAN as map, chat
    # history). Intent sets weighting and the scoring yardstick; exclusions flip
    # "raw has it but owner opted out" from coverage-fail to honest-pass. The
    # blue team gets NONE of this: a real consumer doesn't know the scope deal.
    # Built once as an appendix so the survey/questions role (reads raw) and the
    # de-agentified verdict role (grades from inlined truth) share the same
    # grading yardstick without duplicating it.
    context_appendix = ""
    if constitution:
        context_appendix += _t(
            locale,
            f"\n\nThis KB's ruling discipline (constitution — follow it when grading):\n{constitution}",
            f"\n\n本库的裁决纪律(constitution,判分时遵循):\n{constitution}")
    intent = _load_intent(authoring_dir)
    if intent:
        context_appendix += _t(
            locale,
            "\n\nThis KB's positioning and audience (INTENT, declared by the owner): skew the "
            "question mix toward the audience/purpose declared here, and grade against the scope "
            "it defines — obscure points outside that scope are not gaps.\n" + intent,
            "\n\n本库的定位与受众(INTENT,负责人声明):出题的数量分布要向这里声明的"
            "受众/用途倾斜;评分也以它界定的范围为尺——范围外的冷僻点不算缺口。\n" + intent)
    exclusion_entries = _load_exclusion_entries(authoring_dir)
    if exclusion_entries:
        excl_lines = "\n".join(f"- {e['pattern']}: {e['reason']}" for e in exclusion_entries)
        context_appendix += _t(
            locale,
            "\n\nRaw scopes the owner has **declared excluded** (deliberately not compiled, with "
            "reasons):\n" + excl_lines +
            "\nFor these scopes: do not write \"why doesn't the KB have this\" coverage questions; "
            "if a question touches one and the blue team honestly answers that this KB does not "
            "cover it, grade it 正确标未覆盖 (correctly flagged not-covered) — a pass, not a "
            "coverage failure.",
            "\n\n负责人**声明排除**的 raw 范围(刻意不编,带理由):\n" + excl_lines +
            "\n对这些范围:不要出\"库里为什么没有\"式的覆盖题;若题目触及、且蓝队诚实回答"
            "\"本库未收录\",判 正确标未覆盖(=通过),不算覆盖失败。")
    # survey + questions (agentic, reads raw)
    judge_system = _t(locale, JUDGE_ROLE_EN, JUDGE_ROLE_ZH) + context_appendix
    # verdict (de-agentified, grades from inlined truth)
    verdict_system = _t(locale, VERDICT_ROLE_EN, VERDICT_ROLE_ZH) + context_appendix

    # `errors` (id → {stage, reason}) makes a partial run OBSERVABLE: every
    # untested question carries why. Written per-item so a stalled sibling can't
    # erase a completed one (root cause 缺陷2: fail-fast gather vaporized work).
    detail: dict = {"questions": [], "answers": {}, "verdicts": {}, "errors": {}}
    survey_cache_hit = False

    def _record_error(stage: str, ids: list[str], e: BaseException) -> None:
        for qid in ids:
            detail["errors"].setdefault(qid, {"stage": stage, "reason": repr(e)[:300]})

    async def _body() -> dict:
        nonlocal survey_cache_hit
        # 1+2+3: question set (or targeted override)
        if questions_override:
            questions = questions_override
            say(_t(locale, f"Self-check (PK): targeted re-test, {len(questions)} question(s)",
                   f"自检(PK):定向复测 {len(questions)} 题"))
        else:
            fp = raw_fingerprint(raw_dir)
            topics = _load_survey_cache(authoring_dir, fp)
            survey_cache_hit = topics is not None
            if topics is None:
                say(_t(locale, "Self-check (PK): judge surveying the question surface…",
                       "自检(PK):裁判调研出题面…"))
                areas = derive_area_seeds(raw_dir, wiki_dir)
                data = await _agent_json(
                    engine, stage="survey", system=judge_system,
                    user=_t(locale, SURVEY_USER_EN, SURVEY_USER_ZH).format(
                        raw_dir=raw_dir, wiki_dir=wiki_dir,
                        areas="\n".join(f"- {a}" for a in areas)),
                    model=judge_m, cwd=wiki_dir, roots=judge_roots,
                    timeout=_env_float("KBC_PK_SURVEY_TIMEOUT", 600), locale=locale)
                topics = data.get("topics", []) if isinstance(data, dict) else []
                if not topics:
                    raise PKStageError("survey", "empty topic surface")
                _save_survey_cache(authoring_dir, fp, topics)
            n = questions_budget or question_budget(page_count)
            tickets = _load_contradictions(authoring_dir)
            cblock, chint = "", ""
            if tickets:
                items = [{"title": t.get("title"), "question": t.get("question")} for t in tickets[:20]]
                cblock = _t(locale,
                            "\nOpen contradiction tickets (weak spots flagged during compilation "
                            "— question them first):\n",
                            "\n存疑工单(编译期标记的薄弱面,优先出题):\n") \
                    + json.dumps(items, ensure_ascii=False) + "\n"
                chint = _t(locale, " and points tied to the open contradiction tickets",
                           "与存疑工单相关的点")
            say(_t(locale, f"Self-check (PK): generating {n} questions…", f"自检(PK):出题 {n} 题…"))
            data = await _agent_json(
                engine, stage="questions", system=judge_system,
                user=_t(locale, QUESTIONS_USER_EN, QUESTIONS_USER_ZH).format(
                    n=n, topics_json=json.dumps(topics, ensure_ascii=False),
                    contradictions_block=cblock, contradictions_hint=chint,
                    media_block=_media_block(media_pages, locale=locale)),
                model=judge_m, cwd=wiki_dir, roots=judge_roots,
                timeout=_env_float("KBC_PK_QUESTIONS_TIMEOUT", 300), locale=locale)
            questions = data.get("questions", []) if isinstance(data, dict) else []
            questions = [q for q in questions if isinstance(q, dict) and q.get("question")][:n]
            if not questions:
                raise PKStageError("questions", "no questions generated")
            for i, q in enumerate(questions):
                q.setdefault("id", f"q{i + 1}")
        detail["questions"] = questions

        # 4: blue team — ONE natural question per call (real-consumer fidelity),
        #    parse the consumer's own SOURCES line. Concurrent under the semaphore.
        say(_t(locale,
               f"Self-check (PK): blue team ({blue_m}) answering {len(questions)} questions, "
               f"judge ({judge_m}) grading…",
               f"自检(PK):蓝队({blue_m})答 {len(questions)} 题、裁判({judge_m})判分…"))
        sem = asyncio.Semaphore(concurrency)

        async def _blue(q: dict) -> None:
            # Per-item containment (缺陷2): a single blue call that stalls/errors
            # records its reason and returns — it must not raise through gather
            # and cancel the siblings that already completed.
            async with sem:
                try:
                    text = await engine.run_readonly_agent(
                        cwd=wiki_dir, system_prompt=blue_role,
                        user_message=q["question"], model=blue_m,
                        allowed_read_roots=[wiki_dir],
                        timeout_secs=_env_float("KBC_PK_BLUE_TIMEOUT", 300))
                except (Exception, asyncio.TimeoutError) as e:
                    _record_error("blue", [q["id"]], e)
                    return
            # Written as each answer lands (not after the gather): a wall-clock
            # cancellation must not vaporize the answers that DID complete.
            detail["answers"][q["id"]] = {"id": q["id"], "answer": _strip_sources(text),
                                          "cited_sources": _parse_sources(text),
                                          "said_uncovered": _said_uncovered(text)}

        # return_exceptions=True as a belt: even a bug in the wrapper can't turn
        # one bad item into a whole-round abort.
        await asyncio.gather(*(_blue(q) for q in questions), return_exceptions=True)

        # 5: judge — batched per chunk, DE-AGENTIFIED (2026-07-07 root-cause fix):
        #    grades from the inlined `expected` raw-truth rubric, gate-tier model,
        #    NO raw root (roots=[wiki_dir]) so it can't loop re-reading raw. The
        #    old agentic verdict (raw root + "回原始语料核对" + max_turns 40) is
        #    what hung and, via fail-fast gather, vaporized all 24 answered blues.
        async def _judge(chunk: list[dict]) -> None:
            if en:
                qa = "\n\n".join(
                    f"[{q['id']}] Question: {q['question']}\n"
                    f"Raw ground-truth points: {q.get('expected', '-')}\n"
                    f"Raw source: {q.get('source_ref', '-')}\n"
                    f"Blue-team answer: "
                    f"{detail['answers'].get(q['id'], {}).get('answer') or '(no blue answer / untested)'}\n"
                    f"Blue-team claimed sources: {detail['answers'].get(q['id'], {}).get('cited_sources', [])}"
                    for q in chunk)
            else:
                qa = "\n\n".join(
                    f"[{q['id']}] 问题: {q['question']}\nraw 真值要点: {q.get('expected', '-')}\n"
                    f"raw 出处: {q.get('source_ref', '-')}\n"
                    f"蓝队回答: {detail['answers'].get(q['id'], {}).get('answer') or '(蓝队无回答/未测)'}\n"
                    f"蓝队自称引用: {detail['answers'].get(q['id'], {}).get('cited_sources', [])}"
                    for q in chunk)
            async with sem:
                try:
                    verdicts = await _agent_json(
                        engine, stage="verdict", system=verdict_system,
                        user=_t(locale, VERDICT_USER_EN, VERDICT_USER_ZH).format(qa_block=qa),
                        model=verdict_m, cwd=wiki_dir, roots=[wiki_dir],
                        timeout=_env_float("KBC_PK_VERDICT_TIMEOUT", 180), locale=locale)
                except (Exception, asyncio.TimeoutError) as e:
                    _record_error("verdict", [q["id"] for q in chunk], e)
                    return
            if isinstance(verdicts, list):  # incremental for the same salvage reason
                got = {v.get("id"): v for v in verdicts if isinstance(v, dict)}
                detail["verdicts"].update(got)
                # a verdict landing clears any earlier per-item error for that id
                for gid in got:
                    detail["errors"].pop(gid, None)

        await asyncio.gather(*(_judge(c) for c in _chunks(questions, chunk_size)),
                             return_exceptions=True)

        # 5b: the judge sometimes drops ids from a chunk's JSON (seen live
        # 2026-07-07: 4/24 missing, twice). Re-judge ONLY the missing ones once;
        # whatever is still missing is UNGRADED — cancelled/dropped is not a
        # wiki failure, must not trigger a repair round, and must not pollute
        # the pass-rate denominator.
        missing = [q for q in questions if q["id"] not in detail["verdicts"]]
        if missing:
            say(_t(locale,
                   f"Self-check (PK): {len(missing)} question(s) missing verdicts, re-judging once…",
                   f"自检(PK):{len(missing)} 题判分缺失,补判一轮…"))
            await asyncio.gather(*(_judge(c) for c in _chunks(missing, chunk_size)),
                                 return_exceptions=True)

        # 6: decide — observable terminal state (passed / partial / unconverged),
        # every untested question carries a reason.
        return _finalize(questions, detail, survey_cache_hit=survey_cache_hit,
                         blue_m=blue_m, judge_m=judge_m, verdict_m=verdict_m)

    try:
        summary = await asyncio.wait_for(_body(), timeout=_env_float("KBC_PK_WALL_SECS", 1800))
    except (Exception, asyncio.TimeoutError) as e:  # fail-open boundary (§4.5): report, never raise
        stage = getattr(e, "stage", None)  # PKStageError carries which stage
        if detail["questions"]:
            # Salvage whatever got graded (cancelled ≠ failed, spend is sunk) as a
            # partial; ungraded questions carry their reason. Only a hard EARLY
            # failure (survey/questions → no questions at all) is a bare `failed`.
            summary = _finalize(detail["questions"], detail, survey_cache_hit=survey_cache_hit,
                                blue_m=blue_m, judge_m=judge_m, verdict_m=verdict_m,
                                salvaged=True, error=repr(e))
        else:
            summary = {"state": "failed", "error": repr(e), "stage": stage or "survey",
                       "survey_cache_hit": survey_cache_hit, "blue_model": blue_m,
                       "judge_model": judge_m, "verdict_model": verdict_m}
    summary["wall_secs"] = int(time.monotonic() - t0)
    return summary, detail


# Stored failure_category tokens (Chinese, persisted in PK_RESULT/SELFCHECK)
# glossed to English at render time only — the stored values never change.
_CATEGORY_GLOSS_EN = {"覆盖": "coverage", "路由": "routing", "契约": "contract",
                      "媒介": "medium", "无": "none", "无判定": "ungraded"}


def build_pk_repair_prompt(summary: dict, locale: str | None = None) -> str:
    """The bounded repair turn for PK findings — concrete pages and fixes,
    speaking the BOX_ROLE contract language, in the run's locale (stored
    category tokens are glossed at render time). Injected by the compile
    driver."""
    if _is_en(locale):
        lines = ["[System self-check · red-blue PK] A consumer reading ONLY the wiki answered a "
                 "batch of questions grounded in raw truth; the items below did not pass. Repair "
                 "the page named in each fix (coverage = compile the missing content; routing = "
                 "fix the index/link guidance; contract = cite sources / honestly mark "
                 "not-covered; medium = fix links/wording). Touch only the pages involved — do "
                 "not rewrite unrelated pages:"]
        for f in summary.get("failures", []):
            cat = _CATEGORY_GLOSS_EN.get(f["category"], f["category"])
            lines.append(f"- [{cat}] {f['question']} → page: {f['page']}; fix: {f['fix']}")
        lines.append("Anything you cannot repair (needs the owner's call) goes through the "
                     "contradiction-ticket flow into authoring/CONTRADICTIONS.json — never "
                     "hard-code an answer.")
        return "\n".join(lines)
    lines = ["【系统自检 · 红蓝队】一个只读 wiki 的消费者试答了一批基于 raw 真值的问题,以下未通过。"
             "逐条按 fix 建议回修对应页(覆盖=补编内容;路由=修 index/链接指引;契约=改成带源/诚实标未覆盖;"
             "媒介=修链接/表达)。只动相关页,不要重写无关页面:"]
    for f in summary.get("failures", []):
        lines.append(f"- [{f['category']}] {f['question']} → 页: {f['page']}; 修法: {f['fix']}")
    lines.append("修不动的(需要负责人拍板的),按矛盾工单流程落 authoring/CONTRADICTIONS.json,不许硬编。")
    return "\n".join(lines)


# ── staging helpers (shared by CLI and future compile_box wiring) ──

def stage_wiki_copy(src_dir: str, dest_root: str) -> str:
    """CLI --wiki mode: stage an existing wiki dir into the .siclaw/knowledge
    layout TEST_ROLE expects. Returns the snapshot root."""
    kdir = Path(dest_root) / ".siclaw" / "knowledge"
    kdir.mkdir(parents=True, exist_ok=True)
    src = Path(src_dir)
    for f in sorted(src.rglob("*")):
        if f.is_file() and f.suffix in (".md", ".json"):
            rel = f.relative_to(src)
            out = kdir / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, out)
    return dest_root


# ── S0 calibration CLI: the production pipeline, run offline ──

def _cli():
    import argparse
    ap = argparse.ArgumentParser(description="Red-blue PK self-check (S0 calibration runner)")
    ap.add_argument("--raw", required=True, help="raw corpus dir (ground truth)")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--workdir", help="authoring workdir (contains candidate/, pinned as a snapshot; "
                                       "uses authoring/ caches and tickets)")
    src.add_argument("--wiki", help="an existing wiki dir (e.g. a platform export), tested as-is")
    ap.add_argument("--questions", type=int, help="question count (default scales with page count)")
    ap.add_argument("--retest", help="a previous --out result JSON; re-test only its failed questions")
    ap.add_argument("--out", default="pk-result.json", help="full result output file")
    ap.add_argument("--blue-model", default=None)
    ap.add_argument("--judge-model", default=None)
    ap.add_argument("--locale", default=None, choices=["en", "zh"],
                    help="prompt/narration language (default en, the platform default)")
    args = ap.parse_args()

    from engine import ClaudeEngine  # real engine only in CLI/production paths

    async def _main():
        tmp = tempfile.mkdtemp(prefix="kbc-pk-")
        authoring_dir = None
        constitution = None
        if args.workdir:
            _, pages = selfcheck.pack_candidates_to_wiki(args.workdir, Path(tmp))
            authoring_dir = str(Path(args.workdir) / "authoring")
            c = Path(args.workdir) / "constitution.md"
            constitution = str(c) if c.is_file() else None
        else:
            stage_wiki_copy(args.wiki, tmp)
            pages = sum(1 for _ in (Path(tmp) / ".siclaw" / "knowledge").rglob("*.md"))
        override = None
        if args.retest:
            prev = json.loads(Path(args.retest).read_text(encoding="utf-8"))
            failed_ids = {f["id"] for f in prev["summary"].get("failures", [])}
            override = [q for q in prev["detail"]["questions"] if q.get("id") in failed_ids]
            if not override:
                print("no failed questions in the previous result — nothing to re-test"); return
        summary, detail = await run_pk(
            ClaudeEngine(), wiki_dir=tmp, raw_dir=str(Path(args.raw).resolve()),
            page_count=pages, authoring_dir=authoring_dir, constitution_path=constitution,
            questions_budget=args.questions, questions_override=override,
            blue_model=args.blue_model, judge_model=args.judge_model, progress=print,
            locale=args.locale)
        if args.workdir:
            summary_for_file = dict(summary); summary_for_file["rounds_used"] = 0
            selfcheck.update_pk_section(args.workdir, summary_for_file)
        Path(args.out).write_text(json.dumps({"summary": summary, "detail": detail},
                                             ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n== PK {summary['state']} ==")
        if "pass_rate" in summary:
            print(f"gate tier {summary['blue_model']}: {summary['gate_pass']}/{summary['questions']}"
                  f" = {summary['pass_rate']:.0%} (cache_hit={summary['survey_cache_hit']},"
                  f" {summary['wall_secs']}s)")
            for f in summary["failures"]:
                print(f"  ✗ [{f['category']}] {f['question']} → {f['page']}: {f['fix']}")
        else:
            print(f"error: {summary.get('error')}")
        print(f"full result: {args.out}")
        shutil.rmtree(tmp, ignore_errors=True)

    asyncio.run(_main())


if __name__ == "__main__":
    _cli()
