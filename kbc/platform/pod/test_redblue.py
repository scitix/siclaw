"""Tests for the Layer-2 red-blue PK orchestrator (redblue.py + engine.py).

A FakeEngine routes prompts to canned JSON by stage keyword — the full
pipeline runs with zero LLM calls. Run:
    python test_redblue.py
"""

import asyncio
import json
import re
import tempfile
from pathlib import Path

import redblue
import selfcheck
from engine import parse_json_lenient, path_escape_multi


def _mk(base: Path, rel: str, text: str = "x"):
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


class FakeEngine:
    """Stage-routed canned responses; counts calls per stage."""

    def __init__(self, broken_stages=(), slow_verdict_from=None, drop_verdict_ids=(),
                 error_verdict_ids=()):
        self.calls = {"survey": 0, "questions": 0, "blue": 0, "verdict": 0}
        self.systems = {}  # stage → last system prompt seen (asymmetry assertions)
        self.users = {}    # stage → last user message seen
        self.models = {}   # stage → last model id seen (verdict-tier assertions)
        self.roots = {}    # stage → last allowed_read_roots seen (de-agentic assertions)
        self.broken = set(broken_stages)
        self.slow_verdict_from = slow_verdict_from  # Nth verdict call onward hangs
        self.drop_verdict_ids = set(drop_verdict_ids)  # judge "forgets" these ids
        self.error_verdict_ids = set(error_verdict_ids)  # any chunk w/ these ids raises

    async def run_readonly_agent(self, *, cwd, system_prompt, user_message,
                                 model, effort=None, allowed_read_roots, timeout_secs):
        # route on stage keywords in EITHER locale (en is the platform default)
        if "question-surface survey" in user_message or "出题面调研" in user_message:
            stage = "survey"
        elif "question officer" in user_message or "出题官" in user_message:
            stage = "questions"
        elif "Grading criteria" in user_message or "判分标准" in user_message:
            stage = "verdict"
        elif ("read-only knowledge consumer" in system_prompt
              or "只读的知识消费者" in system_prompt):
            stage = "blue"
        else:
            raise AssertionError(f"unroutable prompt: {user_message[:80]}")
        self.calls[stage] += 1
        self.systems[stage] = system_prompt
        self.users[stage] = user_message
        self.models[stage] = model
        self.roots[stage] = list(allowed_read_roots)
        if stage == "verdict" and self.error_verdict_ids & set(re.findall(r"\[(q\d+)\]", user_message)):
            raise RuntimeError("judge boom")  # a single chunk fails hard, others must survive
        if stage == "verdict" and self.slow_verdict_from and self.calls["verdict"] >= self.slow_verdict_from:
            await asyncio.sleep(30)  # parked until the wall clock cancels us
        if stage in self.broken:
            return "总之就是一段完全不是 JSON 的话。"
        if stage == "survey":
            return json.dumps({"topics": [{"knowledge_point": "kp1", "difficulty": "中",
                                           "flag": "常规", "angles": ["直问"], "source_ref": "a.md"}]})
        if stage == "questions":
            qs = [{"id": f"q{i}", "question": f"问题{i}", "knowledge_point": "kp",
                   "variant_type": "直问", "expected": "exp", "source_ref": "a.md"}
                  for i in range(1, 8)]
            return json.dumps({"questions": qs})
        if stage == "blue":
            # real-consumer persona: natural prose + a SOURCES line (NOT JSON)
            return "根据 wiki,答案是……\nSOURCES: [\"index.md\"]"
        ids = re.findall(r"\[(q\d+)\]", user_message)
        assert ids, "verdict prompt carries no question ids"
        out = []
        for i in ids:  # verdict: q1 fails as 覆盖, everything else passes
            if i in self.drop_verdict_ids:
                continue  # judge silently omits this id from its JSON
            if i == "q1":
                out.append({"id": i, "score": "错", "failure_category": "覆盖",
                            "reason": "缺", "fix": "补编X", "page": "p1.md"})
            else:
                out.append({"id": i, "score": "对", "failure_category": "无",
                            "reason": "-", "fix": "-", "page": "-"})
        return json.dumps(out)


def _pk_workspace(base: Path):
    _mk(base, "raw/s/a.md", "真值A")
    _mk(base, "raw/s/b.md", "真值B")
    wiki = base / "snap"
    _mk(wiki, ".siclaw/knowledge/index.md", "# idx\n[页一](p1.md)")
    _mk(wiki, ".siclaw/knowledge/p1.md", "内容")
    return str(wiki), str(base / "raw")


