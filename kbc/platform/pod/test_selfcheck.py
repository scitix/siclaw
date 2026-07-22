"""Tests for the Layer-1 compile self-check (selfcheck.py + compile_box wiring).

Pure-function tests need only stdlib; the wiring test imports compile_box
(claude-agent-sdk required, same as test_compile_box.py). Run:
    python test_selfcheck.py
"""

import asyncio
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

import selfcheck


def _mk(base: Path, rel: str, text: str = "x"):
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


PAGE_FULL = """---
type: 主题
compiled_from:
  - "85b3e13a · snapshot-a/one.md"
  - snapshot-a/two.md
  - 'raw/snapshot-b/three.txt'
---
正文 [[other]] 和 [链接](other.md)
"""

PAGE_DERIVED = """---
type: glossary
derived: true
---
综合页,无直接 raw 来源。
"""

PAGE_BARE = """---
type: 主题
---
没有 compiled_from 的页。
"""


def test_parse_compiled_from():
    src, derived, has = selfcheck.parse_compiled_from(PAGE_FULL)
    assert src == ["snapshot-a/one.md", "snapshot-a/two.md", "snapshot-b/three.txt"], src
    assert not derived and has
    src, derived, has = selfcheck.parse_compiled_from(PAGE_DERIVED)
    assert src == [] and derived and not has
    src, derived, has = selfcheck.parse_compiled_from(PAGE_BARE)
    assert src == [] and not derived and not has
    src, _, has = selfcheck.parse_compiled_from("---\ntype: Topic\ncompiled_from: []\n---\nx")
    assert src == [] and has
    src, _, has = selfcheck.parse_compiled_from("no frontmatter at all")
    assert src == [] and not has
    print("OK  parse_compiled_from (hash·path / plain / quoted / raw-prefix / derived / inline-empty)")


def test_okf_v01_conformance():
    valid = "---\ntype: Topic\ntitle: T\ndescription: 'why: open this'\n---\nBody"
    fm, body, error = selfcheck.parse_okf_frontmatter(valid)
    assert not error and fm["type"] == "Topic" and body == "Body", (fm, body, error)
    assert selfcheck.parse_okf_frontmatter("# no metadata")[2]
    assert selfcheck.parse_okf_frontmatter("---\ntype: [\n---\nx")[2]
    assert selfcheck.parse_okf_frontmatter("---\n- not\n- a mapping\n---\nx")[2]

    pages = {
        "index.md": {"text": '---\nokf_version: "0.1"\n---\n# Contents\n- [Topic](topic.md) - summary'},
        "topic.md": {"text": valid},
        "log.md": {"text": "# Update log\n## 2026-07-11\n- **Creation**: Added [Topic](topic.md)."},
    }
    assert selfcheck.format_policy_violations(pages) == []

    code_examples = {
        "index.md": pages["index.md"],
        "topic.md": {"text": valid + "\n\n```bash\nif [[ -f /etc/foo ]]; then\n  echo yes\nfi\n```"
                              "\nRun `if [[ -f /etc/foo ]]; then echo yes; fi`."
                              "\nExample: `[root](/tables/example.md)`."},
    }
    assert selfcheck.format_policy_violations(code_examples) == []

    no_version = {**pages, "index.md": {"text": "# Contents\n- [Topic](topic.md) - summary"}}
    assert selfcheck.okf_v01_violations(no_version) == []
    assert {v["kind"] for v in selfcheck.siclaw_portable_output_violations(no_version)} == {
        "siclaw_profile_version_declaration"
    }

    broken = {
        "index.md": {"text": "---\nokf_version: \"0.1\"\n---\n# Index\n- [[bad]]"},
        "missing.md": {"text": "# no frontmatter"},
        "empty.md": {"text": "---\ntype: '  '\n---\nx"},
        "links.md": {"text": "---\ntype: Topic\n---\n[[old]] [root](/root.md)"},
        "sub/index.md": {"text": "---\nokf_version: '0.1'\n---\n# Nested"},
        "log.md": {"text": "---\ntype: log\n---\n# Log\n## 2026-99-99\nentry"},
    }
    kinds = {v["kind"] for v in selfcheck.format_policy_violations(broken)}
    assert {
        "okf_index_frontmatter", "okf_index_structure", "okf_frontmatter", "okf_type",
        "siclaw_profile_wikilink", "siclaw_profile_bundle_link",
        "okf_log_frontmatter", "okf_log_structure",
    } <= kinds, kinds

    empty_latest = {
        "index.md": pages["index.md"],
        "log.md": {"text": "# Log\n\n## 2026-07-11\n\n## 2026-07-10\n\n- older entry"},
    }
    log_violations = selfcheck.okf_v01_violations(empty_latest)
    assert any(v["kind"] == "okf_log_structure" and "2026-07-11" in v["detail"]
               for v in log_violations), log_violations
    print("OK  OKF v0.1 core conformance + Siclaw portable-output profile")


def test_markdown_code_is_not_a_link():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md",
            "---\nokf_version: \"0.1\"\n---\n# Index\n- [A](a.md)")
        _mk(base, "candidate/a.md",
            "---\ntype: Guide\ncompiled_from:\n  - s/a.md\n---\n"
            "# Bash\n```bash\nif [[ -f /etc/foo ]]; then\n  echo yes\nfi\n```\n"
            "Inline: `[[ not-a-link ]]` and `[root](/example.md)`.\n")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"], report
        assert report["lint"]["ok"], report["lint"]

        # A real prose wikilink still bites; code masking must not weaken the
        # Siclaw new-output profile.
        _mk(base, "candidate/a.md",
            "---\ntype: Guide\ncompiled_from:\n  - s/a.md\n---\nSee [[missing]].\n")
        report = selfcheck.run_layer1(td)
        kinds = {v["kind"] for v in report["lint"]["violations"]}
        assert {"broken_wikilink", "siclaw_profile_wikilink"} <= kinds, kinds
    print("OK  markdown code masked while real prose links still fail")


def test_emit_ignores_links_in_code():
    """The legacy ledger emitter enforces the same prose-only link profile."""
    fake_llm = types.ModuleType("llm")
    fake_llm.call_json = lambda _: None
    old_llm = sys.modules.get("llm")
    sys.modules["llm"] = fake_llm
    try:
        emit_path = Path(__file__).parents[2] / "tools" / "emit.py"
        spec = importlib.util.spec_from_file_location("kbc_test_emit", emit_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        ledger = {"claims": [{"text": "x", "src": "a.md"}], "findings": {}}
        page = {"filename": "guide.md", "type": "Guide", "title": "Guide", "description": "d",
                "body": "```bash\nif [[ -f /etc/foo ]]; then echo yes; fi\n```\n`[root](/x.md)`"}
        module.call_json = lambda _: {"pages": [page]}
        with tempfile.TemporaryDirectory() as td:
            assert module.emit(ledger, td) == ["guide.md"]

        module.call_json = lambda _: {"pages": [{**page, "body": "See [[legacy]]."}]}
        with tempfile.TemporaryDirectory() as td:
            try:
                module.emit(ledger, td)
                raise AssertionError("real wikilink must fail")
            except ValueError as exc:
                assert "wikilink" in str(exc)
    finally:
        if old_llm is None:
            sys.modules.pop("llm", None)
        else:
            sys.modules["llm"] = old_llm
    print("OK  emit link profile ignores fenced/inline code and rejects prose wikilinks")


def test_inventory_and_exclusions():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snapshot-a/one.md")
        _mk(base, "raw/snapshot-a/pic.png")            # media → ALSO ledger-accountable
        _mk(base, "raw/.hidden/x.md")                  # hidden dir → skipped
        _mk(base, "raw/media/MANIFEST.tsv")            # text file in media dir → counted
        inv = selfcheck.source_inventory(td)
        assert inv == ["media/MANIFEST.tsv", "snapshot-a/one.md", "snapshot-a/pic.png"], inv
        assert selfcheck.source_inventory(td + "/nope") == []

        # exclusions: missing file → none; malformed → error; glob + dir-prefix forms
        assert selfcheck.load_exclusions(td) == ([], [])
        _mk(base, "authoring/EXCLUSIONS.json", "not json")
        entries, errs = selfcheck.load_exclusions(td)
        assert entries == [] and errs, (entries, errs)
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "media/", "reason": "媒体元文件"},
                        {"pattern": "snapshot-*/TICKET_*", "reason": "周报"},
                        {"bad": "entry"}]))
        entries, errs = selfcheck.load_exclusions(td)
        assert len(entries) == 2 and len(errs) == 1, (entries, errs)
        assert selfcheck._matches("media/MANIFEST.tsv", "media/")
        assert selfcheck._matches("snapshot-1/TICKET_x.md", "snapshot-*/TICKET_*")
        assert not selfcheck._matches("snapshot-1/one.md", "media/")
    print("OK  source_inventory + load_exclusions (text-only / hidden / glob / dir-prefix / malformed)")


