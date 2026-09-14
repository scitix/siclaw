import json

import pytest
import selfcheck


def introduction():
    return {
        "overview": "Explains Device X operation and troubleshooting.",
        "knowledge_structure": "Start with concepts, then apply the recovery procedures.",
        "typical_questions": ["How do I recover Device X?"],
        "scope": "Applies to the documented Device X release; live diagnosis still requires observations.",
        "reading_guide": [{"path": "recovery.md", "reason": "Recovery conditions and exceptions."}],
    }


def test_introduction_is_a_complete_versioned_candidate_artifact(tmp_path):
    (tmp_path / "candidate").mkdir()
    (tmp_path / "candidate/recovery.md").write_text("# Recovery\n")
    selfcheck.write_repo_meta(str(tmp_path), "Device X recovery", introduction())
    artifact = tmp_path / "candidate/.library-introduction.json"
    data = json.loads(artifact.read_text())
    assert data == {"schema_version": 1, "summary": "Device X recovery", **introduction()}
    assert selfcheck.read_repo_meta(str(tmp_path)) == {"domain": "Device X recovery"}
    assert "live diagnosis" in data["scope"]


def test_invalid_introduction_does_not_replace_existing_metadata(tmp_path):
    (tmp_path / "candidate").mkdir()
    (tmp_path / "candidate/recovery.md").write_text("# Recovery\n")
    selfcheck.write_repo_meta(str(tmp_path), "Device X recovery", introduction())
    before = (tmp_path / "candidate/.library-introduction.json").read_bytes()
    bad = introduction()
    bad["reading_guide"] = [{"path": "../raw/private.md", "reason": "Outside the Wiki"}]
    with pytest.raises(ValueError, match="reading_guide"):
        selfcheck.write_repo_meta(str(tmp_path), "Different summary", bad)
    assert (tmp_path / "candidate/.library-introduction.json").read_bytes() == before
    assert selfcheck.read_repo_meta(str(tmp_path))["domain"] == "Device X recovery"


async def test_compile_tool_generates_introduction_and_includes_it_in_test_snapshot(tmp_path):
    import compile_box
    (tmp_path / "candidate").mkdir()
    (tmp_path / "candidate/index.md").write_text("# Wiki\n- [Recovery](recovery.md)\n")
    (tmp_path / "candidate/recovery.md").write_text("# Recovery\n")
    run = compile_box.CompileRun("introduction-test", str(tmp_path), 1)
    tool = next(t for t in compile_box._compile_engine_tools(run) if t.name == "report_domain")
    await tool.handler({"domain": "Device X recovery", "introduction": introduction()})
    artifacts = compile_box._collect_workspace_artifacts(str(tmp_path))
    assert any(a["path"] == "candidate/.library-introduction.json" for a in artifacts)
    selfcheck.pack_candidates_to_wiki(str(tmp_path), tmp_path / "test-session")
    assert (tmp_path / "test-session/.siclaw/knowledge/.library-introduction.json").read_bytes() == (tmp_path / "candidate/.library-introduction.json").read_bytes()


def test_introduction_validates_the_serialized_byte_budget_and_detects_stale_links(tmp_path):
    (tmp_path / "candidate").mkdir()
    page = tmp_path / "candidate/recovery.md"
    page.write_text("# Recovery\n")
    data = introduction()
    data["overview"] = "x" * (48 * 1024)
    with pytest.raises(ValueError, match="48 KiB"):
        selfcheck.write_repo_meta(str(tmp_path), "Device X recovery", data)
    assert not (tmp_path / "candidate/.library-introduction.json").exists()
    selfcheck.write_repo_meta(str(tmp_path), "Device X recovery", introduction())
    page.unlink()
    report = selfcheck.run_layer1(str(tmp_path))
    assert any(v["kind"] == "library_introduction" for v in report["lint"]["violations"])