def test_budget_and_helpers():
    assert redblue.question_budget(2) == 8      # floor
    assert redblue.question_budget(20) == 20    # 20*1.0
    assert redblue.question_budget(100) == 24   # cap (S2 default: 24 focused > 40 sprawled)
    assert redblue._chunks([1, 2, 3, 4, 5, 6, 7], 5) == [[1, 2, 3, 4, 5], [6, 7]]
    # _summarize: normal path counts a missing verdict as a failure (the judge
    # dropped it); salvage path skips it (cancelled ≠ failed).
    qs = [{"id": "q1", "question": "a"}, {"id": "q2", "question": "b"}]
    vs = {"q1": {"score": "对", "failure_category": "无"}}
    full = redblue._summarize(qs, vs, missing_as_failure=True)
    assert full["graded"] == 2 and full["gate_pass"] == 1 and len(full["failures"]) == 1
    part = redblue._summarize(qs, vs, missing_as_failure=False)
    assert part["graded"] == 1 and part["gate_pass"] == 1 and not part["failures"]
    # media block formatting + cap; English by default, Chinese only on locale=zh
    assert redblue._media_block(None) == ""
    blk = redblue._media_block({"p1.md": ["s/a.png", "s/b.png"]})
    assert "Chart-transcribed pages" in blk and "p1.md ← s/a.png, s/b.png" in blk
    zh_blk = redblue._media_block({"p1.md": ["s/a.png", "s/b.png"]}, locale="zh")
    assert "图表转写页" in zh_blk and "p1.md ← s/a.png, s/b.png" in zh_blk
    print("OK  question_budget clamp + chunks + _summarize + _media_block")


def test_parse_json_lenient_cases():
    assert parse_json_lenient('{"a": 1}') == {"a": 1}
    assert parse_json_lenient('前言\n```json\n[1, 2]\n```\n后记') == [1, 2]
    assert parse_json_lenient('好的,结果如下: {"b": [1]} 完毕') == {"b": [1]}
    try:
        parse_json_lenient("毫无 JSON 可言")
        raise AssertionError("should raise")
    except ValueError:
        pass
    print("OK  parse_json_lenient (plain / fenced / prose-wrapped / garbage)")


def test_path_escape_multi():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        (base / "wiki").mkdir(); (base / "raw").mkdir(); (base / "work").mkdir()
        roots = [base / "wiki", base / "raw"]
        ok = path_escape_multi(roots, "Read", {"file_path": str(base / "raw" / "x.md")})
        assert ok is None, ok  # second root counts
        bad = path_escape_multi(roots, "Read", {"file_path": str(base / "work" / "draft.md")})
        assert bad and "draft.md" in bad
        assert path_escape_multi(roots, "Read", {"file_path": "sub/page.md"}) is None  # relative → primary root
        assert path_escape_multi(roots, "Glob", {"pattern": "/etc/*"}) is not None
        assert path_escape_multi(roots, "Read", {"file_path": str(base / "wiki" / ".." / "work" / "e.md")}) is not None
    print("OK  path_escape_multi (multi-root / relative / traversal / absolute glob)")


async def test_full_run():
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine()
        seen = []
        summary, detail = await redblue.run_pk(
            fake, wiki_dir=wiki, raw_dir=raw, page_count=10, questions_budget=7,
            progress=seen.append)
        # blue = per-question (7); judge = batched (7 → 2 chunks of 5+2)
        assert fake.calls == {"survey": 1, "questions": 1, "blue": 7, "verdict": 2}, fake.calls
        assert summary["state"] == "unconverged" and summary["questions"] == 7, summary
        assert summary["gate_pass"] == 6 and len(summary["failures"]) == 1, summary
        f = summary["failures"][0]
        # stored tokens are locale-independent: 覆盖 stays 覆盖 in an English run
        assert f["category"] == "覆盖" and f["page"] == "p1.md", f
        assert len(detail["answers"]) == 7 and len(detail["verdicts"]) == 7
        # consumer SOURCES line parsed into structured cited_sources
        assert detail["answers"]["q1"]["cited_sources"] == ["index.md"], detail["answers"]["q1"]
        # no locale → English everywhere: prompts, blue persona, progress lines
        assert "read-only knowledge consumer" in fake.systems["blue"], fake.systems["blue"][:120]
        assert seen and all(s.startswith("Self-check (PK)") for s in seen), seen
        prompt = redblue.build_pk_repair_prompt(summary)
        assert prompt.startswith("[System self-check · red-blue PK]"), prompt[:80]
        assert "[coverage]" in prompt  # stored 覆盖 token glossed at render time
        assert "补编X" in prompt and "p1.md" in prompt and "CONTRADICTIONS.json" in prompt
    print("OK  full run (stage counts / chunking 5+2 / decide / repair prompt, en default)")