def test_coverage_and_lint():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snapshot-a/one.md")
        _mk(base, "raw/snapshot-a/two.md")
        _mk(base, "raw/snapshot-a/ticket.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p1](p1.md)")
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ncompiled_from:\n  - snapshot-a/one.md\n  - snapshot-a/ghost.md\n---\n[[nope]]")
        _mk(base, "candidate/bare.md", PAGE_BARE)
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "snapshot-a/ticket.md", "reason": "工单周报"}]))
        report = selfcheck.run_layer1(td)
        cov = report["coverage"]
        assert cov["total_sources"] == 3 and cov["excluded"] == 1, cov
        assert cov["unaccounted"] == ["snapshot-a/two.md"], cov
        assert cov["dangling_citations"] == ["snapshot-a/ghost.md"], cov
        assert not cov["closed"]
        kinds = sorted(v["kind"] for v in report["lint"]["violations"])
        # bare.md lacks provenance AND is unreachable from index; p1 has a
        # broken wikilink; index is exempt
        assert kinds == ["broken_wikilink", "no_provenance", "orphan", "siclaw_profile_wikilink"], kinds

        # repair prompt names the concrete gaps — locale-threaded, platform default = en
        report["state"] = "repairing"
        prompt = selfcheck.build_repair_prompt(report)  # default locale → en
        assert "snapshot-a/two.md" in prompt and "ghost.md" in prompt and "EXCLUSIONS.json" in prompt
        assert "Unaccounted raw source files" in prompt  # English by default
        zh_prompt = selfcheck.build_repair_prompt(report, "zh")
        assert "snapshot-a/two.md" in zh_prompt and "未入账" in zh_prompt
        assert "unaccounted" in selfcheck.narration(report, "en")
        assert "未入账" in selfcheck.narration(report, "zh")

        # close the ledger: cite two.md from bare.md (also fixes its provenance) + fix link
        _mk(base, "candidate/bare.md", "---\ntype: Topic\ncompiled_from:\n  - snapshot-a/two.md\n---\nok")
        _mk(base, "candidate/p1.md", "---\ntype: Topic\ncompiled_from:\n  - snapshot-a/one.md\n---\n[bare](bare.md)")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report
        report["state"] = "passed"
        assert "closed" in selfcheck.narration(report)  # default locale → en
        assert "闭合" in selfcheck.narration(report, "zh")
    print("OK  coverage + lint + repair prompt (unaccounted / dangling / exempt index / close / locale)")


def test_candidate_credential_lint():
    """Obvious credentials block convergence without echoing their value, while
    ordinary internal detail and explicit placeholders remain publishable."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        secrets = [
            "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1m2N3p4",
            "sk-" + "A1b2C3d4E5f6G7h8I9j0K1",
            "sk-" + "A1b2testC3d4E5f6G7h8I9j0K1",
            "ghp_" + "a" * 36,
            "github_pat_" + "c" * 25,
            "xoxb-" + "d" * 25,
            "AIza" + "E" * 35,
            "Bearer " + "f" * 32,
            '"password": "correct-horse-battery-staple"',
            "API_KEY=long-random-credential-value",
            "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        ]
        _mk(base, "candidate/p.md",
            "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\n"
            + "\n".join(secrets) + "\n")

        report = selfcheck.run_layer1(td)
        findings = [v for v in report["lint"]["violations"]
                    if v["kind"] == "credential_exposure"]
        assert len(findings) == len(secrets), findings
        assert report["coverage"]["closed"] and not report["lint"]["ok"], report
        serialized = json.dumps(report)
        assert all(secret not in serialized for secret in secrets)
        prompt = selfcheck.build_repair_prompt({**report, "state": "repairing"})
        assert "credential_exposure" in prompt and "[REDACTED]" in prompt
        assert all(secret not in prompt for secret in secrets)

        _mk(base, "candidate/p.md",
            "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\n"
            "Internal host: api.infra.local (10.0.0.42), owner +86 13800000000.\n"
            "Examples: `sk-<your-key>`, `TOKEN=${TOKEN}`, and [REDACTED].\n")
        clean = selfcheck.run_layer1(td)
        assert clean["coverage"]["closed"] and clean["lint"]["ok"], clean
    print("OK  candidate credential lint (high-confidence, non-echoing, placeholder-safe)")


def test_media_ledger_and_new_lint():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/chart.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p1](p1.md)")
        # body cites the image but compiled_from omits it → body_source_uncited;
        # the image itself is unaccounted (media is in the ledger now)
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ntitle: 监控\ncompiled_from:\n  - s/a.md\n---\n利用率 94%。(source: chart.png)")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["unaccounted"] == ["s/chart.png"], report["coverage"]
        kinds = sorted(v["kind"] for v in report["lint"]["violations"])
        assert kinds == ["body_source_uncited"], kinds
        # (来源: 内部访谈) / locators must NOT false-positive
        assert selfcheck._body_source_files("x (来源: 内部访谈) y (source: g.md, §3)") == ["g.md"]

        # register the image → ledger closes, lint clean, dangling stays empty
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ntitle: 监控\ncompiled_from:\n  - s/a.md\n  - s/chart.png\n---\n利用率 94%。(source: chart.png)")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report
        assert report["coverage"]["dangling_citations"] == [], report["coverage"]

        # dup candidates: same normalized title / heavy source overlap
        _mk(base, "raw/s/b.md")
        _mk(base, "candidate/p2.md",
            "---\ntype: Topic\ntitle: 监控\ncompiled_from:\n  - s/b.md\n---\n[p1](p1.md)")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p1](p1.md)\n- [p2](p2.md)")
        report = selfcheck.run_layer1(td)
        dups = report["dup_candidates"]
        assert len(dups) == 1 and sorted(dups[0]["pages"]) == ["p1.md", "p2.md"], dups
        assert dups[0]["reason"] == "标题相同", dups
    print("OK  media ledger + body_source_uncited + orphan-free close + dup_candidates")


def test_body_source_annotations():
    """Body provenance keeps complete imported filenames and fails closed."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        first = "docs/MCP 工具与结果设计指南-70f5bd35.md"
        second = "docs/Skill Knowledge 指南.md"
        report_pdf = "docs/性能报告.pdf"
        punctuated = "docs/上线方案（终版）、GPU 调度，修订；v2.md"
        ascii_punctuated = "docs/Release (final), GPU scheduling; v2.md"
        _mk(base, f"raw/{first}")
        _mk(base, f"raw/{second}")
        _mk(base, f"raw/{report_pdf}")
        _mk(base, f"raw/{punctuated}")
        _mk(base, f"raw/{ascii_punctuated}")
        _mk(base, "candidate/index.md",
            "---\nokf_version: \"0.1\"\n---\n# Index\n- [Guide](guide.md)")

        def write_page(body: str) -> None:
            _mk(base, "candidate/guide.md",
                "---\ntype: Guide\ntitle: Guide\ncompiled_from:\n"
                f"  - {first}\n  - {second}\n  - {report_pdf}\n  - {punctuated}\n"
                f"  - {ascii_punctuated}\n---\n{body}")

        combined = ("(source: MCP 工具与结果设计指南-70f5bd35.md, "
                    "Skill Knowledge 指南.md, §3) (source: legacy.md, p.12)")
        assert selfcheck._body_source_files(combined) == [
            "MCP 工具与结果设计指南-70f5bd35.md",
            "Skill Knowledge 指南.md",
            "legacy.md",
        ]

        punctuated_body = (
            f"正文。（source: {Path(punctuated).name}）\n"
            f"More. (source: {Path(ascii_punctuated).name})"
        )
        assert selfcheck._body_source_files(punctuated_body) == [
            Path(punctuated).name,
            Path(ascii_punctuated).name,
        ]
        write_page(punctuated_body)
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report

        write_page(
            f"正文。(source: {Path(first).name})\n\n"
            "```markdown\n(source: Missing Imported Guide.md)\n```"
        )
        report = selfcheck.run_layer1(td)
        assert report["lint"]["ok"], report["lint"]

        # A locator may follow a complete filename directly after whitespace.
        # This is the natural form emitted by agents and documented by the
        # provenance contract; it must not require an artificial comma.
        write_page(
            f"正文。(source: {Path(first).name} §3)\n"
            f"More. (source: {Path(report_pdf).name} p.12)\n"
            f"更多。（来源: {Path(punctuated).name} 第3节）\n"
            f"Combined. (source: {Path(first).name} §3, "
            f"{Path(report_pdf).name} lines 10-12)\n"
            f"Plural. (source: {Path(report_pdf).name} Pages 3-5)\n"
            f"List. (source: {Path(report_pdf).name} Pages 2, 4)\n"
            f"Short plural. (source: {Path(report_pdf).name} pp. 8-9)"
        )
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report

        write_page("正文。"
                   "(source: MCP 工具与结果设计指南-70f5bd35.md, "
                   "Skill Knowledge 指南.md, §3)")
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["closed"] and report["lint"]["ok"], report

        write_page("正文。(source: Missing Imported Guide.md)")
        report = selfcheck.run_layer1(td)
        body_violations = [v for v in report["lint"]["violations"]
                           if v["kind"] == "body_source_uncited"]
        assert len(body_violations) == 1, report["lint"]
        assert "Missing Imported Guide.md" in body_violations[0]["detail"], body_violations

        # A locator does not make an unknown file valid: recognize the complete
        # filename, then let the existing provenance gate report it as uncited.
        write_page("正文。(source: Missing Imported Guide.md lines 10-12)")
        report = selfcheck.run_layer1(td)
        kinds = [v["kind"] for v in report["lint"]["violations"]]
        assert kinds.count("body_source_uncited") == 1, report["lint"]
        assert "body_source_malformed" not in kinds, report["lint"]

        write_page("正文。(source: MCP 工具与结果设计指南-70f5bd35)")
        report = selfcheck.run_layer1(td)
        body_violations = [v for v in report["lint"]["violations"]
                           if v["kind"] == "body_source_malformed"]
        assert len(body_violations) == 1, report["lint"]
        assert "完整文件名和扩展名" in body_violations[0]["detail"], body_violations

        write_page(f"正文。(source: {Path(first).name} arbitrary prose)")
        report = selfcheck.run_layer1(td)
        assert any(v["kind"] == "body_source_malformed"
                   for v in report["lint"]["violations"]), report["lint"]
    print("OK  body source annotations (spaces / combined / locator / unknown / missing extension)")


