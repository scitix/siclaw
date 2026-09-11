"""Exported kits retain the actual compiler checks and prompt bytes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import authoring_kit


@pytest.mark.parametrize("locale", ["en", "zh"])
def test_kit_matches_compiler_sources_and_runs_real_check(tmp_path, locale):
    kit = tmp_path / "kit"
    manifest = authoring_kit.export_kit(kit, locale)
    assert manifest["okf_version"] == "0.2"
    for rel, sha in manifest["files"].items():
        assert hashlib.sha256((kit / rel).read_bytes()).hexdigest() == sha
    assert (kit / "checker/selfcheck.py").read_bytes() == (authoring_kit.POD / "selfcheck.py").read_bytes()
    assert (kit / "standards/playbook.md").read_bytes() == (authoring_kit.POD / f"prompts/{locale}/playbook.md").read_bytes()
    assert b"candidate/" in (kit / "standards/local-consumer-role.md").read_bytes()
    workspace = tmp_path / "workspace"
    (workspace / "candidate").mkdir(parents=True)
    (workspace / "raw").mkdir()
    (workspace / "raw/source.md").write_text("# Source\nA supported fact.\n")
    (workspace / "candidate/index.md").write_text('---\nokf_version: "0.2"\n---\n# Index\n- [Guide](guide.md) - facts\n')
    (workspace / "candidate/guide.md").write_text('---\ntype: concept\nsources:\n  - resource: raw/source.md\n---\n# Guide\nA supported fact.\n')
    code = "import sys,json; sys.path.insert(0,sys.argv[1]); import selfcheck; print(json.dumps(selfcheck.run_layer1(sys.argv[2])))"
    result = subprocess.run([sys.executable, "-I", "-c", code, str(kit / "checker"), str(workspace)], check=True, capture_output=True, text=True)
    report = json.loads(result.stdout)
    assert report["coverage"]["closed"] and report["lint"]["ok"], report


def test_export_preserves_existing_files_and_refuses_symlinks(tmp_path):
    kit = tmp_path / "kit"
    authoring_kit.export_kit(kit)
    sentinel = kit / "standards/playbook.md"
    sentinel.write_text("local content")
    with pytest.raises(FileExistsError):
        authoring_kit.export_kit(kit)
    assert sentinel.read_text() == "local content"
    linked = tmp_path / "linked"
    linked.symlink_to(kit)
    with pytest.raises(ValueError, match="symlink"):
        authoring_kit.export_kit(linked)