async def test_survey_cache():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        wiki, raw = _pk_workspace(base)
        authoring = str(base / "authoring")
        fake = FakeEngine()
        s1, _ = await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=3,
                                     authoring_dir=authoring, questions_budget=2)
        assert fake.calls["survey"] == 1 and not s1["survey_cache_hit"]
        s2, _ = await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=3,
                                     authoring_dir=authoring, questions_budget=2)
        assert fake.calls["survey"] == 1 and s2["survey_cache_hit"]  # cache hit, no re-survey
        _mk(base, "raw/s/new.md", "新源")  # fingerprint rotates → cache invalid
        s3, _ = await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=3,
                                     authoring_dir=authoring, questions_budget=2)
        assert fake.calls["survey"] == 2 and not s3["survey_cache_hit"]
    print("OK  survey cache (hit on same raw / invalidated by raw change)")


async def test_questions_override_targeted_retest():
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine()
        override = [{"id": "q1", "question": "复测题", "expected": "exp", "source_ref": "a.md"},
                    {"id": "q9", "question": "复测题2", "expected": "exp", "source_ref": "a.md"}]
        summary, detail = await redblue.run_pk(
            fake, wiki_dir=wiki, raw_dir=raw, page_count=10, questions_override=override)
        assert fake.calls["survey"] == 0 and fake.calls["questions"] == 0, fake.calls
        assert fake.calls["blue"] == 2 and summary["questions"] == 2, (fake.calls, summary)
        assert summary["gate_pass"] == 1  # q1 still fails in the canned verdict
    print("OK  questions_override skips survey/questions (targeted retest primitive)")


async def test_dropped_verdicts_retry_then_ungraded():
    """The judge omitting ids from a chunk (seen live: 4/24, twice) gets ONE
    dedicated re-judge round; persistently missing ids land in `ungraded` —
    never in failures, never inflating the repair queue."""
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine(drop_verdict_ids={"q3"})
        summary, detail = await redblue.run_pk(
            fake, wiki_dir=wiki, raw_dir=raw, page_count=10, questions_budget=7)
        # 7 questions → 2 verdict chunks + 1 retry chunk for the missing id
        assert fake.calls["verdict"] == 3, fake.calls
        assert summary["ungraded"] == ["q3"], summary
        assert summary["graded"] == 6 and summary["gate_pass"] == 5, summary
        fails = {f["id"] for f in summary["failures"]}
        assert fails == {"q1"}, fails                     # only the REAL failure
        assert summary["pass_rate"] == round(5 / 6, 3)    # graded denominator
        assert "q3" not in detail["verdicts"]
    print("OK  dropped verdict ids → one re-judge → ungraded (not failures)")


async def test_wall_timeout_salvages_partial():
    """Wall-clock timeout with graded verdicts on hand → state=partial keeping
    the graded subset (the spend is sunk); ungraded questions are NOT failures."""
    import os
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine(slow_verdict_from=2)  # chunk 1 grades, chunk 2 hangs
        os.environ["KBC_PK_WALL_SECS"] = "2"
        os.environ["KBC_PK_CONCURRENCY"] = "1"  # serialize so chunk 1 finishes first
        try:
            summary, detail = await redblue.run_pk(
                fake, wiki_dir=wiki, raw_dir=raw, page_count=10, questions_budget=7)
        finally:
            del os.environ["KBC_PK_WALL_SECS"], os.environ["KBC_PK_CONCURRENCY"]
        assert summary["state"] == "partial", summary
        assert summary["graded"] == 5 and summary["questions"] == 7, summary
        assert len(summary["failures"]) == 1  # q1 fails in chunk 1; q6/q7 ungraded ≠ failed
        assert "error" in summary and len(detail["verdicts"]) == 5
    print("OK  wall timeout → partial salvage (graded kept, cancelled not failed)")