def test_deterministic_body_source_normalization():
    """Exact, unique aliases repair mechanically; ambiguity and code stay put."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n")
        page = base / "candidate" / "guide.md"
        original = (
            "---\ntype: Guide\ntitle: Guide\ncompiled_from:\n"
            "  - docs/专题目录.md\n---\n"
            "正文。（source: “专题目录” 第3节）\n"
            "```markdown\n(source: 专题目录)\n```\n"
        )
        _mk(base, "candidate/guide.md", original)

        fixes = selfcheck.normalize_body_source_annotations(td)
        assert fixes == [{
            "rule": "body_source_exact_alias",
            "page": "guide.md",
            "from": "“专题目录” 第3节",
            "to": "docs/专题目录.md 第3节",
        }], fixes
        updated = page.read_text()
        assert "（source: docs/专题目录.md 第3节）" in updated, updated
        assert "```markdown\n(source: 专题目录)\n```" in updated, updated
        assert not any(v["kind"] == "body_source_malformed"
                       for v in selfcheck.run_layer1(td)["lint"]["violations"])

        # A second pass is byte-identical and emits no duplicate audit record.
        stable = page.read_bytes()
        assert selfcheck.normalize_body_source_annotations(td) == []
        assert page.read_bytes() == stable

        # Duplicate stems are genuinely ambiguous and must remain for semantic
        # repair rather than silently choosing one source.
        ambiguous = (
            "---\ntype: Guide\ntitle: Ambiguous\ncompiled_from:\n"
            "  - a/专题目录.md\n  - b/专题目录.pdf\n---\n"
            "正文。(source: 专题目录)\n"
        )
        _mk(base, "candidate/ambiguous.md", ambiguous)
        before = (base / "candidate" / "ambiguous.md").read_bytes()
        assert selfcheck.normalize_body_source_annotations(
            td, allowed_pages={"ambiguous.md"}) == []
        assert (base / "candidate" / "ambiguous.md").read_bytes() == before
        report = selfcheck.run_layer1(td)
        assert any(v["page"] == "ambiguous.md" and v["kind"] == "body_source_malformed"
                   for v in report["lint"]["violations"]), report["lint"]

        # An unbalanced ASCII ")" inside a full-width marker makes the
        # ASCII-wrapped re-parse close early; rewriting would silently drop
        # the ")节选" tail. The span must stay put as a lint failure.
        truncating = (
            "---\ntype: Guide\ntitle: Truncating\ncompiled_from:\n"
            "  - docs/报告.md\n---\n正文。（source: 报告)节选）\n"
        )
        _mk(base, "candidate/truncating.md", truncating)
        assert selfcheck.normalize_body_source_annotations(
            td, allowed_pages={"truncating.md"}) == []
        assert (base / "candidate" / "truncating.md").read_text() == truncating
        assert any(v["page"] == "truncating.md" and v["kind"] == "body_source_malformed"
                   for v in selfcheck.run_layer1(td)["lint"]["violations"])

        scoped = (
            "---\ntype: Guide\ntitle: Scoped\ncompiled_from:\n"
            "  - docs/only-this.md\n---\n正文。(source: only-this)\n"
        )
        _mk(base, "candidate/scoped.md", scoped)
        assert selfcheck.normalize_body_source_annotations(
            td, allowed_pages={"ambiguous.md"}) == []
        assert (base / "candidate" / "scoped.md").read_text() == scoped
    print("OK  deterministic source normalization (unique / locator / code / ambiguous / truncation-guard / idempotent)")


def test_spaced_markdown_links():
    """Spaced page paths resolve in both CommonMark and URL-encoded forms."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/source.md")
        _mk(base, "candidate/space page.md",
            "---\ntype: Topic\ncompiled_from:\n  - source.md\n---\n# Space page")

        def write_index(target: str) -> None:
            _mk(base, "candidate/index.md",
                "---\nokf_version: \"0.1\"\n---\n# Index\n"
                f"- [Space page]({target}) - summary")

        for target in ("<space page.md>", "space%20page.md", "space page.md"):
            write_index(target)
            report = selfcheck.run_layer1(td)
            assert report["lint"]["ok"], (target, report["lint"])
    print("OK  spaced markdown links (angle / percent-encoded / tolerant raw)")


