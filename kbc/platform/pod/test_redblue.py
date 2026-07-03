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

    def __init__(self, broken_stages=()):
        self.calls = {"survey": 0, "questions": 0, "blue": 0, "verdict": 0}
        self.broken = set(broken_stages)

    async def run_readonly_agent(self, *, cwd, system_prompt, user_message,
                                 model, effort=None, allowed_read_roots, timeout_secs):
        if "出题面调研" in user_message:
            stage = "survey"
        elif "出题官" in user_message:
            stage = "questions"
        elif "判分标准" in user_message:
            stage = "verdict"
        elif "只读的知识消费者" in system_prompt:
            stage = "blue"
        else:
            raise AssertionError(f"unroutable prompt: {user_message[:80]}")
        self.calls[stage] += 1
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
        ids = re.findall(r"\[(q\d+)\]", user_message)
        assert ids, "chunk prompt carries no question ids"
        if stage == "blue":
            return json.dumps([{"id": i, "answer": "答", "cited_sources": ["index.md"],
                                "said_uncovered": False} for i in ids])
        out = []
        for i in ids:  # verdict: q1 fails as 覆盖, everything else passes
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
    assert redblue.question_budget(20) == 30    # 20*1.5
    assert redblue.question_budget(100) == 40   # cap
    assert redblue._chunks([1, 2, 3, 4, 5, 6, 7], 5) == [[1, 2, 3, 4, 5], [6, 7]]
    print("OK  question_budget clamp + chunks")


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
        summary, detail = await redblue.run_pk(
            fake, wiki_dir=wiki, raw_dir=raw, page_count=10, questions_budget=7)
        assert fake.calls == {"survey": 1, "questions": 1, "blue": 2, "verdict": 2}, fake.calls
        assert summary["state"] == "unconverged" and summary["questions"] == 7, summary
        assert summary["gate_pass"] == 6 and len(summary["failures"]) == 1, summary
        f = summary["failures"][0]
        assert f["category"] == "覆盖" and f["page"] == "p1.md", f
        assert len(detail["answers"]) == 7 and len(detail["verdicts"]) == 7
        prompt = redblue.build_pk_repair_prompt(summary)
        assert "补编X" in prompt and "p1.md" in prompt and "CONTRADICTIONS.json" in prompt
    print("OK  full run (stage counts / chunking 5+2 / decide / repair prompt)")


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
        assert fake.calls["blue"] == 1 and summary["questions"] == 2, (fake.calls, summary)
        assert summary["gate_pass"] == 1  # q1 still fails in the canned verdict
    print("OK  questions_override skips survey/questions (targeted retest primitive)")


async def test_broken_json_fails_open():
    with tempfile.TemporaryDirectory() as td:
        wiki, raw = _pk_workspace(Path(td))
        fake = FakeEngine(broken_stages={"survey"})
        summary, _ = await redblue.run_pk(fake, wiki_dir=wiki, raw_dir=raw, page_count=3)
        assert fake.calls["survey"] == 2  # one retry, then the stage fails
        assert summary["state"] == "failed" and "survey" in summary["error"], summary
        assert "wall_secs" in summary
    print("OK  broken JSON → one retry → state=failed (fail-open, never raises)")


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
    asyncio.run(test_broken_json_fails_open())
    test_pk_section_survives_layer1()
    test_stage_wiki_copy_and_seeds()
    print("ALL OK  test_redblue")


if __name__ == "__main__":
    main()