async def test_verdict_error_contained_no_workloss():
    """缺陷2 regression: a verdict chunk that ERRORS must not vaporize the sibling
    chunks that already graded (the old fail-fast gather did exactly that → 0/24
    salvaged in prod). The run completes on its own (no wall timeout); the failed
    chunk's ids land in ungraded WITH a stage=verdict reason. It found a genuine
    failure (q1) on a completed run → unconverged (repairable); ungraded ≠ partial
    here — partial is reserved for a run that was itself cut short (salvaged)."""
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        # 7 questions → chunks q1..q5 (grades) + q6,q7 (raises). concurrency 1 so
        # chunk 1 is committed before chunk 2 blows up.
        import os
        fake = FakeEngine(error_verdict_ids={"q6"})
        os.environ["KBC_PK_CONCURRENCY"] = "1"
        try:
            summary, detail = await redblue.run_pk(
                fake, wiki_dir=wiki, raw_dir=raw, page_count=10, questions_budget=7)
        finally:
            del os.environ["KBC_PK_CONCURRENCY"]
        # THE regression: chunk 1's five verdicts SURVIVED the sibling's hard error
        assert len(detail["verdicts"]) == 5, detail["verdicts"]
        assert summary["graded"] == 5, summary
        assert set(summary["ungraded"]) == {"q6", "q7"}, summary
        # the failure is OBSERVABLE: each ungraded id carries why + which stage
        reasons = summary["ungraded_reasons"]
        assert reasons["q6"]["stage"] == "verdict" and "boom" in reasons["q6"]["reason"], reasons
        # the run finished on its own (contained), it did NOT ride the wall clock
        assert summary["wall_secs"] < 20 and not summary.get("salvaged"), summary
        # q1's real failure still counts + drives repair; q6/q7 ungraded, NOT failures
        assert {f["id"] for f in summary["failures"]} == {"q1"}, summary["failures"]
        assert summary["state"] == "unconverged", summary  # completed run + real failure
    print("OK  verdict chunk error contained → graded siblings kept, reasons observable")


async def test_verdict_deagentified():
    """判官去 agentic (缺陷1 fix): the verdict call runs on the gate tier and is
    fenced OUT of raw — it grades from the inlined `expected` rubric, never by
    agentically re-reading raw (the loop that hung). survey/questions stay strong-
    tier and raw-capable."""
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine()
        await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=10,
                             questions_budget=7,
                             blue_model="B", judge_model="J")
        # verdict = gate tier (default sonnet), NOT the strong authoring judge "J"
        assert fake.models["verdict"] == "claude-sonnet-4-6", fake.models
        assert fake.models["survey"] == "J" and fake.models["questions"] == "J", fake.models
        assert fake.models["blue"] == "B", fake.models
        # verdict is fenced out of raw; survey/questions keep raw for real research
        assert raw not in fake.roots["verdict"], fake.roots["verdict"]
        assert raw in fake.roots["survey"] and raw in fake.roots["questions"], fake.roots
        # the verdict prompt no longer instructs raw reading (en default run)
        assert "do not attempt to read any files" in fake.users["verdict"], fake.users["verdict"][:200]
        assert "raw ground-truth points" in fake.users["verdict"]  # grades from the inlined rubric
        # KBC_PK_VERDICT_MODEL overrides the gate-tier default
        import os
        fake2 = FakeEngine()
        os.environ["KBC_PK_VERDICT_MODEL"] = "opus-override"
        try:
            await redblue.run_pk(fake2, wiki_dir=wiki, raw_dir=raw, page_count=3,
                                 questions_budget=2, judge_model="J")
        finally:
            del os.environ["KBC_PK_VERDICT_MODEL"]
        assert fake2.models["verdict"] == "opus-override", fake2.models
    print("OK  verdict de-agentified (gate tier, fenced out of raw, inlined rubric)")


async def test_media_pages_steer_question_officer():
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine()
        await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=3,
                             questions_budget=2,
                             media_pages={"p1.md": ["s/chart.png"]})
        assert "Chart-transcribed pages" in fake.users["questions"], fake.users["questions"][:200]
        assert "p1.md ← s/chart.png" in fake.users["questions"]
        assert "Chart-transcribed pages" not in fake.users["blue"]  # blue stays ignorant
    print("OK  media_pages reach the question officer only")


async def test_zh_locale_branch():
    """locale='zh' flips every model-facing prompt, the blue persona, and the
    progress/repair narration to Chinese; stored tokens (score/category/state)
    stay identical to the en run — locale never forks the data."""
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine()
        seen = []
        summary, _ = await redblue.run_pk(
            fake, wiki_dir=wiki, raw_dir=raw, page_count=10, questions_budget=7,
            progress=seen.append, locale="zh")
        assert "出题面调研" in fake.users["survey"], fake.users["survey"][:120]
        assert "出题官" in fake.users["questions"]
        assert "判分标准" in fake.users["verdict"]
        assert "只读的知识消费者" in fake.systems["blue"]  # zh test-role pack
        assert seen and all(s.startswith("自检(PK)") for s in seen), seen
        # stored tokens unchanged by locale
        assert summary["state"] == "unconverged"
        assert summary["failures"][0]["category"] == "覆盖", summary["failures"]
        prompt = redblue.build_pk_repair_prompt(summary, locale="zh")
        assert prompt.startswith("【系统自检 · 红蓝队】"), prompt[:60]
        assert "[覆盖]" in prompt and "补编X" in prompt
    print("OK  locale=zh flips prompts/persona/narration; stored tokens unchanged")