def test_charset_corruption_detection():
    """U+FFFD (the lossy-UTF-8-decode marker) anywhere in a page — path OR body
    prose — must block state=passed. Body-prose corruption is INVISIBLE to the
    coverage ledger (it only diffs paths), so this lint is the only guard against
    silently shipping a \ufffd in published text (siflow-test 2026-07-07: 需/础/成 got
    mangled to 3× U+FFFD by an upstream stream chunk-boundary split)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p1](p1.md)")
        # U+FFFD in BODY prose only — paths are clean, so coverage closes.
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ntitle: t\ncompiled_from:\n  - s/a.md\n---\n基\ufffd设施层说明。(source: a.md)")
        report = selfcheck.run_layer1(td)
        # The ledger alone would ship it: coverage is closed (corruption is prose).
        assert report["coverage"]["closed"], report["coverage"]
        # The lint catches it → not ok → compile_box cannot set state=passed.
        viols = [v for v in report["lint"]["violations"] if v["kind"] == "charset_corruption"]
        assert len(viols) == 1 and viols[0]["page"] == "p1.md", report["lint"]
        assert "第6行" in viols[0]["detail"], viols[0]["detail"]
        assert not report["lint"]["ok"]
        # It is surfaced to the model in the bounded repair turn.
        assert "charset_corruption" in selfcheck.build_repair_prompt(report)
        # A corrupted PATH is caught too (redundant with coverage's dangling, but
        # with actionable "restore from raw" guidance instead of "fix the path").
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ntitle: t\ncompiled_from:\n  - s/\ufffd.md\n---\nclean body。(source: a.md)")
        report = selfcheck.run_layer1(td)
        assert any(v["kind"] == "charset_corruption" for v in report["lint"]["violations"])
        # Clean page → no charset violation, ledger closes, lint ok.
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ntitle: t\ncompiled_from:\n  - s/a.md\n---\n基础设施层说明。(source: a.md)")
        report = selfcheck.run_layer1(td)
        assert all(v["kind"] != "charset_corruption" for v in report["lint"]["violations"])
        assert report["lint"]["ok"] and report["coverage"]["closed"], report
    print("OK  charset_corruption (U+FFFD) detection — path + body, blocks passed")


def test_media_verify_helpers():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/chart.png")
        _mk(base, "raw/s/other.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p1](p1.md)\n- [t](text-only.md)")
        # compiled_from full path + body basename citation both resolve
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/chart.png\n---\n94%。(source: other.png)")
        _mk(base, "candidate/text-only.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")
        citing = selfcheck.media_citing_pages(td)
        assert citing == {"p1.md": ["s/chart.png", "s/other.png"]}, citing

        pending = selfcheck.pending_media_verification(td)
        assert list(pending) == ["p1.md"]

        selfcheck.mark_media_verified(td, list(pending))
        assert selfcheck.pending_media_verification(td) == {}
        # run_layer1 must carry media_verify forward (not wipe it)
        report = selfcheck.run_layer1(td)
        assert report["media_verify"]["verified_pages"] == ["p1.md"], report["media_verify"]
        assert report["media_verify"]["summary"] == {
            "total_pages": 1, "passed_pages": 1, "exhausted_pages": 0,
            "pending_pages": 0, "total_images": 2, "pending_images": 0,
        }, report["media_verify"]
        selfcheck.write_selfcheck(td, report)
        assert selfcheck.pending_media_verification(td) == {}
    print("OK  media_citing_pages + pending/mark idempotency + carry-forward")


def test_media_verify_content_identity_and_attempt_reset():
    """A verified path is not a verified future revision of that page/image."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/chart.png", "image-v1")
        _mk(base, "candidate/index.md",
            "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        page = base / "candidate/p.md"
        _mk(base, "candidate/p.md",
            "---\ntype: Topic\ncompiled_from:\n  - chart.png\n---\nvalue 1")

        selfcheck.mark_media_verified(td, ["p.md"])
        assert selfcheck.pending_media_verification(td) == {}

        # Same path, edited claim: must re-enter and get a fresh retry budget.
        page.write_text(page.read_text() + "\nvalue 2", encoding="utf-8")
        assert list(selfcheck.pending_media_verification(td)) == ["p.md"]
        assert selfcheck.bump_media_attempts(td, ["p.md"])["p.md"] == 1
        assert selfcheck.bump_media_attempts(td, ["p.md"])["p.md"] == 2

        # Same page, same image path, replaced bytes: identity changes and the
        # previous revision's two failed attempts must not exhaust this one.
        (base / "raw/chart.png").write_text("image-v2", encoding="utf-8")
        assert list(selfcheck.pending_media_verification(td)) == ["p.md"]
        assert selfcheck.bump_media_attempts(td, ["p.md"])["p.md"] == 1

        selfcheck.mark_media_verified(td, ["p.md"], exhausted=True)
        report = selfcheck.read_selfcheck(td)
        assert report["media_verify"]["summary"]["exhausted_pages"] == 1, report
        assert report["media_verify"]["summary"]["passed_pages"] == 0, report

        # A later repair re-arms an exhausted page; a clean verify clears the
        # stale exhausted flag and records the repaired fingerprint as passed.
        page.write_text(page.read_text() + "\nrepaired", encoding="utf-8")
        assert list(selfcheck.pending_media_verification(td)) == ["p.md"]
        selfcheck.mark_media_verified(td, ["p.md"])
        report = selfcheck.read_selfcheck(td)
        assert report["media_verify"]["summary"]["passed_pages"] == 1, report
        assert report["media_verify"]["summary"]["exhausted_pages"] == 0, report
        assert report["media_verify"]["exhausted"] == [], report
    print("OK  media verification identity = page bytes + cited image bytes; retries reset per revision")


def test_cap_media_pending():
    pend = {"a.md": ["i1", "i2"], "b.md": ["i3"], "c.md": ["i4", "i5", "i6"]}
    c = selfcheck.cap_media_pending(pend, 3)
    assert c == {"a.md": ["i1", "i2"], "b.md": ["i3"]}, c
    # an oversized single page is still included alone (progress guaranteed)
    c2 = selfcheck.cap_media_pending({"z.md": ["1", "2", "3", "4"]}, 2)
    assert list(c2) == ["z.md"]
    print("OK  cap_media_pending (whole pages / oversized-single)")


def test_dangling_alone_blocks_closed():
    """L1: closed = consistent in BOTH directions. A lone dangling citation (all
    sources accounted, lint clean) used to sail through settle as display-only
    owner homework on the publish page — it must gate the repair loop instead."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snap/one.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p1](p1.md)")
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ncompiled_from:\n  - snap/one.md\n  - snap/deleted-long-ago.md\n---\n正文。")
        cov = selfcheck.run_layer1(td)["coverage"]
        assert cov["unaccounted"] == [] and cov["dangling_citations"] == ["snap/deleted-long-ago.md"], cov
        assert not cov["closed"], "a dangling citation alone must keep the ledger open"
        # narration names the dangling count so a dangling-only repair round is explained
        report = {"coverage": cov, "lint": {"ok": True, "violations": []}, "state": "repairing"}
        assert "悬空引用" in selfcheck.narration(report, "zh")
        assert "dangling" in selfcheck.narration(report, "en")
        # fix the citation → closed
        _mk(base, "candidate/p1.md", "---\ntype: Topic\ncompiled_from:\n  - snap/one.md\n---\n正文。")
        cov2 = selfcheck.run_layer1(td)["coverage"]
        assert cov2["closed"], cov2
        print("OK  dangling alone blocks closed (bidirectional ledger) + narration names it")


def test_file_residual_ticket():
    """L2: budget spent with residuals → CODE files ONE ticket in the owner's
    queue (model schema, stable content-fingerprint id). Dedupes on repeat,
    preserves the model's tickets, refuses to clobber an unreadable ledger."""
    report = {
        "coverage": {"unaccounted": ["snap/two.md"], "dangling_citations": []},
        "lint": {"ok": False, "violations": [{"page": "p1.md", "kind": "orphan", "detail": "unreachable"}]},
        "incremental": {"out_of_scope_pages": ["c.md"]},
        "state": "unconverged",
    }
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "authoring/CONTRADICTIONS.json",
            json.dumps([{"id": "model-1", "title": "既有工单", "status": "open"}]))
        assert selfcheck.file_residual_ticket(td, report, "zh") is True
        tickets = json.loads((base / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8"))
        assert len(tickets) == 2 and tickets[0]["id"] == "model-1"  # model ticket preserved
        t = tickets[1]
        assert t["id"].startswith("selfcheck-residual-") and t["status"] == "open" and t["answer"] is None
        assert "未入账源: snap/two.md" in t["sources"][0]["quote"]
        assert sorted(t["affected_pages"]) == ["c.md", "p1.md"]
        assert t["options"] and t["current_value"]
        # same residuals again → dedupe, no second ticket
        assert selfcheck.file_residual_ticket(td, report, "zh") is False
        assert len(json.loads((base / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8"))) == 2
        # different residuals → a fresh ticket (new fingerprint)
        report2 = {"coverage": {"unaccounted": [], "dangling_citations": ["snap/ghost.md"]},
                   "lint": {"ok": True, "violations": []}, "state": "unconverged"}
        assert selfcheck.file_residual_ticket(td, report2, "en") is True
        assert len(json.loads((base / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8"))) == 3
    with tempfile.TemporaryDirectory() as td:
        # nothing residual → no ticket
        clean = {"coverage": {"unaccounted": [], "dangling_citations": []},
                 "lint": {"ok": True, "violations": []}}
        assert selfcheck.file_residual_ticket(td, clean) is False
        assert not (Path(td) / "authoring/CONTRADICTIONS.json").exists()
    with tempfile.TemporaryDirectory() as td:
        # unreadable ledger → bail rather than clobber the model's tickets
        _mk(Path(td), "authoring/CONTRADICTIONS.json", "{oops")
        assert selfcheck.file_residual_ticket(td, report) is False
        assert (Path(td) / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8") == "{oops"
    print("OK  file_residual_ticket (files/dedupes/preserves/bails, fingerprint id)")


def test_ledger_repair_pages():
    """Interlock: the pages a ledger/lint repair legitimately edits — the byte
    guard must authorize exactly these on the repair turn, or the mechanical
    restore reverts the repair itself (live 07-09: 4 charset fixes + 1 orphan
    deletion all undone → unconverged)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [a](a.md)\n- [c](c.md)")
        _mk(base, "candidate/a.md", "---\ntype: Topic\ncompiled_from:\n  - snap/one.md\n---\n正文a。")
        _mk(base, "candidate/c.md", "---\ntype: Topic\ncompiled_from:\n  - snap/ghost.md\n---\n正文c。")
        report = {
            "coverage": {"dangling_citations": ["snap/ghost.md"]},
            "lint": {"ok": False, "violations": [
                {"page": "b.md", "kind": "charset_corruption", "detail": "…"},
                {"page": selfcheck.EXCLUSIONS_PATH, "kind": "exclusions_invalid", "detail": "…"},
            ]},
        }
        pages = selfcheck.ledger_repair_pages(td, report)
        # lint page in; EXCLUSIONS pseudo-page out; dangling-citing page resolved
        assert pages == ["b.md", "c.md"], pages
        # clean report → nothing to widen
        assert selfcheck.ledger_repair_pages(td, {"coverage": {}, "lint": {"ok": True, "violations": []}}) == []
        print("OK  ledger_repair_pages (lint pages + dangling-citing pages, pseudo-entries excluded)")


def test_citation_path_normalization():
    """Review fix: `./live.csv` / `sub/../x.md` citations must canonicalize like
    link targets do — un-normalized they double-reported as unaccounted AND
    dangling, which the dangling→closed gate turns into a permanent wedge."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snap/live.csv")
        _mk(base, "raw/snap/sub/x.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p1](p1.md)")
        _mk(base, "candidate/p1.md",
            "---\ntype: Topic\ncompiled_from:\n  - ./snap/live.csv\n  - snap/sub/../sub/x.md\n---\n正文。")
        cov = selfcheck.run_layer1(td)["coverage"]
        assert cov["unaccounted"] == [] and cov["dangling_citations"] == [], cov
        assert cov["closed"], cov
        print("OK  citation path normalization (./ and a/../ canonicalize; no double-report wedge)")


def test_residual_fingerprint_full_set():
    """Review fix: the ticket id fingerprints the FULL residual set — two sets
    sharing a 10-item prefix must not collide (the old [:10] cap silently
    deduped the second, genuinely different, ticket away)."""
    base_items = [f"snap/s{i:02d}.md" for i in range(10)]
    r1 = {"coverage": {"unaccounted": base_items + ["snap/only-in-one.md"], "dangling_citations": []},
          "lint": {"ok": True, "violations": []}}
    r2 = {"coverage": {"unaccounted": base_items + ["snap/only-in-two.md"], "dangling_citations": []},
          "lint": {"ok": True, "violations": []}}
    with tempfile.TemporaryDirectory() as td:
        assert selfcheck.file_residual_ticket(td, r1) is True
        assert selfcheck.file_residual_ticket(td, r2) is True  # distinct id → files, not deduped
        tickets = json.loads((Path(td) / "authoring/CONTRADICTIONS.json").read_text(encoding="utf-8"))
        assert len(tickets) == 2 and tickets[0]["id"] != tickets[1]["id"], tickets
    print("OK  residual fingerprint covers the full set (no prefix collision)")


async def test_media_clean_pass_settles_converge():
    """Review HIGH: the clean/failed media-verify paths used to stop dead —
    converge_phase parked at "verifying" forever in the single-session case.
    The flow must hand back to the seam: chain PK, else settle."""
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        run = _FakeRun(td)

        async def clean_verify(engine, workdir, pending, progress=None, locale=None):
            return {"findings": [], "errors": [], "images": 1, "cache_hits": 0,
                    "completed_pages": sorted(pending), "failed_pages": []}

        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = clean_verify
        try:
            assert await _post_turn_selfcheck(run) is None  # ledger passes
            assert _maybe_start_media_verify(run)
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc.get("converge_phase") == "settled", sc  # NOT parked at "verifying"
        finally:
            mv.run_blind_verify = orig
    print("OK  clean media pass settles converge (no verifying wedge)")


def test_page_too_large_lint():
    """Review fix: a page crossing the sync cap is silently absent/stale in the
    store and the published version while all checks stay green — lint now
    turns that into a model-fixable violation."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snap/one.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [big](big.md)")
        _mk(base, "candidate/big.md",
            "---\ntype: Topic\ncompiled_from:\n  - snap/one.md\n---\n" + "长内容。" * 200)
        os.environ["KBC_MAX_SYNC_FILE_BYTES"] = "512"
        try:
            report = selfcheck.run_layer1(td)
            kinds = {v["kind"] for v in report["lint"]["violations"]}
            assert "page_too_large" in kinds, report["lint"]
        finally:
            del os.environ["KBC_MAX_SYNC_FILE_BYTES"]
        # default cap (1MB): the same page is fine
        report2 = selfcheck.run_layer1(td)
        assert "page_too_large" not in {v["kind"] for v in report2["lint"]["violations"]}
    print("OK  page_too_large lint (sync-cap divergence made loud, env-tunable)")


def test_page_too_large_uses_raw_bytes():
    """Round-3 review (low): the lint measured len(text.encode()) over read_text's
    newline-TRANSLATED text while the sync gate compares stat().st_size — a CRLF
    page just over the cap linted green while the sync silently skipped it."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snap/one.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [big](big.md)")
        head = "---\ntype: Topic\ncompiled_from:\n  - snap/one.md\n---\n"
        body = "ab\r\n" * 140  # raw 560B vs decoded 420B — the divergence window
        (base / "candidate/big.md").write_bytes((head + body).encode("utf-8"))
        raw = (base / "candidate/big.md").stat().st_size
        decoded = len((head + body).replace("\r\n", "\n").encode("utf-8"))
        assert decoded < 512 < raw, (decoded, raw)  # the test premise itself
        os.environ["KBC_MAX_SYNC_FILE_BYTES"] = "512"
        try:
            report = selfcheck.run_layer1(td)
            kinds = {v["kind"] for v in report["lint"]["violations"]}
            assert "page_too_large" in kinds, report["lint"]
        finally:
            del os.environ["KBC_MAX_SYNC_FILE_BYTES"]
    print("OK  page_too_large measures raw on-disk bytes (CRLF false-green closed)")


async def test_noop_gate_survives_missing_selfcheck():
    """Round-3 review (low): the unchanged-tree fall-through read state from a
    SECOND read_selfcheck — a missing/corrupt SELFCHECK.json (None) silently
    dropped the gate. None must fall through: recomputing heals the file and
    spends the budget honestly."""
    from compile_box import _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/b.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")
        run = _FakeRun(td)
        msg1 = await _post_turn_selfcheck(run)      # b.md unaccounted → repairing
        assert msg1 and run._l1_repairs_used == 1
        (base / "authoring/SELFCHECK.json").unlink()
        # Tree unchanged + file gone: the OLD early-return left NO file and no
        # honest state behind (gate silently dropped). The fall-through must
        # re-run the gate — with the suite's 1-round budget already spent that
        # lands unconverged + residual ticket, i.e. the file HEALS.
        msg2 = await _post_turn_selfcheck(run)
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())  # healed, not absent
        assert sc["state"] in ("repairing", "unconverged"), sc
        if sc["state"] == "unconverged":
            assert msg2 is None  # budget spent → ticket, not another inject
        else:
            assert msg2 is not None
    print("OK  no-op gate falls through on a missing/corrupt SELFCHECK.json")


async def test_ledger_repairs_reset_budget():
    """Round-3 review (low): _run_ledger_repairs forces a fresh check but kept
    the session-lifetime repair counter — a batch ledger phase entered after
    the persistent budget was spent filed a residual ticket with ZERO repair
    attempts for its own findings. Each call is its own bounded episode."""
    import compile_box
    from compile_box import _run_ledger_repairs

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/b.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")
        run = _FakeRun(td)
        run._l1_repairs_used = 99  # earlier interactive turns spent the budget

        drove: list[str] = []

        async def fake_drive(run_, directive, label):
            drove.append(label)
            # the repair session accounts for the missing source
            _mk(base, "candidate/q.md", "---\ntype: Topic\ncompiled_from:\n  - s/b.md\n---\ny")
            _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)\n- [q](q.md)")
            return "fixed"

        real_drive = compile_box._drive_batch_session
        compile_box._drive_batch_session = fake_drive
        try:
            await _run_ledger_repairs(run, [])
        finally:
            compile_box._drive_batch_session = real_drive
        assert drove, "no repair session ran — budget was not reset"
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
        assert sc["state"] == "passed", sc
    print("OK  _run_ledger_repairs grants a fresh repair budget per episode")


def test_repair_prompt_names_noop_exclusions_and_glob_shape():
    """Batch C: a pattern matching no source was shown to the HUMAN (narration)
    but withheld from the repair loop — the model could never converge an
    exclusion it wrote with the wrong glob shape. The repair prompt now names
    the noop patterns and teaches the segment-wise matching rule."""
    report = {
        "coverage": {"unaccounted": ["snap/x.md"], "dangling_citations": [],
                     "noop_exclusions": ["logs"]},
        "lint": {"ok": True, "violations": []},
        "state": "repairing",
    }
    zh = selfcheck.build_repair_prompt(report, "zh")
    assert "logs" in zh and "logs/**" in zh and "按路径段" in zh, zh
    en = selfcheck.build_repair_prompt(report, "en")
    assert "logs/**" in en and "SEGMENT" in en, en
    print("OK  repair prompt names noop exclusions + segment-glob rule (zh/en)")


def test_run_layer1_carries_converge_phase():
    """Batch C: _post_turn_selfcheck overwrites SELFCHECK.json with run_layer1's
    report; dropping converge_phase left a per-turn window with no phase."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/snap/one.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - snap/one.md\n---\n正文。")
        selfcheck.write_selfcheck(td, selfcheck.run_layer1(td))
        selfcheck.set_converge_phase(td, "settled")
        report = selfcheck.run_layer1(td)
        assert report.get("converge_phase") == "settled", report.get("converge_phase")
    print("OK  run_layer1 carries converge_phase forward (no per-turn blank window)")


async def test_media_chunks_self_drain_then_settle():
    """Review fix: with >cap images, settling after chunk 1 silently skipped
    the remaining chunks AND PK. The finally now mirrors the full seam — each
    chunk's completion starts the next; only a fully-drained set settles."""
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "raw/s/i2.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)\n- [q](q.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        _mk(base, "candidate/q.md", "---\ntype: Topic\ncompiled_from:\n  - s/i2.png\n---\ny")
        run = _FakeRun(td)

        calls: list[dict] = []

        async def clean_verify(engine, workdir, pending, progress=None, locale=None):
            calls.append(dict(pending))
            return {"findings": [], "errors": [], "images": 1, "cache_hits": 0,
                    "completed_pages": sorted(pending), "failed_pages": []}

        os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"] = "1"  # force 2 chunks
        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = clean_verify
        try:
            assert await _post_turn_selfcheck(run) is None  # ledger passes
            assert _maybe_start_media_verify(run)           # chunk 1
            first = run._media_task
            await first
            # chunk 1's finally released the single-flight ref and started
            # chunk 2 WITHOUT a new owner turn. With fast fakes chunk 2 may
            # already be done (ref back to None) — both timings are the drain.
            second = run._media_task
            assert second is not first, "second chunk must self-start"
            if second is not None:
                await second
            await asyncio.sleep(0)  # flush any residual scheduled steps
            assert len(calls) == 2, calls
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc.get("converge_phase") == "settled", sc  # settled only after full drain
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"]
    print("OK  media chunks self-drain then settle (no silent skip of chunks 2..N)")


def test_state_key():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        assert selfcheck.state_key(td) is None  # no candidate tree yet
        _mk(base, "candidate/index.md", "i")
        k1 = selfcheck.state_key(td)
        _mk(base, "candidate/p.md", "p")
        k2 = selfcheck.state_key(td)
        assert k1 and k2 and k1 != k2
        # exclusions-only change MUST rotate the key (repair may only add exclusions)
        _mk(base, "authoring/EXCLUSIONS.json", "[]")
        k3 = selfcheck.state_key(td)
        assert k3 != k2
    print("OK  state_key (None / candidate change / exclusions-only change)")


class _FakeRun:
    """Just the attrs _post_turn_selfcheck touches: the engine-neutral surface."""
    def __init__(self, workdir):
        self.workdir = workdir
        self._selfcheck_key = None
        self._l1_repairs_used = 0
        self.summaries: list[str] = []
        self.injected: list[str] = []

    async def emit(self, ev):
        if ev.get("type") == "summary":
            self.summaries.append(ev["text"])

    async def inject_user_message(self, text):
        self.injected.append(text)


async def test_wiring():
    from compile_box import _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/b.md")
        run = _FakeRun(td)

        # no candidate yet → no-op
        assert await _post_turn_selfcheck(run) is None

        # index exists, b.md unaccounted → repairing + repair prompt returned
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")
        msg = await _post_turn_selfcheck(run)
        assert msg and "s/b.md" in msg, msg
        assert run._l1_repairs_used == 1
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
        assert sc["state"] == "repairing" and sc["coverage"]["unaccounted"] == ["s/b.md"], sc

        # same state again (idempotency key unchanged) → no re-check, no double-inject
        assert await _post_turn_selfcheck(run) is None

        # agent repairs by EXCLUSIONS ONLY (no candidate edit) → re-check fires → passed
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "s/b.md", "reason": "活数据"}]))
        assert await _post_turn_selfcheck(run) is None
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
        assert sc["state"] == "passed", sc
        assert run._l1_repairs_used == 0  # budget resets on close

        # budget exhaustion: reopen the gap twice without fixing → unconverged, no injection
        _mk(base, "raw/s/c.md")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx2")  # rotate key
        assert await _post_turn_selfcheck(run) is not None      # round 1 → repairing
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx3")  # agent "fixed" nothing
        assert await _post_turn_selfcheck(run) is None          # budget spent → unconverged
        sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
        assert sc["state"] == "unconverged", sc
    print("OK  wiring (trigger gating / repair inject / exclusions-only reopen / budget → unconverged)")


async def test_media_verify_wiring():
    """Blind-verify wiring (v2): settled-draft gate, ≤max-images chunking with
    the remainder rolling to the next trigger, findings → repair injection,
    clean chunk → no injection, all-verified → PK unblocked."""
    import compile_box
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "raw/s/i2.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)\n- [q](q.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        _mk(base, "candidate/q.md", "---\ntype: Topic\ncompiled_from:\n  - s/i2.png\n---\ny")
        run = _FakeRun(td)

        calls: list[dict] = []

        async def fake_verify(engine, workdir, pending, progress=None, locale=None):
            calls.append(dict(pending))
            done = sorted(pending)  # every page in the chunk verifies to completion
            if len(calls) == 1:  # first chunk: one confirmed misread (still a COMPLETED verification)
                return {"findings": [{"page": "p.md", "image": "s/i1.png", "kind": "不一致",
                                      "claim": "GPU-Util 94%", "expected": "GPU-Util 0%(94% 是 MEM 条)",
                                      "fix": "改为 0%"}],
                        "errors": [], "images": 1, "cache_hits": 0,
                        "completed_pages": done, "failed_pages": []}
            return {"findings": [], "errors": [], "images": 1, "cache_hits": 1,
                    "completed_pages": done, "failed_pages": []}

        os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"] = "1"
        os.environ["KBC_PK_MODE"] = "auto"  # so the PK-yields assertion is meaningful
        orig = mv.run_blind_verify
        mv.run_blind_verify = fake_verify
        try:
            # not settled yet → no start (selfcheck hasn't run/passed)
            assert not _maybe_start_media_verify(run)
            assert await _post_turn_selfcheck(run) is None  # ledger closes → passed
            assert _maybe_start_media_verify(run)           # chunk 1 (p.md, cap 1 image)
            await run._media_task
            assert calls[0] == {"p.md": ["s/i1.png"]}, calls
            assert run.injected and "[System self-check · image verification]" in run.injected[-1] and "94% 是 MEM 条" in run.injected[-1]
            assert compile_box._pk_due(run) is None         # finding page + q.md pending → PK waits

            # Simulate the injected repair editing the finding page. The path is
            # unchanged, but its content fingerprint must re-arm verification.
            p = base / "candidate/p.md"
            p.write_text(p.read_text() + "\nfixed", encoding="utf-8")
            assert _maybe_start_media_verify(run)           # repaired p.md verifies again
            await run._media_task
            assert calls[1] == {"p.md": ["s/i1.png"]}, calls
            # Clean p.md self-drains the remaining q.md chunk before settling.
            for _ in range(4):
                if len(calls) >= 3:
                    break
                task = run._media_task
                if task is not None:
                    await task
                else:
                    await asyncio.sleep(0)
            assert calls[2] == {"q.md": ["s/i2.png"]}, calls
            assert len(run.injected) == 1                   # clean recheck/chunk → no new injection
            assert not _maybe_start_media_verify(run)       # all verified → done
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"]
            os.environ["KBC_PK_MODE"] = "off"
    print("OK  blind media-verify wiring (gate / chunk+roll / findings→repair / PK yields)")




async def test_media_inject_failure_does_not_double_settle():
    """Round-3 review (med-high): a findings-path inject throwing AFTER the
    primary settle used to re-settle the chunk with result=None — bumping the
    just-verified pages' attempt counts (toward a spurious `exhausted`) and
    charging failed pages two attempts for one real failure. The except must
    settle only when the primary settle never ran."""
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        run = _FakeRun(td)

        async def broken_inject(text):
            raise RuntimeError("session gone")
        run.inject_user_message = broken_inject

        async def verify_with_findings(engine, workdir, pending, progress=None, locale=None):
            return {"findings": [{"page": "p.md", "image": "s/i1.png", "kind": "不一致",
                                  "claim": "x", "expected": "y", "fix": "z"}],
                    "errors": [], "images": 1, "cache_hits": 0,
                    "completed_pages": sorted(pending), "failed_pages": []}

        os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"] = "1"  # one spurious bump would exhaust
        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = verify_with_findings
        try:
            assert await _post_turn_selfcheck(run) is None
            assert _maybe_start_media_verify(run)
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert "p.md" not in (mvsec.get("verified_pages") or []), mvsec  # known finding is not a pass
            assert "p.md" not in (mvsec.get("exhausted") or []), mvsec   # no spurious exhausted
            assert not (mvsec.get("attempts") or {}), mvsec       # no phantom failed-attempt bump
            assert list(selfcheck.pending_media_verification(td)) == ["p.md"], mvsec
            assert sc.get("converge_phase") == "settled", sc      # inject failure falls through to the seam
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"]
    print("OK  findings-inject failure settles once (no double-settle, no phantom exhausted)")


async def test_media_failed_chunk_still_drains_later_chunks():
    """Round-3 review (med): a transient failure on chunk 1 used to skip chunks
    2..N AND PK, then settle green — the unattempted chunks were never verified
    in a single session. The drain now chains past a failed chunk (its pages
    deferred, not hot-looped); a later FRESH trigger retries the failed pages."""
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "raw/s/i2.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)\n- [q](q.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        _mk(base, "candidate/q.md", "---\ntype: Topic\ncompiled_from:\n  - s/i2.png\n---\ny")
        run = _FakeRun(td)

        calls: list[dict] = []

        async def p_fails_q_verifies(engine, workdir, pending, progress=None, locale=None):
            calls.append(dict(pending))
            done = [p for p in pending if p != "p.md"]
            failed = [p for p in pending if p == "p.md"]
            return {"findings": [], "errors": ["boom"] if failed else [],
                    "images": 1, "cache_hits": 0,
                    "completed_pages": done, "failed_pages": failed}

        os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"] = "1"  # p.md is chunk 1, q.md chunk 2
        os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"] = "2"
        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = p_fails_q_verifies
        try:
            assert await _post_turn_selfcheck(run) is None
            assert _maybe_start_media_verify(run)               # chunk 1 (p.md) — will fail
            await run._media_task
            second = run._media_task                            # chunk 2 must have self-started
            if second is not None:
                await second
            await asyncio.sleep(0)
            assert [sorted(c) for c in calls] == [["p.md"], ["q.md"]], calls
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert "q.md" in mvsec["verified_pages"], mvsec     # chunk 2 verified in the SAME drain
            assert mvsec["attempts"].get("p.md") == 1, mvsec    # deferred, not hot-looped
            assert sc.get("converge_phase") == "settled", sc
            run._media_task = None
            assert _maybe_start_media_verify(run)               # fresh trigger → p.md retries
            await run._media_task
            assert [sorted(c) for c in calls][-1] == ["p.md"], calls
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc["media_verify"]["attempts"]["p.md"] == 2, sc["media_verify"]
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_MAX_IMAGES"]
            del os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"]
    print("OK  failed chunk defers, later chunks still drain; fresh trigger retries")


async def test_media_failed_pages_retry_then_exhaust():
    """Review fix: verified marks land only AFTER a completed verification.
    A failed page retries on later triggers, bounded by KBC_MEDIA_VERIFY_ATTEMPTS,
    then ships with a VISIBLE exhausted flag — never a silent false-pass."""
    import compile_box
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        run = _FakeRun(td)

        async def failing_verify(engine, workdir, pending, progress=None, locale=None):
            return {"findings": [], "errors": ["transcription failed s/i1.png: boom"],
                    "images": 1, "cache_hits": 0,
                    "completed_pages": [], "failed_pages": sorted(pending)}

        os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"] = "2"
        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = failing_verify
        try:
            assert await _post_turn_selfcheck(run) is None      # ledger passes → settled draft
            assert _maybe_start_media_verify(run)               # attempt 1
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert "p.md" not in (mvsec.get("verified_pages") or []), mvsec  # NOT falsely passed
            assert mvsec["attempts"]["p.md"] == 1, mvsec
            run._media_task = None
            assert _maybe_start_media_verify(run)               # attempt 2 (retry, not skipped)
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert mvsec["attempts"]["p.md"] == 2, mvsec
            assert "p.md" in mvsec["verified_pages"] and "p.md" in mvsec["exhausted"], mvsec
            run._media_task = None
            assert not _maybe_start_media_verify(run)           # budget spent → no more retries
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"]
    print("OK  media failed pages retry then exhaust (visible flag, no silent false-pass)")


async def test_media_attempt_count_resets_on_success():
    """Round-4 review fix: a page that fails once then completes verification
    must have its attempt count cleared — a stale residue would push a later
    re-entry to 'exhausted' after fewer real failures than the budget implies."""
    import compile_box
    import mediaverify as mv
    from compile_box import _maybe_start_media_verify, _post_turn_selfcheck

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "raw/s/i1.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n  - s/i1.png\n---\nx")
        run = _FakeRun(td)
        calls = [0]

        async def flaky_verify(engine, workdir, pending, progress=None, locale=None):
            calls[0] += 1
            if calls[0] == 1:  # first attempt: transcription failure
                return {"findings": [], "errors": ["transcription failed s/i1.png: flaky"],
                        "images": 1, "cache_hits": 0,
                        "completed_pages": [], "failed_pages": sorted(pending)}
            return {"findings": [], "errors": [], "images": 1, "cache_hits": 0,
                    "completed_pages": sorted(pending), "failed_pages": []}

        os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"] = "3"
        os.environ["KBC_PK_MODE"] = "off"
        orig = mv.run_blind_verify
        mv.run_blind_verify = flaky_verify
        try:
            assert await _post_turn_selfcheck(run) is None
            assert _maybe_start_media_verify(run)           # attempt 1 → fails
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc["media_verify"]["attempts"]["p.md"] == 1, sc["media_verify"]
            run._media_task = None
            assert _maybe_start_media_verify(run)           # attempt 2 → succeeds
            await run._media_task
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            mvsec = sc["media_verify"]
            assert "p.md" in mvsec["verified_pages"] and "p.md" not in (mvsec.get("exhausted") or []), mvsec
            assert "p.md" not in (mvsec.get("attempts") or {}), mvsec  # count cleared on success
        finally:
            mv.run_blind_verify = orig
            del os.environ["KBC_MEDIA_VERIFY_ATTEMPTS"]
    print("OK  media attempt count resets on successful verification")


async def test_pk_failed_state_settles_converge():
    """Review fix: run_pk is fail-open and RETURNS state=failed — both that and
    an outright raise must still terminalize converge_phase (it used to wedge
    at 'verifying', locking the frontend test-step gate forever)."""
    import compile_box
    import redblue as rb

    for scenario in ("returns_failed", "raises"):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            _mk(base, "raw/s/a.md")
            _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
            _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")
            run = _FakeRun(td)
            os.environ["KBC_PK_MODE"] = "off"
            assert await compile_box._post_turn_selfcheck(run) is None

            async def fake_failed(engine, **kw):
                return ({"state": "failed", "error": "pk infra down", "questions": 0}, {})

            async def fake_raises(engine, **kw):
                raise RuntimeError("pk infra down")

            orig = rb.run_pk
            rb.run_pk = fake_failed if scenario == "returns_failed" else fake_raises
            os.environ["KBC_PK_MODE"] = "auto"
            try:
                await compile_box._run_pk_flow(run, "full")
            finally:
                rb.run_pk = orig
                os.environ["KBC_PK_MODE"] = "off"
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc["pk"]["state"] == "failed", (scenario, sc["pk"])
            assert sc.get("converge_phase") == "settled", (scenario, sc.get("converge_phase"))
    print("OK  pk failed/raise still settles converge_phase (no verifying wedge)")



async def test_pk_wiring():
    """S2 red-blue wiring: due-gating → full pass → repairing + repair inject →
    targeted retest → merged final scoreboard → idempotent (tree hash stamped)."""
    import compile_box
    import redblue as rb

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")
        run = _FakeRun(td)
        os.environ["KBC_PK_MODE"] = "off"
        assert await compile_box._post_turn_selfcheck(run) is None  # ledger passes
        assert compile_box._pk_due(run) is None                     # mode off
        os.environ["KBC_PK_MODE"] = "auto"
        assert compile_box._pk_due(run) == "full"

        async def fake_run_pk(engine, **kw):
            if kw.get("questions_override"):
                assert [q["id"] for q in kw["questions_override"]] == ["q1"]
                return ({"state": "passed", "questions": 1, "graded": 1, "gate_pass": 1,
                         "pass_rate": 1.0, "failures": [], "wall_secs": 1},
                        {"questions": kw["questions_override"], "answers": {}, "verdicts": {}})
            return ({"state": "unconverged", "questions": 3, "graded": 3, "gate_pass": 2,
                     "pass_rate": 0.667, "wall_secs": 1,
                     "failures": [{"id": "q1", "question": "问", "score": "错",
                                   "category": "覆盖", "page": "p.md", "fix": "补"}]},
                    {"questions": [{"id": "q1", "question": "问"}, {"id": "q2", "question": "b"},
                                   {"id": "q3", "question": "c"}],
                     "answers": {"q1": {"answer": "长" * 9000}}, "verdicts": {}})

        orig = rb.run_pk
        rb.run_pk = fake_run_pk
        try:
            await compile_box._run_pk_flow(run, "full")
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc["pk"]["state"] == "repairing" and sc["pk"]["rounds_used"] == 0, sc["pk"]
            # converge phase = revising (verify found issues → a repair was injected)
            assert sc["converge_phase"] == "revising", sc.get("converge_phase")
            assert run.injected and "[System self-check · red-blue PK]" in run.injected[-1] and "补" in run.injected[-1]
            detail = json.loads((base / "authoring/PK_RESULT.json").read_text())
            assert len(detail["answers"]["q1"]["answer"]) == 4000  # persisted truncated

            assert compile_box._pk_due(run) == "retest"
            await compile_box._run_pk_flow(run, "retest")
            scc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            pk = scc["pk"]
            # merged scoreboard: 2 passes from the full round + 1 resolved retest
            assert pk["state"] == "passed" and pk["rounds_used"] == 1, pk
            assert pk["questions"] == 3 and pk["gate_pass"] == 3 and pk["pass_rate"] == 1.0, pk
            # converged → phase settles to "settled" (the draft is stable + testable)
            assert scc["converge_phase"] == "settled", scc.get("converge_phase")
            assert compile_box._pk_due(run) is None  # tree hash stamped → idempotent
        finally:
            rb.run_pk = orig
            os.environ["KBC_PK_MODE"] = "off"
    print("OK  pk wiring (gating / repairing+inject / targeted retest merge / idempotent / converge phase)")


async def test_seam_settles_when_nothing_pending():
    """The turn seam sets converge_phase='settled' when no ledger repair, no media,
    no PK is pending — so converge_phase is AUTHORITATIVE even with verify OFF, and
    the frontend gates the test step on 'settled' with no config lookup."""
    import compile_box
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/a.md")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")

        class _R:  # just what _emit_message touches
            workdir = td
            _selfcheck_key = None
            _l1_repairs_used = 0
            _turn_text = ["编好了"]
            _sync_sent = None
            _suppress_turn_done = False
            async def emit(self, ev):
                pass
            async def inject_user_message(self, t):
                pass

        class ResultMessage:  # type(msg).__name__ drives the seam
            pass

        os.environ["KBC_PK_MODE"] = "off"        # verify OFF (both layers)
        os.environ["KBC_MEDIA_VERIFY"] = "off"
        try:
            await compile_box._emit_message(_R(), ResultMessage())
            sc = json.loads((base / "authoring/SELFCHECK.json").read_text())
            assert sc.get("converge_phase") == "settled", sc.get("converge_phase")
        finally:
            os.environ["KBC_PK_MODE"] = "off"
            os.environ.pop("KBC_MEDIA_VERIFY", None)
    print("OK  seam settles converge_phase when nothing pending (verify-off authoritative)")


