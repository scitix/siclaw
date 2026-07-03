"""Layer-2 red-blue PK self-check: orchestrator + prompts + calibration CLI.

Deterministic Python drives everything (when to run, how many questions, when
to stop); agents only ever answer inside their asymmetric roles:

  judge  (strong tier, reads raw + wiki snapshot)  — surveys the question
         surface, writes questions with raw-truth expectations, grades answers
         with four-category attribution (覆盖/路由/契约/媒介).
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
import shutil
import tempfile
import time
from pathlib import Path

import selfcheck
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


def question_budget(page_count: int) -> int:
    """Scale by KB size — code formula, never model discretion (principle 8)."""
    lo = _env_int("KBC_PK_QUESTIONS_MIN", 8)
    hi = _env_int("KBC_PK_QUESTIONS_MAX", 40)
    per = _env_float("KBC_PK_QUESTIONS_PER_PAGE", 1.5)
    return max(lo, min(hi, int(page_count * per)))


PASS_SCORES = ("对", "正确标未覆盖")
SURVEY_CACHE_NAME = "PK_SURVEY_CACHE.json"

# ── prompts (calibrated offline via the CLI before production wiring; schemas
#    mirror siflow-kb/.claude/workflows/redblue-pk.js, proven on real data) ──

JUDGE_ROLE = """你是知识库测试【裁判】,负责检验一份编译产物(LLM-Wiki)是否忠实、完整、自足。
你可以读两处:原始语料(真值)与 wiki 快照。蓝队(另一个只读 wiki、读不到原始语料的消费者)的表现
反映的是 wiki 文字本身站不站得住——不是蓝队聪不聪明。你的一切判断都要回原始语料核对,不凭印象。"""

SURVEY_USER = """现在做**出题面调研**(先摸清能测什么,不出题)。
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

QUESTIONS_USER = """你是裁判的**出题官**。基于下面的出题面,出 {n} 道**能打**的测试题。

出题面(已调研):
{topics_json}
{contradictions_block}
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

BLUE_USER = """请依次回答下面 {k} 个问题,每个问题都按你的守则独立作答。

{questions_block}

最终**只输出一个 JSON 数组**,每题一个对象:
{{"id": "...", "answer": "...", "cited_sources": ["页名.md", ...], "said_uncovered": true/false}}
(said_uncovered = 你是否声明了"wiki 未覆盖/查不到"。本次以这个 JSON 数组为准,不需要单独的 SOURCES 行,也不要输出其他文字。)"""

VERDICT_USER = """蓝队(只读 wiki 快照,读不到原始语料)已作答。请逐题回原始语料核对并判分。
- 原始语料(真值):{raw_dir}
- wiki 快照:{wiki_dir}

判分标准:
- score: 对 / 部分对 / 错(含 raw 无据处脑补、矛盾区单口径硬裁) /
  正确标未覆盖(raw 本无 / WIP / 矛盾区,蓝队诚实平铺或明说未覆盖 = 好结果,算通过)
- failure_category(无失败填"无"):
  覆盖(wiki 没编这个内容) / 路由(wiki 编了但蓝队没找到/index 没指到) /
  契约(脑补/没带源/该说未覆盖却硬答/矛盾区乱裁) / 媒介(链接坏/格式/表达误导)
- fix: 失败时具体修哪页/哪条路由/哪个链接;通过填 "-"
- page: 该题内容应落在/实际落在的 wiki 页名;不确定填 "-"

题目与蓝队回答:
{qa_block}