async def test_broken_json_fails_open():
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine(broken_stages={"survey"})
        summary, _ = await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=3)
        assert fake.calls["survey"] == 2  # one retry, then the stage fails
        assert summary["state"] == "failed" and "survey" in summary["error"], summary
        assert "wall_secs" in summary
    print("OK  broken JSON → one retry → state=failed (fail-open, never raises)")


async def test_contract_artifacts_judge_only():
    """INTENT/EXCLUSIONS (owner contract) reach every JUDGE stage; the blue
    team gets none of it — a real consumer doesn't know the scope deal."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        wiki, raw = _pk_workspace(base)
        authoring = base / "authoring"
        _mk(base, "authoring/INTENT.md", "受众=平台新同事,专注操作问答")
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "s/tickets/*", "reason": "周报时效性强"}]))
        fake = FakeEngine()
        await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=3,
                             authoring_dir=str(authoring), questions_budget=2)
        for stage in ("survey", "questions", "verdict"):
            assert "平台新同事" in fake.systems[stage], stage  # INTENT content quoted verbatim
            assert "周报时效性强" in fake.systems[stage], stage  # exclusion reason quoted verbatim
            assert "declared excluded" in fake.systems[stage], stage
        assert "平台新同事" not in fake.systems["blue"]
        assert "周报时效性强" not in fake.systems["blue"]

        # without authoring_dir the judge context carries neither
        fake2 = FakeEngine()
        await redblue.run_pk(fake2, wiki_dir=wiki, raw_dir=raw, page_count=3, questions_budget=2)
        assert "declared excluded" not in fake2.systems["survey"]
    print("OK  INTENT/EXCLUSIONS reach judge stages only, blue stays ignorant")


def test_pk_section_survives_layer1():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/a.md")
        _mk(base, "candidate/index.md", "---\ntype: index\n---\ni")
        _mk(base, "candidate/p.md", "---\ncompiled_from:\n  - a.md\n---\nx")
        selfcheck.write_selfcheck(td, selfcheck.run_layer1(td))
        selfcheck.update_pk_section(td, {"state": "passed", "questions": 7})
        report = selfcheck.run_layer1(td)  # an L1 re-check must carry pk forward
        assert report["pk"] == {"state": "passed", "questions": 7}, report["pk"]
        assert report["coverage"]["closed"]
    print("OK  pk section survives Layer-1 re-checks (update_pk_section merge)")


def test_stage_wiki_copy_and_seeds():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "export/index.md", "# t\n[集群与区域](01_集群.md)")
        _mk(base, "export/01_集群.md", "c")
        _mk(base, "export/media.png", "binary-ish")
        snap = redblue.stage_wiki_copy(str(base / "export"), str(base / "snap"))
        k = Path(snap) / ".siclaw" / "knowledge"
        assert (k / "index.md").is_file() and (k / "01_集群.md").is_file()
        assert not (k / "media.png").exists()  # only md/json staged
        _mk(base, "raw/snapshot-1/x.md")
        seeds = redblue.derive_area_seeds(str(base / "raw"), snap)
        assert "snapshot-1" in seeds and "集群与区域" in seeds, seeds
    print("OK  stage_wiki_copy (.siclaw/knowledge layout) + derive_area_seeds")


def main():
    test_budget_and_helpers()
    test_parse_json_lenient_cases()
    test_path_escape_multi()
    asyncio.run(test_full_run())
    asyncio.run(test_survey_cache())
    asyncio.run(test_questions_override_targeted_retest())
    asyncio.run(test_dropped_verdicts_retry_then_ungraded())
    asyncio.run(test_wall_timeout_salvages_partial())
    asyncio.run(test_verdict_error_contained_no_workloss())
    asyncio.run(test_verdict_deagentified())
    asyncio.run(test_media_pages_steer_question_officer())
    asyncio.run(test_zh_locale_branch())
    asyncio.run(test_broken_json_fails_open())
    asyncio.run(test_contract_artifacts_judge_only())
    test_pk_section_survives_layer1()
    test_stage_wiki_copy_and_seeds()
    print("ALL OK  test_redblue")


if __name__ == "__main__":
    main()
