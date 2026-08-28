"""Focused tests for the standalone OKF attestation attach utility."""

import importlib.util
import json
import tarfile
import tempfile
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("attach_okf_attestation.py")
SPEC = importlib.util.spec_from_file_location("attach_okf_attestation", MODULE_PATH)
assert SPEC and SPEC.loader
tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tool)


INDEX = '---\nokf_version: "0.2"\n---\n\n# Index\n'
PAGE = "---\ntype: Concept\n---\n\n# Page\n"


def _write(root: Path, rel: str, body) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if not isinstance(body, str):
        body = json.dumps(body, ensure_ascii=False)
    target.write_text(body, encoding="utf-8")


def test_attaches_receipts_and_reports_tier() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "page.md", PAGE)
        _write(base, "checks.json", [
            {"name": "kb_eval", "status": "pass", "detail": "gate 12/12"},
            {"name": "lint_links", "status": "pass"},
        ])
        output = base / "attested.tar.gz"
        receipt = tool.attach_attestation(
            wiki, output,
            producer="siclaw-kbc-local",
            producer_version="0.1.0",
            checks_path=base / "checks.json",
            coverage_path=None,
            input_revision="sha256:feedbeef",
        )
        assert receipt["attestation_tier"] == "self_attested"
        # The caller's wiki directory is input only — the sidecar lives in the
        # staging copy and the archive, never in the source tree.
        assert not (wiki / ".okf-attestation.json").exists()
        with tarfile.open(output, "r:gz") as archive:
            body = archive.extractfile(".okf-attestation.json").read()
        doc = json.loads(body)
        assert doc["producer"] == {"name": "siclaw-kbc-local", "version": "0.1.0"}
        assert doc["concept_pages"] == 1
        assert len(doc["payload_manifest_sha256"]) == 64
        assert doc["signature"] is None


def test_failing_checks_still_package_but_report_unattested() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "page.md", PAGE)
        _write(base, "checks.json", [{"name": "kb_eval", "status": "fail", "detail": "gate 7/12"}])
        receipt = tool.attach_attestation(
            wiki, base / "out.tar.gz",
            producer="siclaw-kbc-local",
            producer_version=None,
            checks_path=base / "checks.json",
            coverage_path=None,
            input_revision=None,
        )
        assert receipt["attestation_tier"] == "unattested"


def test_existing_output_requires_explicit_overwrite() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "page.md", PAGE)
        _write(base, "checks.json", [{"name": "kb_eval", "status": "pass"}])
        output = base / "out.tar.gz"
        output.write_bytes(b"pre-existing")
        try:
            tool.attach_attestation(
                wiki, output,
                producer="siclaw-kbc-local",
                producer_version=None,
                checks_path=base / "checks.json",
                coverage_path=None,
                input_revision=None,
            )
        except Exception as error:  # OKFPackageError from the packer
            assert "already exists" in str(error)
        else:
            raise AssertionError("tool overwrote an existing archive without --overwrite")
        assert output.read_bytes() == b"pre-existing"
        receipt = tool.attach_attestation(
            wiki, output,
            producer="siclaw-kbc-local",
            producer_version=None,
            checks_path=base / "checks.json",
            coverage_path=None,
            input_revision=None,
            overwrite=True,
        )
        assert receipt["attestation_tier"] == "self_attested"


def test_invalid_checks_refuse_to_build() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "page.md", PAGE)
        _write(base, "checks.json", [{"name": "kb_eval", "status": "maybe"}])
        try:
            tool.attach_attestation(
                wiki, base / "out.tar.gz",
                producer="siclaw-kbc-local",
                producer_version=None,
                checks_path=base / "checks.json",
                coverage_path=None,
                input_revision=None,
            )
        except tool.AttestationError as error:
            assert "status" in str(error)
        else:
            raise AssertionError("tool built an attestation from an invalid check status")


if __name__ == "__main__":
    test_attaches_receipts_and_reports_tier()
    test_failing_checks_still_package_but_report_unattested()
    test_existing_output_requires_explicit_overwrite()
    test_invalid_checks_refuse_to_build()
    print("OK  OKF package attestation attach")