def test_converge_phase_helper():
    """set_converge_phase: writes the durable authoritative signal (verifying/
    revising/settled), preserves the L1 coverage section, ignores junk phases."""
    import selfcheck
    with tempfile.TemporaryDirectory() as td:
        _mk(Path(td), "raw/s/a.md")
        _mk(Path(td), "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [P](p.md)")
        _mk(Path(td), "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - s/a.md\n---\nx")
        selfcheck.write_selfcheck(td, selfcheck.run_layer1(td))  # L1 first
        selfcheck.set_converge_phase(td, "verifying")
        sc = json.loads((Path(td) / "authoring/SELFCHECK.json").read_text())
        assert sc["converge_phase"] == "verifying" and sc["coverage"]["closed"], sc  # L1 preserved
        selfcheck.set_converge_phase(td, "settled")
        assert json.loads((Path(td) / "authoring/SELFCHECK.json").read_text())["converge_phase"] == "settled"
        selfcheck.set_converge_phase(td, "bogus")  # invalid → no-op, phase unchanged
        assert json.loads((Path(td) / "authoring/SELFCHECK.json").read_text())["converge_phase"] == "settled"
    print("OK  set_converge_phase (durable signal, L1 preserved, junk ignored)")


def test_pack_hash_is_relposix_sorted():
    """pack_candidates_to_wiki must hash in rel_posix-STRING order so a draft
    pinned here and a published bundle installed by compile_box._install_wiki_snapshot
    yield the SAME snapshot_hash for byte-identical content (the question ×
    snapshot grading key is comparable across sources). Uses a nested tree where
    Path-sort and string-sort diverge (dir `a/` vs files `a.md`/`a-x.md`)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        files = {"index.md": "i", "a.md": "A", "a-x.md": "X", "a/b.md": "B"}
        for rel, txt in files.items():
            _mk(base, f"candidate/{rel}", txt)
        h, n = selfcheck.pack_candidates_to_wiki(str(base), base / "snap")
        assert n == 4, n
        # canonical hash = entries sorted by rel_posix string (same formula as
        # _install_wiki_snapshot), NOT filesystem Path order
        want = hashlib.sha256()
        for rp, txt in sorted(files.items()):
            want.update(rp.encode()); want.update(b"\0"); want.update(txt.encode()); want.update(b"\0")
        assert h == want.hexdigest(), "pack hash must be rel_posix-string ordered (draft/published comparability)"
    print("OK  pack hash is rel_posix-sorted (draft/published snapshot comparability, nested-tree safe)")


def test_parse_compiled_from_inline():
    """Fix D: an inline flow list must parse to sources (previously → [] → spurious repair)."""
    src, _, has = selfcheck.parse_compiled_from('---\ntype: Topic\ncompiled_from: [raw/a.md, "b.md"]\n---\nx')
    assert has and src == ["a.md", "b.md"], src
    src, _, has = selfcheck.parse_compiled_from("---\ntype: Topic\ncompiled_from: [snapshot/x.md]\n---\ny")
    assert has and src == ["snapshot/x.md"], src
    src, _, has = selfcheck.parse_compiled_from("---\ntype: Topic\ncompiled_from: []\n---\nz")  # still empty-but-present
    assert has and src == [], src
    print("OK  parse_compiled_from inline flow list (fix D)")


def test_matches_segment_aware():
    """Fix B: `*` never crosses `/`; raw/ prefix on the exclusion side is normalized."""
    assert selfcheck._matches("notes/a.md", "notes/*")
    assert not selfcheck._matches("notes/sub/secret.md", "notes/*")  # over-exclusion false-PASS closed
    assert selfcheck._matches("notes/sub/secret.md", "notes/**")     # ** crosses segments
    assert selfcheck._matches("notes/sub/secret.md", "notes/")       # dir-prefix = whole subtree
    assert selfcheck._matches("live.csv", "raw/live.csv")            # prefix-mismatch false-GAP closed
    assert selfcheck._matches("d/live.csv", "drop/d/live.csv")
    print("OK  _matches segment-aware + prefix-normalized (fix B)")


def test_noop_exclusion_warning():
    """Fix B#3: an exclusion matching no source is surfaced as a warning (not blocking)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/a.md"); _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [P](p.md)")
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - a.md\n---\nx")
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "nope/*.md", "reason": "typo, matches nothing"}]))
        report = selfcheck.run_layer1(td)
        assert report["coverage"]["noop_exclusions"] == ["nope/*.md"], report["coverage"]
        assert report["coverage"]["closed"]  # non-blocking: still closed
        assert "no source" in selfcheck.narration({**report, "state": "passed"}, "en")
    print("OK  no-op exclusion surfaced, non-blocking (fix B#3)")