只输出 JSON 数组(不要任何其他文字),每题:
{{"id": "...", "score": "...", "failure_category": "...", "reason": "...", "fix": "...", "page": "..."}}"""


# ── stage helper ──

class PKStageError(RuntimeError):
    def __init__(self, stage: str, detail: str):
        super().__init__(f"{stage}: {detail}")
        self.stage = stage


async def _agent_json(engine: ReadonlyAgentEngine, *, stage: str, system: str, user: str,
                      model: str, cwd: str, roots: list[str], timeout: float):
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
            user = user + "\n\n(你上一次的输出无法解析为 JSON。请重新作答,**只输出合法 JSON**,不带任何其他文字。)"
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
            import re as _re
            seeds += _re.findall(r"\[([^\]]{2,40})\]\([^)]+\.md\)", index.read_text(encoding="utf-8"))
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


# ── the pipeline ──

async def run_pk(engine: ReadonlyAgentEngine, *, wiki_dir: str, raw_dir: str,
                 page_count: int, authoring_dir: str | None = None,
                 constitution_path: str | None = None,
                 questions_budget: int | None = None,
                 questions_override: list[dict] | None = None,
                 blue_model: str | None = None, judge_model: str | None = None,
                 progress=None) -> tuple[dict, dict]:
    """Run one PK round. Returns (pk_summary, detail).

    pk_summary is the SELFCHECK.json `pk` section (compact); detail carries
    full questions/answers/verdicts for the CLI / targeted retest.
    `questions_override` skips survey+authoring stages — the targeted-retest
    primitive (§9.3-6): re-test exactly the failed questions after a repair.
    Fail-open: any stage error → state=failed with the reason; never raises."""
    t0 = time.monotonic()
    blue_m = blue_model or _blue_model()
    judge_m = judge_model or _judge_model()
    say = progress or (lambda s: None)
    chunk_size = _env_int("KBC_PK_CHUNK", 5)
    concurrency = _env_int("KBC_PK_CONCURRENCY", 2)
    judge_roots = [wiki_dir, raw_dir]

    constitution = ""
    if constitution_path and Path(constitution_path).is_file():
        try:
            constitution = Path(constitution_path).read_text(encoding="utf-8")[:8000]
        except (OSError, UnicodeDecodeError):
            constitution = ""
    judge_system = JUDGE_ROLE + (
        f"\n\n本库的裁决纪律(constitution,判分时遵循):\n{constitution}" if constitution else "")

    detail: dict = {"questions": [], "answers": {}, "verdicts": {}}
    survey_cache_hit = False

    async def _body() -> dict:
        nonlocal survey_cache_hit
        # 1+2+3: question set (or targeted override)
        if questions_override:
            questions = questions_override
            say(f"自检(PK):定向复测 {len(questions)} 题")
        else:
            fp = raw_fingerprint(raw_dir)
            topics = _load_survey_cache(authoring_dir, fp)
            survey_cache_hit = topics is not None
            if topics is None:
                say("自检(PK):裁判调研出题面…")
                areas = derive_area_seeds(raw_dir, wiki_dir)
                data = await _agent_json(
                    engine, stage="survey", system=judge_system,
                    user=SURVEY_USER.format(raw_dir=raw_dir, wiki_dir=wiki_dir,
                                            areas="\n".join(f"- {a}" for a in areas)),
                    model=judge_m, cwd=wiki_dir, roots=judge_roots,
                    timeout=_env_float("KBC_PK_SURVEY_TIMEOUT", 600))
                topics = data.get("topics", []) if isinstance(data, dict) else []
                if not topics:
                    raise PKStageError("survey", "empty topic surface")
                _save_survey_cache(authoring_dir, fp, topics)
            n = questions_budget or question_budget(page_count)
            tickets = _load_contradictions(authoring_dir)
            cblock, chint = "", ""
            if tickets:
                items = [{"title": t.get("title"), "question": t.get("question")} for t in tickets[:20]]
                cblock = "\n存疑工单(编译期标记的薄弱面,优先出题):\n" + json.dumps(items, ensure_ascii=False) + "\n"
                chint = "与存疑工单相关的点"
            say(f"自检(PK):出题 {n} 题…")
            data = await _agent_json(
                engine, stage="questions", system=judge_system,
                user=QUESTIONS_USER.format(n=n, topics_json=json.dumps(topics, ensure_ascii=False),
                                           contradictions_block=cblock, contradictions_hint=chint),
                model=judge_m, cwd=wiki_dir, roots=judge_roots,
                timeout=_env_float("KBC_PK_QUESTIONS_TIMEOUT", 300))
            questions = data.get("questions", []) if isinstance(data, dict) else []
            questions = [q for q in questions if isinstance(q, dict) and q.get("question")][:n]
            if not questions:
                raise PKStageError("questions", "no questions generated")
            for i, q in enumerate(questions):
                q.setdefault("id", f"q{i + 1}")
        detail["questions"] = questions

        # 4+5: per-chunk blue answer → judge verdict, chunks concurrent under a semaphore
        say(f"自检(PK):蓝队({blue_m})答 {len(questions)} 题、裁判({judge_m})判分…")
        sem = asyncio.Semaphore(concurrency)

        async def _run_chunk(chunk: list[dict]):
            qblock = "\n".join(f"[{q['id']}] {q['question']}" for q in chunk)
            async with sem:
                answers = await _agent_json(
                    engine, stage="blue", system=selfcheck.TEST_ROLE,
                    user=BLUE_USER.format(k=len(chunk), questions_block=qblock),
                    model=blue_m, cwd=wiki_dir, roots=[wiki_dir],
                    timeout=_env_float("KBC_PK_BLUE_TIMEOUT", 420))
            amap = {a.get("id"): a for a in answers if isinstance(a, dict)} \
                if isinstance(answers, list) else {}
            qa = "\n\n".join(
                f"[{q['id']}] 问题: {q['question']}\nraw 真值要点: {q.get('expected', '-')}\n"
                f"raw 出处: {q.get('source_ref', '-')}\n"
                f"蓝队回答: {json.dumps(amap.get(q['id'], {}), ensure_ascii=False)}"
                for q in chunk)
            async with sem:
                verdicts = await _agent_json(
                    engine, stage="verdict", system=judge_system,
                    user=VERDICT_USER.format(raw_dir=raw_dir, wiki_dir=wiki_dir, qa_block=qa),
                    model=judge_m, cwd=wiki_dir, roots=judge_roots,
                    timeout=_env_float("KBC_PK_VERDICT_TIMEOUT", 420))
            vmap = {v.get("id"): v for v in verdicts if isinstance(v, dict)} \
                if isinstance(verdicts, list) else {}
            return amap, vmap

        results = await asyncio.gather(*(_run_chunk(c) for c in _chunks(questions, chunk_size)))
        for amap, vmap in results:
            detail["answers"].update(amap)
            detail["verdicts"].update(vmap)

        # 6: decide
        failures = []
        gate_pass = 0
        for q in questions:
            v = detail["verdicts"].get(q["id"]) or {}
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
            "state": "passed" if not failures else "unconverged",
            "questions": len(questions), "gate_pass": gate_pass,
            "pass_rate": round(gate_pass / len(questions), 3),
            "failures": failures,
            "survey_cache_hit": survey_cache_hit,
            "blue_model": blue_m, "judge_model": judge_m,
        }

    try:
        summary = await asyncio.wait_for(_body(), timeout=_env_float("KBC_PK_WALL_SECS", 1800))
    except (Exception, asyncio.TimeoutError) as e:  # fail-open boundary (§4.5): report, never raise
        summary = {"state": "failed", "error": repr(e), "survey_cache_hit": survey_cache_hit,
                   "blue_model": blue_m, "judge_model": judge_m}
    summary["wall_secs"] = int(time.monotonic() - t0)
    return summary, detail


def build_pk_repair_prompt(summary: dict) -> str:
    """The bounded repair turn for PK findings — concrete pages and fixes,
    speaking the BOX_ROLE contract language. Injected by the compile driver."""
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
    ap.add_argument("--raw", required=True, help="原始语料目录(真值)")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--workdir", help="authoring workdir(含 candidate/,将钉快照;用 authoring/ 的缓存与工单)")
    src.add_argument("--wiki", help="现成 wiki 目录(如平台导出物),直接作为被测对象")
    ap.add_argument("--questions", type=int, help="题量(默认按页数伸缩)")
    ap.add_argument("--retest", help="上次 --out 结果 JSON,只复测其中失败题")
    ap.add_argument("--out", default="pk-result.json", help="完整结果输出文件")
    ap.add_argument("--blue-model", default=None)
    ap.add_argument("--judge-model", default=None)
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
                print("上次结果没有失败题,无需复测"); return
        summary, detail = await run_pk(
            ClaudeEngine(), wiki_dir=tmp, raw_dir=str(Path(args.raw).resolve()),
            page_count=pages, authoring_dir=authoring_dir, constitution_path=constitution,
            questions_budget=args.questions, questions_override=override,
            blue_model=args.blue_model, judge_model=args.judge_model, progress=print)
        if args.workdir:
            summary_for_file = dict(summary); summary_for_file["rounds_used"] = 0
            selfcheck.update_pk_section(args.workdir, summary_for_file)
        Path(args.out).write_text(json.dumps({"summary": summary, "detail": detail},
                                             ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n== PK {summary['state']} ==")
        if "pass_rate" in summary:
            print(f"门槛档 {summary['blue_model']}: {summary['gate_pass']}/{summary['questions']}"
                  f" = {summary['pass_rate']:.0%} (cache_hit={summary['survey_cache_hit']},"
                  f" {summary['wall_secs']}s)")
            for f in summary["failures"]:
                print(f"  ✗ [{f['category']}] {f['question']} → {f['page']}: {f['fix']}")
        else:
            print(f"error: {summary.get('error')}")
        print(f"完整结果: {args.out}")
        shutil.rmtree(tmp, ignore_errors=True)

    asyncio.run(_main())


if __name__ == "__main__":
    _cli()
