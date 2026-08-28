"""Contract tests for the compiler attestation sidecar (build + packaging gate)."""

import json
import tempfile
from pathlib import Path

import okf_attestation
from okf_package import OKFPackageError, collect_import_files, write_import_archive


INDEX = '---\nokf_version: "0.2"\n---\n\n# Contents\n'
PAGE = "---\ntype: Topic\n---\n\nA compiled page.\n"


def _write(root: Path, rel: str, body: str) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")


def _valid_doc(concept_pages: int = 2) -> dict:
    return {
        "schema_version": 1,
        "producer": {"name": "siclaw-kbc", "version": "0.9.0"},
        "input_revision": "sha256:a1b2c3",
        "concept_pages": concept_pages,
        "coverage": {"closed": True, "cited": 4, "excluded": 1, "auto_attached": 0,
                     "derived": 0, "unaccounted": 0, "dangling": 0},
        "checks": [
            {"name": "selfcheck", "status": "pass"},
            {"name": "redblue", "status": "pass", "detail": "16/16 questions"},
        ],
        "signature": None,
    }


def _wiki_with_sidecar(base: Path, doc: dict | str) -> Path:
    wiki = base / "wiki"
    _write(wiki, "index.md", INDEX)
    _write(wiki, "topics/a.md", PAGE)
    _write(wiki, "topics/b.md", PAGE)
    body = doc if isinstance(doc, str) else okf_attestation.render_attestation(doc)
    _write(wiki, okf_attestation.ATTESTATION_SIDECAR, body)
    return wiki


def test_valid_attestation_passes_and_classifies_attested() -> None:
    doc = _valid_doc()
    assert okf_attestation.attestation_violations(doc, concept_pages=2) == []
    assert okf_attestation.classify_tier(doc) == okf_attestation.TIER_ATTESTED


def test_honest_failure_classifies_unattested() -> None:
    doc = _valid_doc()
    doc["checks"][0]["status"] = "fail"
    assert okf_attestation.attestation_violations(doc, concept_pages=2) == []
    assert okf_attestation.classify_tier(doc) == okf_attestation.TIER_UNATTESTED


def test_open_coverage_classifies_unattested() -> None:
    doc = _valid_doc()
    doc["coverage"].update({"closed": False, "unaccounted": 3})
    assert okf_attestation.attestation_violations(doc, concept_pages=2) == []
    assert okf_attestation.classify_tier(doc) == okf_attestation.TIER_UNATTESTED


def test_lying_receipts_are_violations() -> None:
    cases = [
        ("concept_pages", lambda d: d.update(concept_pages=37)),
        ("closed contradicts", lambda d: d["coverage"].update(unaccounted=5)),
        ("unknown field", lambda d: d.update(extra=True)),
        ("schema version", lambda d: d.update(schema_version=9)),
        ("signature", lambda d: d.update(signature="sig-bytes")),
        ("duplicate checks", lambda d: d["checks"].append({"name": "selfcheck", "status": "pass"})),
        ("bad status", lambda d: d["checks"][0].update(status="maybe")),
        ("empty checks", lambda d: d.update(checks=[])),
        ("bad producer", lambda d: d["producer"].update(name=" ")),
        ("bad revision", lambda d: d.update(input_revision="!!!")),
    ]
    for label, mutate in cases:
        doc = _valid_doc()
        mutate(doc)
        assert okf_attestation.attestation_violations(doc, concept_pages=2), label


def test_build_attestation_refuses_invalid_input() -> None:
    try:
        okf_attestation.build_attestation(
            producer_name="siclaw-kbc", concept_pages=2,
            checks=[{"name": "selfcheck", "status": "maybe"}],
        )
    except ValueError as error:
        assert "status" in str(error)
    else:
        raise AssertionError("build_attestation accepted an invalid check status")


def test_packager_ships_valid_sidecar_and_keeps_determinism() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = _wiki_with_sidecar(base, _valid_doc())
        assert [rel for rel, _ in collect_import_files(wiki)] == [
            okf_attestation.ATTESTATION_SIDECAR, "index.md", "topics/a.md", "topics/b.md",
        ]
        first = write_import_archive(wiki, base / "first.tar.gz")
        second = write_import_archive(wiki, base / "second.tar.gz")
        assert first["sha256"] == second["sha256"]


def test_packager_rejects_lying_sidecar_before_upload() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = _wiki_with_sidecar(base, _valid_doc(concept_pages=37))
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "concept_pages 37 does not match" in str(error)
        else:
            raise AssertionError("packager accepted a sidecar that lies about page count")


def test_packager_rejects_malformed_sidecar_json() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = _wiki_with_sidecar(base, "{not json")
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "invalid JSON" in str(error)
        else:
            raise AssertionError("packager accepted malformed attestation JSON")


def test_packager_without_sidecar_is_unchanged() -> None:
    with tempfile.TemporaryDirectory() as raw:
        wiki = Path(raw) / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "topics/a.md", PAGE)
        assert [rel for rel, _ in collect_import_files(wiki)] == ["index.md", "topics/a.md"]


if __name__ == "__main__":
    test_valid_attestation_passes_and_classifies_attested()
    test_honest_failure_classifies_unattested()
    test_open_coverage_classifies_unattested()
    test_lying_receipts_are_violations()
    test_build_attestation_refuses_invalid_input()
    test_packager_ships_valid_sidecar_and_keeps_determinism()
    test_packager_rejects_lying_sidecar_before_upload()
    test_packager_rejects_malformed_sidecar_json()
    test_packager_without_sidecar_is_unchanged()
    print("OK  compiler attestation sidecar validation + packaging gate")