def test_candidate_tree_hash_unreadable():
    """Fix C: a perm-denied candidate file must not crash state_key (runs before fail-open)."""
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        print("OK  candidate_tree_hash unreadable (skipped as root)"); return
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "candidate/index.md", "i")
        bad = base / "candidate" / "denied.md"; bad.write_text("x"); bad.chmod(0)
        try:
            assert selfcheck.state_key(td) is not None  # must NOT raise
        finally:
            bad.chmod(0o644)  # let tempdir cleanup succeed
    print("OK  candidate_tree_hash tolerates a perm-denied file (fix C)")


def test_content_hash_shared_formula():
    """Design: pack / tree / canonical must agree for byte-identical content (nested)."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        files = {"index.md": "i", "a.md": "A", "a/b.md": "B"}  # nested: Path- vs string-sort diverge
        for rel, txt in files.items():
            _mk(base, f"candidate/{rel}", txt)
        h_pack, _ = selfcheck.pack_candidates_to_wiki(str(base), base / "snap")
        h_tree = selfcheck.candidate_tree_hash(str(base))
        want = selfcheck.content_hash([(rel, txt.encode()) for rel, txt in files.items()])
        assert h_pack == want == h_tree, (h_pack, h_tree, want)
    print("OK  content_hash: pack == tree == canonical (single shared formula)")


def test_is_media_asset():
    """Media-asset predicate (coverage v2 §4.1): an assets/ (or legacy *.assets)
    segment AND an image extension; sheet placeholders and non-images are not."""
    yes = ["assets/a.png", "guide/assets/b.JPG", "report.assets/c.png",
           "x/assets/y/d.webp", "assets/photo.tiff",
           # case-INSENSITIVE segment (locked here, not in the fixture: an
           # uppercase dir is not portable on a case-insensitive filesystem).
           "Assets/e.png", "report.ASSETS/f.png", "guide/AsSeTs/g.png"]
    no = ["docs/x.png",              # no assets segment
          "assets/sheets/t.md",      # sheet placeholder = content file
          "assets/data.json",        # json is not an image
          "assets/notes.pdf",        # pdf is not a media asset
          "assetsx/y.png",           # segment is not exactly `assets`
          "my.assets.bak/y.png"]     # segment ends with .bak, not .assets
    for p in yes:
        assert selfcheck.is_media_asset(p), p
    for p in no:
        assert not selfcheck.is_media_asset(p), p
    print("OK  is_media_asset (assets/ + *.assets, case-insensitive seg + image ext; sheet/.json/.pdf excluded)")


def test_document_link_targets():
    """Link/img extraction (coverage v2 §4.2): md image + md link + HTML <img>
    (both quote styles), URL-decoded, angle-bracket, title/fragment stripped,
    code fences masked; external targets pass through (filtered at edge time)."""
    targets = selfcheck.document_link_targets(
        "# T\n"
        "![a](assets/a.png)\n"
        "[b](assets/b.png)\n"
        "<img src=\"assets/c.png\">\n"
        "<img alt='x' src='assets/d.png' />\n"
        "![e](assets/a%20b.png)\n"
        "![f](<assets/g h.png>)\n"
        "![t](assets/t.png \"caption\")\n"
        "![h](assets/i.png#frag)\n"
        "![q](assets/q.png?v=2)\n"
        "```\n![code](assets/nope.png)\n```\n"
        "[ext](https://example.test/y.png)\n"
    )
    for want in ["assets/a.png", "assets/b.png", "assets/c.png", "assets/d.png",
                 "assets/a b.png", "assets/g h.png", "assets/t.png", "assets/i.png",
                 "assets/q.png", "https://example.test/y.png"]:
        assert want in targets, (want, targets)
    assert "assets/nope.png" not in targets, targets       # masked inside a code fence
    assert "assets/q.png?v=2" not in targets, targets       # ?query truncated
    print("OK  document_link_targets (md/html/url-encoded/angle/title/fragment/query; code masked)")


def test_coverage_v2_auto_attach():
    """Coverage v2 auto-attach semantics, each in isolation."""
    okf_index = "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)\n"

    # A. image embedded by a cited doc → auto; orphan image → unaccounted; a
    # sheet placeholder is a content file, not media (cited, not auto).
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/d.md", "# D\n![x](assets/a.png)\n")
        _mk(base, "raw/assets/a.png"); _mk(base, "raw/assets/orphan.png")
        _mk(base, "raw/assets/sheets/t.md", "| c |\n| - |\n| 1 |\n")
        _mk(base, "candidate/index.md", okf_index)
        _mk(base, "candidate/p.md",
            "---\ntype: Topic\ncompiled_from:\n  - d.md\n  - assets/sheets/t.md\n---\nok")
        cov = selfcheck.run_layer1(td)["coverage"]
        assert cov["unaccounted"] == ["assets/orphan.png"], cov
        assert cov["auto_attached"] == 1, cov
        assert cov["auto_attached_sample"] == [{"asset": "assets/a.png", "via": "d.md"}], cov
        assert not selfcheck.is_media_asset("assets/sheets/t.md")
        assert not cov["closed"]

    # B. v1 compatibility + no double count: a directly-cited asset stays cited,
    # an explicitly-excluded asset stays excluded, and neither shows up as auto.
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/d.md", "# D\n![a](assets/a.png)\n![b](assets/b.png)\n")
        _mk(base, "raw/assets/a.png"); _mk(base, "raw/assets/b.png")
        _mk(base, "candidate/index.md", okf_index)
        _mk(base, "candidate/p.md",
            "---\ntype: Topic\ncompiled_from:\n  - d.md\n  - assets/a.png\n---\nok")
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "assets/b.png", "reason": "not needed"}]))
        cov = selfcheck.run_layer1(td)["coverage"]
        assert cov["closed"], cov
        assert cov["auto_attached"] == 0, cov
        assert cov["cited"] == 2 and cov["excluded"] == 1, cov

    # C. an image inherits its document's exclusion (auto via an excluded doc).
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/x.md", "# X\n![c](assets/c.png)\n")
        _mk(base, "raw/assets/c.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n")
        _mk(base, "authoring/EXCLUSIONS.json",
            json.dumps([{"pattern": "x.md", "reason": "draft"}]))
        cov = selfcheck.run_layer1(td)["coverage"]
        assert cov["closed"], cov
        assert cov["auto_attached"] == 1, cov
        assert cov["auto_attached_sample"] == [{"asset": "assets/c.png", "via": "x.md"}], cov

    # D. an image shared by a cited AND an unaccounted doc: auto via the cited
    # one; the unaccounted document itself stays unaccounted (no fail-open).
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/cited.md", "# C\n![s](assets/s.png)\n")
        _mk(base, "raw/loose.md", "# L\n![s](assets/s.png)\n")
        _mk(base, "raw/assets/s.png")
        _mk(base, "candidate/index.md", okf_index)
        _mk(base, "candidate/p.md", "---\ntype: Topic\ncompiled_from:\n  - cited.md\n---\nok")
        cov = selfcheck.run_layer1(td)["coverage"]
        assert cov["unaccounted"] == ["loose.md"], cov
        assert cov["auto_attached"] == 1, cov
        assert cov["auto_attached_sample"] == [{"asset": "assets/s.png", "via": "cited.md"}], cov
    print("OK  coverage v2 auto-attach (embed/orphan/sheet, v1 compat, exclusion inherit, shared-any-cited)")


def test_media_citing_pages_via_attribution_edge():
    """Coverage v2: a page citing only a DOCUMENT still enters the image
    numeric-verification surface for every image that document embeds — agents no
    longer cite images one-by-one, so the attribution edge is the carrier."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/doc.md", "# D\n![c](assets/chart.png)\n")
        _mk(base, "raw/assets/chart.png")
        _mk(base, "candidate/index.md", "---\nokf_version: \"0.1\"\n---\n# Index\n- [p](p.md)")
        # cites the DOCUMENT only — no image in compiled_from, no (source: img)
        _mk(base, "candidate/p.md",
            "---\ntype: Topic\ncompiled_from:\n  - doc.md\n---\nSummary of the chart.")
        citing = selfcheck.media_citing_pages(td)
        assert citing == {"p.md": ["assets/chart.png"]}, citing
        assert list(selfcheck.pending_media_verification(td)) == ["p.md"]
    print("OK  media_citing_pages via attribution edge (doc-only citation still verifies embedded images)")


def test_asset_provenance_fixture():
    """The shared two-repo fixture: edges + coverage v2 must equal expected.json
    byte-for-byte (sicore's adoption ledger asserts the SAME expected.json)."""
    fx = Path(__file__).resolve().parent / "fixtures" / "asset-provenance"
    expected = json.loads((fx / "expected.json").read_text(encoding="utf-8"))
    edges = selfcheck.asset_attribution_edges(str(fx))
    assert edges == expected["attribution_edges"], edges
    pages = selfcheck.candidate_pages(str(fx))
    exclusions, errors = selfcheck.load_exclusions(str(fx))
    assert errors == [], errors
    cov = selfcheck.coverage(str(fx), pages, exclusions)
    assert cov == expected["coverage"], cov
    print("OK  asset-provenance fixture (edges + coverage v2 == expected.json)")


def main():
    os.environ["KBC_L1_REPAIR_ROUNDS"] = "1"
    os.environ.setdefault("KBC_PK_MODE", "off")  # PK never fires in unrelated wiring tests
    test_parse_compiled_from()
    test_okf_v01_conformance()
    test_markdown_code_is_not_a_link()
    test_emit_ignores_links_in_code()
    test_parse_compiled_from_inline()
    test_inventory_and_exclusions()
    test_matches_segment_aware()
    test_noop_exclusion_warning()
    test_coverage_and_lint()
    test_candidate_credential_lint()
    test_media_ledger_and_new_lint()
    test_is_media_asset()
    test_document_link_targets()
    test_coverage_v2_auto_attach()
    test_media_citing_pages_via_attribution_edge()
    test_asset_provenance_fixture()
    test_body_source_annotations()
    test_deterministic_body_source_normalization()
    test_spaced_markdown_links()
    test_media_verify_helpers()
    test_media_verify_content_identity_and_attempt_reset()
    test_cap_media_pending()
    test_dangling_alone_blocks_closed()
    test_file_residual_ticket()
    test_ledger_repair_pages()
    test_citation_path_normalization()
    test_residual_fingerprint_full_set()
    test_page_too_large_lint()
    test_repair_prompt_names_noop_exclusions_and_glob_shape()
    test_run_layer1_carries_converge_phase()
    test_state_key()
    test_candidate_tree_hash_unreadable()
    test_pack_hash_is_relposix_sorted()
    test_content_hash_shared_formula()
    test_page_too_large_uses_raw_bytes()
    asyncio.run(test_wiring())
    asyncio.run(test_noop_gate_survives_missing_selfcheck())
    asyncio.run(test_ledger_repairs_reset_budget())
    asyncio.run(test_media_verify_wiring())
    asyncio.run(test_media_clean_pass_settles_converge())
    asyncio.run(test_media_chunks_self_drain_then_settle())
    asyncio.run(test_media_inject_failure_does_not_double_settle())
    asyncio.run(test_media_failed_chunk_still_drains_later_chunks())
    asyncio.run(test_media_failed_pages_retry_then_exhaust())
    asyncio.run(test_media_attempt_count_resets_on_success())
    asyncio.run(test_pk_failed_state_settles_converge())
    asyncio.run(test_pk_wiring())
    asyncio.run(test_seam_settles_when_nothing_pending())
    test_converge_phase_helper()
    print("ALL OK  test_selfcheck")


if __name__ == "__main__":
    main()
